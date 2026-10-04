/**
 * Street 3D reconstruction — privacy-safe derivatives, durable jobs, scenes and
 * their published versions.
 *
 * ## The two lifecycles this module keeps apart
 *
 * Everything in `capture.ts` is TEMPORARY: raw media dies by schema. Some of
 * what is here is DERIVED and long-lived, and the boundary is the point:
 *
 *   - `capture_derivatives` are still temporary. They are privacy-safe frames
 *     and training masks, smaller and safer than the raw media they replace,
 *     and they carry the same structural ceiling (`expires_at` NOT NULL and
 *     CHECKed against `ABSOLUTE_RETENTION_CEILING_DAYS`, bounded extensions).
 *   - `street3d_scene_versions` are PUBLISHED OUTPUT. They survive the deletion
 *     of every input, live in a different bucket, and no capture sweeper ever
 *     touches them. A version is removed by moderation (`disabled`), never by
 *     an expiry.
 *
 * ## Nothing here is a location history
 *
 * Scenes have an anchor because a scene IS a place. Coverage areas are coarse
 * geohash cells with banded counts. Neither table has a user column. The only
 * Oxy user id in this module is a report's author, which is accountability for
 * a moderation request, not a position.
 *
 * ## The job table is the system of record; the queue is not
 *
 * SQS carries pointers to `street3d_jobs` rows and nothing else. A lost message
 * is recovered by the scheduler's lease sweep, a duplicated one by idempotency
 * (`street3d_job_events` keyed by `eventId`, one version per job, one open job
 * per scene and per capture — all enforced HERE, not by a convention in the
 * scheduler).
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  STREET_COVERAGE_AREA_STATES,
  STREET_SCENE_PROFILES,
  STREET_SCENE_REPORT_REASONS,
  DELETION_REASONS,
  RETENTION_REASONS,
  type StreetSceneAsset,
  type StreetSceneInitialView,
  type StreetSceneNavigation,
  type StreetSceneQuality,
  type StreetSceneWorldTransform,
} from '@goway/shared-types';
import { ABSOLUTE_RETENTION_CEILING_DAYS, MAX_RETENTION_EXTENSIONS, captureAssets } from './capture';
import { closedSet, foreignServiceId, generatedGeographyPoint, latitude, longitude } from './columns';
import {
  DERIVATIVE_STORAGE_STATES,
  STREET3D_JOB_KINDS,
  STREET3D_JOB_STATES,
  STREET3D_SCENE_STATES,
  STREET3D_SCENE_VERSION_STATES,
  STREET3D_TERMINAL_JOB_STATES,
} from './valueSets';

const SHA256_PATTERN = "'^[0-9a-f]{64}$'";
const terminalJobStates = sql.raw(inList(STREET3D_TERMINAL_JOB_STATES));

/**
 * A reconstruction area.
 *
 * The anchor is INTERNAL — a centroid of the captures that formed the scene,
 * used to cluster later captures around it with `ST_DWithin`. It is never
 * published: a viewer sees a version's `bounds` and `worldTransform`, which the
 * reconstruction produced, not this point.
 *
 * `last_allocated_version` hands out version numbers when a job is CREATED, so
 * a job, its manifest and its result all name the same version before any
 * version row exists. Numbers are never reused, even for a job that failed.
 */
export const street3dScenes = pgTable(
  'street3d_scenes',
  {
    id: generatedId(),
    state: text().notNull().default('candidate'),
    anchorLatitude: latitude().notNull(),
    anchorLongitude: longitude().notNull(),
    /** GENERATED from the two ordinates; never written. */
    anchorGeo: generatedGeographyPoint('anchor_longitude', 'anchor_latitude'),
    radiusMeters: doublePrecision().notNull(),
    /** The version served to viewers. Null until the first publication or after a disable. */
    currentVersionId: text().references((): AnyPgColumn => street3dSceneVersions.id, { onDelete: 'set null' }),
    lastAllocatedVersion: integer().notNull().default(0),
    /**
     * SHA-256 over the sorted input-frame digests of the last QUEUED job. The
     * scheduler never queues the same input set twice, which is what keeps a
     * `needs_more_capture` scene from burning GPU time on identical inputs.
     */
    lastQueuedInputFingerprint: text(),
    /** Eligible frames and distinct 45° heading sectors at the last tick. */
    eligibleFrames: integer().notNull().default(0),
    headingSectors: integer().notNull().default(0),
    /** Registration ratio of the current version, 0–1. Null while unpublished. */
    confidence: doublePrecision(),
    /** Set when a source was withdrawn or blocked, or by an operator. Cleared by the next queued job. */
    rebuildRequestedAt: timestamptz(),
    rebuildProfile: text(),
    disabledAt: timestamptz(),
    disabledReason: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('street3d_scenes_state_check', table.state, STREET3D_SCENE_STATES),
    closedSet('street3d_scenes_rebuild_profile_check', table.rebuildProfile, STREET_SCENE_PROFILES),
    check('street3d_scenes_latitude_range_check', sql`${table.anchorLatitude} between -90 and 90`),
    check('street3d_scenes_longitude_range_check', sql`${table.anchorLongitude} between -180 and 180`),
    check('street3d_scenes_radius_check', sql`${table.radiusMeters} > 0 and ${table.radiusMeters} <= 1000`),
    check('street3d_scenes_counts_check', sql`${table.eligibleFrames} >= 0 and ${table.headingSectors} between 0 and 8`),
    check('street3d_scenes_confidence_check', sql`${table.confidence} is null or ${table.confidence} between 0 and 1`),
    check('street3d_scenes_version_counter_check', sql`${table.lastAllocatedVersion} >= 0`),
    check(
      'street3d_scenes_fingerprint_check',
      sql`${table.lastQueuedInputFingerprint} is null or ${table.lastQueuedInputFingerprint} ~ ${sql.raw(SHA256_PATTERN)}`,
    ),
    check('street3d_scenes_disabled_check', sql`(${table.disabledAt} is null) = (${table.disabledReason} is null)`),
    check('street3d_scenes_disabled_state_check', sql`(${table.state} = 'disabled') = (${table.disabledAt} is not null)`),
    check(
      'street3d_scenes_published_check',
      sql`${table.state} <> 'published' or ${table.currentVersionId} is not null`,
    ),
    /** The clustering index. See `capture_assets_geo_gist` for why `ST_DWithin` and not a cell. */
    index('street3d_scenes_geo_gist').using('gist', table.anchorGeo),
    index('street3d_scenes_state_idx').on(table.state),
  ],
);

/**
 * One unit of external-worker work: a privacy pass over one capture, or one
 * reconstruction of one scene version.
 *
 * `id` IS the `jobId` in every envelope, manifest, event and result, and it is
 * fixed when this row is created — so a redelivered message, a duplicate event
 * and a re-reported result all name the same row.
 *
 * `dispatched_at` is the outbox. A row is created first and sent after commit;
 * a crash between the two leaves `dispatched_at` null and the next tick sends
 * it. A crash after sending but before recording sends it twice, which the
 * worker absorbs by `jobId`.
 */
export const street3dJobs = pgTable(
  'street3d_jobs',
  {
    id: generatedId(),
    kind: text().notNull(),
    /** The capture a privacy job reads. `restrict`: an asset row is a tombstone that outlives its bytes. */
    assetId: text().references(() => captureAssets.id, { onDelete: 'restrict' }),
    sceneId: text().references(() => street3dScenes.id, { onDelete: 'restrict' }),
    sceneVersion: integer(),
    profile: text(),

    state: text().notNull().default('queued'),
    attempt: integer().notNull().default(1),
    maxAttempts: integer().notNull(),
    /** Opaque worker id from the last event. Never a hostname. */
    workerId: text(),
    stage: text(),
    progress: doublePrecision(),
    heartbeatAt: timestamptz(),
    leaseExpiresAt: timestamptz(),
    enqueuedAt: timestamptz().notNull().defaultNow(),
    dispatchedAt: timestamptz(),
    retryAfter: timestamptz(),
    startedAt: timestamptz(),
    finishedAt: timestamptz(),

    failureCode: text(),
    failureRetryable: boolean(),
    /** Sanitized and short. Never a path, a URL or a stack. */
    failureDetail: text(),

    inputManifestKey: text(),
    inputManifestSha256: text(),
    outputPrefix: text().notNull(),
    /** Derivative ids the manifest listed — the worker's `frameId`s. Scene jobs only. */
    inputDerivativeIds: text().array(),
    inputFingerprint: text(),
    resultKey: text(),
    resultSha256: text(),
    /** Cost and quality numbers from the result: GPU seconds, bytes, cache hits. */
    metrics: jsonb().$type<Record<string, number>>(),

    cancelRequestedAt: timestamptz(),
    cancelReason: text(),
    /** When `jobs/<id>/cancel` was written. The outbox for cancellation. */
    cancelMarkerWrittenAt: timestamptz(),
    supersededByJobId: text(),
    /** When this job's temporary artifacts were removed from `jobs/` (and failed `derived/` output). */
    artifactsDeletedAt: timestamptz(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('street3d_jobs_kind_check', table.kind, STREET3D_JOB_KINDS),
    closedSet('street3d_jobs_state_check', table.state, STREET3D_JOB_STATES),
    closedSet('street3d_jobs_profile_check', table.profile, STREET_SCENE_PROFILES),
    /** A job names exactly the subject its kind needs, and nothing else. */
    check(
      'street3d_jobs_subject_check',
      sql`(${table.kind} = 'capture_privacy' and ${table.assetId} is not null and ${table.sceneId} is null)
          or (${table.kind} = 'scene_reconstruct' and ${table.assetId} is null and ${table.sceneId} is not null
              and ${table.sceneVersion} is not null and ${table.profile} is not null
              and ${table.inputManifestKey} is not null and ${table.inputManifestSha256} is not null)`,
    ),
    check('street3d_jobs_attempt_check', sql`${table.attempt} between 1 and ${table.maxAttempts} and ${table.maxAttempts} <= 20`),
    check('street3d_jobs_progress_check', sql`${table.progress} is null or ${table.progress} between 0 and 1`),
    check('street3d_jobs_version_check', sql`${table.sceneVersion} is null or ${table.sceneVersion} > 0`),
    check(
      'street3d_jobs_finished_check',
      sql`(${table.state} in (${terminalJobStates})) = (${table.finishedAt} is not null)`,
    ),
    check('street3d_jobs_retry_check', sql`${table.state} <> 'retry_wait' or ${table.retryAfter} is not null`),
    check('street3d_jobs_cancel_check', sql`(${table.cancelRequestedAt} is null) = (${table.cancelReason} is null)`),
    check(
      'street3d_jobs_digest_check',
      sql`(${table.inputManifestSha256} is null or ${table.inputManifestSha256} ~ ${sql.raw(SHA256_PATTERN)})
          and (${table.resultSha256} is null or ${table.resultSha256} ~ ${sql.raw(SHA256_PATTERN)})`,
    ),
    check('street3d_jobs_failure_code_check', sql`${table.failureCode} is null or ${table.failureCode} ~ '^[a-z_]{1,40}$'`),
    check('street3d_jobs_failure_detail_check', sql`${table.failureDetail} is null or char_length(${table.failureDetail}) <= 200`),
    check('street3d_jobs_worker_id_check', sql`${table.workerId} is null or char_length(${table.workerId}) <= 64`),
    /**
     * ONE open job per capture and per scene. "Never enqueue while a job for
     * that scene is open" is this index, not a SELECT in the scheduler that two
     * concurrent ticks could both pass. Superseding cancels the old job in the
     * same transaction that inserts the new one.
     */
    uniqueIndex('street3d_jobs_open_asset_key')
      .on(table.assetId)
      .where(sql`${table.assetId} is not null and ${table.state} not in (${terminalJobStates})`),
    uniqueIndex('street3d_jobs_open_scene_key')
      .on(table.sceneId)
      .where(sql`${table.sceneId} is not null and ${table.state} not in (${terminalJobStates})`),
    /** A scene version is produced by exactly one job. */
    uniqueIndex('street3d_jobs_scene_version_key')
      .on(table.sceneId, table.sceneVersion)
      .where(sql`${table.sceneId} is not null`),
    index('street3d_jobs_state_idx').on(table.state),
    index('street3d_jobs_dispatch_idx').on(table.enqueuedAt).where(sql`${table.dispatchedAt} is null`),
    index('street3d_jobs_finished_idx').on(table.finishedAt).where(sql`${table.artifactsDeletedAt} is null`),
  ],
);

/**
 * One privacy-safe frame (and its training mask) produced from one capture.
 *
 * A photo yields one; a video yields its keyframes. The bytes live under
 * `derived/` in the temporary bucket. Raw media is never stored here, and a
 * row exists only for a capture whose privacy job reported a `passed` verdict
 * naming its pipeline version — which this table repeats per frame, so a
 * rebuild after a detector improvement can tell old frames from new ones.
 *
 * Temporary, with the same structural guarantees as `capture_media_objects`:
 * NOT NULL expiry under the absolute ceiling, protection bounded by expiry, a
 * capped extension count and a tombstone that says when and why.
 */
export const captureDerivatives = pgTable(
  'capture_derivatives',
  {
    id: generatedId(),
    assetId: text()
      .notNull()
      .references(() => captureAssets.id, { onDelete: 'restrict' }),
    /** The privacy job that produced it. */
    jobId: text()
      .notNull()
      .references(() => street3dJobs.id, { onDelete: 'restrict' }),
    frameIndex: integer().notNull(),
    objectKey: text().notNull(),
    imageSha256: text().notNull(),
    imageByteSize: bigint({ mode: 'number' }).notNull(),
    maskKey: text(),
    maskSha256: text(),
    maskByteSize: bigint({ mode: 'number' }),
    width: integer().notNull(),
    height: integer().notNull(),
    privacyPipelineVersion: text().notNull(),

    retentionClass: text().notNull().default('privacy_safe_proxy'),
    retentionReason: text().notNull().default('awaiting_overlap'),
    expiresAt: timestamptz().notNull(),
    protectedUntil: timestamptz(),
    extensionCount: integer().notNull().default(0),
    storageState: text().notNull().default('stored'),
    deletionRequestedAt: timestamptz(),
    deletionRequestedReason: text(),
    deletedAt: timestamptz(),
    deletionReason: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    /** One class, and it is not a raw class: a raw upload here is unrepresentable. */
    closedSet('capture_derivatives_retention_class_check', table.retentionClass, ['privacy_safe_proxy']),
    closedSet('capture_derivatives_retention_reason_check', table.retentionReason, RETENTION_REASONS),
    closedSet('capture_derivatives_storage_state_check', table.storageState, DERIVATIVE_STORAGE_STATES),
    closedSet('capture_derivatives_deletion_reason_check', table.deletionReason, DELETION_REASONS),
    closedSet('capture_derivatives_deletion_requested_reason_check', table.deletionRequestedReason, DELETION_REASONS),
    check(
      'capture_derivatives_digest_check',
      sql`${table.imageSha256} ~ ${sql.raw(SHA256_PATTERN)} and (${table.maskSha256} is null or ${table.maskSha256} ~ ${sql.raw(SHA256_PATTERN)})`,
    ),
    check('capture_derivatives_mask_check', sql`(${table.maskKey} is null) = (${table.maskSha256} is null)`),
    check(
      'capture_derivatives_size_check',
      sql`${table.imageByteSize} > 0 and (${table.maskByteSize} is null or ${table.maskByteSize} > 0)
          and ${table.width} > 0 and ${table.height} > 0 and ${table.frameIndex} >= 0`,
    ),
    check('capture_derivatives_key_check', sql`${table.objectKey} like 'derived/%' and (${table.maskKey} is null or ${table.maskKey} like 'derived/%')`),
    check('capture_derivatives_expiry_after_creation_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'capture_derivatives_expiry_ceiling_check',
      sql`${table.expiresAt} <= ${table.createdAt} + ${sql.raw(`interval '${ABSOLUTE_RETENTION_CEILING_DAYS} days'`)}`,
    ),
    check(
      'capture_derivatives_protected_until_check',
      sql`${table.protectedUntil} is null or ${table.protectedUntil} <= ${table.expiresAt}`,
    ),
    check(
      'capture_derivatives_extension_count_check',
      sql`${table.extensionCount} between 0 and ${sql.raw(String(MAX_RETENTION_EXTENSIONS))}`,
    ),
    check('capture_derivatives_deletion_request_check', sql`(${table.deletionRequestedAt} is null) = (${table.deletionRequestedReason} is null)`),
    check('capture_derivatives_tombstone_check', sql`(${table.deletedAt} is null) = (${table.deletionReason} is null)`),
    check('capture_derivatives_deleted_state_check', sql`(${table.storageState} = 'deleted') = (${table.deletedAt} is not null)`),
    unique('capture_derivatives_object_key_key').on(table.objectKey),
    unique('capture_derivatives_job_frame_key').on(table.jobId, table.frameIndex),
    index('capture_derivatives_asset_idx').on(table.assetId),
    index('capture_derivatives_expiry_idx').on(table.expiresAt).where(sql`${table.deletedAt} is null`),
  ],
);

/**
 * One version of a scene: a validated reconstruction, published or not.
 *
 * `assets` holds PUBLIC data only — scene-bucket keys and the URLs they are
 * served at, digests, sizes. `provenance` holds the pipeline and component
 * versions and nothing that identifies a contributor; which captures went in is
 * `street3d_scene_inputs`, internal. `quality` is the published
 * {@link StreetSceneQuality}; `metrics` is the worker's full numeric report,
 * kept for cost accounting and never served.
 */
export const street3dSceneVersions = pgTable(
  'street3d_scene_versions',
  {
    id: generatedId(),
    sceneId: text()
      .notNull()
      .references(() => street3dScenes.id, { onDelete: 'restrict' }),
    version: integer().notNull(),
    jobId: text()
      .notNull()
      .references(() => street3dJobs.id, { onDelete: 'restrict' }),
    state: text().notNull().default('validating'),
    profile: text().notNull(),
    boundsWest: longitude().notNull(),
    boundsSouth: latitude().notNull(),
    boundsEast: longitude().notNull(),
    boundsNorth: latitude().notNull(),
    footprint: jsonb().notNull().$type<{ type: 'Polygon'; coordinates: number[][][] }>(),
    worldTransform: jsonb().notNull().$type<StreetSceneWorldTransform>(),
    initialView: jsonb().notNull().$type<StreetSceneInitialView>(),
    /** Published guided navigation, already decimated and reordered. Null when the worker reported none. */
    navigation: jsonb().$type<StreetSceneNavigation>(),
    assets: jsonb().notNull().$type<(StreetSceneAsset & { key: string })[]>(),
    quality: jsonb().notNull().$type<StreetSceneQuality>(),
    metrics: jsonb().notNull().$type<Record<string, number>>(),
    provenance: jsonb().notNull().$type<{ pipelineVersion: string; components: Record<string, string> }>(),
    /** Gate failures for a `failed_quality` version. Empty otherwise. */
    gateFailures: text().array().notNull().default(sql`'{}'::text[]`),
    observedFrom: timestamptz().notNull(),
    observedTo: timestamptz().notNull(),
    privacyPipelineVersions: text().array().notNull(),
    attributions: text().array().notNull().default(sql`'{}'::text[]`),
    resultSha256: text().notNull(),
    publishedAt: timestamptz(),
    disabledAt: timestamptz(),
    disabledReason: text(),
    /** When a disabled version's public objects were deleted and the CDN invalidated. The purge outbox. */
    assetsPurgedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('street3d_versions_state_check', table.state, STREET3D_SCENE_VERSION_STATES),
    closedSet('street3d_versions_profile_check', table.profile, STREET_SCENE_PROFILES),
    check('street3d_versions_version_check', sql`${table.version} > 0`),
    check(
      'street3d_versions_bounds_check',
      sql`${table.boundsSouth} <= ${table.boundsNorth}
          and ${table.boundsSouth} between -90 and 90 and ${table.boundsNorth} between -90 and 90
          and ${table.boundsWest} between -180 and 180 and ${table.boundsEast} between -180 and 180`,
    ),
    check('street3d_versions_observed_check', sql`${table.observedFrom} <= ${table.observedTo}`),
    check('street3d_versions_digest_check', sql`${table.resultSha256} ~ ${sql.raw(SHA256_PATTERN)}`),
    check('street3d_versions_assets_check', sql`jsonb_typeof(${table.assets}) = 'array'`),
    /** `coalesce`: a missing `viewpoints` key makes `jsonb_typeof` null, which a bare CHECK would let through. */
    check(
      'street3d_versions_navigation_check',
      sql`${table.navigation} is null or coalesce(jsonb_typeof(${table.navigation} -> 'viewpoints') = 'array', false)`,
    ),
    /** A version that was ever served says when; one that was never served does not. */
    check(
      'street3d_versions_published_check',
      sql`${table.state} not in ('published', 'superseded') or ${table.publishedAt} is not null`,
    ),
    check('street3d_versions_disabled_check', sql`(${table.state} = 'disabled') = (${table.disabledAt} is not null)`),
    check('street3d_versions_disabled_reason_check', sql`(${table.disabledAt} is null) = (${table.disabledReason} is null)`),
    unique('street3d_versions_scene_version_key').on(table.sceneId, table.version),
    unique('street3d_versions_job_key').on(table.jobId),
    /** At most ONE served version per scene; publication supersedes in the same transaction. */
    uniqueIndex('street3d_versions_published_key').on(table.sceneId).where(sql`${table.state} = 'published'`),
    index('street3d_versions_bounds_idx').on(table.boundsWest, table.boundsSouth, table.boundsEast, table.boundsNorth),
  ],
);

/**
 * Which derivatives went into which version, and whether each was registered.
 *
 * Internal provenance — never published. It is what lets a contributor's
 * withdrawal or a moderation block find every version their pixels reached, and
 * what makes "blocked captures never re-enter a manifest" auditable.
 */
export const street3dSceneInputs = pgTable(
  'street3d_scene_inputs',
  {
    versionId: text()
      .notNull()
      .references(() => street3dSceneVersions.id, { onDelete: 'cascade' }),
    captureAssetId: text()
      .notNull()
      .references(() => captureAssets.id, { onDelete: 'restrict' }),
    derivativeId: text()
      .notNull()
      .references(() => captureDerivatives.id, { onDelete: 'restrict' }),
    registered: boolean().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    primaryKey({ name: 'street3d_scene_inputs_pkey', columns: [table.versionId, table.derivativeId] }),
    index('street3d_scene_inputs_asset_idx').on(table.captureAssetId),
  ],
);

/**
 * The visual capture graph: two derivatives that a solve verified to match.
 *
 * Undirected, so stored once with `derivative_a < derivative_b`. Upserted by
 * the latest version that observed the pair. Compact derived knowledge that is
 * worth keeping after the pixels go — it is how a later scheduler can tell which
 * new capture actually connects to an existing scene.
 */
export const street3dCaptureEdges = pgTable(
  'street3d_capture_edges',
  {
    derivativeA: text()
      .notNull()
      .references(() => captureDerivatives.id, { onDelete: 'restrict' }),
    derivativeB: text()
      .notNull()
      .references(() => captureDerivatives.id, { onDelete: 'restrict' }),
    inliers: integer().notNull(),
    matcherVersion: text().notNull(),
    observedInVersionId: text()
      .notNull()
      .references(() => street3dSceneVersions.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    primaryKey({ name: 'street3d_capture_edges_pkey', columns: [table.derivativeA, table.derivativeB] }),
    check('street3d_capture_edges_order_check', sql`${table.derivativeA} < ${table.derivativeB}`),
    check('street3d_capture_edges_inliers_check', sql`${table.inliers} > 0`),
    index('street3d_capture_edges_b_idx').on(table.derivativeB),
  ],
);

/**
 * A viewer's report about a published scene.
 *
 * Reports never disable anything automatically — a moderator decides — but
 * they are counted in `street3d:admin status`, privacy reports separately. The
 * note is never published.
 */
export const street3dSceneReports = pgTable(
  'street3d_scene_reports',
  {
    id: generatedId(),
    sceneId: text()
      .notNull()
      .references(() => street3dScenes.id, { onDelete: 'restrict' }),
    versionId: text()
      .notNull()
      .references(() => street3dSceneVersions.id, { onDelete: 'restrict' }),
    /** The reporter. An Oxy user id: no foreign key, never published. */
    reporterOxyUserId: foreignServiceId().notNull(),
    reason: text().notNull(),
    note: text(),
    createdAt: createdAt(),
    resolvedAt: timestamptz(),
  },
  (table) => [
    closedSet('street3d_reports_reason_check', table.reason, STREET_SCENE_REPORT_REASONS),
    check('street3d_reports_note_check', sql`${table.note} is null or char_length(${table.note}) <= 500`),
    /** One open report per reporter per version: a repeat answers the existing one. */
    uniqueIndex('street3d_reports_open_key')
      .on(table.versionId, table.reporterOxyUserId)
      .where(sql`${table.resolvedAt} is null`),
    index('street3d_reports_open_idx').on(table.sceneId).where(sql`${table.resolvedAt} is null`),
  ],
);

/**
 * Every worker event the backend has applied, by `eventId`.
 *
 * SQS delivers at least once; this table is what makes applying an event
 * idempotent. The insert happens in the same transaction as the state change,
 * so an event is either applied and recorded or neither.
 */
export const street3dJobEvents = pgTable(
  'street3d_job_events',
  {
    eventId: text().primaryKey(),
    jobId: text()
      .notNull()
      .references(() => street3dJobs.id, { onDelete: 'cascade' }),
    attempt: integer().notNull(),
    type: text().notNull(),
    receivedAt: timestamptz().notNull().defaultNow(),
  },
  (table) => [
    closedSet('street3d_job_events_type_check', table.type, ['heartbeat', 'completed', 'failed']),
    index('street3d_job_events_job_idx').on(table.jobId),
  ],
);

/**
 * A permanent moderation block on a capture.
 *
 * `capture_assets.privacy_state = 'blocked'` already closes the generated
 * eligibility column; this row adds what that state cannot hold — the REASON,
 * and the content hash, so the identical bytes contributed again (by anybody,
 * to a new object) are refused at privacy scheduling and never re-enter a
 * manifest either.
 */
export const street3dCaptureBlocks = pgTable(
  'street3d_capture_blocks',
  {
    id: generatedId(),
    captureAssetId: text()
      .notNull()
      .references(() => captureAssets.id, { onDelete: 'restrict' }),
    contentHash: text().notNull(),
    reason: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    check('street3d_capture_blocks_hash_check', sql`${table.contentHash} ~ ${sql.raw(SHA256_PATTERN)}`),
    check('street3d_capture_blocks_reason_check', sql`btrim(${table.reason}) <> '' and char_length(${table.reason}) <= 200`),
    unique('street3d_capture_blocks_asset_key').on(table.captureAssetId),
    index('street3d_capture_blocks_hash_idx').on(table.contentHash),
  ],
);

/**
 * The public coverage map, materialized by the scheduler.
 *
 * One row per coarse geohash cell holding useful contributions. `center` and
 * `bounds` are the CELL's, never a capture's, and the count is published only
 * as a band — coverage cannot be read back into anybody's position. The cell
 * itself is not published either: `public_id` is an opaque digest of it.
 *
 * `last_rescue_at` bounds rescue extensions to one per new contribution.
 */
export const street3dCoverageAreas = pgTable(
  'street3d_coverage_areas',
  {
    cell: text().primaryKey(),
    publicId: text().notNull(),
    state: text().notNull(),
    centerLatitude: latitude().notNull(),
    centerLongitude: longitude().notNull(),
    boundsWest: longitude().notNull(),
    boundsSouth: latitude().notNull(),
    boundsEast: longitude().notNull(),
    boundsNorth: latitude().notNull(),
    contributionCount: integer().notNull(),
    atRiskUntil: timestamptz(),
    sceneId: text().references(() => street3dScenes.id, { onDelete: 'set null' }),
    latestContributionAt: timestamptz(),
    lastRescueAt: timestamptz(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('street3d_coverage_state_check', table.state, STREET_COVERAGE_AREA_STATES),
    check('street3d_coverage_count_check', sql`${table.contributionCount} > 0`),
    check('street3d_coverage_cell_check', sql`${table.cell} ~ '^[0-9b-hjkmnp-z]{4,9}$'`),
    check('street3d_coverage_at_risk_check', sql`${table.state} <> 'at_risk' or ${table.atRiskUntil} is not null`),
    unique('street3d_coverage_public_id_key').on(table.publicId),
    index('street3d_coverage_center_idx').on(table.centerLatitude, table.centerLongitude),
  ],
);

/** Every Street 3D-owned SQL fragment that the scheduler and the schema agree on. */
export const STREET3D_OPEN_JOB_PREDICATE = (stateColumn: AnyPgColumn): SQL =>
  sql`${stateColumn} not in (${terminalJobStates})`;

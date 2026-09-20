/**
 * Street 3D capture — contributed imagery, where it is, why it is stored and
 * when it dies.
 *
 * ## The one invariant this file exists to make structural
 *
 * **No raw media is permanent by accident.** Not "we remember to set an
 * expiry", not "a cleanup job knows the rules" — there is no row shape here
 * that describes a permanent object. `capture_media_objects` declares
 * `retention_class`, `retention_reason` and `expires_at` NOT NULL and CHECKs
 * the expiry against a hard ceiling, so a permanent raw upload cannot be
 * INSERTED, by this application or by a backfill, a script or a psql session.
 * Everything else about retention is policy and policy can be got wrong; this
 * is the part that cannot.
 *
 * ## Four tables, and why none of them is a column on another
 *
 *  - `capture_sessions`         — one contribution ACT: a walk down a street,
 *                                 or a handful of library photos sent
 *                                 together. It holds the consent version that
 *                                 was accepted, which is per-submission rather
 *                                 than per-account because consent text changes
 *                                 and "what did they agree to" must stay
 *                                 answerable afterwards.
 *  - `capture_media_objects`    — the BYTES. Separate from the asset because
 *                                 deduplication makes the relationship
 *                                 many-to-one: two contributors who upload the
 *                                 identical photo are two contributions and one
 *                                 stored object, with one lifecycle and one
 *                                 bill. Lifecycle therefore belongs here and
 *                                 not on the asset, or expiring one
 *                                 contribution would delete another's pixels.
 *  - `capture_assets`           — one contributed photo or video: its resolved
 *                                 position, its camera metadata, its processing
 *                                 state and its privacy gate.
 *  - `capture_location_evidence` — every position CLAIMED or MEASURED for an
 *                                 asset, one row each. A single pair of
 *                                 coordinate columns could not hold "the app
 *                                 said Gràcia and our own ingest read Eixample
 *                                 out of the EXIF", and that disagreement is
 *                                 exactly what #13 and #11 need to see.
 *  - `capture_storage_budgets`  — the CEILING per scope. Policy rows, so a
 *                                 budget is data an operator can set rather
 *                                 than a constant in a deploy.
 *
 * ## Privacy: this is contribution, and it is not location history
 *
 * Every coordinate in this file hangs off a SUBMITTED ASSET. There is no table
 * keyed by (user, time, position), `capture_sessions` holds no position of its
 * own — no start point, no end point, no path — and nothing here records where
 * a contributor was, only where the thing they photographed is. A session with
 * a track would be a personal travel timeline assembled as a side effect of
 * contributing, which #13 forbids in as many words, and the absence of those
 * columns is the only reliable way to not build one.
 *
 * `oxy_user_id` on a session and an asset is CONTRIBUTION AUTHORSHIP: it is
 * what makes consent, abuse handling and a deletion request possible, and it
 * is never published in a scene manifest.
 *
 * ## The privacy gate is a GENERATED column, not a convention
 *
 * `capture_assets.reconstruction_eligible` is computed by the database from the
 * privacy verdict and the asset state. Nothing can write it, so nothing can
 * mark a capture usable as a reconstruction input without the gate having
 * actually passed — and a CHECK additionally refuses to let an asset ENTER a
 * reconstruction state while the gate is shut. Privacy fails closed twice, on
 * purpose: the flag and the transition are separate mistakes.
 */

import { sql, type SQL } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, generatedId, timestamptz, updatedAt } from '@oxy.so/db';
import {
  CAPTURE_ASSET_STATES,
  CAPTURE_LOCATION_ORIGINS,
  CAPTURE_LOCATION_WITNESSES,
  CAPTURE_MEDIA_KINDS,
  CAPTURE_PRIVACY_STATES,
  CAPTURE_RETENTION_CLASSES,
  CAPTURE_SOURCES,
  DELETION_REASONS,
  RETENTION_REASONS,
} from '@goway/shared-types';
import {
  closedSet,
  foreignServiceId,
  generatedGeographyPoint,
  latitude,
  longitude,
} from './columns';
import { CAPTURE_BUDGET_SCOPES, CAPTURE_OBJECT_STORAGE_STATES } from './valueSets';

/**
 * The outer bound on how long ANY contributed object may be scheduled to live,
 * in days.
 *
 * This is not the retention policy. The policy is ~60–90 days for photos and
 * far less for raw video, it is configuration (`config/retention.ts`), and it
 * moves. This number is the BACKSTOP underneath it: a value past this point is
 * not a policy decision, it is a bug — an arithmetic slip that wrote
 * milliseconds as seconds, a "temporary" extension somebody meant to undo, a
 * migration that defaulted a column. The CHECK built from it turns every one of
 * those into a refused INSERT instead of an object nobody notices for a year.
 *
 * Generous on purpose: it has to sit clear of the longest legitimate policy
 * plus its bounded extensions, or it would start refusing correct rows and
 * somebody would raise it without thinking. 400 days is a year plus room.
 */
export const ABSOLUTE_RETENTION_CEILING_DAYS = 400;

/**
 * The most bounded extensions one object may receive.
 *
 * #10 allows a nearly-reconstructable scene to hold its inputs a little longer.
 * "A little longer, repeatedly, forever" is the failure mode that turns a
 * temporary store into an archive, so the count is capped in the schema and the
 * ceiling above caps the total regardless of how the extensions were spread.
 * No silent indefinite renewals means a countable, refusable number.
 */
export const MAX_RETENTION_EXTENSIONS = 3;

/**
 * Characters of geohash in the internal geographic bucketing key.
 *
 * 9 characters is roughly a 5 m square — fine enough that a key identifies one
 * shopfront rather than one neighbourhood, and PREFIX-TRUNCATABLE, which is
 * what lets one budget row cap a city and another cap a plaza without a second
 * table or a second column.
 */
const GEO_CELL_PRECISION = 9;

/**
 * The bucketing key, GENERATED from the anchor ordinates.
 *
 * Geohash rather than H3, and the choice is justified rather than defaulted.
 * #9 asks for a hierarchical index and names H3 first; H3 would mean a runtime
 * dependency in the API process and a second representation of a position that
 * can disagree with the ordinates. `ST_GeoHash` is already present — PostGIS is
 * a precondition of this schema — it is IMMUTABLE so it can be GENERATED, and
 * being generated it cannot drift from the coordinates the way an
 * application-computed cell silently does the first time a position is
 * corrected by a path that forgot to recompute it.
 *
 * It is also deliberately NOT published. #9's real requirement is that captures
 * be findable near each other; this key serves bucketing, budgets and coarse
 * grouping, while the actual neighbour search is `ST_DWithin` against the gist
 * index below — which does not care about cell boundaries at all, and so cannot
 * make one into a false scene boundary. #11 may replace this with H3 for
 * scheduling without touching a single public contract.
 *
 * The ordinate order is `ST_MakePoint(longitude, latitude)`, which is the
 * opposite of every `lat, lng` the HTTP layer receives — see
 * `generatedGeographyPoint`, whose comment this shares a trap with.
 *
 * One side effect worth knowing: `ST_GeoHash` RAISES on an out-of-range
 * ordinate, and a generated expression is evaluated before the table's CHECKs.
 * So an insert with a latitude of 120 is refused with PostGIS's message rather
 * than with `capture_assets_latitude_range_check`. The row is refused either
 * way; the CHECK remains because it is what protects a future schema that stops
 * generating this column, and `captureSchema.realdb.test.ts` asserts both.
 */
const generatedGeoCell = (longitudeColumn: string, latitudeColumn: string) =>
  text().generatedAlwaysAs(() =>
    sql.raw(
      `ST_GeoHash(ST_SetSRID(ST_MakePoint(${longitudeColumn}, ${latitudeColumn}), 4326), ${GEO_CELL_PRECISION})`,
    ),
  );

/**
 * One contribution act.
 *
 * A session is what the contributor watches: it gives a batch of photos one
 * status, one cancellation and one place to have been told the retention policy
 * before submitting. It is NOT a track — see this module's privacy note. There
 * is no position on this table and there must never be one.
 *
 * `consent_version` is NOT NULL because a contribution whose consent is unknown
 * is a contribution GoWay cannot honestly keep. Recording it per session rather
 * than per account is what keeps it answerable after the text changes.
 */
export const captureSessions = pgTable(
  'capture_sessions',
  {
    id: generatedId(),
    /**
     * The contributor. An Oxy user id: Oxy owns identity, so no foreign key and
     * no `users` table.
     *
     * Contributing requires an account precisely so consent, deletion requests,
     * abuse controls and attribution are possible — which is the opposite of
     * anonymous collection, and is why this column is NOT NULL here while it is
     * absent from every public capture shape.
     */
    oxyUserId: foreignServiceId().notNull(),
    source: text().notNull(),
    /** The consent text version accepted for this contribution. */
    consentVersion: text().notNull(),
    /** Optional contributor note — what they were trying to capture. */
    note: text(),
    startedAt: timestamptz().notNull().defaultNow(),
    /** When the contributor finished. Null while the session is open. */
    endedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('capture_sessions_source_check', table.source, CAPTURE_SOURCES),
    check('capture_sessions_consent_version_check', sql`btrim(${table.consentVersion}) <> ''`),
    check(
      'capture_sessions_ended_at_check',
      sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`,
    ),
    /**
     * The contributor's own history read, and the only per-user index in this
     * schema. It is a list of CONTRIBUTION OBJECTS, which #13 explicitly
     * allows; it is not a trace, because there is nothing positional on this
     * table for it to order.
     */
    index('capture_sessions_contributor_idx').on(table.oxyUserId, table.startedAt),
  ],
);

/**
 * The stored bytes.
 *
 * ## Why this is not columns on `capture_assets`
 *
 * Deduplication. Two contributors sending byte-identical media are two
 * contributions and ONE object: one upload, one bill, one lifecycle. Putting
 * `expires_at` on the asset would mean the first contribution's expiry deleting
 * the second contributor's pixels, or two rows disagreeing about when the same
 * object dies. The partial unique index below is the whole of exact-duplicate
 * handling, and it only makes sense on a table that is about bytes.
 *
 * ## What deduplication here does NOT claim to do
 *
 * This detects EXACT duplicates — the same file, re-sent. It does nothing about
 * near-duplicates, and that is deliberate rather than unfinished: two photos of
 * the same shopfront a step apart look almost identical to a perceptual hash
 * and are worth far MORE to a reconstruction than either alone, because the
 * baseline between them is what produces depth. Discarding one on visual
 * similarity would delete the signal. A near-duplicate decision has to weigh
 * viewpoint, position, time and quality together, it belongs with the capture
 * graph in #11 where those are known, and there is no column here pretending
 * otherwise.
 *
 * ## Why a row exists before the bytes do
 *
 * `storage_state = 'expected'` is written when the upload target is issued. An
 * object in the store with no row is then a detectable leak, and a row stuck in
 * `expected` past `upload_intent_expires_at` is a detectable abandoned upload.
 * Without the record, reconciling the store means listing the whole bucket and
 * guessing.
 */
export const captureMediaObjects = pgTable(
  'capture_media_objects',
  {
    id: generatedId(),
    /**
     * Lower-case hex SHA-256 of the exact bytes — the deduplication key, and
     * the integrity check the finalize step verifies the store's own checksum
     * against.
     */
    contentHash: text().notNull(),
    /**
     * Where the bytes live, generated by the SERVER and never by a client.
     *
     * A client-chosen key is a path traversal, a collision with another
     * contributor's object, or a write outside the prefix the lifecycle
     * backstop is configured on — all three silently. Unique below, so one path
     * is one row: two rows claiming the same object would each believe they own
     * its deletion.
     */
    objectKey: text().notNull(),
    contentType: text().notNull(),
    /**
     * Declared at intent, in bytes. `bigint` and not `integer`: a 4K video
     * passes 2 GB and an overflowed size is a budget that silently stops
     * counting.
     */
    byteSize: bigint({ mode: 'number' }).notNull(),
    /** What the store actually reported once the bytes landed. Null until then. */
    confirmedByteSize: bigint({ mode: 'number' }),

    storageState: text().notNull().default('expected'),
    /** When the upload target stops being accepted by the store. */
    uploadIntentExpiresAt: timestamptz().notNull(),
    /** When the bytes were confirmed present. Null while merely expected. */
    storedAt: timestamptz(),

    /** What KIND of artifact this is — see the class tuple in `@goway/shared-types`. */
    retentionClass: text().notNull(),
    /** What is still USING it. An object whose reason no longer holds is garbage. */
    retentionReason: text().notNull(),
    /**
     * When the bytes die. NOT NULL, bounded by a CHECK, and a MAXIMUM rather
     * than a plan: moderation, a contributor's deletion or a successful
     * derivation all remove an object earlier.
     */
    expiresAt: timestamptz().notNull(),
    /**
     * The earliest the sweeper MAY delete, when that is before expiry. A raw
     * video becomes eligible as soon as its keyframes are safely stored, which
     * is normally weeks before its window runs out — and that early deletion is
     * most of #10's cost saving.
     */
    deletionEligibleAt: timestamptz(),
    /** A floor under a bounded extension: the sweeper must not delete before it. */
    protectedUntil: timestamptz(),
    retentionExtensionCount: integer().notNull().default(0),

    /** Tombstone. Set together with `deletion_reason`, enforced below. */
    deletedAt: timestamptz(),
    deletionReason: text(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('capture_objects_storage_state_check', table.storageState, CAPTURE_OBJECT_STORAGE_STATES),
    /**
     * The class set is the CAPTURE subset, not the whole retention vocabulary.
     * A `published_splat` in this table would be a published scene inheriting a
     * raw upload's expiry — the precise confusion #10 spends a section warning
     * about — so it is not merely unlikely here, it is unrepresentable.
     */
    closedSet('capture_objects_retention_class_check', table.retentionClass, CAPTURE_RETENTION_CLASSES),
    closedSet('capture_objects_retention_reason_check', table.retentionReason, RETENTION_REASONS),
    closedSet('capture_objects_deletion_reason_check', table.deletionReason, DELETION_REASONS),

    check('capture_objects_content_hash_check', sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`),
    check('capture_objects_object_key_check', sql`btrim(${table.objectKey}) <> ''`),
    check('capture_objects_byte_size_check', sql`${table.byteSize} > 0`),
    check(
      'capture_objects_confirmed_byte_size_check',
      sql`${table.confirmedByteSize} is null or ${table.confirmedByteSize} > 0`,
    ),

    /**
     * ── The ceiling ───────────────────────────────────────────────────────
     *
     * Together with `expires_at`, `retention_class` and `retention_reason`
     * being NOT NULL, these two are "no raw media is permanent by accident" as
     * a property of the table rather than of the code above it. An expiry in
     * the past of its own creation is an arithmetic slip; an expiry past the
     * backstop is a bug wearing a policy's clothes. Neither can be stored.
     */
    check('capture_objects_expiry_after_creation_check', sql`${table.expiresAt} > ${table.createdAt}`),
    check(
      'capture_objects_expiry_ceiling_check',
      // The columns are interpolated as drizzle Columns so their SQL names come
      // from the casing authority; only the INTERVAL LITERAL is raw, because a
      // bound parameter cannot appear in a CHECK — see `closedSet` in
      // `columns.ts` and `bun run check:migrations`, which gates exactly this.
      sql`${table.expiresAt} <= ${table.createdAt} + ${sql.raw(`interval '${ABSOLUTE_RETENTION_CEILING_DAYS} days'`)}`,
    ),
    check(
      'capture_objects_deletion_eligible_check',
      sql`${table.deletionEligibleAt} is null or ${table.deletionEligibleAt} <= ${table.expiresAt}`,
    ),
    /**
     * Protection cannot outlive the expiry it is protecting against. A
     * `protected_until` past `expires_at` would be a second, invisible expiry
     * that wins — exactly the silent indefinite renewal #10 refuses.
     */
    check(
      'capture_objects_protected_until_check',
      sql`${table.protectedUntil} is null or ${table.protectedUntil} <= ${table.expiresAt}`,
    ),
    check(
      'capture_objects_extension_count_check',
      sql`${table.retentionExtensionCount} between 0 and ${sql.raw(String(MAX_RETENTION_EXTENSIONS))}`,
    ),

    /** A tombstone says WHEN and WHY, or it is not a tombstone. */
    check(
      'capture_objects_tombstone_check',
      sql`(${table.deletedAt} is null) = (${table.deletionReason} is null)`,
    ),
    check(
      'capture_objects_deleted_state_check',
      sql`(${table.storageState} = 'deleted') = (${table.deletedAt} is not null)`,
    ),
    /** Bytes that are present must know when they arrived; bytes merely expected must not claim to. */
    check(
      'capture_objects_stored_at_present_check',
      sql`${table.storageState} not in ('stored', 'deleting') or ${table.storedAt} is not null`,
    ),
    check(
      'capture_objects_stored_at_absent_check',
      sql`${table.storageState} <> 'expected' or ${table.storedAt} is null`,
    ),

    /** One path, one row. Two rows for one object would each own its deletion. */
    unique('capture_objects_object_key_key').on(table.objectKey),
    /**
     * ── Deduplication ─────────────────────────────────────────────────────
     *
     * One LIVE object per content hash. The same photo contributed twice is one
     * stored object and two assets pointing at it.
     *
     * PARTIAL, on `deleted_at is null`, and that is the load-bearing part: once
     * an object has expired and been deleted, the identical bytes arriving
     * again are a NEW contribution that deserves its own lifecycle, and a total
     * unique constraint would refuse it forever on the strength of a tombstone.
     * A partial unique INDEX rather than a `unique()` CONSTRAINT because
     * Postgres has no partial unique constraint; nothing references this, so
     * the usual "a foreign key cannot target an index" rule does not apply —
     * `capture_assets` targets the primary key.
     */
    uniqueIndex('capture_objects_live_content_hash_key')
      .on(table.contentHash)
      .where(sql`${table.deletedAt} is null`),

    /**
     * The sweeper's index: live objects in expiry order. Partial, because a
     * tombstone is never a candidate and there will eventually be far more
     * tombstones than live objects.
     */
    index('capture_objects_expiry_idx')
      .on(table.expiresAt)
      .where(sql`${table.deletedAt} is null`),
    /** Orphan detection: expected objects whose upload window has run out. */
    index('capture_objects_orphan_idx')
      .on(table.uploadIntentExpiresAt)
      .where(sql`${table.storageState} = 'expected'`),
    index('capture_objects_storage_state_idx').on(table.storageState),
    index('capture_objects_retention_class_idx').on(table.retentionClass),
  ],
);

/**
 * One contributed photo or video.
 *
 * The asset is the CONTRIBUTION — who submitted it, where the thing they
 * photographed is, what the camera was doing, how far through processing it is
 * and whether the privacy gate has opened. The bytes are
 * `capture_media_objects`, which it may share with somebody else's identical
 * contribution.
 *
 * ## The anchor is resolved, and its provenance travels with it
 *
 * `anchor_latitude`/`anchor_longitude` are the position GoWay actually uses,
 * and `anchor_origin`/`anchor_witness` say where it came from and who observed
 * it. They are DERIVED from `capture_location_evidence` by
 * `capture/anchor.ts`, never taken from a request: a client can send any
 * coordinate it likes, and the difference between "the app told us" and "our
 * own ingest read it out of the file" is the difference between a claim and a
 * measurement. Both are kept; this pair records which one won.
 *
 * The PostGIS point beside them is GENERATED from the two ordinates and never
 * written, so a capture's position has exactly one source of truth.
 */
export const captureAssets = pgTable(
  'capture_assets',
  {
    id: generatedId(),
    sessionId: text()
      .notNull()
      .references(() => captureSessions.id, { onDelete: 'cascade' }),
    /**
     * The bytes.
     *
     * `restrict` and emphatically not `cascade`: an object row is a TOMBSTONE
     * after its bytes are deleted, and the assets that referenced it must
     * survive it — a published scene's provenance, a contributor's history and
     * a rebuild's blocklist all outlive the pixels. Deleting the row out from
     * under them is refused.
     */
    mediaObjectId: text()
      .notNull()
      .references(() => captureMediaObjects.id, { onDelete: 'restrict' }),
    /**
     * The contributor, denormalized from the session.
     *
     * Authorship, not a location trace. It is here as well as on the session
     * because every authorization check and every deletion request is per
     * ASSET, and a join to decide whether a caller may read their own
     * contribution is a join that eventually gets forgotten. An Oxy user id:
     * no foreign key, and never published in a scene manifest.
     */
    oxyUserId: foreignServiceId().notNull(),

    mediaKind: text().notNull(),
    source: text().notNull(),
    state: text().notNull().default('expected'),
    /** When the media was captured, where that is known. Not when it was uploaded. */
    capturedAt: timestamptz(),

    anchorLatitude: latitude().notNull(),
    anchorLongitude: longitude().notNull(),
    /** GENERATED from the two ordinates above; never written. See `columns.ts`. */
    anchorGeo: generatedGeographyPoint('anchor_longitude', 'anchor_latitude'),
    /** The internal bucketing key, GENERATED. Not published — see `generatedGeoCell`. */
    geoCell: generatedGeoCell('anchor_longitude', 'anchor_latitude'),
    anchorOrigin: text().notNull(),
    anchorWitness: text().notNull(),
    anchorAccuracyMeters: doublePrecision(),

    /** The gate. `pending` by default, and `pending` is shut. */
    privacyState: text().notNull().default('pending'),
    /** Which pipeline produced the verdict. Required for a pass, enforced below. */
    privacyPipelineVersion: text(),
    privacyCompletedAt: timestamptz(),
    /**
     * Whether this capture may be used as a reconstruction input — GENERATED,
     * so nothing can write it.
     *
     * This is the privacy gate as a column. A worker selecting training inputs
     * filters on this one boolean instead of re-deriving a rule that will get
     * stricter, and no code path — not a migration, not a backfill, not a
     * well-meaning repair script — can set it true on a capture whose pixels
     * nobody has looked at. `privacy_state` alone would not be enough: a
     * `passed` verdict with no pipeline version recorded is a clearance nobody
     * can audit or rebuild from, so it does not count as one.
     */
    reconstructionEligible: boolean()
      .notNull()
      .generatedAlwaysAs(
        (): SQL =>
          sql.raw(
            "privacy_state = 'passed' and privacy_pipeline_version is not null " +
              "and state in ('accepted', 'waiting_for_overlap', 'reconstruction_candidate', 'integrated')",
          ),
      ),

    /**
     * Camera metadata — flattened into columns rather than a jsonb blob because
     * every one of these is read by a camera solve individually, and because a
     * blob is where a device serial number ends up without anybody deciding to
     * store one. The set of columns IS the minimization policy: there is no
     * place here to put a field that does not help reconstruction.
     */
    cameraWidthPixels: integer(),
    cameraHeightPixels: integer(),
    /** EXIF orientation tag, 1–8. Normalized on ingest; consumers do not reapply it. */
    exifOrientation: integer(),
    focalLengthMm: doublePrecision(),
    /** 35 mm equivalent focal length — the comparable number across sensor sizes. */
    focalLengthEquivalentMm: doublePrecision(),
    cameraMake: text(),
    cameraModel: text(),
    cameraLens: text(),
    /** Video only, enforced below. */
    durationSeconds: doublePrecision(),
    frameRate: doublePrecision(),

    /**
     * Sharpness/exposure quality in [0, 1], once something has measured it.
     *
     * A low score is NOT a deletion trigger — a soft photo still anchors
     * context and may be the only view of a façade — it is a RANKING input, so
     * that a reconstruction spends its budget on the best available views
     * first. Null means unmeasured, which is not the same as bad.
     */
    qualityScore: doublePrecision(),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('capture_assets_media_kind_check', table.mediaKind, CAPTURE_MEDIA_KINDS),
    closedSet('capture_assets_source_check', table.source, CAPTURE_SOURCES),
    closedSet('capture_assets_state_check', table.state, CAPTURE_ASSET_STATES),
    closedSet('capture_assets_anchor_origin_check', table.anchorOrigin, CAPTURE_LOCATION_ORIGINS),
    closedSet('capture_assets_anchor_witness_check', table.anchorWitness, CAPTURE_LOCATION_WITNESSES),
    closedSet('capture_assets_privacy_state_check', table.privacyState, CAPTURE_PRIVACY_STATES),

    /**
     * The ordinates are bounded HERE as well as in the HTTP layer, for the same
     * reason `places` bounds its own: a latitude of 120 that arrives through a
     * backfill or an importer is a point PostGIS normalizes into somewhere else
     * on Earth, and every query still returns rows.
     */
    check('capture_assets_latitude_range_check', sql`${table.anchorLatitude} between -90 and 90`),
    check('capture_assets_longitude_range_check', sql`${table.anchorLongitude} between -180 and 180`),
    check(
      'capture_assets_accuracy_check',
      sql`${table.anchorAccuracyMeters} is null or ${table.anchorAccuracyMeters} >= 0`,
    ),
    /**
     * GoWay's own ingest cannot witness a map tap. `user_placed` is a human
     * decision made in the app, so a row claiming `goway_ingest` produced one
     * is laundering a client's coordinate into a measurement.
     */
    check(
      'capture_assets_user_placed_witness_check',
      sql`${table.anchorOrigin} <> 'user_placed' or ${table.anchorWitness} = 'client'`,
    ),

    /**
     * ── The privacy gate, enforced on the TRANSITION ──────────────────────
     *
     * `reconstruction_eligible` is generated and cannot be forged, but a state
     * machine could still walk an asset into `reconstruction_candidate` with
     * the gate shut and then ask a worker to look at it. This refuses that
     * write. Privacy fails closed in both directions: the flag cannot be set
     * without a pass, and the state cannot be entered without one.
     */
    check(
      'capture_assets_privacy_gate_check',
      sql`${table.state} not in ('reconstruction_candidate', 'integrated') or ${table.privacyState} = 'passed'`,
    ),
    /**
     * A clearance that does not name the pipeline that produced it is not a
     * clearance: it cannot be audited, and it cannot be re-run when detection
     * improves — which is exactly what #13 keeps the version for.
     */
    check(
      'capture_assets_privacy_version_check',
      sql`${table.privacyState} <> 'passed' or ${table.privacyPipelineVersion} is not null`,
    ),
    check(
      'capture_assets_privacy_completed_check',
      sql`(${table.privacyState} in ('passed', 'failed', 'blocked')) = (${table.privacyCompletedAt} is not null)`,
    ),

    check(
      'capture_assets_exif_orientation_check',
      sql`${table.exifOrientation} is null or ${table.exifOrientation} between 1 and 8`,
    ),
    check(
      'capture_assets_pixels_check',
      sql`(${table.cameraWidthPixels} is null or ${table.cameraWidthPixels} > 0)
          and (${table.cameraHeightPixels} is null or ${table.cameraHeightPixels} > 0)`,
    ),
    check(
      'capture_assets_focal_length_check',
      sql`(${table.focalLengthMm} is null or ${table.focalLengthMm} > 0)
          and (${table.focalLengthEquivalentMm} is null or ${table.focalLengthEquivalentMm} > 0)`,
    ),
    /** A photo has no duration and no frame rate. A row that claims otherwise is confused about what it holds. */
    check(
      'capture_assets_video_fields_check',
      sql`${table.mediaKind} = 'video' or (${table.durationSeconds} is null and ${table.frameRate} is null)`,
    ),
    check(
      'capture_assets_duration_check',
      sql`(${table.durationSeconds} is null or ${table.durationSeconds} > 0)
          and (${table.frameRate} is null or ${table.frameRate} > 0)`,
    ),
    check(
      'capture_assets_quality_score_check',
      sql`${table.qualityScore} is null or ${table.qualityScore} between 0 and 1`,
    ),

    /**
     * The index every spatial read depends on. `ST_DWithin` against this is
     * index-backed; `ST_Distance(...) < r` in a WHERE clause is not, and
     * degrades to a scan of every capture on Earth.
     *
     * This — not the geohash — is how #11 finds neighbouring imagery, which is
     * why a cell boundary can never become a false scene boundary.
     */
    index('capture_assets_geo_gist').using('gist', table.anchorGeo),
    /** Bucketing and budgets. `text_pattern_ops` so a prefix match on a coarser cell is index-backed. */
    index('capture_assets_geo_cell_idx').on(table.geoCell.op('text_pattern_ops')),
    index('capture_assets_session_idx').on(table.sessionId),
    index('capture_assets_media_object_idx').on(table.mediaObjectId),
    index('capture_assets_contributor_idx').on(table.oxyUserId, table.createdAt),
    index('capture_assets_state_idx').on(table.state),
    /** What the privacy worker claims work from: everything the gate is still shut on. */
    index('capture_assets_privacy_pending_idx')
      .on(table.privacyState)
      .where(sql`${table.privacyState} in ('pending', 'in_progress', 'failed')`),
  ],
);

/**
 * Every position claimed or measured for a capture.
 *
 * One row per `(origin, witness)` pair, and the uniqueness key includes the
 * WITNESS for the same reason `places_capabilities` includes the verification
 * tier: "the app said the EXIF reads 41.3851" and "our ingest read 41.3902 out
 * of the file" are different assertions with different weight, and collapsing
 * them means whichever arrives second silently erases the other. Both coexist;
 * `capture_assets` records which one the anchor came from, and a later privacy
 * or georeferencing pass can see that they disagreed.
 *
 * There is no `geography` column here on purpose. These rows are read by asset
 * id and never searched spatially — the anchor is the one searchable position —
 * and a second indexed point would be an invitation to run a neighbour query
 * against a coordinate GoWay decided not to trust.
 *
 * This table is not a location history. Its rows are reachable only through an
 * asset the contributor deliberately submitted, they carry no user column at
 * all, and there is no index by which they could be walked in time order for a
 * person.
 */
export const captureLocationEvidence = pgTable(
  'capture_location_evidence',
  {
    id: generatedId(),
    assetId: text()
      .notNull()
      .references(() => captureAssets.id, { onDelete: 'cascade' }),
    origin: text().notNull(),
    witness: text().notNull(),
    latitude: latitude().notNull(),
    longitude: longitude().notNull(),
    /** Horizontal accuracy in metres as the platform reported it — a radius, not an error bar. */
    accuracyMeters: doublePrecision(),
    altitudeMeters: doublePrecision(),
    /** Compass heading, degrees clockwise from true north, `[0, 360)`. */
    headingDegrees: doublePrecision(),
    /** When this position was OBSERVED, which is not when the row was written. */
    observedAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('capture_evidence_origin_check', table.origin, CAPTURE_LOCATION_ORIGINS),
    closedSet('capture_evidence_witness_check', table.witness, CAPTURE_LOCATION_WITNESSES),
    check('capture_evidence_latitude_range_check', sql`${table.latitude} between -90 and 90`),
    check('capture_evidence_longitude_range_check', sql`${table.longitude} between -180 and 180`),
    check(
      'capture_evidence_accuracy_check',
      sql`${table.accuracyMeters} is null or ${table.accuracyMeters} >= 0`,
    ),
    check(
      'capture_evidence_heading_check',
      sql`${table.headingDegrees} is null or (${table.headingDegrees} >= 0 and ${table.headingDegrees} < 360)`,
    ),
    /** As on the asset: GoWay's own ingest cannot have witnessed a map tap. */
    check(
      'capture_evidence_user_placed_witness_check',
      sql`${table.origin} <> 'user_placed' or ${table.witness} = 'client'`,
    ),
    /** Explicitly named: the derived name would exceed Postgres's 63-byte identifier limit. */
    unique('capture_evidence_assertion_key').on(table.assetId, table.origin, table.witness),
    index('capture_evidence_asset_idx').on(table.assetId),
  ],
);

/**
 * A storage ceiling.
 *
 * Rows rather than constants, because #10's cost guardrails are an operational
 * dial: a tourist plaza that is accumulating raw bytes faster than it is
 * producing coverage needs its ceiling lowered today, not in the next deploy.
 *
 * This table holds the POLICY. Usage is not stored beside it and is computed
 * from `capture_media_objects` instead — a maintained counter is a number that
 * drifts from the rows it summarizes the first time a delete takes a path that
 * forgot to decrement it, and a budget enforced against a drifted counter is
 * worse than none, because it is confidently wrong in whichever direction the
 * bug went.
 *
 * Phase A models and reports; it does not refuse an upload. Enforcement lands
 * with #10's sweeper, where "which objects would have to go" is answerable —
 * refusing a contribution is only defensible when GoWay can say what it would
 * delete instead.
 */
export const captureStorageBudgets = pgTable(
  'capture_storage_budgets',
  {
    id: generatedId(),
    scope: text().notNull(),
    /**
     * What the scope names: an Oxy user id, a geohash prefix, or `''` for the
     * global budget. A PREFIX for `geo_cell`, so the length of the key is the
     * granularity — three characters caps a region, nine cap a doorway.
     */
    scopeKey: text().notNull(),
    /** Null means "every class together", which is the useful shape for a global cap. */
    retentionClass: text(),
    byteCeiling: bigint({ mode: 'number' }).notNull(),
    /** Why this ceiling exists, for whoever finds it in six months. */
    note: text(),
    effectiveFrom: timestamptz().notNull().defaultNow(),
    effectiveUntil: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    closedSet('capture_budgets_scope_check', table.scope, CAPTURE_BUDGET_SCOPES),
    closedSet('capture_budgets_retention_class_check', table.retentionClass, CAPTURE_RETENTION_CLASSES),
    check('capture_budgets_byte_ceiling_check', sql`${table.byteCeiling} > 0`),
    /** The global budget names nothing; every other scope must name something. */
    check(
      'capture_budgets_scope_key_check',
      sql`(${table.scope} = 'global') = (${table.scopeKey} = '')`,
    ),
    check(
      'capture_budgets_effective_window_check',
      sql`${table.effectiveUntil} is null or ${table.effectiveUntil} > ${table.effectiveFrom}`,
    ),
    /**
     * `nullsNotDistinct` because a null `retention_class` MEANS "all classes" —
     * a real value, not a missing one. Under Postgres's default, two global
     * all-class budgets would both be insertable and the pair would silently
     * disagree about the ceiling.
     */
    unique('capture_budgets_scope_key')
      .on(table.scope, table.scopeKey, table.retentionClass)
      .nullsNotDistinct(),
  ],
);

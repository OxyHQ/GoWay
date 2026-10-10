/**
 * Scene formation and the reconstruction job's database half.
 *
 * ## What may enter a manifest — enforced in ONE query
 *
 * {@link loadEligibleFrames} is the only place a reconstruction input is
 * selected, and every exclusion lives in its WHERE clause rather than in the
 * code that consumes it:
 *
 *   - the capture's GENERATED `reconstruction_eligible` is true (privacy
 *     `passed` with a named pipeline, in a reconstruction state);
 *   - no moderation block exists for the capture OR for its content hash;
 *   - the derivative is stored, has no removal request, and does not expire
 *     within the job window — a frame that could vanish mid-job is not offered.
 *
 * A blocked, withdrawn, expired or deleted capture therefore cannot reach a
 * manifest through any path in this codebase, and `street3d.realdb.test.ts`
 * asserts it against real rows.
 *
 * ## Clustering is by distance, never by cell
 *
 * Captures join the nearest scene whose anchor is within its radius
 * (`ST_DWithin` on the GiST-indexed points). Captures with no scene and at
 * least one eligible neighbour seed a new one. A geohash boundary is never a
 * scene boundary.
 */

import { and, desc, eq, inArray, isNotNull, sql, type Column } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { qualified, uuidv7 } from '@oxy.so/db';
import type { StreetSceneProfile } from '@goway/contracts';
import { street3dConfig } from '../../config/street3d';
import type { SceneReconstructJob } from '../../street3d/workerContract';
import { WORKER_CONTRACT_SCHEMA_VERSION } from '../../street3d/workerContract';
import type { Database, Transaction } from '../postgres';
import {
  captureAssets,
  captureDerivatives,
  captureLocationEvidence,
  captureMediaObjects,
  captureSessions,
  street3dCaptureBlocks,
  street3dJobs,
  street3dScenes,
} from '../schema';
import { cancelOpenJobs, progressSceneState, refreshInputProtection, type JobRow } from './jobs';

/** One reconstruction-eligible frame, with everything a manifest and the scheduler need. */
export interface EligibleFrame {
  derivativeId: string;
  assetId: string;
  sessionId: string;
  frameIndex: number;
  imageKey: string;
  imageSha256: string;
  maskKey: string | null;
  maskSha256: string | null;
  width: number;
  height: number;
  privacyPipelineVersion: string;
  expiresAt: Date;
  capturedAt: Date | null;
  privacyCompletedAt: Date | null;
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
  altitudeMeters: number | null;
  headingDegrees: number | null;
  focalLength35mm: number | null;
  /** Set for a view cut from a 360° capture; see `capture_derivatives.panorama_*`. */
  panoramaIndex: number | null;
  panoramaYawDegrees: number | null;
  panoramaFovDegrees: number | null;
  geoCell: string;
  assetState: string;
}

/** Best evidence first: GoWay's own measurement, then the device, then metadata. */
const evidenceOrder = sql`
  case ${qualified(captureLocationEvidence.origin)} when 'device_capture' then 0 when 'media_metadata' then 1 else 2 end,
  case ${qualified(captureLocationEvidence.witness)} when 'goway_ingest' then 0 else 1 end`;

const evidenceValue = (column: Column) =>
  sql<number | null>`(
    select ${qualified(column)} from ${captureLocationEvidence}
    where ${qualified(captureLocationEvidence.assetId)} = ${qualified(captureAssets.id)} and ${qualified(column)} is not null
    order by ${evidenceOrder}
    limit 1
  )`;

/**
 * Every reconstruction-eligible frame. See this module's header for why every
 * exclusion is here.
 */
export async function loadEligibleFrames(
  db: Database | Transaction,
  now: Date,
): Promise<EligibleFrame[]> {
  const horizon = new Date(now.getTime() + street3dConfig.jobWindowHours * 3600_000);
  return db
    .select({
      derivativeId: captureDerivatives.id,
      assetId: captureAssets.id,
      sessionId: captureAssets.sessionId,
      frameIndex: captureDerivatives.frameIndex,
      imageKey: captureDerivatives.objectKey,
      imageSha256: captureDerivatives.imageSha256,
      maskKey: captureDerivatives.maskKey,
      maskSha256: captureDerivatives.maskSha256,
      width: captureDerivatives.width,
      height: captureDerivatives.height,
      privacyPipelineVersion: captureDerivatives.privacyPipelineVersion,
      expiresAt: captureDerivatives.expiresAt,
      capturedAt: captureAssets.capturedAt,
      privacyCompletedAt: captureAssets.privacyCompletedAt,
      latitude: captureAssets.anchorLatitude,
      longitude: captureAssets.anchorLongitude,
      accuracyMeters: captureAssets.anchorAccuracyMeters,
      altitudeMeters: evidenceValue(captureLocationEvidence.altitudeMeters),
      headingDegrees: evidenceValue(captureLocationEvidence.headingDegrees),
      focalLength35mm: captureAssets.focalLengthEquivalentMm,
      panoramaIndex: captureDerivatives.panoramaIndex,
      panoramaYawDegrees: captureDerivatives.panoramaYawDegrees,
      panoramaFovDegrees: captureDerivatives.panoramaFovDegrees,
      geoCell: sql<string>`${captureAssets.geoCell}`,
      assetState: captureAssets.state,
    })
    .from(captureDerivatives)
    .innerJoin(captureAssets, eq(captureAssets.id, captureDerivatives.assetId))
    .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
    .where(
      and(
        eq(captureAssets.reconstructionEligible, true),
        eq(captureAssets.privacyState, 'passed'),
        eq(captureDerivatives.storageState, 'stored'),
        sql`${captureDerivatives.deletionRequestedAt} is null`,
        sql`${captureDerivatives.expiresAt} > ${horizon.toISOString()}::timestamptz`,
        sql`not exists (
          select 1 from ${street3dCaptureBlocks}
          where ${qualified(street3dCaptureBlocks.captureAssetId)} = ${qualified(captureAssets.id)}
             or ${qualified(street3dCaptureBlocks.contentHash)} = ${qualified(captureMediaObjects.contentHash)}
        )`,
      ),
    )
    .orderBy(captureAssets.id, captureDerivatives.frameIndex);
}

/** Nearest scene (any state) within its radius, per capture. Disabled scenes absorb but never build. */
export async function nearestScenes(
  db: Database,
  assetIds: readonly string[],
): Promise<Map<string, string>> {
  if (assetIds.length === 0) return new Map();
  // Every reference in the correlated subquery is QUALIFIED: drizzle renders a
  // bare column when its table is not in the statement's FROM, and both tables
  // here have an `anchor_geo` — unqualified, the predicate would compare the
  // scene's anchor with itself and match every scene on Earth.
  const rows = await db
    .select({
      assetId: captureAssets.id,
      sceneId: sql<string | null>`(
        select ${qualified(street3dScenes.id)} from ${street3dScenes}
        where ST_DWithin(${qualified(street3dScenes.anchorGeo)}, ${qualified(captureAssets.anchorGeo)}, ${qualified(street3dScenes.radiusMeters)})
        order by ${qualified(street3dScenes.anchorGeo)} <-> ${qualified(captureAssets.anchorGeo)}
        limit 1
      )`,
    })
    .from(captureAssets)
    .where(inArray(captureAssets.id, [...assetIds]));
  return new Map(rows.flatMap((row) => (row.sceneId ? [[row.assetId, row.sceneId] as const] : [])));
}

/** Pairs of the given captures within `radiusMeters` of each other, index-backed. */
export async function neighbourPairs(
  db: Database,
  assetIds: readonly string[],
  radiusMeters: number,
): Promise<[string, string][]> {
  if (assetIds.length < 2) return [];
  const a = alias(captureAssets, 'a');
  const b = alias(captureAssets, 'b');
  const rows = await db
    .select({ a: a.id, b: b.id })
    .from(a)
    .innerJoin(
      b,
      and(
        sql`${qualified(a.id)} < ${qualified(b.id)}`,
        sql`ST_DWithin(${qualified(a.anchorGeo)}, ${qualified(b.anchorGeo)}, ${radiusMeters})`,
      ),
    )
    .where(and(inArray(a.id, [...assetIds]), inArray(b.id, [...assetIds])));
  return rows.map((row) => [row.a, row.b]);
}

/** Create a candidate scene around a cluster's centroid. */
export async function createScene(
  db: Database,
  anchor: { latitude: number; longitude: number },
  now: Date,
): Promise<string> {
  const [row] = await db
    .insert(street3dScenes)
    .values({
      anchorLatitude: anchor.latitude,
      anchorLongitude: anchor.longitude,
      radiusMeters: street3dConfig.clusterRadiusMeters,
      state: 'candidate',
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: street3dScenes.id });
  if (!row) throw new Error('The scene was not created.');
  return row.id;
}

export type SceneRow = typeof street3dScenes.$inferSelect;

export async function loadScenes(db: Database, ids: readonly string[]): Promise<SceneRow[]> {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(street3dScenes)
    .where(inArray(street3dScenes.id, [...ids]));
}

/** The open job per scene, if any. */
export async function openSceneJobs(
  db: Database,
  sceneIds: readonly string[],
): Promise<Map<string, JobRow>> {
  if (sceneIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(street3dJobs)
    .where(
      and(
        inArray(street3dJobs.sceneId, [...sceneIds]),
        sql`${street3dJobs.state} not in ('completed', 'failed', 'cancelled')`,
      ),
    );
  return new Map(rows.map((row) => [row.sceneId as string, row]));
}

/** The most recently CREATED reconstruction job per scene, open or not. */
export async function lastSceneJob(db: Database, sceneId: string): Promise<JobRow | null> {
  const [row] = await db
    .select()
    .from(street3dJobs)
    .where(and(eq(street3dJobs.sceneId, sceneId), isNotNull(street3dJobs.sceneVersion)))
    .orderBy(desc(street3dJobs.sceneVersion))
    .limit(1);
  return row ?? null;
}

/** Record the per-tick counters a coverage and status report read. */
export async function updateSceneCounters(
  db: Database,
  sceneId: string,
  frames: number,
  sectors: number,
  now: Date,
): Promise<void> {
  await db
    .update(street3dScenes)
    .set({ eligibleFrames: frames, headingSectors: sectors, updatedAt: now })
    .where(eq(street3dScenes.id, sceneId));
}

/** Session attributions for a set of captures, distinct and sorted. */
export async function attributionsFor(
  db: Database | Transaction,
  assetIds: readonly string[],
): Promise<string[]> {
  if (assetIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ attribution: captureSessions.attribution })
    .from(captureAssets)
    .innerJoin(captureSessions, eq(captureSessions.id, captureAssets.sessionId))
    .where(and(inArray(captureAssets.id, [...assetIds]), isNotNull(captureSessions.attribution)));
  return rows.map((row) => row.attribution as string).sort();
}

export interface CreateSceneJobInput {
  scene: SceneRow;
  jobId: string;
  version: number;
  profile: StreetSceneProfile;
  frames: readonly EligibleFrame[];
  fingerprint: string;
  manifestKey: string;
  manifestSha256: string;
  /** Open job to cancel as superseded in the same transaction. */
  supersede?: JobRow;
}

/** A fresh job id and the version it would produce. The manifest is written before the row. */
export function nextSceneJobIdentity(scene: SceneRow): { jobId: string; version: number } {
  return { jobId: uuidv7(), version: scene.lastAllocatedVersion + 1 };
}

/**
 * Create the reconstruction job, atomically with the scene's version counter,
 * its input fingerprint and the candidates' state.
 *
 * Returns `false` when another tick got there first (the version counter moved,
 * or an open job exists) — the manifest that caller already wrote is then an
 * orphan under `jobs/`, which the bucket's lifecycle backstop removes.
 */
export async function createSceneJob(
  db: Database,
  input: CreateSceneJobInput,
  now: Date,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Lock order: an open job before its scene, as every job transition does.
    if (input.supersede) {
      await tx
        .select({ id: street3dJobs.id })
        .from(street3dJobs)
        .where(eq(street3dJobs.id, input.supersede.id))
        .for('update');
    }
    const [scene] = await tx
      .select()
      .from(street3dScenes)
      .where(eq(street3dScenes.id, input.scene.id))
      .for('update');
    if (!scene || scene.state === 'disabled' || scene.lastAllocatedVersion + 1 !== input.version)
      return false;

    if (input.supersede) {
      const cancelled = await cancelOpenJobs(
        tx,
        eq(street3dJobs.id, input.supersede.id),
        'superseded',
        now,
        {
          supersededByJobId: input.jobId,
          releaseConsequences: false,
        },
      );
      if (cancelled.length === 0) return false;
    }

    const inserted = await tx
      .insert(street3dJobs)
      .values({
        id: input.jobId,
        kind: 'scene_reconstruct',
        sceneId: scene.id,
        sceneVersion: input.version,
        profile: input.profile,
        state: 'queued',
        attempt: 1,
        maxAttempts: street3dConfig.jobMaxAttempts,
        enqueuedAt: now,
        inputManifestKey: input.manifestKey,
        inputManifestSha256: input.manifestSha256,
        outputPrefix: `jobs/${input.jobId}/`,
        inputDerivativeIds: input.frames.map((frame) => frame.derivativeId),
        inputFingerprint: input.fingerprint,
      })
      .onConflictDoNothing()
      .returning();
    const job = inserted[0];
    if (!job) return false;

    await tx
      .update(street3dScenes)
      .set({
        lastAllocatedVersion: input.version,
        lastQueuedInputFingerprint: input.fingerprint,
        rebuildRequestedAt: null,
        rebuildProfile: null,
        state: progressSceneState('queued'),
        updatedAt: now,
      })
      .where(eq(street3dScenes.id, scene.id));

    const assetIds = [...new Set(input.frames.map((frame) => frame.assetId))];
    await tx
      .update(captureAssets)
      .set({ state: 'reconstruction_candidate', updatedAt: now })
      .where(
        and(inArray(captureAssets.id, assetIds), eq(captureAssets.state, 'waiting_for_overlap')),
      );
    await refreshInputProtection(tx, job, now);
    return true;
  });
}

/** The SQS envelope for a reconstruction job. */
export function sceneEnvelope(job: JobRow, issuedAt: Date): SceneReconstructJob | null {
  if (
    !job.sceneId ||
    !job.sceneVersion ||
    !job.profile ||
    !job.inputManifestKey ||
    !job.inputManifestSha256
  )
    return null;
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    jobId: job.id,
    jobType: 'scene_reconstruct',
    issuedAt: issuedAt.toISOString(),
    sceneId: job.sceneId,
    sceneVersion: job.sceneVersion,
    profile: job.profile as StreetSceneProfile,
    inputManifestKey: job.inputManifestKey,
    inputManifestSha256: job.inputManifestSha256,
    outputPrefix: job.outputPrefix,
  };
}

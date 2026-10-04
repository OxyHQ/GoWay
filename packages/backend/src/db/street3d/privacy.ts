/**
 * The privacy gate's half of the scheduler: queueing captures for privacy
 * preprocessing, and recording what the external worker found.
 *
 * ## Locking follows the capture sweeper's order
 *
 * `capture_media_objects` row first, then `capture_assets` — the order
 * `finalizeAsset` and the expiry sweeper already use (`STREET3D_LIFECYCLE.md`
 * → State and concurrency). Taking the object lock is what lets a job ACQUIRE
 * PROTECTION safely: under it, an object in `deleting`/`deleted`, or one with a
 * removal request, is refused, and `protected_until` is raised before the lock
 * is released — so the sweeper, which re-checks protection under the same lock,
 * cannot delete bytes a job has just been told to read. The protection is
 * BOUNDED (never past the object's own expiry) and refreshed by heartbeats.
 *
 * ## The verdict is the worker's; the gate is the database's
 *
 * A `passed` verdict sets `privacy_state = 'passed'` with the pipeline version,
 * and `capture_assets.reconstruction_eligible` — a GENERATED column — opens on
 * its own. Nothing here writes eligibility, and nothing could.
 */

import { and, asc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { qualified, uuidv7 } from '@oxy.so/db';
import { addDays } from '../../capture/retention';
import { captureConfig } from '../../config/capture';
import { street3dConfig } from '../../config/street3d';
import type { CapturePrivacyJob, CapturePrivacyResult } from '../../street3d/workerContract';
import { WORKER_CONTRACT_SCHEMA_VERSION } from '../../street3d/workerContract';
import type { Database, Transaction } from '../postgres';
import {
  captureAssets,
  captureDerivatives,
  captureMediaObjects,
  street3dCaptureBlocks,
  street3dJobs,
} from '../schema';
import { failPrivacyGate, isTerminal, lockJob, privacyAttempts, refreshInputProtection, ResultRejected, type JobRow } from './jobs';

/** Where a privacy job's outputs go. Under `derived/`, keyed by capture and job. */
export function privacyOutputPrefix(assetId: string, jobId: string): string {
  return `derived/privacy/${assetId}/${jobId}/`;
}

/**
 * Captures that need a privacy pass: finalized bytes, a shut gate that has not
 * failed too often, and no open privacy job.
 */
export async function findPrivacyCandidates(db: Database, now: Date, limit: number): Promise<string[]> {
  const soonest = new Date(now.getTime() + street3dConfig.inputProtectionHours * 3600_000);
  const rows = await db
    .select({ id: captureAssets.id })
    .from(captureAssets)
    .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
    .where(
      and(
        inArray(captureAssets.state, ['uploaded', 'accepted', 'validating']),
        inArray(captureAssets.privacyState, ['pending', 'failed']),
        eq(captureMediaObjects.storageState, 'stored'),
        isNull(captureMediaObjects.deletedAt),
        isNull(captureMediaObjects.deletionRequestedAt),
        // Bytes that die before a job could plausibly finish are not worth a job.
        sql`${captureMediaObjects.expiresAt} > ${soonest.toISOString()}::timestamptz`,
        sql`not exists (
          select 1 from ${street3dJobs}
          where ${qualified(street3dJobs.assetId)} = ${qualified(captureAssets.id)}
            and ${qualified(street3dJobs.state)} not in ('completed', 'failed', 'cancelled')
        )`,
        sql`(select count(*) from ${street3dJobs}
             where ${qualified(street3dJobs.assetId)} = ${qualified(captureAssets.id)}
               and ${qualified(street3dJobs.kind)} = 'capture_privacy')
            < ${street3dConfig.privacyMaxAttempts}`,
      ),
    )
    .orderBy(asc(captureAssets.createdAt), asc(captureAssets.id))
    .limit(limit);
  return rows.map((row) => row.id);
}

export type PrivacyEnqueueOutcome = 'queued' | 'skipped' | 'blocked';

/**
 * Create one privacy job, acquiring bounded protection on the raw object.
 *
 * Everything is re-checked under the locks; a candidate that changed between
 * the scan and here (withdrawn, expired, claimed by a concurrent tick) is
 * skipped, never forced. Bytes whose content hash is under a moderation block
 * are refused here — the identical photo uploaded again does not get a second
 * chance at a manifest.
 */
export async function enqueuePrivacyJob(db: Database, assetId: string, now: Date): Promise<PrivacyEnqueueOutcome> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({ mediaObjectId: captureAssets.mediaObjectId })
      .from(captureAssets)
      .where(eq(captureAssets.id, assetId));
    if (!link) return 'skipped';
    const [media] = await tx
      .select()
      .from(captureMediaObjects)
      .where(eq(captureMediaObjects.id, link.mediaObjectId))
      .for('update', { skipLocked: true });
    if (!media) return 'skipped';
    const [asset] = await tx.select().from(captureAssets).where(eq(captureAssets.id, assetId)).for('update');
    if (
      !asset ||
      !['uploaded', 'accepted', 'validating'].includes(asset.state) ||
      !['pending', 'failed'].includes(asset.privacyState) ||
      media.storageState !== 'stored' ||
      media.deletionRequestedAt !== null ||
      media.expiresAt <= now
    ) {
      return 'skipped';
    }

    const [block] = await tx
      .select({ id: street3dCaptureBlocks.id })
      .from(street3dCaptureBlocks)
      .where(or(eq(street3dCaptureBlocks.captureAssetId, assetId), eq(street3dCaptureBlocks.contentHash, media.contentHash)))
      .limit(1);
    if (block) {
      await tx
        .update(captureAssets)
        .set({ privacyState: 'blocked', privacyCompletedAt: now, state: 'rejected', updatedAt: now })
        .where(eq(captureAssets.id, assetId));
      return 'blocked';
    }
    if ((await privacyAttempts(tx, assetId)) >= street3dConfig.privacyMaxAttempts) return 'skipped';

    const jobId = uuidv7();
    const inserted = await tx
      .insert(street3dJobs)
      .values({
        id: jobId,
        kind: 'capture_privacy',
        assetId,
        state: 'queued',
        attempt: 1,
        maxAttempts: street3dConfig.jobMaxAttempts,
        enqueuedAt: now,
        outputPrefix: privacyOutputPrefix(assetId, jobId),
      })
      // The partial unique index on open privacy jobs is the real guard; a
      // concurrent tick that won the race makes this a no-op, not an error.
      .onConflictDoNothing()
      .returning({ id: street3dJobs.id });
    if (inserted.length === 0) return 'skipped';

    await tx
      .update(captureAssets)
      .set({ privacyState: 'in_progress', privacyCompletedAt: null, state: 'validating', updatedAt: now })
      .where(eq(captureAssets.id, assetId));
    const [job] = await tx.select().from(street3dJobs).where(eq(street3dJobs.id, jobId));
    if (job) await refreshInputProtection(tx, job, now);
    return 'queued';
  });
}

/** The SQS envelope for a privacy job, rebuilt from the database at send time. */
export async function privacyEnvelope(db: Database | Transaction, job: JobRow, issuedAt: Date): Promise<CapturePrivacyJob | null> {
  if (!job.assetId) return null;
  const [row] = await db
    .select({
      mediaKind: captureAssets.mediaKind,
      key: captureMediaObjects.objectKey,
      contentType: captureMediaObjects.contentType,
      byteSize: captureMediaObjects.byteSize,
      confirmedByteSize: captureMediaObjects.confirmedByteSize,
      sha256: captureMediaObjects.contentHash,
    })
    .from(captureAssets)
    .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
    .where(eq(captureAssets.id, job.assetId));
  if (!row) return null;
  return {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    jobId: job.id,
    jobType: 'capture_privacy',
    issuedAt: issuedAt.toISOString(),
    assetId: job.assetId,
    mediaKind: row.mediaKind as 'photo' | 'video',
    input: {
      key: row.key,
      contentType: row.contentType,
      byteSize: row.confirmedByteSize ?? row.byteSize,
      sha256: row.sha256,
    },
    outputPrefix: job.outputPrefix,
    keyframes: {
      maxFrames: street3dConfig.keyframeMaxFrames,
      minIntervalSeconds: street3dConfig.keyframeMinIntervalSeconds,
      maxLongEdgePixels: street3dConfig.keyframeMaxLongEdgePixels,
    },
  };
}

/** Every key the worker reported must sit under the job's own output prefix. */
export function assertPrivacyResultMatches(job: JobRow, result: CapturePrivacyResult): void {
  if (result.jobId !== job.id || result.assetId !== job.assetId) {
    throw new ResultRejected('result_mismatch', 'The privacy result names a different job or capture.');
  }
  for (const frame of result.frames) {
    for (const key of [frame.imageKey, frame.maskKey]) {
      if (key !== undefined && !key.startsWith(job.outputPrefix)) {
        throw new ResultRejected('result_mismatch', 'A privacy frame lies outside its job output prefix.');
      }
    }
    if ((frame.maskKey === undefined) !== (frame.maskSha256 === undefined)) {
      throw new ResultRejected('result_mismatch', 'A privacy frame mask is missing its digest.');
    }
  }
}

export type PrivacyApplyOutcome = 'passed' | 'failed' | 'withdrawn' | 'late';

/**
 * Record a privacy result. The caller verified the result object's digest and
 * size and parsed it; this checks it belongs to THIS job and applies it.
 *
 * - `passed` → one derivative row per frame (temporary, `privacy_safe_proxy`),
 *   the gate opens with the pipeline version, the capture waits for overlap,
 *   and the raw original becomes deletion-eligible: a photo after a short
 *   audit window, a video at once — its keyframes are now the input.
 * - `failed` → the gate is failed; another attempt follows unless exhausted.
 * - a capture withdrawn or blocked WHILE the job ran still gets its derivative
 *   rows — so the cleanup sweeper can delete the bytes the worker wrote — but
 *   born with a removal request, and its gate stays shut.
 */
export async function applyPrivacyResult(
  tx: Transaction,
  job: JobRow,
  result: CapturePrivacyResult,
  reference: { key: string; sha256: string },
  now: Date,
): Promise<PrivacyApplyOutcome> {
  if (isTerminal(job.state)) return 'late';
  assertPrivacyResultMatches(job, result);
  const assetId = job.assetId as string;

  const [link] = await tx.select({ mediaObjectId: captureAssets.mediaObjectId }).from(captureAssets).where(eq(captureAssets.id, assetId));
  if (!link) throw new ResultRejected('result_mismatch', 'The privacy job names a capture that does not exist.');
  const [media] = await tx.select().from(captureMediaObjects).where(eq(captureMediaObjects.id, link.mediaObjectId)).for('update');
  const [asset] = await tx.select().from(captureAssets).where(eq(captureAssets.id, assetId)).for('update');
  if (!media || !asset) throw new ResultRejected('result_mismatch', 'The privacy job names a capture that does not exist.');

  const [block] = await tx
    .select({ id: street3dCaptureBlocks.id })
    .from(street3dCaptureBlocks)
    .where(or(eq(street3dCaptureBlocks.captureAssetId, assetId), eq(street3dCaptureBlocks.contentHash, media.contentHash)))
    .limit(1);
  const withdrawn = asset.state === 'deleted' || asset.privacyState === 'blocked' || block !== undefined;

  await tx
    .update(street3dJobs)
    .set({
      state: 'completed',
      finishedAt: now,
      progress: 1,
      resultKey: reference.key,
      resultSha256: reference.sha256,
      metrics: { frames: result.frames.length, rejectedFrames: result.rejectedFrames },
      updatedAt: now,
    })
    .where(eq(street3dJobs.id, job.id));

  if (result.verdict === 'passed') {
    const expiresAt = addDays(now, captureConfig.retentionDays.privacy_safe_proxy);
    const removal = withdrawn
      ? { deletionRequestedAt: now, deletionRequestedReason: asset.state === 'deleted' && !block ? 'contributor_request' : 'moderation' }
      : {};
    await tx
      .insert(captureDerivatives)
      .values(
        result.frames.map((frame) => ({
          assetId,
          jobId: job.id,
          frameIndex: frame.frameIndex,
          objectKey: frame.imageKey,
          imageSha256: frame.imageSha256,
          imageByteSize: frame.imageByteSize,
          maskKey: frame.maskKey ?? null,
          maskSha256: frame.maskSha256 ?? null,
          maskByteSize: frame.maskByteSize ?? null,
          width: frame.width,
          height: frame.height,
          privacyPipelineVersion: result.privacyPipelineVersion,
          expiresAt,
          createdAt: now,
          updatedAt: now,
          ...removal,
        })),
      )
      .onConflictDoNothing();
    if (withdrawn) return 'withdrawn';

    await tx
      .update(captureAssets)
      .set({
        privacyState: 'passed',
        privacyPipelineVersion: result.privacyPipelineVersion,
        privacyCompletedAt: now,
        state: 'waiting_for_overlap',
        updatedAt: now,
      })
      .where(eq(captureAssets.id, assetId));

    const eligibleAt =
      media.retentionClass === 'raw_video' ? now : addDays(now, street3dConfig.rawAuditWindowDays);
    await tx
      .update(captureMediaObjects)
      .set({
        deletionEligibleAt: sql`least(${captureMediaObjects.expiresAt}, ${eligibleAt.toISOString()}::timestamptz)`,
        ...(media.retentionClass === 'raw_photo' ? { retentionReason: 'audit_window' } : {}),
        updatedAt: now,
      })
      .where(eq(captureMediaObjects.id, media.id));
    await releaseProtectionIfIdle(tx, media.id, now);
    return 'passed';
  }

  if (!withdrawn) await failPrivacyGate(tx, assetId, now);
  await releaseProtectionIfIdle(tx, media.id, now);
  return withdrawn ? 'withdrawn' : 'failed';
}

async function releaseProtectionIfIdle(tx: Transaction, mediaObjectId: string, now: Date): Promise<void> {
  const open = await tx
    .select({ id: street3dJobs.id })
    .from(street3dJobs)
    .innerJoin(captureAssets, eq(captureAssets.id, street3dJobs.assetId))
    .where(
      and(
        eq(captureAssets.mediaObjectId, mediaObjectId),
        sql`${street3dJobs.state} not in ('completed', 'failed', 'cancelled')`,
      ),
    )
    .limit(1);
  if (open.length > 0) return;
  await tx
    .update(captureMediaObjects)
    .set({ protectedUntil: null, updatedAt: now })
    .where(and(eq(captureMediaObjects.id, mediaObjectId), isNull(captureMediaObjects.deletedAt)));
}

/** Locks and returns the job for an event, or `null` when it does not exist. */
export async function lockJobForEvent(tx: Transaction, jobId: string): Promise<JobRow | null> {
  return lockJob(tx, jobId);
}

/** Captures whose privacy gate is `in_progress` without an open job — repair after a crash. */
export async function reopenOrphanedPrivacyGates(db: Database, now: Date): Promise<number> {
  const rows = await db
    .update(captureAssets)
    .set({ privacyState: 'pending', privacyCompletedAt: null, updatedAt: now })
    .where(
      and(
        eq(captureAssets.privacyState, 'in_progress'),
        ne(captureAssets.state, 'deleted'),
        lt(captureAssets.updatedAt, new Date(now.getTime() - 3600_000)),
        sql`not exists (
          select 1 from ${street3dJobs}
          where ${qualified(street3dJobs.assetId)} = ${qualified(captureAssets.id)}
            and ${qualified(street3dJobs.state)} not in ('completed', 'failed', 'cancelled')
        )`,
      ),
    )
    .returning({ id: captureAssets.id });
  return rows.length;
}

export { ResultRejected };

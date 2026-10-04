/**
 * Retiring privacy-safe derivatives and finished jobs' temporary artifacts.
 *
 * The same three-step shape as the raw-capture sweeper
 * (`db/capture/captureCleanupRepository.ts`), for the same reasons:
 *
 *   1. claim a bounded batch under `FOR UPDATE SKIP LOCKED` and commit the
 *      intent (`deleting`) before any object I/O;
 *   2. delete through the store;
 *   3. only after success, write the tombstone — once.
 *
 * A derivative is a candidate when it expired or its removal was requested
 * (contributor withdrawal, moderation), and no unexpired protection holds it.
 * `deleting` is irreversible and retried after `retryAfterSeconds`. Published
 * scenes live in another bucket and are never touched here.
 */

import { and, asc, eq, inArray, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../postgres';
import { captureAssets, captureDerivatives, captureMediaObjects, street3dJobEvents, street3dJobs } from '../schema';

export interface DerivativeCleanupOptions {
  now: Date;
  limit: number;
  retryAfterSeconds: number;
}

function derivativeCandidates({ now, retryAfterSeconds }: DerivativeCleanupOptions) {
  const retryBefore = new Date(now.getTime() - retryAfterSeconds * 1000);
  return and(
    isNull(captureDerivatives.deletedAt),
    or(
      and(
        eq(captureDerivatives.storageState, 'stored'),
        or(lte(captureDerivatives.expiresAt, now), isNotNull(captureDerivatives.deletionRequestedAt)),
        or(isNull(captureDerivatives.protectedUntil), lte(captureDerivatives.protectedUntil, now)),
      ),
      and(eq(captureDerivatives.storageState, 'deleting'), lte(captureDerivatives.updatedAt, retryBefore)),
    ),
  );
}

export async function previewDerivativeCleanup(db: Database, options: DerivativeCleanupOptions) {
  const rows = await db
    .select({ bytes: sql<number>`(${captureDerivatives.imageByteSize} + coalesce(${captureDerivatives.maskByteSize}, 0))::bigint` })
    .from(captureDerivatives)
    .where(derivativeCandidates(options))
    .limit(options.limit);
  return { candidates: rows.length, declaredBytes: rows.reduce((sum, row) => sum + Number(row.bytes), 0) };
}

export async function claimDerivativeCleanup(db: Database, options: DerivativeCleanupOptions) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: captureDerivatives.id,
        objectKey: captureDerivatives.objectKey,
        maskKey: captureDerivatives.maskKey,
        bytes: sql<number>`(${captureDerivatives.imageByteSize} + coalesce(${captureDerivatives.maskByteSize}, 0))::bigint`,
      })
      .from(captureDerivatives)
      .where(derivativeCandidates(options))
      .orderBy(asc(captureDerivatives.updatedAt), asc(captureDerivatives.id))
      .limit(options.limit)
      .for('update', { skipLocked: true });
    if (rows.length > 0) {
      await tx
        .update(captureDerivatives)
        .set({ storageState: 'deleting', updatedAt: options.now })
        .where(inArray(captureDerivatives.id, rows.map((row) => row.id)));
    }
    return rows.map((row) => ({ ...row, bytes: Number(row.bytes) }));
  });
}

/**
 * Write the tombstone, once. When the capture has no stored derivative left
 * and its raw bytes are gone too, the contribution itself has expired.
 */
export async function completeDerivativeCleanup(db: Database, id: string, now: Date): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(captureDerivatives)
      .set({
        storageState: 'deleted',
        deletedAt: now,
        deletionReason: sql`coalesce(${captureDerivatives.deletionRequestedReason}, 'expired')`,
        updatedAt: now,
      })
      .where(and(eq(captureDerivatives.id, id), eq(captureDerivatives.storageState, 'deleting')))
      .returning({ assetId: captureDerivatives.assetId });
    const done = rows[0];
    if (!done) return false;
    const [live] = await tx
      .select({ id: captureDerivatives.id })
      .from(captureDerivatives)
      .where(and(eq(captureDerivatives.assetId, done.assetId), isNull(captureDerivatives.deletedAt)))
      .limit(1);
    if (!live) {
      const [asset] = await tx
        .select({ state: captureAssets.state, storage: captureMediaObjects.storageState })
        .from(captureAssets)
        .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
        .where(eq(captureAssets.id, done.assetId));
      if (asset && asset.storage === 'deleted' && ['waiting_for_overlap', 'reconstruction_candidate', 'integrated', 'accepted'].includes(asset.state)) {
        await tx.update(captureAssets).set({ state: 'expired', updatedAt: now }).where(eq(captureAssets.id, done.assetId));
      }
    }
    return true;
  });
}

/** Finished jobs whose temporary artifacts have outlived the retention window. */
export async function findExpiredJobArtifacts(db: Database, before: Date, limit: number) {
  return db
    .select({ id: street3dJobs.id, kind: street3dJobs.kind, outputPrefix: street3dJobs.outputPrefix })
    .from(street3dJobs)
    .where(
      and(
        isNull(street3dJobs.artifactsDeletedAt),
        lte(street3dJobs.finishedAt, before),
        // Nothing the worker might still be writing: a terminal job only.
        sql`${street3dJobs.state} in ('completed', 'failed', 'cancelled')`,
      ),
    )
    .orderBy(asc(street3dJobs.finishedAt))
    .limit(limit);
}

/** Whether a privacy job's outputs became derivative rows (which then own those bytes). */
export async function jobHasDerivatives(db: Database, jobId: string): Promise<boolean> {
  const [row] = await db.select({ id: captureDerivatives.id }).from(captureDerivatives).where(eq(captureDerivatives.jobId, jobId)).limit(1);
  return row !== undefined;
}

export async function completeJobArtifacts(db: Database, jobId: string, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(street3dJobs).set({ artifactsDeletedAt: now, updatedAt: now }).where(eq(street3dJobs.id, jobId));
    // The idempotency ledger of a job nothing can deliver events for any more.
    await tx.delete(street3dJobEvents).where(eq(street3dJobEvents.jobId, jobId));
  });
}

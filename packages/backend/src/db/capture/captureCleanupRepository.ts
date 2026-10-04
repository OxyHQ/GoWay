import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../postgres';
import { qualified } from '@oxy.so/db';
import { captureAssets, captureDerivatives, captureMediaObjects } from '../schema';

export interface CaptureCleanupOptions {
  now: Date;
  limit: number;
  retryAfterSeconds: number;
}

function candidates({ now, retryAfterSeconds }: CaptureCleanupOptions) {
  const retryBefore = new Date(now.getTime() - retryAfterSeconds * 1000);
  return and(
    isNull(captureMediaObjects.deletedAt),
    or(
      and(
        inArray(captureMediaObjects.storageState, ['expected', 'stored']),
        or(lte(captureMediaObjects.expiresAt, now), isNotNull(captureMediaObjects.deletionRequestedAt)),
        lte(captureMediaObjects.uploadIntentExpiresAt, now),
        or(isNull(captureMediaObjects.protectedUntil), lte(captureMediaObjects.protectedUntil, now)),
      ),
      and(eq(captureMediaObjects.storageState, 'deleting'), lte(captureMediaObjects.updatedAt, retryBefore)),
    ),
  );
}

export async function previewCaptureCleanup(db: Database, options: CaptureCleanupOptions) {
  // Counts only this bounded batch. No object keys, hashes or contributor data.
  const rows = await db.select({ byteSize: captureMediaObjects.byteSize })
    .from(captureMediaObjects).where(candidates(options))
    .orderBy(asc(captureMediaObjects.updatedAt), asc(captureMediaObjects.id)).limit(options.limit);
  return { candidates: rows.length, declaredBytes: rows.reduce((sum, row) => sum + row.byteSize, 0) };
}

/** Commit intent BEFORE calling the store. Deleting objects can never be reused. */
export async function claimCaptureCleanup(db: Database, options: CaptureCleanupOptions) {
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: captureMediaObjects.id,
      objectKey: captureMediaObjects.objectKey,
      byteSize: captureMediaObjects.byteSize,
      deletionRequestedReason: captureMediaObjects.deletionRequestedReason,
    }).from(captureMediaObjects).where(candidates(options))
      .orderBy(asc(captureMediaObjects.updatedAt), asc(captureMediaObjects.id))
      .limit(options.limit).for('update', { skipLocked: true });
    if (rows.length === 0) return rows;
    const ids = rows.map((row) => row.id);
    await tx.update(captureMediaObjects).set({ storageState: 'deleting', updatedAt: options.now })
      .where(inArray(captureMediaObjects.id, ids));
    // Close reconstruction eligibility atomically with intent. Retain compact
    // provenance; published scenes have a separate lifecycle, never this table.
    // A raw original retired because its privacy-safe derivative REPLACED it is
    // not an expiry: its contribution stays eligible through the derivative.
    const expiring = rows.filter((row) => row.deletionRequestedReason !== 'superseded_by_derivative').map((row) => row.id);
    if (expiring.length > 0) {
      await tx.update(captureAssets).set({
        state: sql`case when ${captureAssets.state} in ('expected', 'abandoned') then 'abandoned' else 'expired' end`,
        updatedAt: options.now,
      }).where(and(inArray(captureAssets.mediaObjectId, expiring), ne(captureAssets.state, 'deleted')));
    }
    return rows;
  });
}

/** A repeated successful DELETE may only produce one tombstone / accounting event. */
export async function completeCaptureCleanup(db: Database, id: string, now: Date): Promise<boolean> {
  const rows = await db.update(captureMediaObjects).set({
    storageState: 'deleted', deletedAt: now,
    deletionReason: sql`coalesce(${captureMediaObjects.deletionRequestedReason}, 'expired')`, updatedAt: now,
  }).where(and(eq(captureMediaObjects.id, id), eq(captureMediaObjects.storageState, 'deleting')))
    .returning({ id: captureMediaObjects.id });
  return rows.length === 1;
}

/**
 * Raw originals whose privacy-safe derivatives now stand in for them.
 *
 * `deletion_eligible_at` alone is NOT proof (see `STREET3D_LIFECYCLE.md`): it
 * is set at registration for a video, long before any keyframe exists. So an
 * object qualifies only when, besides being eligible and unprotected, EVERY
 * live contribution using it has at least one stored derivative with no removal
 * request — and at least one such contribution exists. A deduplicated object
 * whose second contributor has not been privacy-processed yet waits.
 *
 * Qualifying objects get a durable removal request with reason
 * `superseded_by_derivative`; the ordinary claim → DELETE → tombstone pipeline
 * above then retires them, without expiring their contributions.
 */
function supersededCandidates(now: Date) {
  return and(
    isNull(captureMediaObjects.deletedAt),
    eq(captureMediaObjects.storageState, 'stored'),
    isNull(captureMediaObjects.deletionRequestedAt),
    lte(captureMediaObjects.deletionEligibleAt, now),
    or(isNull(captureMediaObjects.protectedUntil), lte(captureMediaObjects.protectedUntil, now)),
    sql`exists (
      select 1 from ${captureAssets}
      where ${qualified(captureAssets.mediaObjectId)} = ${qualified(captureMediaObjects.id)}
        and ${qualified(captureAssets.state)} <> 'deleted'
    )`,
    sql`not exists (
      select 1 from ${captureAssets}
      where ${qualified(captureAssets.mediaObjectId)} = ${qualified(captureMediaObjects.id)}
        and ${qualified(captureAssets.state)} <> 'deleted'
        and not exists (
          select 1 from ${captureDerivatives}
          where ${qualified(captureDerivatives.assetId)} = ${qualified(captureAssets.id)}
            and ${qualified(captureDerivatives.storageState)} = 'stored'
            and ${qualified(captureDerivatives.deletionRequestedAt)} is null
        )
    )`,
  );
}

export async function previewSupersededRawObjects(db: Database, options: CaptureCleanupOptions): Promise<number> {
  const rows = await db.select({ id: captureMediaObjects.id }).from(captureMediaObjects)
    .where(supersededCandidates(options.now)).limit(options.limit);
  return rows.length;
}

/** Mark a bounded batch, under row locks, re-checking the predicate on the locked rows. */
export async function markSupersededRawObjects(db: Database, options: CaptureCleanupOptions): Promise<number> {
  return db.transaction(async (tx) => {
    const rows = await tx.select({ id: captureMediaObjects.id }).from(captureMediaObjects)
      .where(supersededCandidates(options.now))
      .orderBy(asc(captureMediaObjects.deletionEligibleAt), asc(captureMediaObjects.id))
      .limit(options.limit).for('update', { skipLocked: true });
    if (rows.length === 0) return 0;
    const marked = await tx.update(captureMediaObjects).set({
      deletionRequestedAt: options.now,
      deletionRequestedReason: 'superseded_by_derivative',
      updatedAt: options.now,
    }).where(and(inArray(captureMediaObjects.id, rows.map((row) => row.id)), supersededCandidates(options.now)))
      .returning({ id: captureMediaObjects.id });
    return marked.length;
  });
}

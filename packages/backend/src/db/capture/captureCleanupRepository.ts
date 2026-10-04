import { and, asc, eq, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import type { Database } from '../postgres';
import { captureAssets, captureMediaObjects } from '../schema';

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
    }).from(captureMediaObjects).where(candidates(options))
      .orderBy(asc(captureMediaObjects.updatedAt), asc(captureMediaObjects.id))
      .limit(options.limit).for('update', { skipLocked: true });
    if (rows.length === 0) return rows;
    const ids = rows.map((row) => row.id);
    await tx.update(captureMediaObjects).set({ storageState: 'deleting', updatedAt: options.now })
      .where(inArray(captureMediaObjects.id, ids));
    // Close reconstruction eligibility atomically with intent. Retain compact
    // provenance; published scenes have a separate lifecycle, never this table.
    await tx.update(captureAssets).set({
      state: sql`case when ${captureAssets.state} in ('expected', 'abandoned') then 'abandoned' else 'expired' end`,
      updatedAt: options.now,
    }).where(and(inArray(captureAssets.mediaObjectId, ids), ne(captureAssets.state, 'deleted')));
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

import type { Database } from '../db/postgres';
import {
  claimCaptureCleanup,
  completeCaptureCleanup,
  previewCaptureCleanup,
} from '../db/capture/captureCleanupRepository';
import type { CaptureObjectStore } from '../storage/objectStore';

export interface CleanupOptions {
  dryRun?: boolean;
  limit?: number;
  retryAfterSeconds?: number;
  now?: () => Date;
}

/** One bounded pass; schedule repeatedly. Errors leave a durable retryable intent. */
export async function sweepExpiredCaptures(
  db: Database,
  store: Pick<CaptureObjectStore, 'deleteObject'> | null,
  options: CleanupOptions = {},
) {
  const clock = options.now ?? (() => new Date());
  const limit = options.limit ?? 100;
  const retryAfterSeconds = options.retryAfterSeconds ?? 300;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Cleanup limit must be an integer between 1 and 1000.');
  }
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 30 || retryAfterSeconds > 86400) {
    throw new Error('Cleanup retry interval must be between 30 and 86400 seconds.');
  }
  const query = { now: clock(), limit, retryAfterSeconds };
  if (options.dryRun) {
    return { dryRun: true, ...await previewCaptureCleanup(db, query), deleted: 0, failed: 0, deletedDeclaredBytes: 0 };
  }
  if (!store) throw new Error('Capture cleanup requires a configured object store.');
  const rows = await claimCaptureCleanup(db, query);
  const summary = { dryRun: false, candidates: rows.length, declaredBytes: 0, deleted: 0, failed: 0, deletedDeclaredBytes: 0 };
  for (const row of rows) {
    summary.declaredBytes += row.byteSize;
    try {
      await store.deleteObject(row.objectKey);
      if (await completeCaptureCleanup(db, row.id, clock())) {
        summary.deleted++;
        summary.deletedDeclaredBytes += row.byteSize;
      }
    } catch {
      // Do not log provider exceptions: they can contain signed URLs / raw keys.
      // A timeout is ambiguous; retry the idempotent DELETE, never revive bytes.
      summary.failed++;
    }
  }
  return summary;
}

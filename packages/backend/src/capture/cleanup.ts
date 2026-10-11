/**
 * The temporary-storage sweeper: raw captures, privacy-safe derivatives and
 * finished Street 3D jobs' artifacts — in one bounded, idempotent pass.
 *
 * Every class follows the same shape (claim under lock and commit `deleting`,
 * DELETE through the store, tombstone once on success) and the same
 * guarantees as the original raw-capture sweeper documented in
 * `docs/STREET3D_LIFECYCLE.md`. Errors leave a durable, retryable intent and
 * are COUNTED, never logged: provider exceptions can carry signed URLs and raw
 * keys.
 *
 * Published scene assets live in the scene bucket. Nothing here can reach it.
 */

import type { Database } from '../db/postgres';
import {
  claimCaptureCleanup,
  completeCaptureCleanup,
  markSupersededRawObjects,
  previewCaptureCleanup,
  previewSupersededRawObjects,
} from '../db/capture/captureCleanupRepository';
import {
  claimDerivativeCleanup,
  completeDerivativeCleanup,
  completeJobArtifacts,
  findExpiredJobArtifacts,
  jobHasDerivatives,
  previewDerivativeCleanup,
} from '../db/street3d/cleanup';
import type { CaptureObjectStore } from '../storage/objectStore';
import type { JobObjectStore } from '../street3d/jobObjectStore';

export interface CleanupOptions {
  dryRun?: boolean;
  limit?: number;
  retryAfterSeconds?: number;
  /** Days a finished job's `jobs/` artifacts are kept. Default 7. */
  jobArtifactRetentionDays?: number;
  now?: () => Date;
}

export interface CleanupSummary {
  dryRun: boolean;
  /** Raw objects claimed (or, in a dry run, eligible) this pass. */
  candidates: number;
  declaredBytes: number;
  deleted: number;
  failed: number;
  deletedDeclaredBytes: number;
  /** Raw originals newly marked as replaced by their privacy-safe derivatives. */
  supersededMarked: number;
  derivativeCandidates: number;
  derivativeDeclaredBytes: number;
  derivativesDeleted: number;
  derivativesFailed: number;
  jobArtifactCandidates: number;
  jobArtifactObjectsDeleted: number;
  jobArtifactsFailed: number;
}

/** One bounded pass; schedule repeatedly. Errors leave a durable retryable intent. */
export async function sweepExpiredCaptures(
  db: Database,
  store: Pick<CaptureObjectStore, 'deleteObject'> | null,
  options: CleanupOptions = {},
  jobStore: Pick<JobObjectStore, 'delete' | 'list'> | null = null,
): Promise<CleanupSummary> {
  const clock = options.now ?? (() => new Date());
  const limit = options.limit ?? 100;
  const retryAfterSeconds = options.retryAfterSeconds ?? 300;
  const retentionDays = options.jobArtifactRetentionDays ?? 7;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new Error('Cleanup limit must be an integer between 1 and 1000.');
  }
  if (!Number.isInteger(retryAfterSeconds) || retryAfterSeconds < 30 || retryAfterSeconds > 86400) {
    throw new Error('Cleanup retry interval must be between 30 and 86400 seconds.');
  }
  const now = clock();
  const query = { now, limit, retryAfterSeconds };
  const artifactsBefore = new Date(now.getTime() - retentionDays * 86_400_000);

  if (options.dryRun) {
    const raw = await previewCaptureCleanup(db, query);
    const derivatives = await previewDerivativeCleanup(db, query);
    return {
      dryRun: true,
      ...raw,
      deleted: 0,
      failed: 0,
      deletedDeclaredBytes: 0,
      supersededMarked: await previewSupersededRawObjects(db, query),
      derivativeCandidates: derivatives.candidates,
      derivativeDeclaredBytes: derivatives.declaredBytes,
      derivativesDeleted: 0,
      derivativesFailed: 0,
      jobArtifactCandidates: (await findExpiredJobArtifacts(db, artifactsBefore, limit)).length,
      jobArtifactObjectsDeleted: 0,
      jobArtifactsFailed: 0,
    };
  }
  if (!store) throw new Error('Capture cleanup requires a configured object store.');

  const summary: CleanupSummary = {
    dryRun: false,
    candidates: 0,
    declaredBytes: 0,
    deleted: 0,
    failed: 0,
    deletedDeclaredBytes: 0,
    supersededMarked: await markSupersededRawObjects(db, query),
    derivativeCandidates: 0,
    derivativeDeclaredBytes: 0,
    derivativesDeleted: 0,
    derivativesFailed: 0,
    jobArtifactCandidates: 0,
    jobArtifactObjectsDeleted: 0,
    jobArtifactsFailed: 0,
  };

  const rows = await claimCaptureCleanup(db, query);
  summary.candidates = rows.length;
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

  // Derivatives and job artifacts live in the same temporary bucket, under
  // `derived/` and `jobs/`. Without that store configured they wait.
  if (!jobStore) return summary;

  const derivatives = await claimDerivativeCleanup(db, query);
  summary.derivativeCandidates = derivatives.length;
  for (const derivative of derivatives) {
    summary.derivativeDeclaredBytes += derivative.bytes;
    try {
      await jobStore.delete(derivative.objectKey);
      if (derivative.maskKey) await jobStore.delete(derivative.maskKey);
      if (await completeDerivativeCleanup(db, derivative.id, clock())) summary.derivativesDeleted++;
    } catch {
      summary.derivativesFailed++;
    }
  }

  const jobs = await findExpiredJobArtifacts(db, artifactsBefore, limit);
  summary.jobArtifactCandidates = jobs.length;
  for (const job of jobs) {
    try {
      const prefixes = [`jobs/${job.id}/`];
      // A privacy job's frames become derivative rows, which own those bytes.
      // A privacy job that produced none (failed, cancelled, withdrawn) leaves
      // orphans under its `derived/` prefix; those go with the job.
      if (job.kind === 'capture_privacy' && !(await jobHasDerivatives(db, job.id)))
        prefixes.push(job.outputPrefix);
      for (const prefix of prefixes) {
        for (const key of await jobStore.list(prefix, 1000)) {
          await jobStore.delete(key);
          summary.jobArtifactObjectsDeleted++;
        }
      }
      await completeJobArtifacts(db, job.id, clock());
    } catch {
      summary.jobArtifactsFailed++;
    }
  }
  return summary;
}

/**
 * Job state transitions shared by every Street 3D phase.
 *
 * ## One row lock, one transition
 *
 * Every change to a job happens in a transaction that holds the job's row lock
 * (`lockJob`) and re-reads its state under it. Two ticks that both received a
 * duplicate SQS delivery, or a lease sweep racing a late heartbeat, therefore
 * serialize on the row, and the second one sees what the first committed. No
 * transition is decided on a state read outside the lock.
 *
 * ## Consequences live next to the transition
 *
 * A job reaching `failed` is not only a job row: a privacy failure reopens or
 * rejects its capture, a reconstruction failure moves its scene and returns its
 * candidates to `waiting_for_overlap`. Those consequences are applied here, in
 * the same transaction, so there is no window in which a scene says
 * `reconstructing` while its only job is already dead.
 */

import { and, count, eq, inArray, isNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { street3dConfig } from '../../config/street3d';
import { RETRYABLE_FAILURE_CODES, type WorkerFailureCode } from '../../street3d/workerContract';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import {
  captureAssets,
  captureDerivatives,
  captureMediaObjects,
  street3dJobEvents,
  street3dJobs,
  street3dScenes,
  STREET3D_RUNNING_JOB_STATES,
  STREET3D_TERMINAL_JOB_STATES,
  type Street3dSceneState,
} from '../schema';

export type JobRow = typeof street3dJobs.$inferSelect;

/**
 * A worker result that can never be applied as reported: it names another job,
 * points outside its output prefix, fails its digest, or references assets that
 * are not there. Distinct from a transient fault (S3 or the database being
 * unreachable), which leaves the event in the queue to be retried; a rejected
 * result is recorded as a failed attempt and retried or failed by policy.
 *
 * `retryable: false` is for a result whose next attempt would be refused the
 * same way — a worker that processed a declared 360° capture as a flat image
 * will do so again — so the job fails at once instead of spending attempts.
 */
export class ResultRejected extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean = true,
  ) {
    super(message);
    this.name = 'ResultRejected';
  }
}

export function isTerminal(state: string): boolean {
  return (STREET3D_TERMINAL_JOB_STATES as readonly string[]).includes(state);
}

export function isRunning(state: string): boolean {
  return (STREET3D_RUNNING_JOB_STATES as readonly string[]).includes(state);
}

/** The job, locked for the rest of the transaction. */
export async function lockJob(tx: Transaction, jobId: string): Promise<JobRow | null> {
  const [row] = await tx
    .select()
    .from(street3dJobs)
    .where(eq(street3dJobs.id, jobId))
    .for('update');
  return row ?? null;
}

/**
 * Record that an event was applied. `false` when it already was.
 *
 * Inserted in the SAME transaction as the transition it describes, so an event
 * is applied-and-recorded or neither: a crash between the two cannot make a
 * redelivery look new, or a new event look like a redelivery.
 */
export async function recordEvent(
  tx: Transaction,
  event: {
    eventId: string;
    jobId: string;
    attempt: number;
    type: 'heartbeat' | 'completed' | 'failed';
  },
): Promise<boolean> {
  const rows = await tx
    .insert(street3dJobEvents)
    .values({
      eventId: event.eventId,
      jobId: event.jobId,
      attempt: event.attempt,
      type: event.type,
    })
    .onConflictDoNothing()
    .returning({ eventId: street3dJobEvents.eventId });
  return rows.length === 1;
}

/**
 * The scene state a job transition implies, unless the scene is published or
 * disabled. A published scene stays `published` while it is being improved —
 * its current version is still what viewers get — and only moderation leaves
 * `disabled`.
 */
export function progressSceneState(desired: Street3dSceneState) {
  return sql`case
    when ${street3dScenes.state} = 'disabled' then ${street3dScenes.state}
    when ${street3dScenes.currentVersionId} is not null then 'published'
    else ${desired} end`;
}

/** Bounded exponential backoff between attempts: 1, 2, 4… minutes, at most an hour. */
export function retryDelayMs(attempt: number): number {
  return Math.min(60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1));
}

/** Short, single-line, and free of anything that looks like a path or a URL. */
export function sanitizeDetail(detail: string | undefined): string | null {
  if (!detail) return null;
  const cleaned = detail
    .replace(/[a-z][a-z0-9+.-]*:\/\/\S+/gi, '[url]')
    .replace(/(?:^|\s)\/?[\w.-]+(?:\/[\w.-]+){1,}/g, ' [path]')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 200) || null;
}

/**
 * Release the bounded protection a privacy job held on its raw object, unless
 * another open privacy job still reads the same bytes (a deduplicated object).
 */
async function releaseRawProtection(tx: Transaction, assetId: string, now: Date): Promise<void> {
  const [asset] = await tx
    .select({ mediaObjectId: captureAssets.mediaObjectId })
    .from(captureAssets)
    .where(eq(captureAssets.id, assetId));
  if (!asset) return;
  const [open] = await tx
    .select({ open: count() })
    .from(street3dJobs)
    .innerJoin(captureAssets, eq(captureAssets.id, street3dJobs.assetId))
    .where(
      and(
        eq(captureAssets.mediaObjectId, asset.mediaObjectId),
        sql`${street3dJobs.state} not in ('completed', 'failed', 'cancelled')`,
      ),
    );
  if ((open?.open ?? 0) > 0) return;
  await tx
    .update(captureMediaObjects)
    .set({ protectedUntil: null, updatedAt: now })
    .where(
      and(eq(captureMediaObjects.id, asset.mediaObjectId), isNull(captureMediaObjects.deletedAt)),
    );
}

/**
 * Refresh the bounded protection a running job holds on its inputs.
 *
 * Never past the input's own expiry (the schema refuses that), never lowered,
 * and never applied to an input whose removal was requested: a contributor's
 * withdrawal outranks a job.
 */
export async function refreshInputProtection(
  tx: Transaction,
  job: JobRow,
  now: Date,
): Promise<void> {
  const until = new Date(
    now.getTime() + street3dConfig.inputProtectionHours * 3600_000,
  ).toISOString();
  if (job.kind === 'capture_privacy' && job.assetId) {
    const [asset] = await tx
      .select({ mediaObjectId: captureAssets.mediaObjectId })
      .from(captureAssets)
      .where(eq(captureAssets.id, job.assetId));
    if (!asset) return;
    await tx
      .update(captureMediaObjects)
      .set({
        protectedUntil: sql`least(${captureMediaObjects.expiresAt}, greatest(coalesce(${captureMediaObjects.protectedUntil}, ${until}::timestamptz), ${until}::timestamptz))`,
        updatedAt: now,
      })
      .where(
        and(
          eq(captureMediaObjects.id, asset.mediaObjectId),
          eq(captureMediaObjects.storageState, 'stored'),
          isNull(captureMediaObjects.deletionRequestedAt),
        ),
      );
    return;
  }
  const inputs = job.inputDerivativeIds ?? [];
  if (inputs.length === 0) return;
  await tx
    .update(captureDerivatives)
    .set({
      protectedUntil: sql`least(${captureDerivatives.expiresAt}, greatest(coalesce(${captureDerivatives.protectedUntil}, ${until}::timestamptz), ${until}::timestamptz))`,
      updatedAt: now,
    })
    .where(
      and(
        inArray(captureDerivatives.id, inputs),
        eq(captureDerivatives.storageState, 'stored'),
        isNull(captureDerivatives.deletionRequestedAt),
      ),
    );
}

/** Return a scene job's selected candidates to `waiting_for_overlap`. */
export async function releaseSceneCandidates(
  tx: Transaction,
  job: JobRow,
  now: Date,
): Promise<void> {
  const inputs = job.inputDerivativeIds ?? [];
  if (inputs.length === 0) return;
  const assetIds = tx
    .select({ id: captureDerivatives.assetId })
    .from(captureDerivatives)
    .where(inArray(captureDerivatives.id, inputs));
  await tx
    .update(captureAssets)
    .set({ state: 'waiting_for_overlap', updatedAt: now })
    .where(
      and(inArray(captureAssets.id, assetIds), eq(captureAssets.state, 'reconstruction_candidate')),
    );
}

/** How many privacy attempts a capture has had, counting every job ever created for it. */
export async function privacyAttempts(db: DatabaseOrTransaction, assetId: string): Promise<number> {
  const [row] = await db
    .select({ attempts: count() })
    .from(street3dJobs)
    .where(and(eq(street3dJobs.kind, 'capture_privacy'), eq(street3dJobs.assetId, assetId)));
  return row?.attempts ?? 0;
}

/**
 * Mark a privacy verdict as failed and decide whether the capture gets another
 * attempt. Exhausted → `rejected`: fail closed, and never a reconstruction
 * input. Only a capture that is still a live contribution is touched; a
 * withdrawn or moderated one keeps its `blocked` gate.
 */
export async function failPrivacyGate(tx: Transaction, assetId: string, now: Date): Promise<void> {
  const exhausted = (await privacyAttempts(tx, assetId)) >= street3dConfig.privacyMaxAttempts;
  await tx
    .update(captureAssets)
    .set({
      privacyState: 'failed',
      privacyCompletedAt: now,
      ...(exhausted ? { state: 'rejected' } : {}),
      updatedAt: now,
    })
    .where(
      and(
        eq(captureAssets.id, assetId),
        ne(captureAssets.privacyState, 'blocked'),
        ne(captureAssets.state, 'deleted'),
      ),
    );
}

/** The scene state a terminal reconstruction failure implies. */
export function sceneStateForFailure(code: string): Street3dSceneState {
  if (
    code === 'insufficient_overlap' ||
    code === 'camera_solve_failed' ||
    code === 'georeference_failed'
  ) {
    return 'needs_more_capture';
  }
  if (code === 'quality_failed') return 'failed_quality';
  return 'candidate';
}

export interface FailureInput {
  code: string;
  detail?: string;
  /** The attempt that failed. A failure older than the current attempt is ignored. */
  attempt?: number;
  /** Whether the backend may spend another attempt. Defaults to its own classification. */
  retryable?: boolean;
}

/**
 * Apply a failure to a LOCKED, non-terminal job: retry it, or end it.
 *
 * Retry is a backend decision: a class in {@link RETRYABLE_FAILURE_CODES} (or a
 * backend-detected transient fault), with attempts left. A retried job goes to
 * `retry_wait` with `attempt + 1` and is re-sent by the dispatch phase once its
 * backoff passes — same `jobId`, so the worker dedups any copy still in flight.
 */
export async function applyFailure(
  tx: Transaction,
  job: JobRow,
  failure: FailureInput,
  now: Date,
): Promise<'retried' | 'failed' | 'cancelled' | 'ignored'> {
  if (isTerminal(job.state)) return 'ignored';
  if (failure.attempt !== undefined && failure.attempt < job.attempt) return 'ignored';

  const detail = sanitizeDetail(failure.detail);
  if (failure.code === 'cancelled' || job.cancelRequestedAt) {
    await tx
      .update(street3dJobs)
      .set({
        state: 'cancelled',
        finishedAt: now,
        cancelRequestedAt: job.cancelRequestedAt ?? now,
        cancelReason: job.cancelReason ?? 'worker_cancelled',
        updatedAt: now,
      })
      .where(eq(street3dJobs.id, job.id));
    await endConsequences(tx, job, 'candidate', now);
    return 'cancelled';
  }

  const retryable =
    failure.retryable ?? RETRYABLE_FAILURE_CODES.has(failure.code as WorkerFailureCode);
  if (retryable && job.attempt < job.maxAttempts) {
    await tx
      .update(street3dJobs)
      .set({
        state: 'retry_wait',
        attempt: job.attempt + 1,
        retryAfter: new Date(now.getTime() + retryDelayMs(job.attempt)),
        dispatchedAt: null,
        failureCode: failure.code,
        failureRetryable: true,
        failureDetail: detail,
        stage: null,
        progress: null,
        updatedAt: now,
      })
      .where(eq(street3dJobs.id, job.id));
    return 'retried';
  }

  await tx
    .update(street3dJobs)
    .set({
      state: 'failed',
      finishedAt: now,
      failureCode: failure.code,
      failureRetryable: false,
      failureDetail: detail,
      updatedAt: now,
    })
    .where(eq(street3dJobs.id, job.id));
  await endConsequences(tx, job, sceneStateForFailure(failure.code), now, failure.code);
  return 'failed';
}

/**
 * What a job ending without a usable result means for its subject.
 *
 * Privacy: the gate is failed (and the capture rejected once attempts are
 * exhausted) — except for a cancellation, which reopens the gate as `pending`
 * when the capture is still a live contribution. Reconstruction: the scene
 * takes the state the failure implies and its candidates wait for overlap
 * again. The scene's `last_queued_input_fingerprint` was set when the job was
 * queued, so an identical input set is not queued again: insufficient overlap
 * stays `needs_more_capture` until new input actually arrives.
 */
async function endConsequences(
  tx: Transaction,
  job: JobRow,
  sceneState: Street3dSceneState,
  now: Date,
  code?: string,
): Promise<void> {
  if (job.kind === 'capture_privacy' && job.assetId) {
    if (code === undefined) {
      await tx
        .update(captureAssets)
        .set({ privacyState: 'pending', privacyCompletedAt: null, updatedAt: now })
        .where(
          and(eq(captureAssets.id, job.assetId), eq(captureAssets.privacyState, 'in_progress')),
        );
    } else {
      await failPrivacyGate(tx, job.assetId, now);
    }
    await releaseRawProtection(tx, job.assetId, now);
    return;
  }
  if (job.sceneId) {
    await tx
      .update(street3dScenes)
      .set({ state: progressSceneState(sceneState), updatedAt: now })
      .where(eq(street3dScenes.id, job.sceneId));
    await releaseSceneCandidates(tx, job, now);
  }
}

/**
 * Request cancellation of every open job matching `where`, in this transaction.
 *
 * The job ends `cancelled` immediately — the backend's record is the truth, and
 * nothing a late event says can revive it — and the `jobs/<id>/cancel` marker
 * is written by the next tick's marker phase, so the worker stops at its next
 * safe checkpoint. Returns the jobs it cancelled.
 */
export async function cancelOpenJobs(
  tx: Transaction,
  where: SQL | undefined,
  reason: string,
  now: Date,
  options: { supersededByJobId?: string; releaseConsequences?: boolean } = {},
): Promise<JobRow[]> {
  const jobs = await tx
    .select()
    .from(street3dJobs)
    .where(and(where, sql`${street3dJobs.state} not in ('completed', 'failed', 'cancelled')`))
    .for('update');
  for (const job of jobs) {
    await tx
      .update(street3dJobs)
      .set({
        state: 'cancelled',
        finishedAt: now,
        cancelRequestedAt: now,
        cancelReason: reason,
        ...(options.supersededByJobId ? { supersededByJobId: options.supersededByJobId } : {}),
        // A job that was never sent needs no marker; one that was gets one.
        ...(job.dispatchedAt === null ? { cancelMarkerWrittenAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(street3dJobs.id, job.id));
    if (options.releaseConsequences !== false) await endConsequences(tx, job, 'candidate', now);
  }
  return jobs;
}

/** Running jobs whose heartbeat went stale. Locked; the caller decides per job. */
export async function claimStaleJobs(tx: Transaction, now: Date, limit: number): Promise<JobRow[]> {
  const staleBefore = new Date(now.getTime() - street3dConfig.heartbeatStaleSeconds * 1000);
  return tx
    .select()
    .from(street3dJobs)
    .where(
      and(
        inArray(street3dJobs.state, [...STREET3D_RUNNING_JOB_STATES]),
        or(
          lte(street3dJobs.heartbeatAt, staleBefore),
          and(isNull(street3dJobs.heartbeatAt), lte(street3dJobs.startedAt, staleBefore)),
        ),
      ),
    )
    .orderBy(street3dJobs.heartbeatAt)
    .limit(limit)
    .for('update', { skipLocked: true });
}

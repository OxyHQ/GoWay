/**
 * Draining the events queue: heartbeats, completions and failures from the
 * external worker, applied idempotently.
 *
 * ## Delete only after commit
 *
 * A message is deleted from SQS only once the transaction that applied it has
 * COMMITTED (or once it is known to be unusable). A crash in between leaves the
 * message to be redelivered, and the redelivery is absorbed by
 * `street3d_job_events` (keyed by `eventId`) and by the job's terminal state —
 * so "applied twice" and "never applied" are both impossible.
 *
 * ## Three kinds of bad message, three answers
 *
 *   - unparseable or not the contract → deleted and counted (`invalid`). It can
 *     never become valid by being retried.
 *   - a result that fails its digest, names another job or points outside its
 *     prefix → the attempt is FAILED (`ResultRejected`) and retried by policy;
 *     the message is deleted.
 *   - S3 or the database being unreachable → the message is left in the queue
 *     and reappears after its visibility timeout. A poison message is bounded
 *     by the events queue's own redrive policy.
 *
 * Nothing here logs a coordinate, an object key, a URL or a worker-supplied
 * string. Counters only.
 */

import { createHash } from 'node:crypto';
import type { Street3dConfig } from '../config/street3d';
import {
  applyFailure,
  isTerminal,
  lockJob,
  recordEvent,
  refreshInputProtection,
  ResultRejected,
  type JobRow,
} from '../db/street3d/jobs';
import { applyPrivacyResult } from '../db/street3d/privacy';
import { recordSceneOutcome, type SceneOutcome } from '../db/street3d/publication';
import { progressSceneState } from '../db/street3d/jobs';
import type { Database } from '../db/postgres';
import { street3dJobEvents, street3dJobs, street3dScenes } from '../db/schema';
import { eq } from 'drizzle-orm';
import type { JobObjectStore } from './jobObjectStore';
import { evaluateSceneResult } from './sceneValidation';
import type { SceneAssetStore } from './sceneAssetStore';
import type { QueueMessage, WorkQueue } from './workQueue';
import {
  capturePrivacyResultSchema,
  jobEnvelopeSchema,
  sceneReconstructResultSchema,
  workerEventSchema,
  type WorkerEvent,
} from './workerContract';

export interface EventDeps {
  db: Database;
  jobStore: JobObjectStore;
  sceneStore: SceneAssetStore;
  config: Street3dConfig;
  now: () => Date;
}

export type EventOutcome =
  | 'applied'
  | 'duplicate'
  | 'late'
  | 'invalid'
  | 'unknown_job'
  | 'rejected'
  | 'published'
  | 'failed_quality';

export interface EventSummary {
  received: number;
  outcomes: Partial<Record<EventOutcome, number>>;
  /** Messages left in the queue because of a transient fault. */
  deferred: number;
}

function parseMessage(body: string): WorkerEvent | null {
  try {
    const parsed = workerEventSchema.safeParse(JSON.parse(body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function alreadyRecorded(db: Database, eventId: string): Promise<boolean> {
  const [row] = await db
    .select({ eventId: street3dJobEvents.eventId })
    .from(street3dJobEvents)
    .where(eq(street3dJobEvents.eventId, eventId));
  return row !== undefined;
}

/**
 * Fetch a result object and verify it is EXACTLY what the event described:
 * under the job's own output prefix, the declared size, the declared SHA-256.
 */
async function fetchVerifiedResult(
  deps: EventDeps,
  job: JobRow,
  reference: { key: string; sha256: string; byteSize: number },
): Promise<unknown> {
  if (!reference.key.startsWith(`jobs/${job.id}/`) && !reference.key.startsWith(job.outputPrefix)) {
    throw new ResultRejected('result_mismatch', 'The result object lies outside its job prefix.');
  }
  if (reference.byteSize > deps.config.maxResultBytes) {
    throw new ResultRejected(
      'result_too_large',
      'The result object exceeds the configured ceiling.',
    );
  }
  const bytes = await deps.jobStore.getBytes(reference.key, deps.config.maxResultBytes);
  if (!bytes) throw new ResultRejected('result_missing', 'The result object does not exist.');
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (bytes.byteLength !== reference.byteSize || digest !== reference.sha256) {
    throw new ResultRejected(
      'result_digest',
      'The result object does not match its reported size or digest.',
    );
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8')) as unknown;
  } catch {
    throw new ResultRejected('result_unparseable', 'The result object is not JSON.');
  }
}

/** Record a rejected result as a failed attempt (retried by policy). */
async function rejectAttempt(
  deps: EventDeps,
  event: WorkerEvent,
  error: ResultRejected,
): Promise<EventOutcome> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    if (!(await recordEvent(tx, { ...event, type: event.type }))) return 'duplicate';
    const job = await lockJob(tx, event.jobId);
    if (!job || isTerminal(job.state)) return 'late';
    await applyFailure(
      tx,
      job,
      { code: error.code, detail: error.message, retryable: error.retryable },
      now,
    );
    return 'rejected';
  });
}

async function applyHeartbeat(
  deps: EventDeps,
  event: Extract<WorkerEvent, { type: 'heartbeat' }>,
): Promise<EventOutcome> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    if (!(await recordEvent(tx, event))) return 'duplicate';
    const job = await lockJob(tx, event.jobId);
    if (!job) return 'unknown_job';
    if (isTerminal(job.state)) return 'late';
    await tx
      .update(street3dJobs)
      .set({
        state: event.stage ?? 'leased',
        stage: event.stage ?? null,
        ...(event.progress !== undefined ? { progress: event.progress } : {}),
        workerId: event.workerId,
        // Server time, not the worker's: staleness is judged on THIS clock, and
        // a worker with a skewed clock must not look alive or dead because of it.
        heartbeatAt: now,
        ...(event.leaseExpiresAt ? { leaseExpiresAt: new Date(event.leaseExpiresAt) } : {}),
        startedAt: job.startedAt ?? now,
        retryAfter: null,
        updatedAt: now,
      })
      .where(eq(street3dJobs.id, job.id));
    if (job.sceneId) {
      await tx
        .update(street3dScenes)
        .set({ state: progressSceneState('reconstructing'), updatedAt: now })
        .where(eq(street3dScenes.id, job.sceneId));
    }
    await refreshInputProtection(tx, job, now);
    return 'applied';
  });
}

async function applyFailed(
  deps: EventDeps,
  event: Extract<WorkerEvent, { type: 'failed' }>,
): Promise<EventOutcome> {
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    if (!(await recordEvent(tx, event))) return 'duplicate';
    const job = await lockJob(tx, event.jobId);
    if (!job) return 'unknown_job';
    if (isTerminal(job.state)) return 'late';
    const outcome = await applyFailure(
      tx,
      job,
      {
        code: event.failure.code,
        attempt: event.attempt,
        ...(event.failure.detail !== undefined ? { detail: event.failure.detail } : {}),
      },
      now,
    );
    return outcome === 'ignored' ? 'late' : 'applied';
  });
}

async function applyCompleted(
  deps: EventDeps,
  event: Extract<WorkerEvent, { type: 'completed' }>,
  job: JobRow,
): Promise<EventOutcome> {
  const reference = { key: event.result.key, sha256: event.result.sha256 };
  if (job.kind === 'capture_privacy') {
    const raw = await fetchVerifiedResult(deps, job, event.result);
    const parsed = capturePrivacyResultSchema.safeParse(raw);
    if (!parsed.success)
      throw new ResultRejected('result_invalid', 'The privacy result is not the contract.');
    const now = deps.now();
    return deps.db.transaction(async (tx) => {
      if (!(await recordEvent(tx, event))) return 'duplicate';
      const locked = await lockJob(tx, job.id);
      if (!locked || isTerminal(locked.state)) return 'late';
      const outcome = await applyPrivacyResult(tx, locked, parsed.data, reference, now);
      return outcome === 'late' ? 'late' : 'applied';
    });
  }

  const raw = await fetchVerifiedResult(deps, job, event.result);
  const parsed = sceneReconstructResultSchema.safeParse(raw);
  if (!parsed.success)
    throw new ResultRejected('result_invalid', 'The reconstruction result is not the contract.');
  const outcome: SceneOutcome = await evaluateSceneResult(deps, job, parsed.data, reference);
  const now = deps.now();
  return deps.db.transaction(async (tx) => {
    if (!(await recordEvent(tx, event))) return 'duplicate';
    const locked = await lockJob(tx, job.id);
    if (!locked || isTerminal(locked.state)) return 'late';
    const recorded = await recordSceneOutcome(tx, locked, outcome, now);
    return recorded.state === 'published' ? 'published' : 'failed_quality';
  });
}

/** Apply one event. Throws only for a transient fault; the caller then leaves the message queued. */
export async function processEvent(deps: EventDeps, body: string): Promise<EventOutcome> {
  const event = parseMessage(body);
  if (!event) return 'invalid';
  if (await alreadyRecorded(deps.db, event.eventId)) return 'duplicate';
  const [job] = await deps.db.select().from(street3dJobs).where(eq(street3dJobs.id, event.jobId));
  if (!job) return 'unknown_job';
  if (isTerminal(job.state)) return 'late';
  try {
    if (event.type === 'heartbeat') return await applyHeartbeat(deps, event);
    if (event.type === 'failed') return await applyFailed(deps, event);
    return await applyCompleted(deps, event, job);
  } catch (error) {
    if (error instanceof ResultRejected) return rejectAttempt(deps, event, error);
    throw error;
  }
}

/** Drain up to `eventBatchSize` messages. Each message is deleted only after its outcome is durable. */
export async function drainEvents(deps: EventDeps, queue: WorkQueue): Promise<EventSummary> {
  const summary: EventSummary = { received: 0, outcomes: {}, deferred: 0 };
  while (summary.received < deps.config.eventBatchSize) {
    const messages = await queue.receive({
      maxMessages: Math.min(10, deps.config.eventBatchSize - summary.received),
      waitSeconds: deps.config.eventWaitSeconds,
    });
    if (messages.length === 0) break;
    for (const message of messages) {
      summary.received += 1;
      let outcome: EventOutcome;
      try {
        outcome = await processEvent(deps, message.body);
      } catch {
        summary.deferred += 1;
        continue;
      }
      summary.outcomes[outcome] = (summary.outcomes[outcome] ?? 0) + 1;
      await queue.delete(message.receiptHandle);
    }
  }
  return summary;
}

/**
 * Fail jobs whose envelope reached the jobs queue's dead-letter queue.
 *
 * SQS moves a message there after bounded receives — a worker that crashes on
 * it every time. A job still heartbeating (a long job whose message was
 * received again by mistake) is left alone; only a job that is waiting or
 * whose lease went stale is failed.
 */
export async function drainDeadLetters(
  deps: EventDeps,
  queue: WorkQueue,
): Promise<{ received: number; failed: number }> {
  const result = { received: 0, failed: 0 };
  const messages: QueueMessage[] = await queue.receive({ maxMessages: 10, waitSeconds: 0 });
  for (const message of messages) {
    result.received += 1;
    let jobId: string | null = null;
    try {
      const parsed = jobEnvelopeSchema.safeParse(JSON.parse(message.body));
      if (parsed.success) jobId = parsed.data.jobId;
    } catch {
      jobId = null;
    }
    if (jobId) {
      const id = jobId;
      const now = deps.now();
      const staleBefore = now.getTime() - deps.config.heartbeatStaleSeconds * 1000;
      const failed = await deps.db.transaction(async (tx) => {
        const job = await lockJob(tx, id);
        if (!job || isTerminal(job.state)) return false;
        const alive = job.heartbeatAt !== null && job.heartbeatAt.getTime() > staleBefore;
        if (alive) return false;
        await applyFailure(
          tx,
          job,
          {
            code: 'dead_lettered',
            detail: 'Moved to the dead-letter queue after bounded receives.',
            retryable: false,
          },
          now,
        );
        return true;
      });
      if (failed) result.failed += 1;
    }
    await queue.delete(message.receiptHandle);
  }
  return result;
}

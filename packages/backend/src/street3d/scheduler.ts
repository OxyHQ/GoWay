/**
 * The Street 3D scheduler: one `tick()`, safe to run concurrently, that moves
 * every capture, job and scene one step forward.
 *
 * ## Phases, in order
 *
 *   1. events      drain worker heartbeats, completions and failures;
 *   2. dead letters fail jobs whose envelope was dead-lettered;
 *   3. leases      a running job whose heartbeat went stale → `retry_wait`
 *                  (same `jobId`, `attempt + 1`) or `failed` when exhausted;
 *   4. markers     write `jobs/<id>/cancel` for cancelled jobs the worker saw;
 *   5. privacy     queue privacy passes for finalized captures;
 *   6. formation   cluster eligible captures into scenes and queue
 *                  reconstructions that cross the information-gain rule;
 *   7. coverage    materialize the coarse public coverage map; bounded rescue;
 *   8. dispatch    send queued jobs (the outbox) and due retries to SQS;
 *   9. purge       delete a disabled version's public objects, invalidate CDN.
 *
 * Each phase is independently safe under concurrency — row locks with SKIP
 * LOCKED, partial unique indexes for "one open job", `eventId` for events —
 * so two ticks, or a tick and the admin command, interleave correctly rather
 * than relying on there being one scheduler. A failing phase is logged and the
 * tick continues with the next: SQS being unreachable must not stop coverage
 * from being computed, and nothing here can take the API down.
 *
 * ## Inert by default
 *
 * The in-process loop starts only when `STREET3D_SCHEDULER_ENABLED` is true and
 * the pipeline is configured. `bun run street3d:tick` runs one tick on demand.
 * Neither is a dependency of `/ready`.
 */

import { and, asc, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { Street3dConfig } from '../config/street3d';
import type { Database } from '../db/postgres';
import { street3dJobs, street3dSceneVersions } from '../db/schema';
import { applyFailure, claimStaleJobs } from '../db/street3d/jobs';
import {
  enqueuePrivacyJob,
  findPrivacyCandidates,
  privacyEnvelope,
  reopenOrphanedPrivacyGates,
} from '../db/street3d/privacy';
import { sceneEnvelope } from '../db/street3d/scenes';
import { refreshCoverage, type CoverageSummary } from './coverage';
import { drainDeadLetters, drainEvents, type EventSummary } from './events';
import { formScenes } from './formation';
import type { Street3dServices } from './services';

/** Logs counters and error CLASSES only — never a coordinate, key, URL or message body. */
export interface SchedulerLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export interface SchedulerDeps {
  db: Database;
  services: Street3dServices;
  config: Street3dConfig;
  now?: () => Date;
  logger?: SchedulerLogger;
}

export interface TickSummary {
  events?: EventSummary;
  deadLetters?: { received: number; failed: number };
  leases?: { stale: number; retried: number; failed: number };
  markers?: { written: number };
  privacy?: { candidates: number; queued: number; blocked: number; reopened: number };
  formation?: { frames: number; scenesCreated: number; jobsQueued: number; jobsSuperseded: number };
  coverage?: CoverageSummary;
  dispatch?: { sent: number };
  purge?: { versions: number; objects: number };
  /** Phases that threw, by name. Their error classes are logged, never their messages. */
  failedPhases: string[];
}

/** The error's class name, or `Error`. Messages may carry keys or URLs; names do not. */
function errorClass(error: unknown): string {
  return error instanceof Error ? error.name : 'Error';
}

const BATCH = 100;

/** Phase 3: stale leases. */
export async function recoverLeases(
  deps: SchedulerDeps,
  now: Date,
): Promise<NonNullable<TickSummary['leases']>> {
  return deps.db.transaction(async (tx) => {
    const stale = await claimStaleJobs(tx, now, BATCH);
    let retried = 0;
    let failed = 0;
    for (const job of stale) {
      // A lost lease is a transient fault by definition: the worker crashed or
      // lost its network. Retried with the same jobId; the worker dedups.
      const outcome = await applyFailure(
        tx,
        job,
        { code: 'lease_expired', detail: 'Heartbeat went stale.', retryable: true },
        now,
      );
      if (outcome === 'retried') retried += 1;
      if (outcome === 'failed') failed += 1;
    }
    return { stale: stale.length, retried, failed };
  });
}

/** Phase 4: cancel markers for cancelled jobs the worker may hold. */
export async function writeCancelMarkers(
  deps: SchedulerDeps,
  now: Date,
): Promise<{ written: number }> {
  const pending = await deps.db
    .select({ id: street3dJobs.id, reason: street3dJobs.cancelReason })
    .from(street3dJobs)
    .where(
      and(isNotNull(street3dJobs.cancelRequestedAt), isNull(street3dJobs.cancelMarkerWrittenAt)),
    )
    .orderBy(asc(street3dJobs.cancelRequestedAt))
    .limit(BATCH);
  let written = 0;
  for (const job of pending) {
    await deps.services.jobStore.putJson(`jobs/${job.id}/cancel`, {
      schemaVersion: 1,
      jobId: job.id,
      reason: job.reason ?? 'cancelled',
      at: now.toISOString(),
    });
    await deps.db
      .update(street3dJobs)
      .set({ cancelMarkerWrittenAt: now, updatedAt: now })
      .where(eq(street3dJobs.id, job.id));
    written += 1;
  }
  return { written };
}

/** Phase 5: privacy passes. */
export async function schedulePrivacy(
  deps: SchedulerDeps,
  now: Date,
): Promise<NonNullable<TickSummary['privacy']>> {
  const reopened = await reopenOrphanedPrivacyGates(deps.db, now);
  const candidates = await findPrivacyCandidates(deps.db, now, deps.config.privacyBatchSize);
  let queued = 0;
  let blocked = 0;
  for (const assetId of candidates) {
    const outcome = await enqueuePrivacyJob(deps.db, assetId, now);
    if (outcome === 'queued') queued += 1;
    if (outcome === 'blocked') blocked += 1;
  }
  return { candidates: candidates.length, queued, blocked, reopened };
}

/**
 * Phase 8: the outbox. A job is sent while its row is locked, then marked
 * dispatched in the same transaction; a concurrent tick skips the locked row.
 * The attempt travels as a message attribute so the body stays exactly the
 * contract fixture's shape.
 */
export async function dispatchJobs(deps: SchedulerDeps, now: Date): Promise<{ sent: number }> {
  let sent = 0;
  for (let index = 0; index < BATCH; index += 1) {
    const done = await deps.db.transaction(async (tx) => {
      const [job] = await tx
        .select()
        .from(street3dJobs)
        .where(
          and(
            isNull(street3dJobs.cancelRequestedAt),
            or(
              and(eq(street3dJobs.state, 'queued'), isNull(street3dJobs.dispatchedAt)),
              and(eq(street3dJobs.state, 'retry_wait'), lte(street3dJobs.retryAfter, now)),
            ),
          ),
        )
        .orderBy(asc(street3dJobs.enqueuedAt))
        .limit(1)
        .for('update', { skipLocked: true });
      if (!job) return true;
      const envelope =
        job.kind === 'capture_privacy'
          ? await privacyEnvelope(tx, job, now)
          : sceneEnvelope(job, now);
      if (!envelope) {
        await applyFailure(
          tx,
          job,
          { code: 'internal', detail: 'The job could not be described.', retryable: false },
          now,
        );
        return false;
      }
      await deps.services.jobsQueue.send(JSON.stringify(envelope), { attempt: job.attempt });
      await tx
        .update(street3dJobs)
        .set({ state: 'queued', dispatchedAt: now, retryAfter: null, updatedAt: now })
        .where(eq(street3dJobs.id, job.id));
      sent += 1;
      return false;
    });
    if (done) break;
  }
  return { sent };
}

/** The CDN path of a scene-bucket key, honouring a path on the public asset origin. */
function cdnPath(config: Street3dConfig, key: string): string {
  const base = config.publicAssetBaseUrl
    ? new URL(config.publicAssetBaseUrl).pathname.replace(/\/+$/, '')
    : '';
  return `${base}/${key}`;
}

/**
 * Phase 9: purge disabled versions — delete their public objects, then
 * invalidate the CDN path, then record it. A failure leaves the version in the
 * outbox for the next tick; the version is ALREADY hidden from the API, which
 * reads only `published`.
 */
export async function purgeDisabledVersions(
  deps: SchedulerDeps,
  now: Date,
): Promise<{ versions: number; objects: number }> {
  const pending = await deps.db
    .select()
    .from(street3dSceneVersions)
    .where(
      and(
        eq(street3dSceneVersions.state, 'disabled'),
        isNull(street3dSceneVersions.assetsPurgedAt),
      ),
    )
    .limit(BATCH);
  let objects = 0;
  for (const version of pending) {
    for (const asset of version.assets) {
      await deps.services.sceneStore.delete(asset.key);
      objects += 1;
    }
    if (deps.services.cdn && version.assets.length > 0) {
      const prefix = `${deps.config.sceneKeyPrefix}/${version.sceneId}/v${version.version}/`;
      await deps.services.cdn.invalidate(
        [`${cdnPath(deps.config, prefix)}*`],
        `goway-street3d-disable-${version.id}`,
      );
    }
    await deps.db
      .update(street3dSceneVersions)
      .set({ assetsPurgedAt: now, updatedAt: now })
      .where(eq(street3dSceneVersions.id, version.id));
  }
  return { versions: pending.length, objects };
}

/** One tick. Never throws: a failing phase is recorded and the next one runs. */
export async function tick(deps: SchedulerDeps): Promise<TickSummary> {
  const clock = deps.now ?? (() => new Date());
  const summary: TickSummary = { failedPhases: [] };
  const run = async <K extends keyof Omit<TickSummary, 'failedPhases'>>(
    phase: K,
    work: () => Promise<TickSummary[K]>,
  ): Promise<void> => {
    try {
      summary[phase] = await work();
    } catch (error) {
      summary.failedPhases.push(phase);
      deps.logger?.error(
        { phase, errorClass: errorClass(error) },
        'Street 3D scheduler phase failed',
      );
    }
  };

  const eventDeps = {
    db: deps.db,
    jobStore: deps.services.jobStore,
    sceneStore: deps.services.sceneStore,
    config: deps.config,
    now: clock,
  };
  await run('events', () => drainEvents(eventDeps, deps.services.eventsQueue));
  if (deps.services.deadLetterQueue) {
    const dlq = deps.services.deadLetterQueue;
    await run('deadLetters', () => drainDeadLetters(eventDeps, dlq));
  }
  await run('leases', () => recoverLeases(deps, clock()));
  await run('markers', () => writeCancelMarkers(deps, clock()));
  await run('privacy', () => schedulePrivacy(deps, clock()));

  let formed: Awaited<ReturnType<typeof formScenes>> | null = null;
  await run('formation', async () => {
    formed = await formScenes({
      db: deps.db,
      jobStore: deps.services.jobStore,
      config: deps.config,
      now: clock(),
    });
    return {
      frames: formed.frames.length,
      scenesCreated: formed.scenesCreated,
      jobsQueued: formed.jobsQueued,
      jobsSuperseded: formed.jobsSuperseded,
    };
  });
  const formation = formed as Awaited<ReturnType<typeof formScenes>> | null;
  if (formation) {
    await run('coverage', () =>
      refreshCoverage(
        { db: deps.db, config: deps.config, now: clock() },
        formation.frames,
        formation.assignment,
      ),
    );
  }
  await run('dispatch', () => dispatchJobs(deps, clock()));
  await run('purge', () => purgeDisabledVersions(deps, clock()));
  return summary;
}

/**
 * Start the in-process loop. Returns a stop function.
 *
 * Ticks never overlap within a process (the next is scheduled after the
 * previous settles), and `unref` keeps the timer from holding a draining
 * process open. Concurrency ACROSS processes is the phases' own business.
 */
export function startScheduler(deps: SchedulerDeps, intervalSeconds: number): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  const loop = async () => {
    if (stopped) return;
    try {
      const summary = await tick(deps);
      deps.logger?.info(
        {
          failedPhases: summary.failedPhases,
          sent: summary.dispatch?.sent ?? 0,
          events: summary.events?.received ?? 0,
          queued: (summary.privacy?.queued ?? 0) + (summary.formation?.jobsQueued ?? 0),
        },
        'Street 3D scheduler tick',
      );
    } catch (error) {
      deps.logger?.error({ errorClass: errorClass(error) }, 'Street 3D scheduler tick failed');
    }
    if (!stopped) {
      timer = setTimeout(() => void loop(), intervalSeconds * 1000);
      timer.unref();
    }
  };
  timer = setTimeout(() => void loop(), 1000);
  timer.unref();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

/**
 * Operator commands for Street 3D — `bun run street3d:admin <command>`.
 *
 * Every command prints aggregate JSON and nothing else: no coordinates, no
 * object keys, no URLs, no contributor ids, no worker-supplied text. A command
 * that changes state does so through the same repository functions the
 * scheduler and the API use, so an operator cannot reach a state the code
 * could not.
 */

import { createHash } from 'node:crypto';
import { and, count, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import type { StreetSceneProfile } from '@goway/contracts';
import type { Street3dConfig } from '../config/street3d';
import type { Database } from '../db/postgres';
import { summarizeCaptureStorage } from '../db/capture/captureRepository';
import {
  captureDerivatives,
  street3dJobs,
  street3dSceneReports,
  street3dSceneVersions,
  street3dScenes,
} from '../db/schema';
import {
  blockCapture,
  cancelJob,
  disableVersion,
  enableVersion,
  requestRebuild,
  requeueJob,
} from '../db/street3d/moderation';
import { purgeDisabledVersions, writeCancelMarkers, type SchedulerDeps } from './scheduler';
import type { Street3dServices } from './services';
import { sceneReconstructResultSchema } from './workerContract';
import type { QueueStats } from './workQueue';

export interface AdminDeps {
  db: Database;
  services: Street3dServices | null;
  config: Street3dConfig;
  now?: () => Date;
}

async function queueStats(
  queue: { stats(): Promise<QueueStats> } | null | undefined,
): Promise<QueueStats | null> {
  if (!queue) return null;
  return queue.stats();
}

/** `status`: queues, jobs, cost, storage, scenes and open reports. */
export async function adminStatus(deps: AdminDeps) {
  const now = (deps.now ?? (() => new Date()))();
  const jobs = await deps.db
    .select({ kind: street3dJobs.kind, state: street3dJobs.state, count: count() })
    .from(street3dJobs)
    .groupBy(street3dJobs.kind, street3dJobs.state);
  const [oldest] = await deps.db
    .select({ enqueuedAt: sql<Date | null>`min(${street3dJobs.enqueuedAt})` })
    .from(street3dJobs)
    .where(sql`${street3dJobs.state} in ('queued', 'retry_wait')`);
  const [cost] = await deps.db
    .select({
      gpuSeconds: sql<string>`coalesce(sum((${street3dJobs.metrics} ->> 'gpuSeconds')::double precision), 0)`,
      wallSeconds: sql<string>`coalesce(sum((${street3dJobs.metrics} ->> 'wallSeconds')::double precision), 0)`,
      inputBytesDownloaded: sql<string>`coalesce(sum((${street3dJobs.metrics} ->> 'inputBytesDownloaded')::double precision), 0)`,
      outputBytes: sql<string>`coalesce(sum((${street3dJobs.metrics} ->> 'outputBytes')::double precision), 0)`,
      meanCacheHitRatio: sql<
        string | null
      >`avg((${street3dJobs.metrics} ->> 'cacheHitRatio')::double precision)`,
    })
    .from(street3dJobs)
    .where(isNotNull(street3dJobs.metrics));
  const derivatives = await deps.db
    .select({
      storageState: captureDerivatives.storageState,
      bytes: sql<string>`coalesce(sum(${captureDerivatives.imageByteSize} + coalesce(${captureDerivatives.maskByteSize}, 0)), 0)`,
      count: count(),
    })
    .from(captureDerivatives)
    .groupBy(captureDerivatives.storageState);
  const published = await deps.db
    .select({
      state: street3dSceneVersions.state,
      count: count(),
      bytes: sql<string>`coalesce(sum((select sum((value ->> 'byteSize')::bigint) from jsonb_array_elements(${street3dSceneVersions.assets}))), 0)`,
    })
    .from(street3dSceneVersions)
    .groupBy(street3dSceneVersions.state);
  const scenes = await deps.db
    .select({ state: street3dScenes.state, count: count() })
    .from(street3dScenes)
    .groupBy(street3dScenes.state);
  const reports = await deps.db
    .select({ reason: street3dSceneReports.reason, count: count() })
    .from(street3dSceneReports)
    .where(isNull(street3dSceneReports.resolvedAt))
    .groupBy(street3dSceneReports.reason);

  const byReason = Object.fromEntries(reports.map((row) => [row.reason, row.count]));
  return {
    queues: {
      jobs: await queueStats(deps.services?.jobsQueue),
      events: await queueStats(deps.services?.eventsQueue),
      deadLetter: await queueStats(deps.services?.deadLetterQueue),
      // SQS reports no message age through GetQueueAttributes; the backend's
      // own outbox is the honest source for "how long has work waited".
      oldestWaitingJobAgeSeconds: oldest?.enqueuedAt
        ? Math.max(0, Math.round((now.getTime() - new Date(oldest.enqueuedAt).getTime()) / 1000))
        : null,
    },
    jobs: jobs.map((row) => ({ kind: row.kind, state: row.state, count: row.count })),
    cost: {
      gpuSeconds: Number(cost?.gpuSeconds ?? 0),
      wallSeconds: Number(cost?.wallSeconds ?? 0),
      inputBytesDownloaded: Number(cost?.inputBytesDownloaded ?? 0),
      outputBytes: Number(cost?.outputBytes ?? 0),
      meanCacheHitRatio:
        cost?.meanCacheHitRatio === null || cost?.meanCacheHitRatio === undefined
          ? null
          : Number(cost.meanCacheHitRatio),
    },
    storage: {
      captures: await summarizeCaptureStorage(deps.db, { now }),
      derivatives: derivatives.map((row) => ({
        storageState: row.storageState,
        bytes: Number(row.bytes),
        count: row.count,
      })),
      sceneVersions: published.map((row) => ({
        state: row.state,
        bytes: Number(row.bytes),
        count: row.count,
      })),
    },
    scenes: scenes.map((row) => ({ state: row.state, count: row.count })),
    reports: {
      open: reports.reduce((sum, row) => sum + row.count, 0),
      openPrivacy: byReason.privacy ?? 0,
      byReason,
    },
  };
}

function schedulerDeps(deps: AdminDeps): SchedulerDeps | null {
  return deps.services
    ? {
        db: deps.db,
        services: deps.services,
        config: deps.config,
        ...(deps.now ? { now: deps.now } : {}),
      }
    : null;
}

/** `disable-version`: hide at once; purge public objects and invalidate the CDN now when possible. */
export async function adminDisableVersion(deps: AdminDeps, versionId: string, reason: string) {
  const now = (deps.now ?? (() => new Date()))();
  const disabled = await disableVersion(deps.db, versionId, reason, now);
  const scheduler = schedulerDeps(deps);
  const purge = disabled && scheduler ? await purgeDisabledVersions(scheduler, now) : null;
  return { disabled, purged: purge?.versions ?? 0, purgePending: disabled && !scheduler };
}

/**
 * `enable-version`: only when every public object still exists — or can be
 * restored from the job's own result in the temporary bucket, verified by
 * digest — and no registered input has since been withdrawn or blocked.
 */
export async function adminEnableVersion(deps: AdminDeps, versionId: string) {
  const now = (deps.now ?? (() => new Date()))();
  if (!deps.services) return { enabled: false, reason: 'pipeline_not_configured' };
  const [version] = await deps.db
    .select()
    .from(street3dSceneVersions)
    .where(eq(street3dSceneVersions.id, versionId));
  if (version?.state !== 'disabled') return { enabled: false, reason: 'not_disabled' };

  const missing = [];
  for (const asset of version.assets) {
    const stat = await deps.services.sceneStore.head(asset.key);
    if (!stat || stat.byteSize !== asset.byteSize) missing.push(asset);
  }
  if (missing.length > 0) {
    const [job] = await deps.db
      .select()
      .from(street3dJobs)
      .where(eq(street3dJobs.id, version.jobId));
    const bytes = job?.resultKey
      ? await deps.services.jobStore.getBytes(job.resultKey, deps.config.maxResultBytes)
      : null;
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== version.resultSha256) {
      return { enabled: false, reason: 'assets_gone' };
    }
    const parsed = sceneReconstructResultSchema.safeParse(
      JSON.parse(Buffer.from(bytes).toString('utf8')),
    );
    if (!parsed.success) return { enabled: false, reason: 'assets_gone' };
    for (const asset of missing) {
      const source = parsed.data.assets.find(
        (candidate) => candidate.sha256 === asset.sha256 && candidate.role === asset.role,
      );
      const stat = source ? await deps.services.jobStore.head(source.key) : null;
      if (!source || !stat || stat.byteSize !== asset.byteSize)
        return { enabled: false, reason: 'assets_gone' };
      await deps.services.sceneStore.copyFromStaging({
        sourceKey: source.key,
        destinationKey: asset.key,
        contentType: asset.format === 'jpeg' ? 'image/jpeg' : 'application/octet-stream',
        sha256: asset.sha256,
        byteSize: asset.byteSize,
      });
    }
  }
  const outcome = await enableVersion(deps.db, versionId, now);
  return {
    enabled: outcome === 'published' || outcome === 'superseded',
    state: outcome,
    restoredAssets: missing.length,
  };
}

export async function adminRebuildScene(
  deps: AdminDeps,
  sceneId: string,
  profile: StreetSceneProfile | null,
) {
  return {
    requested: await requestRebuild(deps.db, sceneId, profile, (deps.now ?? (() => new Date()))()),
  };
}

export async function adminBlockCapture(deps: AdminDeps, assetId: string, reason: string) {
  const now = (deps.now ?? (() => new Date()))();
  const blocked = await blockCapture(deps.db, assetId, reason, now);
  if (!blocked) return { blocked: false };
  const scheduler = schedulerDeps(deps);
  const purge = scheduler ? await purgeDisabledVersions(scheduler, now) : null;
  if (scheduler) await writeCancelMarkers(scheduler, now);
  return {
    blocked: true,
    disabledVersions: blocked.disabledVersions.length,
    rebuildScenes: blocked.rebuildScenes.length,
    cancelledJobs: blocked.cancelledJobs,
    purged: purge?.versions ?? 0,
  };
}

export async function adminCancelJob(deps: AdminDeps, jobId: string) {
  const now = (deps.now ?? (() => new Date()))();
  const cancelled = await cancelJob(deps.db, jobId, now);
  const scheduler = schedulerDeps(deps);
  if (cancelled && scheduler) await writeCancelMarkers(scheduler, now);
  return { cancelled };
}

export async function adminRequeueJob(deps: AdminDeps, jobId: string) {
  return { outcome: await requeueJob(deps.db, jobId, (deps.now ?? (() => new Date()))()) };
}

/** Counts used by tests and `status` alike: open reports per scene. */
export async function openReportCount(db: Database, sceneId: string): Promise<number> {
  const [row] = await db
    .select({ count: count() })
    .from(street3dSceneReports)
    .where(and(eq(street3dSceneReports.sceneId, sceneId), isNull(street3dSceneReports.resolvedAt)));
  return row?.count ?? 0;
}

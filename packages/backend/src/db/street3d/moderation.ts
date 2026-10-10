/**
 * Contributor withdrawal, moderation and operator actions on Street 3D state.
 *
 * ## The derived-data policy
 *
 * When a contributor withdraws a capture:
 *
 *   - every OPEN job that reads it (its privacy pass, any reconstruction whose
 *     manifest lists one of its frames) is cancelled at once;
 *   - its privacy-safe derivatives are marked for deletion — the cleanup
 *     sweeper removes the bytes;
 *   - every scene whose PUBLISHED version registered one of its frames gets a
 *     rebuild request. The published version stays until a rebuild without the
 *     capture replaces it. That is deliberate: a published scene is derived
 *     work that no longer contains the photo, only geometry and colour learned
 *     from many, and pulling a street's scene offline because one of forty
 *     inputs was withdrawn would punish every other contributor. Moderation is
 *     the path that removes a version immediately.
 *
 * A moderation BLOCK is stronger: the capture's gate is shut permanently, a
 * `street3d_capture_blocks` row records the reason and the content hash (so the
 * identical bytes contributed again are refused too), every published or
 * superseded version that registered it is DISABLED immediately (the purge
 * phase deletes its public objects and invalidates the CDN), and a rebuild
 * without it is queued.
 */

import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { qualified } from '@oxy.so/db';
import type { StreetSceneProfile } from '@goway/contracts';
import { street3dConfig } from '../../config/street3d';
import type { Database, Transaction } from '../postgres';
import {
  captureAssets,
  captureDerivatives,
  captureMediaObjects,
  street3dCaptureBlocks,
  street3dJobs,
  street3dSceneInputs,
  street3dSceneVersions,
  street3dScenes,
} from '../schema';
import { cancelOpenJobs, isTerminal, lockJob, progressSceneState, type JobRow } from './jobs';

export type RetractionReason = 'contributor_request' | 'moderation';

/**
 * Retract one capture from Street 3D, inside the caller's transaction.
 *
 * Call it BEFORE locking the capture's object or asset rows: it locks job rows,
 * and every job transition takes the job lock before capture rows. A caller
 * that inverted that order could deadlock against an event being applied. Returns
 * the versions that registered it (published or superseded).
 */
export async function retractCaptureFromStreet3d(
  tx: Transaction,
  assetId: string,
  reason: RetractionReason,
  now: Date,
): Promise<{ versionIds: string[]; sceneIds: string[]; cancelledJobs: number }> {
  const derivatives = await tx
    .select({ id: captureDerivatives.id })
    .from(captureDerivatives)
    .where(eq(captureDerivatives.assetId, assetId));
  const derivativeIds = derivatives.map((row) => row.id);

  const cancelReason = reason === 'moderation' ? 'source_blocked' : 'source_withdrawn';
  const cancelled = [
    ...(await cancelOpenJobs(tx, eq(street3dJobs.assetId, assetId), cancelReason, now)),
    ...(derivativeIds.length
      ? await cancelOpenJobs(
          tx,
          sql`${street3dJobs.inputDerivativeIds} && ${sql`array[${sql.join(
            derivativeIds.map((id) => sql`${id}`),
            sql`, `,
          )}]::text[]`}`,
          cancelReason,
          now,
        )
      : []),
  ];

  if (derivativeIds.length) {
    await tx
      .update(captureDerivatives)
      .set({
        deletionRequestedAt: now,
        deletionRequestedReason: reason,
        protectedUntil: null,
        updatedAt: now,
      })
      .where(
        and(
          inArray(captureDerivatives.id, derivativeIds),
          isNull(captureDerivatives.deletedAt),
          isNull(captureDerivatives.deletionRequestedAt),
        ),
      );
  }

  const versions = await tx
    .selectDistinct({ id: street3dSceneVersions.id, sceneId: street3dSceneVersions.sceneId })
    .from(street3dSceneInputs)
    .innerJoin(street3dSceneVersions, eq(street3dSceneVersions.id, street3dSceneInputs.versionId))
    .where(
      and(
        eq(street3dSceneInputs.captureAssetId, assetId),
        eq(street3dSceneInputs.registered, true),
        inArray(street3dSceneVersions.state, ['published', 'superseded']),
      ),
    );
  const sceneIds = [
    ...new Set([
      ...versions.map((row) => row.sceneId),
      ...cancelled.flatMap((job) => (job.sceneId ? [job.sceneId] : [])),
    ]),
  ];
  if (sceneIds.length) {
    await tx
      .update(street3dScenes)
      .set({ rebuildRequestedAt: now, updatedAt: now })
      .where(and(inArray(street3dScenes.id, sceneIds), ne(street3dScenes.state, 'disabled')));
  }
  return { versionIds: versions.map((row) => row.id), sceneIds, cancelledJobs: cancelled.length };
}

/**
 * Disable one version inside the caller's transaction: hidden from the API at
 * commit, public objects purged by the next purge phase.
 */
export async function disableVersionInTransaction(
  tx: Transaction,
  versionId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  const [version] = await tx
    .select()
    .from(street3dSceneVersions)
    .where(eq(street3dSceneVersions.id, versionId))
    .for('update');
  if (!version || version.state === 'disabled') return false;
  await tx
    .update(street3dSceneVersions)
    .set({
      state: 'disabled',
      disabledAt: now,
      disabledReason: reason.slice(0, 200),
      assetsPurgedAt: null,
      updatedAt: now,
    })
    .where(eq(street3dSceneVersions.id, versionId));
  const [scene] = await tx
    .select()
    .from(street3dScenes)
    .where(eq(street3dScenes.id, version.sceneId))
    .for('update');
  if (scene && scene.currentVersionId === versionId) {
    await tx
      .update(street3dScenes)
      .set({
        currentVersionId: null,
        state: scene.state === 'disabled' ? 'disabled' : 'candidate',
        confidence: null,
        updatedAt: now,
      })
      .where(eq(street3dScenes.id, scene.id));
  }
  return true;
}

export async function disableVersion(
  db: Database,
  versionId: string,
  reason: string,
  now: Date,
): Promise<boolean> {
  return db.transaction((tx) => disableVersionInTransaction(tx, versionId, reason, now));
}

/**
 * Re-enable a disabled version. Refused when any registered input is now
 * withdrawn or blocked. The caller has already verified (or restored) its
 * public objects. It becomes `published` only when it is newer than the
 * scene's current version; otherwise `superseded`.
 */
export async function enableVersion(
  db: Database,
  versionId: string,
  now: Date,
): Promise<'published' | 'superseded' | 'refused' | 'missing'> {
  return db.transaction(async (tx) => {
    const [version] = await tx
      .select()
      .from(street3dSceneVersions)
      .where(eq(street3dSceneVersions.id, versionId))
      .for('update');
    if (version?.state !== 'disabled' || version.assets.length === 0) return 'missing';
    const blockedInputs = await tx
      .select({ id: street3dSceneInputs.derivativeId })
      .from(street3dSceneInputs)
      .innerJoin(captureAssets, eq(captureAssets.id, street3dSceneInputs.captureAssetId))
      .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
      .where(
        and(
          eq(street3dSceneInputs.versionId, versionId),
          eq(street3dSceneInputs.registered, true),
          or(
            ne(captureAssets.privacyState, 'passed'),
            sql`exists (select 1 from ${street3dCaptureBlocks}
              where ${qualified(street3dCaptureBlocks.captureAssetId)} = ${qualified(captureAssets.id)}
                 or ${qualified(street3dCaptureBlocks.contentHash)} = ${qualified(captureMediaObjects.contentHash)})`,
          ),
        ),
      )
      .limit(1);
    if (blockedInputs.length > 0) return 'refused';

    const [scene] = await tx
      .select()
      .from(street3dScenes)
      .where(eq(street3dScenes.id, version.sceneId))
      .for('update');
    if (!scene || scene.state === 'disabled') return 'refused';
    const [current] = scene.currentVersionId
      ? await tx
          .select()
          .from(street3dSceneVersions)
          .where(eq(street3dSceneVersions.id, scene.currentVersionId))
      : [];
    const publish = !current || current.version < version.version;
    if (publish && current) {
      await tx
        .update(street3dSceneVersions)
        .set({ state: 'superseded', updatedAt: now })
        .where(eq(street3dSceneVersions.id, current.id));
    }
    await tx
      .update(street3dSceneVersions)
      .set({
        state: publish ? 'published' : 'superseded',
        disabledAt: null,
        disabledReason: null,
        assetsPurgedAt: null,
        publishedAt: version.publishedAt ?? now,
        updatedAt: now,
      })
      .where(eq(street3dSceneVersions.id, versionId));
    if (publish) {
      await tx
        .update(street3dScenes)
        .set({
          currentVersionId: versionId,
          state: 'published',
          confidence: version.quality.registrationRatio,
          updatedAt: now,
        })
        .where(eq(street3dScenes.id, scene.id));
    }
    return publish ? 'published' : 'superseded';
  });
}

/** Request a rebuild; the next formation pass queues it if the scene is reconstructable. */
export async function requestRebuild(
  db: Database,
  sceneId: string,
  profile: StreetSceneProfile | null,
  now: Date,
): Promise<boolean> {
  const rows = await db
    .update(street3dScenes)
    .set({ rebuildRequestedAt: now, rebuildProfile: profile, updatedAt: now })
    .where(and(eq(street3dScenes.id, sceneId), ne(street3dScenes.state, 'disabled')))
    .returning({ id: street3dScenes.id });
  return rows.length === 1;
}

/**
 * Block a capture permanently. See this module's header. Returns the versions
 * disabled and the scenes queued for rebuild, or `null` when it does not exist.
 */
export async function blockCapture(
  db: Database,
  assetId: string,
  reason: string,
  now: Date,
): Promise<{ disabledVersions: string[]; rebuildScenes: string[]; cancelledJobs: number } | null> {
  return db.transaction(async (tx) => {
    const [link] = await tx
      .select({ mediaObjectId: captureAssets.mediaObjectId })
      .from(captureAssets)
      .where(eq(captureAssets.id, assetId));
    if (!link) return null;
    // Job rows first, capture rows after — the order every job transition uses.
    const retraction = await retractCaptureFromStreet3d(tx, assetId, 'moderation', now);
    const [media] = await tx
      .select()
      .from(captureMediaObjects)
      .where(eq(captureMediaObjects.id, link.mediaObjectId))
      .for('update');
    const [asset] = await tx
      .select()
      .from(captureAssets)
      .where(eq(captureAssets.id, assetId))
      .for('update');
    if (!media || !asset) return null;

    await tx
      .insert(street3dCaptureBlocks)
      .values({
        captureAssetId: assetId,
        contentHash: media.contentHash,
        reason: reason.slice(0, 200),
        createdAt: now,
      })
      .onConflictDoNothing();
    await tx
      .update(captureAssets)
      .set({ state: 'deleted', privacyState: 'blocked', privacyCompletedAt: now, updatedAt: now })
      .where(eq(captureAssets.id, assetId));

    for (const versionId of retraction.versionIds) {
      await disableVersionInTransaction(tx, versionId, `moderation: ${reason}`, now);
    }

    // The raw bytes: removed unless another LIVE contribution still holds them.
    // Identical bytes held by another contributor are blocked from Street 3D by
    // the content-hash block, but their raw object follows its own lifecycle.
    const [remaining] = await tx
      .select({ count: sql<number>`count(*)::integer` })
      .from(captureAssets)
      .where(and(eq(captureAssets.mediaObjectId, media.id), ne(captureAssets.state, 'deleted')));
    if ((remaining?.count ?? 0) === 0) {
      await tx
        .update(captureMediaObjects)
        .set({
          deletionRequestedAt: now,
          deletionRequestedReason: 'moderation',
          protectedUntil: null,
          updatedAt: now,
        })
        .where(
          and(
            eq(captureMediaObjects.id, media.id),
            isNull(captureMediaObjects.deletedAt),
            isNull(captureMediaObjects.deletionRequestedAt),
          ),
        );
    }
    return {
      disabledVersions: retraction.versionIds,
      rebuildScenes: retraction.sceneIds,
      cancelledJobs: retraction.cancelledJobs,
    };
  });
}

/** Cancel one job by id. */
export async function cancelJob(db: Database, jobId: string, now: Date): Promise<boolean> {
  return db.transaction(
    async (tx) =>
      (await cancelOpenJobs(tx, eq(street3dJobs.id, jobId), 'operator', now)).length === 1,
  );
}

/**
 * Requeue a failed or cancelled job as a NEW attempt of the same job: same
 * `jobId`, same manifest, `attempt + 1` (the budget grows by one if it was
 * exhausted). A completed job is never requeued — rebuild the scene instead.
 */
export async function requeueJob(
  db: Database,
  jobId: string,
  now: Date,
): Promise<'requeued' | 'refused' | 'missing'> {
  return db.transaction(async (tx) => {
    const job: JobRow | null = await lockJob(tx, jobId);
    if (!job) return 'missing';
    if (!isTerminal(job.state) || job.state === 'completed') return 'refused';
    const [other] = await tx
      .select({ id: street3dJobs.id })
      .from(street3dJobs)
      .where(
        and(
          ne(street3dJobs.id, jobId),
          job.assetId
            ? eq(street3dJobs.assetId, job.assetId)
            : eq(street3dJobs.sceneId, job.sceneId as string),
          sql`${street3dJobs.state} not in ('completed', 'failed', 'cancelled')`,
        ),
      )
      .limit(1);
    if (other) return 'refused';
    if (job.kind === 'capture_privacy' && job.assetId) {
      const [asset] = await tx
        .select()
        .from(captureAssets)
        .where(eq(captureAssets.id, job.assetId));
      if (
        !asset ||
        asset.state === 'deleted' ||
        asset.privacyState === 'blocked' ||
        asset.privacyState === 'passed'
      )
        return 'refused';
      await tx
        .update(captureAssets)
        .set({
          privacyState: 'in_progress',
          privacyCompletedAt: null,
          state: 'validating',
          updatedAt: now,
        })
        .where(eq(captureAssets.id, job.assetId));
    }
    if (job.sceneId) {
      await tx
        .update(street3dScenes)
        .set({ state: progressSceneState('queued'), updatedAt: now })
        .where(eq(street3dScenes.id, job.sceneId));
    }
    const attempt = job.attempt + 1;
    await tx
      .update(street3dJobs)
      .set({
        state: 'queued',
        attempt,
        maxAttempts: Math.min(20, Math.max(job.maxAttempts, attempt)),
        dispatchedAt: null,
        retryAfter: null,
        finishedAt: null,
        cancelRequestedAt: null,
        cancelReason: null,
        cancelMarkerWrittenAt: null,
        failureCode: null,
        failureRetryable: null,
        failureDetail: null,
        heartbeatAt: null,
        startedAt: null,
        stage: null,
        progress: null,
        updatedAt: now,
      })
      .where(eq(street3dJobs.id, jobId));
    return 'requeued';
  });
}

/** For `status`: the newest versions of a scene, newest first. */
export async function versionsOfScene(db: Database, sceneId: string) {
  return db
    .select()
    .from(street3dSceneVersions)
    .where(eq(street3dSceneVersions.sceneId, sceneId))
    .orderBy(desc(street3dSceneVersions.version));
}

/** Defaults the admin command shows next to its counters. */
export const MODERATION_DEFAULTS = { profile: street3dConfig.defaultProfile };

/** Jobs older than `before` that still hold temporary artifacts. */
export async function finishedJobsWithArtifacts(
  db: Database,
  before: Date,
  limit: number,
): Promise<JobRow[]> {
  return db
    .select()
    .from(street3dJobs)
    .where(and(isNull(street3dJobs.artifactsDeletedAt), lt(street3dJobs.finishedAt, before)))
    .orderBy(street3dJobs.finishedAt)
    .limit(limit);
}

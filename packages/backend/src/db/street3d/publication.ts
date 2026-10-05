/**
 * Recording a reconstruction result: a published version, or a version that
 * failed quality — and every consequence of either, in one transaction.
 *
 * ## Publication is a swap, never a gap
 *
 * The previous published version becomes `superseded` and the new one
 * `published` in the same transaction, under the partial unique index that
 * allows one published version per scene. A viewer reading in between sees the
 * old version or the new one, never neither and never both.
 *
 * ## A failed version keeps the old one
 *
 * `failed_quality` is a version row too — its metrics and gate failures are
 * worth keeping — but the scene's `current_version_id` does not move. A scene
 * that had a published version keeps serving it.
 *
 * ## The last privacy check is under the lock
 *
 * A capture can be withdrawn or blocked while its job runs. The input check is
 * repeated here, under the job's row lock and inside the transaction that
 * would publish. If any registered input is no longer allowed, the version is
 * recorded `disabled` (never served), the purge phase deletes whatever was
 * already copied to the scene bucket, and a rebuild without that input is
 * requested.
 */

import { and, eq, inArray, isNotNull, ne, or, sql, type Column, type SQL } from 'drizzle-orm';
import { sqlColumnName } from '@oxy.so/db';
import type { StreetSceneAsset, StreetSceneQuality } from '@goway/contracts';
import type { SceneReconstructResult } from '../../street3d/workerContract';
import { publishedNavigation } from '../../street3d/navigation';
import type { DatabaseOrTransaction, Transaction } from '../postgres';
import {
  captureAssets,
  captureDerivatives,
  captureMediaObjects,
  street3dCaptureBlocks,
  street3dCaptureEdges,
  street3dJobs,
  street3dSceneInputs,
  street3dSceneVersions,
  street3dScenes,
} from '../schema';
import { progressSceneState, type JobRow } from './jobs';

/**
 * Registered inputs that may no longer be published: the capture was
 * withdrawn, rejected or blocked, or its derivative has a removal request.
 */
export async function withdrawnInputs(db: DatabaseOrTransaction, derivativeIds: readonly string[]): Promise<string[]> {
  if (derivativeIds.length === 0) return [];
  const rows = await db
    .select({ id: captureDerivatives.id })
    .from(captureDerivatives)
    .innerJoin(captureAssets, eq(captureAssets.id, captureDerivatives.assetId))
    .innerJoin(captureMediaObjects, eq(captureMediaObjects.id, captureAssets.mediaObjectId))
    .leftJoin(
      street3dCaptureBlocks,
      or(
        eq(street3dCaptureBlocks.captureAssetId, captureAssets.id),
        eq(street3dCaptureBlocks.contentHash, captureMediaObjects.contentHash),
      ),
    )
    .where(
      and(
        inArray(captureDerivatives.id, [...derivativeIds]),
        or(
          ne(captureAssets.privacyState, 'passed'),
          eq(captureAssets.state, 'deleted'),
          isNotNull(street3dCaptureBlocks.id),
          sql`${captureDerivatives.deletionRequestedReason} in ('contributor_request', 'moderation')`,
        ),
      ),
    );
  return [...new Set(rows.map((row) => row.id))];
}

/** The privacy pipeline versions of a set of derivatives, distinct and sorted. */
export async function privacyVersionsOf(db: DatabaseOrTransaction, derivativeIds: readonly string[]): Promise<string[]> {
  if (derivativeIds.length === 0) return [];
  const rows = await db
    .selectDistinct({ version: captureDerivatives.privacyPipelineVersion })
    .from(captureDerivatives)
    .where(inArray(captureDerivatives.id, [...derivativeIds]));
  return rows.map((row) => row.version).sort();
}

export interface SceneOutcome {
  kind: 'published' | 'failed_quality';
  result: SceneReconstructResult;
  reference: { key: string; sha256: string };
  /** Public assets (scene-bucket key + URL), empty for a quality failure. */
  assets: (StreetSceneAsset & { key: string })[];
  quality: StreetSceneQuality;
  gateFailures: string[];
  attributions: string[];
  privacyPipelineVersions: string[];
}

/** `excluded."<column>"`, with the SQL name from the casing authority. */
function excluded(column: Column): SQL {
  return sql.raw(`excluded."${sqlColumnName(column)}"`);
}

function numericMetrics(metrics: SceneReconstructResult['metrics']): Record<string, number> {
  return Object.fromEntries(
    Object.entries(metrics).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])),
  );
}

/**
 * Record a validated outcome for a LOCKED, non-terminal reconstruction job.
 * Returns the version's id and the state it was stored in.
 */
export async function recordSceneOutcome(
  tx: Transaction,
  job: JobRow,
  outcome: SceneOutcome,
  now: Date,
): Promise<{ versionId: string; state: 'published' | 'failed_quality' | 'disabled' }> {
  const sceneId = job.sceneId as string;
  const inputs = job.inputDerivativeIds ?? [];
  const registered = new Set(outcome.result.frames.registeredFrameIds);

  let state: 'published' | 'failed_quality' | 'disabled' = outcome.kind;
  if (state === 'published' && (await withdrawnInputs(tx, [...registered])).length > 0) state = 'disabled';

  const [scene] = await tx.select().from(street3dScenes).where(eq(street3dScenes.id, sceneId)).for('update');
  if (!scene) throw new Error('A reconstruction job names a scene that does not exist.');
  if (state === 'published' && scene.state === 'disabled') state = 'disabled';

  if (state === 'published') {
    await tx
      .update(street3dSceneVersions)
      .set({ state: 'superseded', updatedAt: now })
      .where(and(eq(street3dSceneVersions.sceneId, sceneId), eq(street3dSceneVersions.state, 'published')));
  }

  const { result } = outcome;
  const [version] = await tx
    .insert(street3dSceneVersions)
    .values({
      sceneId,
      version: job.sceneVersion as number,
      jobId: job.id,
      state,
      profile: result.profile,
      boundsWest: result.bounds.west,
      boundsSouth: result.bounds.south,
      boundsEast: result.bounds.east,
      boundsNorth: result.bounds.north,
      footprint: result.footprint as { type: 'Polygon'; coordinates: number[][][] },
      worldTransform: result.worldTransform,
      initialView: result.initialView,
      navigation: publishedNavigation(result),
      assets: outcome.assets,
      quality: outcome.quality,
      metrics: numericMetrics(result.metrics),
      provenance: { pipelineVersion: result.provenance.pipelineVersion, components: result.provenance.components },
      gateFailures: state === 'disabled' && outcome.kind === 'published' ? ['input_withdrawn'] : outcome.gateFailures,
      observedFrom: new Date(result.observedFrom),
      observedTo: new Date(result.observedTo),
      privacyPipelineVersions: outcome.privacyPipelineVersions,
      attributions: outcome.attributions,
      resultSha256: outcome.reference.sha256,
      ...(state === 'published' ? { publishedAt: now } : {}),
      ...(state === 'disabled' ? { disabledAt: now, disabledReason: 'input withdrawn before publication' } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .returning({ id: street3dSceneVersions.id });
  if (!version) throw new Error('The scene version was not recorded.');

  if (state === 'published') {
    await tx
      .update(street3dScenes)
      .set({
        currentVersionId: version.id,
        state: 'published',
        confidence: result.metrics.registrationRatio,
        updatedAt: now,
      })
      .where(eq(street3dScenes.id, sceneId));
  } else {
    await tx
      .update(street3dScenes)
      .set({
        state: progressSceneState(state === 'disabled' ? 'candidate' : 'failed_quality'),
        ...(state === 'disabled' ? { rebuildRequestedAt: now } : {}),
        updatedAt: now,
      })
      .where(eq(street3dScenes.id, sceneId));
  }

  // Provenance — internal, never published.
  const derivatives = inputs.length
    ? await tx
        .select({ id: captureDerivatives.id, assetId: captureDerivatives.assetId })
        .from(captureDerivatives)
        .where(inArray(captureDerivatives.id, inputs))
    : [];
  if (derivatives.length > 0) {
    await tx.insert(street3dSceneInputs).values(
      derivatives.map((derivative) => ({
        versionId: version.id,
        captureAssetId: derivative.assetId,
        derivativeId: derivative.id,
        registered: registered.has(derivative.id),
        createdAt: now,
      })),
    );
  }

  // The capture graph: verified pairs, undirected, stored once.
  const known = new Set(derivatives.map((derivative) => derivative.id));
  const matcherVersion = (result.provenance.components.sfm ?? result.provenance.pipelineVersion).slice(0, 120);
  const edges = new Map<string, { a: string; b: string; inliers: number }>();
  for (const edge of result.edges) {
    if (edge.a === edge.b || !known.has(edge.a) || !known.has(edge.b)) continue;
    const [a, b] = edge.a < edge.b ? [edge.a, edge.b] : [edge.b, edge.a];
    const existing = edges.get(`${a}|${b}`);
    if (!existing || existing.inliers < edge.inliers) edges.set(`${a}|${b}`, { a, b, inliers: edge.inliers });
  }
  if (edges.size > 0) {
    await tx
      .insert(street3dCaptureEdges)
      .values(
        [...edges.values()].map((edge) => ({
          derivativeA: edge.a,
          derivativeB: edge.b,
          inliers: edge.inliers,
          matcherVersion,
          observedInVersionId: version.id,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [street3dCaptureEdges.derivativeA, street3dCaptureEdges.derivativeB],
        set: {
          inliers: excluded(street3dCaptureEdges.inliers),
          matcherVersion: excluded(street3dCaptureEdges.matcherVersion),
          observedInVersionId: excluded(street3dCaptureEdges.observedInVersionId),
          updatedAt: now,
        },
      });
  }

  // Capture states: registered inputs of a PUBLISHED version are integrated;
  // everything else this job held goes back to waiting for overlap.
  const registeredAssets = [
    ...new Set(derivatives.filter((derivative) => registered.has(derivative.id)).map((derivative) => derivative.assetId)),
  ];
  if (state === 'published' && registeredAssets.length > 0) {
    await tx
      .update(captureAssets)
      .set({ state: 'integrated', updatedAt: now })
      .where(
        and(
          inArray(captureAssets.id, registeredAssets),
          inArray(captureAssets.state, ['reconstruction_candidate', 'waiting_for_overlap']),
          eq(captureAssets.privacyState, 'passed'),
        ),
      );
    await tx
      .update(captureDerivatives)
      .set({ retentionReason: 'reconstruction_input', updatedAt: now })
      .where(and(inArray(captureDerivatives.id, [...registered]), eq(captureDerivatives.storageState, 'stored')));
  }
  const allAssets = [...new Set(derivatives.map((derivative) => derivative.assetId))];
  if (allAssets.length > 0) {
    await tx
      .update(captureAssets)
      .set({ state: 'waiting_for_overlap', updatedAt: now })
      .where(and(inArray(captureAssets.id, allAssets), eq(captureAssets.state, 'reconstruction_candidate')));
  }

  await tx
    .update(street3dJobs)
    .set({
      state: 'completed',
      finishedAt: now,
      progress: 1,
      resultKey: outcome.reference.key,
      resultSha256: outcome.reference.sha256,
      metrics: numericMetrics(result.metrics),
      updatedAt: now,
    })
    .where(eq(street3dJobs.id, job.id));

  return { versionId: version.id, state };
}

/**
 * Validating a reconstruction result before anything is published.
 *
 * The worker reports `gates.passed`; the backend does not take its word for
 * it. Every check below runs against the backend's OWN configuration and its
 * own record of the job:
 *
 *   - identity: the result names this job, scene, version and profile, and the
 *     digest of the manifest the backend wrote;
 *   - frames and edges reference only frames the manifest listed;
 *   - quality gates (registration, reprojection, georeference inliers and
 *     residual, held-out PSNR, registered frame count) at the configured
 *     thresholds;
 *   - budgets: the splat's bytes and Gaussian count under the profile's caps;
 *   - required assets (`splat`, `poster`) present once each, under the job's
 *     output prefix, with the format and content type their role implies, and
 *     PRESENT IN S3 with the reported size (and checksum when S3 has one);
 *   - privacy: every registered input passed a privacy pipeline the result
 *     names, and none was withdrawn or blocked meanwhile.
 *
 * An identity or integrity mismatch is a {@link ResultRejected}: the attempt is
 * treated as failed and retried by policy. A quality or budget miss is a
 * `failed_quality` version: recorded, never served, and the scene keeps its
 * previous version.
 */

import type { StreetSceneAsset, StreetSceneProfile, StreetSceneQuality } from '@goway/contracts';
import type { Street3dConfig } from '../config/street3d';
import { ResultRejected, type JobRow } from '../db/street3d/jobs';
import { privacyVersionsOf, withdrawnInputs, type SceneOutcome } from '../db/street3d/publication';
import { attributionsFor } from '../db/street3d/scenes';
import type { Database } from '../db/postgres';
import { captureDerivatives } from '../db/schema';
import { inArray } from 'drizzle-orm';
import type { JobObjectStore } from './jobObjectStore';
import { sceneAssetKey, type SceneAssetStore } from './sceneAssetStore';
import type { SceneReconstructResult, SceneResultAsset } from './workerContract';

const ROLE_FORMAT: Readonly<Record<SceneResultAsset['role'], SceneResultAsset['format']>> = {
  splat: 'spz',
  splat_preview: 'spz',
  poster: 'jpeg',
};
const FORMAT_CONTENT_TYPE: Readonly<Record<SceneResultAsset['format'], string>> = {
  spz: 'application/octet-stream',
  jpeg: 'image/jpeg',
};

export interface SceneValidationDeps {
  db: Database;
  jobStore: JobObjectStore;
  sceneStore: SceneAssetStore;
  config: Street3dConfig;
}

/** The identity and reference checks. Throws {@link ResultRejected}. */
export function assertSceneResultMatches(job: JobRow, result: SceneReconstructResult): void {
  if (
    result.jobId !== job.id ||
    result.sceneId !== job.sceneId ||
    result.sceneVersion !== job.sceneVersion ||
    result.profile !== job.profile ||
    result.inputManifestSha256 !== job.inputManifestSha256
  ) {
    throw new ResultRejected(
      'result_mismatch',
      'The reconstruction result names a different job, scene, version or manifest.',
    );
  }
  const inputs = new Set(job.inputDerivativeIds ?? []);
  const registered = result.frames.registeredFrameIds;
  if (
    new Set(registered).size !== registered.length ||
    registered.some((id) => !inputs.has(id)) ||
    result.frames.registered !== registered.length ||
    registered.length > inputs.size
  ) {
    throw new ResultRejected(
      'result_mismatch',
      'The reconstruction result registers frames its manifest did not list.',
    );
  }
  if (result.edges.some((edge) => !inputs.has(edge.a) || !inputs.has(edge.b))) {
    throw new ResultRejected(
      'result_mismatch',
      'The reconstruction result reports edges between unknown frames.',
    );
  }
  for (const asset of result.assets) {
    if (!asset.key.startsWith(job.outputPrefix)) {
      throw new ResultRejected(
        'result_mismatch',
        'A reconstruction asset lies outside its job output prefix.',
      );
    }
  }
}

/** Gate, budget and asset-shape failures, by the backend's own thresholds. */
export function qualityFailures(result: SceneReconstructResult, config: Street3dConfig): string[] {
  const failures: string[] = [];
  if (!result.gates.passed)
    failures.push(
      ...(result.gates.failures.length ? result.gates.failures : ['worker_gates_failed']),
    );
  const gates = config.gates;
  const metrics = result.metrics;
  if (result.frames.registered < gates.minRegisteredFrames) failures.push('registered_frames');
  if (metrics.registrationRatio < gates.minRegistrationRatio) failures.push('registration_ratio');
  if (metrics.meanReprojectionErrorPx > gates.maxMeanReprojectionErrorPx)
    failures.push('reprojection_error');
  if (metrics.georeferenceInliers < gates.minGeoreferenceInliers)
    failures.push('georeference_inliers');
  if (metrics.medianGeoreferenceResidualMeters > gates.maxMedianGeoreferenceResidualMeters)
    failures.push('georeference_residual');
  if (metrics.heldOutPsnr < gates.minHeldOutPsnr) failures.push('held_out_psnr');

  const budget = config.budgets[result.profile as StreetSceneProfile];
  const roles = result.assets.map((asset) => asset.role);
  for (const required of ['splat', 'poster'] as const) {
    if (roles.filter((role) => role === required).length !== 1)
      failures.push(`asset_${required}_missing`);
  }
  if (roles.filter((role) => role === 'splat_preview').length > 1)
    failures.push('asset_splat_preview_duplicated');
  for (const asset of result.assets) {
    if (
      asset.format !== ROLE_FORMAT[asset.role] ||
      asset.contentType !== FORMAT_CONTENT_TYPE[asset.format]
    ) {
      failures.push(`asset_${asset.role}_format`);
    }
    if (asset.role !== 'poster' && asset.byteSize > budget.maxAssetBytes)
      failures.push(`asset_${asset.role}_bytes`);
    if (asset.gaussians !== undefined && asset.gaussians > budget.maxGaussians)
      failures.push(`asset_${asset.role}_gaussians`);
  }
  if (metrics.gaussians !== undefined && metrics.gaussians > budget.maxGaussians)
    failures.push('gaussians');
  return [...new Set(failures)].map((failure) => failure.slice(0, 120));
}

/** The published quality block. `approximate` placement must not be shown as exact. */
export function publishedQuality(
  result: SceneReconstructResult,
  config: Street3dConfig,
): StreetSceneQuality {
  const residual = result.metrics.medianGeoreferenceResidualMeters;
  return {
    profile: result.profile as StreetSceneProfile,
    registrationRatio: result.metrics.registrationRatio,
    alignmentResidualMeters: residual,
    heldOutPsnr: result.metrics.heldOutPsnr,
    placement: residual <= config.precisePlacementResidualMeters ? 'precise' : 'approximate',
  };
}

/** The public URL of a scene-bucket key. */
export function publicAssetUrl(config: Street3dConfig, key: string): string {
  return `${(config.publicAssetBaseUrl ?? '').replace(/\/+$/, '')}/${key}`;
}

/**
 * Validate a reconstruction result and, when it passes, copy its assets into
 * the scene bucket. Returns the outcome to record. The copy happens BEFORE the
 * recording transaction (it is network I/O); content-hashed keys make a
 * repeated copy after a crash a harmless overwrite with identical bytes.
 */
export async function evaluateSceneResult(
  deps: SceneValidationDeps,
  job: JobRow,
  result: SceneReconstructResult,
  reference: { key: string; sha256: string },
): Promise<SceneOutcome> {
  assertSceneResultMatches(job, result);
  const registered = result.frames.registeredFrameIds;
  const failures = qualityFailures(result, deps.config);

  const versions = await privacyVersionsOf(deps.db, registered);
  const named = new Set(result.provenance.privacyPipelineVersions);
  if (versions.some((version) => !named.has(version))) failures.push('privacy_versions_mismatch');
  if ((await withdrawnInputs(deps.db, registered)).length > 0) failures.push('input_withdrawn');

  const derivativeAssets = registered.length
    ? await deps.db
        .select({ assetId: captureDerivatives.assetId })
        .from(captureDerivatives)
        .where(inArray(captureDerivatives.id, registered))
    : [];
  const attributions = await attributionsFor(deps.db, [
    ...new Set(derivativeAssets.map((row) => row.assetId)),
  ]);
  const quality = publishedQuality(result, deps.config);

  if (failures.length > 0) {
    return {
      kind: 'failed_quality',
      result,
      reference,
      assets: [],
      quality,
      gateFailures: failures,
      attributions,
      privacyPipelineVersions: versions,
    };
  }

  for (const asset of result.assets) {
    const stat = await deps.jobStore.head(asset.key);
    if (
      !stat ||
      stat.byteSize !== asset.byteSize ||
      (stat.checksumSha256 !== undefined && stat.checksumSha256 !== asset.sha256)
    ) {
      throw new ResultRejected(
        'asset_mismatch',
        'A reconstruction asset is missing or does not match its reported size or digest.',
      );
    }
  }

  const assets: (StreetSceneAsset & { key: string })[] = [];
  for (const asset of result.assets) {
    const key = sceneAssetKey(
      deps.config.sceneKeyPrefix,
      job.sceneId as string,
      job.sceneVersion as number,
      asset.sha256,
      asset.format,
    );
    await deps.sceneStore.copyFromStaging({
      sourceKey: asset.key,
      destinationKey: key,
      contentType: FORMAT_CONTENT_TYPE[asset.format],
      sha256: asset.sha256,
      byteSize: asset.byteSize,
    });
    assets.push({
      role: asset.role,
      format: asset.format,
      url: publicAssetUrl(deps.config, key),
      key,
      byteSize: asset.byteSize,
      sha256: asset.sha256,
      ...(asset.gaussians !== undefined ? { gaussians: asset.gaussians } : {}),
    });
  }
  return {
    kind: 'published',
    result,
    reference,
    assets,
    quality,
    gateFailures: [],
    attributions,
    privacyPipelineVersions: versions,
  };
}

/**
 * Scene formation and the information-gain rule — when GPU time is worth
 * spending.
 *
 * ## The rule
 *
 * A fixed "N new images" trigger is the wrong rule twice over: twelve more
 * photos of a façade from the same spot add nothing, and three photos from the
 * opposite pavement can be what makes a scene solvable. So a scene is queued
 * only when its eligible input set:
 *
 *   1. is RECONSTRUCTABLE at all — at least `STREET3D_MIN_ELIGIBLE_FRAMES`
 *      frames, spanning `STREET3D_MIN_HEADING_SECTORS` of eight 45° sectors
 *      when the frames report a heading at all (library photos often do not,
 *      and refusing them would refuse most contributions);
 *   2. is not the set last queued (`last_queued_input_fingerprint`) — so a
 *      `needs_more_capture` scene is never re-run on identical inputs; and
 *   3. for a scene that was queued before: brings at least
 *      `STREET3D_REBUILD_MIN_NEW_FRAMES` new frames, OR new frames covering a
 *      heading sector the last job lacked, OR new frames that will expire
 *      within the at-risk window — or a rebuild was requested (a source was
 *      withdrawn or blocked, or an operator asked).
 *
 * A job that is still waiting for the worker (never started) is SUPERSEDED when
 * the input set has grown by `STREET3D_SUPERSEDE_MIN_NEW_FRAMES` since it was
 * queued: the worker may be offline for days, and the next job it picks up
 * should be the best one available. A job the worker has started is never
 * superseded — that would throw away GPU time already spent.
 */

import type { StreetSceneProfile } from '@goway/contracts';
import type { Street3dConfig } from '../config/street3d';
import {
  createScene,
  createSceneJob,
  lastSceneJob,
  loadEligibleFrames,
  loadScenes,
  nearestScenes,
  neighbourPairs,
  nextSceneJobIdentity,
  openSceneJobs,
  updateSceneCounters,
  type EligibleFrame,
  type SceneRow,
} from '../db/street3d/scenes';
import type { JobRow } from '../db/street3d/jobs';
import type { Database } from '../db/postgres';
import { headingSector, inputFingerprint, sequenceGroup } from './geo';
import type { JobObjectStore } from './jobObjectStore';
import type { ManifestFrame, SceneInputManifest } from './workerContract';
import { WORKER_CONTRACT_SCHEMA_VERSION } from './workerContract';

export interface FormationResult {
  /** Eligible frames considered this tick. */
  frames: EligibleFrame[];
  /** capture asset id → scene id, for every capture that belongs to a scene. */
  assignment: Map<string, string>;
  scenesCreated: number;
  jobsQueued: number;
  jobsSuperseded: number;
}

export interface FormationDeps {
  db: Database;
  jobStore: JobObjectStore;
  config: Street3dConfig;
  now: Date;
}

/**
 * Where a frame looks, when known. A view cut from a 360° capture looks its
 * yaw away from the capture's own heading, so one panorama covers every
 * sector — which is the point of capturing one.
 */
export function frameHeading(frame: Pick<EligibleFrame, 'headingDegrees' | 'panoramaYawDegrees'>): number | null {
  if (frame.headingDegrees === null) return null;
  return (((frame.headingDegrees + (frame.panoramaYawDegrees ?? 0)) % 360) + 360) % 360;
}

function sectorsOf(frames: readonly EligibleFrame[]): Set<number> {
  const sectors = new Set<number>();
  for (const frame of frames) {
    const heading = frameHeading(frame);
    if (heading !== null) sectors.add(headingSector(heading));
  }
  return sectors;
}

/** Whether a frame set could be reconstructed at all. See this module's header. */
export function isReconstructable(frames: readonly EligibleFrame[], config: Street3dConfig): boolean {
  if (frames.length < config.minEligibleFrames) return false;
  const withHeading = frames.filter((frame) => frame.headingDegrees !== null).length;
  return withHeading === 0 || sectorsOf(frames).size >= config.minHeadingSectors;
}

/** Whether a scene's current frames justify a new job versus the last one. */
export function hasInformationGain(
  frames: readonly EligibleFrame[],
  previousInputs: readonly string[],
  config: Street3dConfig,
  now: Date,
): boolean {
  const previous = new Set(previousInputs);
  const fresh = frames.filter((frame) => !previous.has(frame.derivativeId));
  if (fresh.length === 0) return false;
  if (fresh.length >= config.rebuildMinNewFrames) return true;
  const knownSectors = sectorsOf(frames.filter((frame) => previous.has(frame.derivativeId)));
  if ([...sectorsOf(fresh)].some((sector) => !knownSectors.has(sector))) return true;
  const atRiskBefore = now.getTime() + config.atRiskWindowDays * 86_400_000;
  return fresh.some((frame) => frame.expiresAt.getTime() < atRiskBefore);
}

/** Build the manifest frames: grouped by an opaque per-job sequence token, ordered within it. */
export function manifestFrames(jobId: string, frames: readonly EligibleFrame[]): ManifestFrame[] {
  const sorted = [...frames].sort((a, b) => {
    if (a.sessionId !== b.sessionId) return a.sessionId < b.sessionId ? -1 : 1;
    const at = (a.capturedAt?.getTime() ?? 0) - (b.capturedAt?.getTime() ?? 0);
    if (at !== 0) return at;
    if (a.assetId !== b.assetId) return a.assetId < b.assetId ? -1 : 1;
    return a.frameIndex - b.frameIndex;
  });
  const indexes = new Map<string, number>();
  return sorted.map((frame): ManifestFrame => {
    const group = sequenceGroup(jobId, frame.sessionId);
    const index = indexes.get(group) ?? 0;
    indexes.set(group, index + 1);
    const heading = frameHeading(frame);
    return {
      frameId: frame.derivativeId,
      captureAssetId: frame.assetId,
      imageKey: frame.imageKey,
      imageSha256: frame.imageSha256,
      ...(frame.maskKey && frame.maskSha256 ? { maskKey: frame.maskKey, maskSha256: frame.maskSha256 } : {}),
      width: frame.width,
      height: frame.height,
      privacyPipelineVersion: frame.privacyPipelineVersion,
      sequenceGroup: group,
      sequenceIndex: index,
      ...(frame.capturedAt ? { capturedAt: frame.capturedAt.toISOString() } : {}),
      prior: {
        latitude: frame.latitude,
        longitude: frame.longitude,
        ...(frame.altitudeMeters !== null ? { altitudeMeters: frame.altitudeMeters } : {}),
        ...(frame.accuracyMeters !== null ? { accuracyMeters: frame.accuracyMeters } : {}),
        ...(heading !== null ? { headingDegrees: heading } : {}),
      },
      ...(frame.panoramaIndex !== null && frame.panoramaYawDegrees !== null && frame.panoramaFovDegrees !== null
        ? {
            // A view's intrinsics are its field of view; a 360° camera's own
            // focal length describes a lens the view was never taken through.
            panorama: {
              index: frame.panoramaIndex,
              yawDegrees: frame.panoramaYawDegrees,
              horizontalFovDegrees: frame.panoramaFovDegrees,
            },
          }
        : frame.focalLength35mm !== null
          ? { camera: { focalLength35mm: frame.focalLength35mm } }
          : {}),
    };
  });
}

/**
 * Cluster the eligible captures that belong to no scene yet into new candidate
 * scenes: greedy, densest first, seed plus its direct neighbours. A capture
 * with no eligible neighbour stays `waiting_for_overlap` and forms nothing.
 */
async function seedNewScenes(
  deps: FormationDeps,
  frames: readonly EligibleFrame[],
  assignment: Map<string, string>,
): Promise<number> {
  const unassigned = [...new Set(frames.filter((frame) => !assignment.has(frame.assetId)).map((frame) => frame.assetId))];
  if (unassigned.length < 2) return 0;
  const pairs = await neighbourPairs(deps.db, unassigned, deps.config.clusterRadiusMeters);
  const neighbours = new Map<string, Set<string>>();
  for (const [a, b] of pairs) {
    if (!neighbours.has(a)) neighbours.set(a, new Set());
    if (!neighbours.has(b)) neighbours.set(b, new Set());
    neighbours.get(a)?.add(b);
    neighbours.get(b)?.add(a);
  }
  const position = new Map(frames.map((frame) => [frame.assetId, frame] as const));
  const seeds = [...neighbours.keys()].sort(
    (a, b) => (neighbours.get(b)?.size ?? 0) - (neighbours.get(a)?.size ?? 0) || (a < b ? -1 : 1),
  );
  const used = new Set<string>();
  let created = 0;
  for (const seed of seeds) {
    if (used.has(seed)) continue;
    const members = [seed, ...[...(neighbours.get(seed) ?? [])].filter((id) => !used.has(id))];
    if (members.length < 2) continue;
    // The anchor is a centroid of the cluster — internal, never published, and
    // not any single contributor's coordinate.
    let latitude = 0;
    let longitude = 0;
    for (const id of members) {
      latitude += position.get(id)?.latitude ?? 0;
      longitude += position.get(id)?.longitude ?? 0;
    }
    const sceneId = await createScene(deps.db, { latitude: latitude / members.length, longitude: longitude / members.length }, deps.now);
    for (const id of members) {
      used.add(id);
      assignment.set(id, sceneId);
    }
    created += 1;
  }
  return created;
}

/** One formation pass. Safe to run concurrently: the job insert is guarded by the schema. */
export async function formScenes(deps: FormationDeps): Promise<FormationResult> {
  const frames = await loadEligibleFrames(deps.db, deps.now);
  const assetIds = [...new Set(frames.map((frame) => frame.assetId))];
  const assignment = await nearestScenes(deps.db, assetIds);
  const scenesCreated = await seedNewScenes(deps, frames, assignment);

  const byScene = new Map<string, EligibleFrame[]>();
  for (const frame of frames) {
    const sceneId = assignment.get(frame.assetId);
    if (!sceneId) continue;
    const list = byScene.get(sceneId) ?? [];
    list.push(frame);
    byScene.set(sceneId, list);
  }

  const scenes = await loadScenes(deps.db, [...byScene.keys()]);
  const open = await openSceneJobs(deps.db, scenes.map((scene) => scene.id));
  let jobsQueued = 0;
  let jobsSuperseded = 0;

  for (const scene of scenes) {
    const sceneFrames = byScene.get(scene.id) ?? [];
    await updateSceneCounters(deps.db, scene.id, sceneFrames.length, sectorsOf(sceneFrames).size, deps.now);
    if (scene.state === 'disabled' || !isReconstructable(sceneFrames, deps.config)) continue;

    const fingerprint = inputFingerprint(sceneFrames.map((frame) => frame.imageSha256));
    const openJob = open.get(scene.id);
    if (openJob) {
      const waiting = openJob.startedAt === null && (openJob.state === 'queued' || openJob.state === 'retry_wait');
      const previous = new Set(openJob.inputDerivativeIds ?? []);
      const grown = sceneFrames.filter((frame) => !previous.has(frame.derivativeId)).length;
      if (waiting && grown >= deps.config.supersedeMinNewFrames && fingerprint !== openJob.inputFingerprint) {
        if (await queueSceneJob(deps, scene, sceneFrames, fingerprint, openJob)) {
          jobsQueued += 1;
          jobsSuperseded += 1;
        }
      }
      continue;
    }

    // An explicit rebuild request (operator, withdrawal, moderation) is the one
    // thing allowed to re-queue an identical input set — e.g. at another profile.
    if (fingerprint === scene.lastQueuedInputFingerprint && scene.rebuildRequestedAt === null) continue;
    const previous = await lastSceneJob(deps.db, scene.id);
    const due =
      previous === null ||
      scene.rebuildRequestedAt !== null ||
      hasInformationGain(sceneFrames, previous.inputDerivativeIds ?? [], deps.config, deps.now);
    if (!due) continue;
    if (await queueSceneJob(deps, scene, sceneFrames, fingerprint)) jobsQueued += 1;
  }

  return { frames, assignment, scenesCreated, jobsQueued, jobsSuperseded };
}

/**
 * Write the input manifest, then create the job row.
 *
 * Manifest FIRST: the row is what the dispatcher sends, and a row whose
 * manifest is missing would send the worker to a 404. The reverse failure — a
 * manifest whose row was never committed because a concurrent tick won — is an
 * orphan JSON object under `jobs/`, removed by the bucket's lifecycle backstop.
 */
async function queueSceneJob(
  deps: FormationDeps,
  scene: SceneRow,
  frames: readonly EligibleFrame[],
  fingerprint: string,
  supersede?: JobRow,
): Promise<boolean> {
  const { jobId, version } = nextSceneJobIdentity(scene);
  const profile: StreetSceneProfile = (scene.rebuildProfile as StreetSceneProfile | null) ?? deps.config.defaultProfile;
  const manifest: SceneInputManifest = {
    schemaVersion: WORKER_CONTRACT_SCHEMA_VERSION,
    jobId,
    sceneId: scene.id,
    sceneVersion: version,
    profile,
    anchor: { latitude: scene.anchorLatitude, longitude: scene.anchorLongitude },
    radiusMeters: scene.radiusMeters,
    frames: manifestFrames(jobId, frames),
    budgets: { ...deps.config.budgets[profile] },
    gates: { ...deps.config.gates },
  };
  const manifestKey = `jobs/${jobId}/input.json`;
  const written = await deps.jobStore.putJson(manifestKey, manifest);
  return createSceneJob(
    deps.db,
    {
      scene,
      jobId,
      version,
      profile,
      frames,
      fingerprint,
      manifestKey,
      manifestSha256: written.sha256,
      ...(supersede ? { supersede } : {}),
    },
    deps.now,
  );
}

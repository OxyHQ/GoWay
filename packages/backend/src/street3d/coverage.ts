/**
 * The coverage map and bounded rescue.
 *
 * ## Coarse by construction
 *
 * Coverage is materialized per geohash cell (precision 7 by default, roughly a
 * 150 m square) from the frames the formation pass already loaded. A row holds
 * the CELL's centre and box, a count that is only ever published as a band,
 * and an opaque id — never a capture's coordinate, id or time. Coverage cannot
 * be read back into anybody's position, and it holds no user column at all.
 *
 * ## State, per cell
 *
 *   - `reconstructing`     a job the worker has started covers the cell;
 *   - `reconstructable`    a job is queued for the worker;
 *   - `needs_more_capture` the last attempt found too little overlap;
 *   - `partial` / `at_risk` captures here belong to a scene that cannot yet be
 *     reconstructed; `at_risk` when the earliest useful input expires within
 *     the at-risk window and no published version covers the cell (published
 *     output survives its inputs, so a published scene is never at risk);
 *   - `seeded`             useful captures, nothing overlapping yet.
 *
 * A cell whose every capture is integrated into a scene's current version is
 * not an area at all: the scene itself is what the coverage API returns there.
 *
 * ## Rescue is bounded and explicit
 *
 * When an at-risk cell receives a NEW eligible contribution, the derivatives
 * there that would expire within the window are extended once — by
 * `STREET3D_RESCUE_EXTENSION_DAYS`, at most `MAX_RETENTION_EXTENSIONS` times
 * per derivative, never past the absolute ceiling (the schema refuses it), and
 * marked `rescue_extension` so the reason is visible. One rescue per new
 * contribution, recorded in `last_rescue_at`.
 */

import { and, eq, inArray, isNull, lt, notInArray, sql } from 'drizzle-orm';
import type { StreetCoverageAreaState } from '@goway/shared-types';
import type { Street3dConfig } from '../config/street3d';
import type { Database } from '../db/postgres';
import {
  ABSOLUTE_RETENTION_CEILING_DAYS,
  MAX_RETENTION_EXTENSIONS,
  captureDerivatives,
  street3dCoverageAreas,
  street3dSceneInputs,
  street3dScenes,
  street3dJobs,
} from '../db/schema';
import type { EligibleFrame } from '../db/street3d/scenes';
import { coverageAreaId, decodeGeohash } from './geo';
import { isReconstructable } from './formation';

export interface CoverageDeps {
  db: Database;
  config: Street3dConfig;
  now: Date;
}

export interface CoverageSummary {
  areas: number;
  rescued: number;
  derivativesExtended: number;
}

interface CellFacts {
  assets: Set<string>;
  scenes: Set<string>;
  earliestExpiry: Date;
  latestContribution: Date | null;
  derivativeIds: string[];
}

/** Materialize coverage from this tick's frames and scene assignment, then rescue. */
export async function refreshCoverage(
  deps: CoverageDeps,
  frames: readonly EligibleFrame[],
  assignment: ReadonlyMap<string, string>,
): Promise<CoverageSummary> {
  const precision = deps.config.coverageCellPrecision;
  const cells = new Map<string, CellFacts>();
  for (const frame of frames) {
    const cell = frame.geoCell.slice(0, precision);
    const facts = cells.get(cell) ?? {
      assets: new Set<string>(),
      scenes: new Set<string>(),
      earliestExpiry: frame.expiresAt,
      latestContribution: null,
      derivativeIds: [],
    };
    facts.assets.add(frame.assetId);
    const sceneId = assignment.get(frame.assetId);
    if (sceneId) facts.scenes.add(sceneId);
    if (frame.expiresAt < facts.earliestExpiry) facts.earliestExpiry = frame.expiresAt;
    if (frame.privacyCompletedAt && (!facts.latestContribution || frame.privacyCompletedAt > facts.latestContribution)) {
      facts.latestContribution = frame.privacyCompletedAt;
    }
    facts.derivativeIds.push(frame.derivativeId);
    cells.set(cell, facts);
  }

  const sceneIds = [...new Set([...cells.values()].flatMap((facts) => [...facts.scenes]))];
  const scenes = sceneIds.length
    ? await deps.db.select().from(street3dScenes).where(inArray(street3dScenes.id, sceneIds))
    : [];
  const sceneById = new Map(scenes.map((scene) => [scene.id, scene]));
  const openJobs = sceneIds.length
    ? await deps.db
        .select({ sceneId: street3dJobs.sceneId, startedAt: street3dJobs.startedAt })
        .from(street3dJobs)
        .where(and(inArray(street3dJobs.sceneId, sceneIds), sql`${street3dJobs.state} not in ('completed', 'failed', 'cancelled')`))
    : [];
  const openBySceneId = new Map(openJobs.map((job) => [job.sceneId as string, job]));
  const currentVersions = scenes.flatMap((scene) => (scene.currentVersionId ? [scene.currentVersionId] : []));
  const integrated = new Set(
    currentVersions.length
      ? (
          await deps.db
            .select({ assetId: street3dSceneInputs.captureAssetId })
            .from(street3dSceneInputs)
            .where(and(inArray(street3dSceneInputs.versionId, currentVersions), eq(street3dSceneInputs.registered, true)))
        ).map((row) => row.assetId)
      : [],
  );
  const framesByScene = new Map<string, EligibleFrame[]>();
  for (const frame of frames) {
    const sceneId = assignment.get(frame.assetId);
    if (!sceneId) continue;
    framesByScene.set(sceneId, [...(framesByScene.get(sceneId) ?? []), frame]);
  }

  const atRiskBefore = new Date(deps.now.getTime() + deps.config.atRiskWindowDays * 86_400_000);
  const existing = cells.size
    ? await deps.db.select().from(street3dCoverageAreas).where(inArray(street3dCoverageAreas.cell, [...cells.keys()]))
    : [];
  const previous = new Map(existing.map((row) => [row.cell, row]));

  let rescued = 0;
  let derivativesExtended = 0;
  const kept: string[] = [];

  for (const [cell, facts] of cells) {
    const cellScenes = [...facts.scenes].flatMap((id) => (sceneById.has(id) ? [sceneById.get(id)!] : []));
    const published = cellScenes.find((scene) => scene.currentVersionId !== null && scene.state !== 'disabled');
    const allIntegrated = [...facts.assets].every((assetId) => integrated.has(assetId));

    let state: StreetCoverageAreaState;
    const running = cellScenes.find((scene) => openBySceneId.get(scene.id)?.startedAt);
    const queued = cellScenes.find((scene) => openBySceneId.has(scene.id));
    if (running) state = 'reconstructing';
    else if (queued) state = 'reconstructable';
    else if (published && allIntegrated) continue;
    else if (cellScenes.some((scene) => scene.state === 'needs_more_capture')) state = 'needs_more_capture';
    else if (cellScenes.length > 0) {
      const reconstructable = cellScenes.some((scene) => isReconstructable(framesByScene.get(scene.id) ?? [], deps.config));
      state = reconstructable ? 'reconstructable' : !published && facts.earliestExpiry < atRiskBefore ? 'at_risk' : 'partial';
    } else state = 'seeded';

    const { center, bounds } = decodeGeohash(cell);
    const before = previous.get(cell);
    const values = {
      cell,
      publicId: coverageAreaId(cell),
      state,
      centerLatitude: center.latitude,
      centerLongitude: center.longitude,
      boundsWest: bounds.west,
      boundsSouth: bounds.south,
      boundsEast: bounds.east,
      boundsNorth: bounds.north,
      contributionCount: facts.assets.size,
      atRiskUntil: state === 'at_risk' ? facts.earliestExpiry : null,
      sceneId: published?.id ?? cellScenes[0]?.id ?? null,
      latestContributionAt: facts.latestContribution,
      lastRescueAt: before?.lastRescueAt ?? null,
      updatedAt: deps.now,
    };

    // A NEW contribution into an area that was already at risk: rescue once.
    const newContribution =
      before !== undefined &&
      facts.latestContribution !== null &&
      (before.latestContributionAt === null || facts.latestContribution > before.latestContributionAt) &&
      (before.lastRescueAt === null || facts.latestContribution > before.lastRescueAt);
    if ((before?.state === 'at_risk' || state === 'at_risk') && newContribution && !published) {
      const extended = await rescueDerivatives(deps, facts.derivativeIds, atRiskBefore);
      derivativesExtended += extended;
      if (extended > 0) rescued += 1;
      values.lastRescueAt = deps.now;
    }

    await deps.db
      .insert(street3dCoverageAreas)
      .values(values)
      .onConflictDoUpdate({ target: street3dCoverageAreas.cell, set: { ...values } });
    kept.push(cell);
  }

  // Cells with nothing useful left are not areas any more.
  await deps.db
    .delete(street3dCoverageAreas)
    .where(kept.length ? notInArray(street3dCoverageAreas.cell, kept) : sql`true`);

  return { areas: kept.length, rescued, derivativesExtended };
}

/** One bounded extension of the derivatives that would otherwise expire inside the window. */
async function rescueDerivatives(deps: CoverageDeps, derivativeIds: readonly string[], before: Date): Promise<number> {
  if (derivativeIds.length === 0) return 0;
  // Hours, not days: `+ interval 'N days'` follows the session time zone's
  // daylight-saving shifts, and an extension is an exact duration. The ceiling
  // is spelled exactly as the schema's CHECK spells it, so `least()` can never
  // produce a value the CHECK refuses.
  const extension = `${deps.config.rescueExtensionDays * 24} hours`;
  const ceiling = `${ABSOLUTE_RETENTION_CEILING_DAYS} days`;
  const rows = await deps.db
    .update(captureDerivatives)
    .set({
      expiresAt: sql`least(${captureDerivatives.createdAt} + ${ceiling}::interval, ${captureDerivatives.expiresAt} + ${extension}::interval)`,
      protectedUntil: sql`least(${captureDerivatives.createdAt} + ${ceiling}::interval, ${captureDerivatives.expiresAt} + ${extension}::interval)`,
      extensionCount: sql`${captureDerivatives.extensionCount} + 1`,
      retentionReason: 'rescue_extension',
      updatedAt: deps.now,
    })
    .where(
      and(
        inArray(captureDerivatives.id, [...derivativeIds]),
        eq(captureDerivatives.storageState, 'stored'),
        isNull(captureDerivatives.deletionRequestedAt),
        lt(captureDerivatives.expiresAt, before),
        lt(captureDerivatives.extensionCount, MAX_RETENTION_EXTENSIONS),
        // Already at the ceiling: an "extension" that extends nothing is not counted.
        sql`${captureDerivatives.expiresAt} < ${captureDerivatives.createdAt} + ${ceiling}::interval`,
      ),
    )
    .returning({ id: captureDerivatives.id });
  return rows.length;
}

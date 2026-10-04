/**
 * Every read the public Street 3D API makes, and its one write (a report).
 *
 * As `captureMapper` does for captures, this module READS the columns the
 * contract names and WRITES fresh contract objects — nothing is spread from a
 * row. A version's `assets` column carries its scene-bucket `key` beside the
 * public `url`; the key is dropped here. No capture id, derivative, input,
 * contributor, worker id or position prior is selected at all.
 *
 * Only a version that is `published`, AND is its scene's current version, AND
 * belongs to a scene that is not disabled, is ever served. Disabling either
 * the version or the scene hides it at the next read.
 */

import { and, eq, gte, lte, or, sql } from 'drizzle-orm';
import type {
  GeoBoundingBox,
  StreetCoverage,
  StreetCoverageArea,
  StreetSceneAsset,
  StreetSceneManifest,
  StreetSceneNavigation,
  StreetSceneReport,
  StreetSceneReportInput,
  StreetSceneSummary,
} from '@goway/shared-types';
import type { Database } from '../postgres';
import { street3dCoverageAreas, street3dSceneReports, street3dSceneVersions, street3dScenes } from '../schema';
import { contributionBand } from '../../street3d/geo';

/** The most scenes and areas one coverage answer carries. The bbox cap keeps this generous. */
const MAX_SCENES = 200;
const MAX_AREAS = 500;

const servedVersion = and(
  eq(street3dScenes.currentVersionId, street3dSceneVersions.id),
  eq(street3dSceneVersions.state, 'published'),
  sql`${street3dScenes.state} <> 'disabled'`,
);

function publicAssets(assets: readonly (StreetSceneAsset & { key: string })[]): StreetSceneAsset[] {
  return assets.map((asset) => ({
    role: asset.role,
    format: asset.format,
    url: asset.url,
    byteSize: asset.byteSize,
    sha256: asset.sha256,
    ...(asset.gaussians !== undefined ? { gaussians: asset.gaussians } : {}),
  }));
}

type VersionRow = typeof street3dSceneVersions.$inferSelect;

function publicNavigation(navigation: StreetSceneNavigation): StreetSceneNavigation {
  const published: StreetSceneNavigation = {
    viewpoints: navigation.viewpoints.map((viewpoint) => ({
      position: [...viewpoint.position] as [number, number, number],
      forward: [...viewpoint.forward] as [number, number, number],
    })),
  };
  if (navigation.fieldOfView) {
    published.fieldOfView = {
      horizontalDegrees: navigation.fieldOfView.horizontalDegrees,
      verticalDegrees: navigation.fieldOfView.verticalDegrees,
    };
  }
  return published;
}

function toManifest(row: VersionRow): StreetSceneManifest {
  const manifest: StreetSceneManifest = {
    id: row.sceneId,
    version: row.version,
    bounds: { west: row.boundsWest, south: row.boundsSouth, east: row.boundsEast, north: row.boundsNorth },
    footprint: { type: 'Polygon', coordinates: row.footprint.coordinates },
    worldTransform: {
      anchor: {
        latitude: row.worldTransform.anchor.latitude,
        longitude: row.worldTransform.anchor.longitude,
        altitudeMeters: row.worldTransform.anchor.altitudeMeters,
      },
      frame: 'enu',
      enuFromScene: [...row.worldTransform.enuFromScene],
    },
    initialView: {
      position: [...row.initialView.position] as [number, number, number],
      target: [...row.initialView.target] as [number, number, number],
    },
    assets: publicAssets(row.assets),
    quality: {
      profile: row.quality.profile,
      registrationRatio: row.quality.registrationRatio,
      alignmentResidualMeters: row.quality.alignmentResidualMeters,
      heldOutPsnr: row.quality.heldOutPsnr,
      placement: row.quality.placement,
    },
    observedFrom: row.observedFrom.toISOString(),
    observedTo: row.observedTo.toISOString(),
    publishedAt: (row.publishedAt ?? row.createdAt).toISOString(),
    attributions: [...row.attributions],
    privacyPipelineVersions: [...row.privacyPipelineVersions],
  };
  if (row.navigation) manifest.navigation = publicNavigation(row.navigation);
  return manifest;
}

/** The served manifest of a scene, or `null`. */
export async function findPublishedManifest(db: Database, sceneId: string): Promise<StreetSceneManifest | null> {
  const [row] = await db
    .select({ version: street3dSceneVersions })
    .from(street3dScenes)
    .innerJoin(street3dSceneVersions, servedVersion)
    .where(eq(street3dScenes.id, sceneId));
  return row ? toManifest(row.version) : null;
}

/** Longitude overlap, honouring a box that crosses the antimeridian (`west > east`). */
function longitudeOverlap(west: number, east: number, rowWest: typeof street3dSceneVersions.boundsWest, rowEast: typeof street3dSceneVersions.boundsEast) {
  return west <= east
    ? and(lte(rowWest, east), gte(rowEast, west))
    : or(gte(rowEast, west), lte(rowWest, east));
}

/** Published scenes and coarse coverage areas inside a box. */
export async function findCoverage(db: Database, box: GeoBoundingBox): Promise<StreetCoverage> {
  const sceneRows = await db
    .select({ version: street3dSceneVersions })
    .from(street3dScenes)
    .innerJoin(street3dSceneVersions, servedVersion)
    .where(
      and(
        lte(street3dSceneVersions.boundsSouth, box.north),
        gte(street3dSceneVersions.boundsNorth, box.south),
        longitudeOverlap(box.west, box.east, street3dSceneVersions.boundsWest, street3dSceneVersions.boundsEast),
      ),
    )
    .limit(MAX_SCENES);

  const scenes = sceneRows.map(({ version }): StreetSceneSummary => {
    const poster = version.assets.find((asset) => asset.role === 'poster');
    const summary: StreetSceneSummary = {
      id: version.sceneId,
      version: version.version,
      center: {
        latitude: (version.boundsSouth + version.boundsNorth) / 2,
        longitude: (version.boundsWest + version.boundsEast) / 2,
      },
      bounds: { west: version.boundsWest, south: version.boundsSouth, east: version.boundsEast, north: version.boundsNorth },
      footprint: { type: 'Polygon', coordinates: version.footprint.coordinates },
      placement: version.quality.placement,
      publishedAt: (version.publishedAt ?? version.createdAt).toISOString(),
    };
    if (poster) summary.posterUrl = poster.url;
    return summary;
  });

  const lonFilter =
    box.west <= box.east
      ? and(gte(street3dCoverageAreas.centerLongitude, box.west), lte(street3dCoverageAreas.centerLongitude, box.east))
      : or(gte(street3dCoverageAreas.centerLongitude, box.west), lte(street3dCoverageAreas.centerLongitude, box.east));
  const areaRows = await db
    .select({
      publicId: street3dCoverageAreas.publicId,
      state: street3dCoverageAreas.state,
      centerLatitude: street3dCoverageAreas.centerLatitude,
      centerLongitude: street3dCoverageAreas.centerLongitude,
      boundsWest: street3dCoverageAreas.boundsWest,
      boundsSouth: street3dCoverageAreas.boundsSouth,
      boundsEast: street3dCoverageAreas.boundsEast,
      boundsNorth: street3dCoverageAreas.boundsNorth,
      contributionCount: street3dCoverageAreas.contributionCount,
      atRiskUntil: street3dCoverageAreas.atRiskUntil,
      sceneId: street3dCoverageAreas.sceneId,
    })
    .from(street3dCoverageAreas)
    .where(and(gte(street3dCoverageAreas.centerLatitude, box.south), lte(street3dCoverageAreas.centerLatitude, box.north), lonFilter))
    .limit(MAX_AREAS);

  const servedSceneIds = new Set(scenes.map((scene) => scene.id));
  const areas = areaRows.map((row): StreetCoverageArea => {
    const area: StreetCoverageArea = {
      id: row.publicId,
      state: row.state as StreetCoverageArea['state'],
      center: { latitude: row.centerLatitude, longitude: row.centerLongitude },
      bounds: { west: row.boundsWest, south: row.boundsSouth, east: row.boundsEast, north: row.boundsNorth },
      contributionBand: contributionBand(row.contributionCount),
    };
    if (row.state === 'at_risk' && row.atRiskUntil) area.atRiskUntil = row.atRiskUntil.toISOString();
    // Only a scene the caller can actually open is named.
    if (row.sceneId && servedSceneIds.has(row.sceneId)) area.sceneId = row.sceneId;
    return area;
  });

  return { scenes, areas };
}

/**
 * Record a report against the scene's served version. One open report per
 * reporter per version: a repeat returns the existing one. `null` when the
 * scene is not served.
 */
export async function createSceneReport(
  db: Database,
  sceneId: string,
  reporterOxyUserId: string,
  input: StreetSceneReportInput,
): Promise<{ report: StreetSceneReport; created: boolean } | null> {
  const [served] = await db
    .select({ versionId: street3dSceneVersions.id, version: street3dSceneVersions.version })
    .from(street3dScenes)
    .innerJoin(street3dSceneVersions, servedVersion)
    .where(eq(street3dScenes.id, sceneId));
  if (!served) return null;

  const [inserted] = await db
    .insert(street3dSceneReports)
    .values({
      sceneId,
      versionId: served.versionId,
      reporterOxyUserId,
      reason: input.reason,
      ...(input.note ? { note: input.note } : {}),
    })
    .onConflictDoNothing()
    .returning();
  const row =
    inserted ??
    (
      await db
        .select()
        .from(street3dSceneReports)
        .where(
          and(
            eq(street3dSceneReports.versionId, served.versionId),
            eq(street3dSceneReports.reporterOxyUserId, reporterOxyUserId),
            sql`${street3dSceneReports.resolvedAt} is null`,
          ),
        )
    )[0];
  if (!row) return null;
  return {
    created: inserted !== undefined,
    report: {
      id: row.id,
      sceneId: row.sceneId,
      version: served.version,
      reason: row.reason as StreetSceneReport['reason'],
      createdAt: row.createdAt.toISOString(),
    },
  };
}

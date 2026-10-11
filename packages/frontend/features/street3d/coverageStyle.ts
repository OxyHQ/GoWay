/**
 * How Street 3D coverage is drawn on the map — pure, so it is tested without a
 * renderer.
 *
 * Every colour is a Bloom theme ROLE resolved at render time from
 * `useTheme().colors`, never a literal: the map follows light/dark and any
 * future palette change for free, and AGENTS.md forbids a hardcoded colour.
 *
 * Colour is never the only channel. A state's meaning is also in its words (the
 * coverage hint and the contribution screen); the dots are a glance.
 */
import type { ThemeColors } from '@oxy.so/bloom/theme';
import {
  STREET_COVERAGE_AREA_STATES,
  type StreetCoverage,
  type StreetCoverageArea,
  type StreetCoverageAreaState,
  type StreetSceneSummary,
} from '@goway.to/sdk';

import type { GeoBounds, MapMarker, MapOverlay } from '@/components/map/types';

/** Coverage is street-scale; below this zoom it is noise and is not fetched. */
export const STREET3D_MIN_ZOOM = 14;

/** Marker `kind` for a published scene's chip. */
export const SCENE_MARKER_KIND = 'street3d-scene';
const SCENE_MARKER_PREFIX = 'street3d-scene:';

/**
 * The Bloom role each area state is drawn in.
 *
 * Ordered from "nothing to do" to "help wanted": `seeded` is quiet,
 * `at_risk` is the warning role because it is the one a contributor can act
 * on before a deadline, and `needs_more_capture` is the tertiary accent rather
 * than an error — a reconstruction that wants more photos has not failed.
 */
export const AREA_STATE_COLOR: Readonly<Record<StreetCoverageAreaState, keyof ThemeColors>> = {
  seeded: 'textTertiary',
  partial: 'info',
  at_risk: 'warning',
  reconstructable: 'success',
  reconstructing: 'primary',
  needs_more_capture: 'tertiary',
};

/** States where another contribution nearby is what is missing. */
export const AREA_STATES_WANTING_CAPTURE: ReadonlySet<StreetCoverageAreaState> = new Set([
  'seeded',
  'partial',
  'at_risk',
  'needs_more_capture',
]);

export type CoverageColors = Pick<
  ThemeColors,
  (typeof AREA_STATE_COLOR)[StreetCoverageAreaState] | 'primary' | 'textSecondary'
>;

export function shouldFetchCoverage(zoom: number | null | undefined): boolean {
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom >= STREET3D_MIN_ZOOM;
}

function point(
  longitude: number,
  latitude: number,
  properties: Record<string, unknown>,
): GeoJSON.Feature {
  return {
    type: 'Feature',
    properties,
    geometry: { type: 'Point', coordinates: [longitude, latitude] },
  };
}

function collection(features: GeoJSON.Feature[]): GeoJSON.FeatureCollection {
  return { type: 'FeatureCollection', features };
}

function footprints(scenes: readonly StreetSceneSummary[]): GeoJSON.FeatureCollection {
  return collection(
    scenes.map((scene) => ({
      type: 'Feature',
      properties: { sceneId: scene.id },
      geometry: { type: 'Polygon', coordinates: scene.footprint.coordinates },
    })),
  );
}

/**
 * The map overlays for a coverage answer.
 *
 * One overlay per (kind, state) because `MapOverlayPaint` is one colour per
 * overlay — the seam deliberately has no data-driven paint. Empty groups are
 * omitted so the engine is not asked to hold layers with nothing in them.
 *
 * Approximately placed scenes are drawn in the muted role with a thinner
 * outline: the contract says they "must not be presented as exactly placed on
 * the map", and a crisp primary outline is exactly that presentation.
 */
export function coverageOverlays(coverage: StreetCoverage, colors: CoverageColors): MapOverlay[] {
  const overlays: MapOverlay[] = [];

  for (const placement of ['precise', 'approximate'] as const) {
    const scenes = coverage.scenes.filter((scene) => scene.placement === placement);
    if (scenes.length === 0) continue;
    const color = placement === 'precise' ? colors.primary : colors.textSecondary;
    const data = footprints(scenes);
    overlays.push(
      {
        id: `street3d-scenes-${placement}-fill`,
        kind: 'fill',
        data,
        paint: { color, opacity: placement === 'precise' ? 0.14 : 0.08 },
      },
      {
        id: `street3d-scenes-${placement}-line`,
        kind: 'line',
        data,
        paint: { color, width: placement === 'precise' ? 2 : 1, opacity: 0.9 },
      },
    );
  }

  // An area that improves a published scene is drawn by the scene already;
  // a dot on top of the footprint would read as a second, separate thing.
  const sceneIds = new Set(coverage.scenes.map((scene) => scene.id));
  const areas = coverage.areas.filter((entry) => !entry.sceneId || !sceneIds.has(entry.sceneId));

  for (const state of STREET_COVERAGE_AREA_STATES) {
    const inState = areas.filter((entry) => entry.state === state);
    if (inState.length === 0) continue;
    overlays.push({
      id: `street3d-areas-${state}`,
      kind: 'circle',
      data: collection(
        inState.map((entry) =>
          point(entry.center.longitude, entry.center.latitude, { areaId: entry.id }),
        ),
      ),
      paint: {
        color: colors[AREA_STATE_COLOR[state]],
        radius: state === 'at_risk' ? 9 : 7,
        opacity: 0.85,
      },
    });
  }

  return overlays;
}

/** A chip per published scene, at its centre. */
export function sceneMarkers(scenes: readonly StreetSceneSummary[], label: string): MapMarker[] {
  return scenes.map((scene) => ({
    id: `${SCENE_MARKER_PREFIX}${scene.id}`,
    coordinate: scene.center,
    kind: SCENE_MARKER_KIND,
    label: '3D',
    accessibilityLabel: label,
  }));
}

/** The scene id behind a marker this module made, or `null` for any other marker. */
export function sceneIdOfMarker(marker: Pick<MapMarker, 'id' | 'kind'>): string | null {
  if (marker.kind !== SCENE_MARKER_KIND || !marker.id.startsWith(SCENE_MARKER_PREFIX)) return null;
  const id = marker.id.slice(SCENE_MARKER_PREFIX.length);
  return id === '' ? null : id;
}

/** Whether any area in view is one where another photo is what is missing. */
export function areasWantingCapture(areas: readonly StreetCoverageArea[]): StreetCoverageArea[] {
  return areas.filter((entry) => AREA_STATES_WANTING_CAPTURE.has(entry.state));
}

/** The area containing `coordinate`, preferring `at_risk` when cells overlap. */
export function areaContaining(
  areas: readonly StreetCoverageArea[],
  coordinate: { latitude: number; longitude: number },
): StreetCoverageArea | null {
  const containing = areas.filter((entry) => within(entry.bounds, coordinate));
  return containing.find((entry) => entry.state === 'at_risk') ?? containing[0] ?? null;
}

function within(
  bounds: GeoBounds,
  { latitude, longitude }: { latitude: number; longitude: number },
): boolean {
  const inLongitude =
    bounds.west <= bounds.east
      ? longitude >= bounds.west && longitude <= bounds.east
      : longitude >= bounds.west || longitude <= bounds.east;
  return inLongitude && latitude >= bounds.south && latitude <= bounds.north;
}

/**
 * A small box around a point, for "what is the coverage HERE".
 *
 * `radiusMeters` is converted with the local metres-per-degree, so the box is
 * square on the ground rather than in degrees.
 */
export function boxAround(
  coordinate: { latitude: number; longitude: number },
  radiusMeters: number,
): GeoBounds {
  const dLat = radiusMeters / 111_320;
  const cos = Math.max(0.01, Math.cos((coordinate.latitude * Math.PI) / 180));
  const dLon = radiusMeters / (111_320 * cos);
  return {
    west: coordinate.longitude - dLon,
    south: Math.max(-90, coordinate.latitude - dLat),
    east: coordinate.longitude + dLon,
    north: Math.min(90, coordinate.latitude + dLat),
  };
}

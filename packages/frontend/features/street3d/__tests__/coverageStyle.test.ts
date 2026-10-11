import { describe, expect, test } from 'bun:test';
import {
  STREET_COVERAGE_AREA_STATES,
  type StreetCoverage,
  type StreetCoverageArea,
  type StreetSceneSummary,
} from '@goway.to/sdk';

import {
  AREA_STATE_COLOR,
  areaContaining,
  areasWantingCapture,
  boxAround,
  coverageOverlays,
  sceneIdOfMarker,
  sceneMarkers,
  shouldFetchCoverage,
  type CoverageColors,
} from '../coverageStyle';

/** Every role resolves to its own name, so a test can see which role was used. */
const COLORS = new Proxy({}, { get: (_, key) => `role:${String(key)}` }) as CoverageColors;

/**
 * A self-contained coverage answer — independent of the fixture env, which a
 * developer may have pointed at a local scene — with both placements, every
 * area state, and one area that improves a visible scene.
 */
function scene(
  id: string,
  placement: 'precise' | 'approximate',
  longitude: number,
): StreetSceneSummary {
  const box = { west: longitude - 0.001, south: 41.38, east: longitude + 0.001, north: 41.382 };
  return {
    id,
    version: 1,
    center: { latitude: 41.381, longitude },
    bounds: box,
    footprint: {
      type: 'Polygon',
      coordinates: [
        [
          [box.west, box.south],
          [box.east, box.south],
          [box.east, box.north],
          [box.west, box.north],
          [box.west, box.south],
        ],
      ],
    },
    placement,
    publishedAt: '2026-09-01T00:00:00.000Z',
  };
}

function area(
  id: string,
  state: StreetCoverageArea['state'],
  longitude: number,
  extra: Partial<StreetCoverageArea> = {},
): StreetCoverageArea {
  return {
    id,
    state,
    center: { latitude: 41.39, longitude },
    bounds: { west: longitude - 0.0005, south: 41.3895, east: longitude + 0.0005, north: 41.3905 },
    contributionBand: '5-19',
    ...extra,
  };
}

const COVERAGE: StreetCoverage = {
  scenes: [scene('s-precise', 'precise', 2.17), scene('s-approx', 'approximate', 2.18)],
  areas: [
    ...STREET_COVERAGE_AREA_STATES.map((state, index) =>
      area(
        `a-${state}`,
        state,
        2.16 + index * 0.002,
        state === 'at_risk' ? { atRiskUntil: '2026-10-20T00:00:00.000Z' } : {},
      ),
    ),
    area('a-improving', 'partial', 2.17, { sceneId: 's-precise' }),
  ],
};

describe('state → Bloom role', () => {
  test('every published state has a role, and only theme roles are used', () => {
    for (const state of STREET_COVERAGE_AREA_STATES) {
      expect(typeof AREA_STATE_COLOR[state]).toBe('string');
    }
    // A role is a ThemeColors key, never a literal colour.
    for (const role of Object.values(AREA_STATE_COLOR)) {
      expect(role).not.toMatch(/^#|^rgb|^hsl/);
    }
  });

  test('at_risk is the warning role and is drawn larger', () => {
    const overlays = coverageOverlays(COVERAGE, COLORS);
    const atRisk = overlays.find((overlay) => overlay.id === 'street3d-areas-at_risk');
    expect(atRisk?.kind).toBe('circle');
    expect(atRisk?.paint?.color).toBe('role:warning');
    const partial = overlays.find((overlay) => overlay.id === 'street3d-areas-partial');
    expect(atRisk?.paint?.radius ?? 0).toBeGreaterThan(partial?.paint?.radius ?? 0);
  });
});

describe('coverageOverlays', () => {
  test('precise footprints are a primary fill + line; approximate ones are muted and thinner', () => {
    const overlays = coverageOverlays(COVERAGE, COLORS);
    const byId = new Map(overlays.map((overlay) => [overlay.id, overlay]));
    expect(byId.get('street3d-scenes-precise-fill')?.kind).toBe('fill');
    expect(byId.get('street3d-scenes-precise-line')?.paint?.color).toBe('role:primary');
    expect(byId.get('street3d-scenes-approximate-line')?.paint?.color).toBe('role:textSecondary');
    expect(byId.get('street3d-scenes-approximate-line')?.paint?.width ?? 0).toBeLessThan(
      byId.get('street3d-scenes-precise-line')?.paint?.width ?? 0,
    );
  });

  test('an area that improves a visible scene is not drawn twice', () => {
    const coverage = COVERAGE;
    const improving = coverage.areas.find((entry) => entry.sceneId);
    expect(improving).toBeDefined();
    const overlays = coverageOverlays(coverage, COLORS);
    const ids = overlays.flatMap((overlay) =>
      (overlay.data as GeoJSON.FeatureCollection).features.map(
        (feature) => feature.properties?.areaId,
      ),
    );
    expect(ids).not.toContain(improving?.id);
  });

  test('nothing to draw is no overlays, not empty layers', () => {
    expect(coverageOverlays({ scenes: [], areas: [] }, COLORS)).toEqual([]);
  });

  test('ids are stable for the same answer', () => {
    const a = coverageOverlays(COVERAGE, COLORS).map((overlay) => overlay.id);
    const b = coverageOverlays(COVERAGE, COLORS).map((overlay) => overlay.id);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(a.length);
  });
});

describe('scene markers', () => {
  test('round-trip a scene id, and ignore every other marker', () => {
    const coverage: StreetCoverage = COVERAGE;
    const markers = sceneMarkers(coverage.scenes, 'Open');
    expect(markers).toHaveLength(coverage.scenes.length);
    for (const [index, marker] of markers.entries()) {
      expect(sceneIdOfMarker(marker)).toBe(coverage.scenes[index].id);
    }
    expect(sceneIdOfMarker({ id: 'street3d-scene:x', kind: 'place' })).toBeNull();
    expect(sceneIdOfMarker({ id: 'gw_place', kind: 'street3d-scene' })).toBeNull();
  });
});

describe('zoom gate', () => {
  test('fetches only at street zoom', () => {
    expect(shouldFetchCoverage(13.9)).toBe(false);
    expect(shouldFetchCoverage(14)).toBe(true);
    expect(shouldFetchCoverage(Number.NaN)).toBe(false);
    expect(shouldFetchCoverage(null)).toBe(false);
  });
});

describe('areas and points', () => {
  const coverage = COVERAGE;

  test('areasWantingCapture keeps only the states another photo helps', () => {
    const states = new Set(areasWantingCapture(coverage.areas).map((entry) => entry.state));
    expect(states.has('at_risk')).toBe(true);
    expect(states.has('reconstructing')).toBe(false);
    expect(states.has('reconstructable')).toBe(false);
  });

  test('areaContaining finds the cell around a point and prefers at_risk', () => {
    const atRisk = coverage.areas.find((entry) => entry.state === 'at_risk');
    expect(atRisk).toBeDefined();
    const found = areaContaining(coverage.areas, atRisk!.center);
    expect(found?.id).toBe(atRisk!.id);
    expect(areaContaining(coverage.areas, { latitude: 0, longitude: 0 })).toBeNull();

    const overlapping = [{ ...atRisk!, id: 'p', state: 'partial' as const }, atRisk!];
    expect(areaContaining(overlapping, atRisk!.center)?.id).toBe(atRisk!.id);
  });

  test('boxAround is square on the ground', () => {
    const box = boxAround({ latitude: 60, longitude: 10 }, 100);
    const heightDegrees = box.north - box.south;
    const widthDegrees = box.east - box.west;
    // At 60° a degree of longitude is half a degree of latitude.
    expect(widthDegrees / heightDegrees).toBeCloseTo(2, 2);
    expect(box.west).toBeLessThan(10);
    expect(box.east).toBeGreaterThan(10);
  });
});

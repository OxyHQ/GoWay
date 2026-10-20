/**
 * The landmarks the map offers (the "Landmarks" pill, the tour, a place's
 * "Landmark tour") are exactly the ones it can draw: over a WHOLLY published
 * z14 cell — the engine's own source rule, so not at a region's ragged edge —
 * and with a model that loads (`city3dLayer.web.ts` → `drawableLandmarks`).
 */
import { describe, expect, test } from 'bun:test';

import { drawableLandmarks } from '@/components/map/city3dLayer.web';
import { assignSources } from '@/components/map/engine/city3d/sources';
import { coverageCovers } from '@/components/map/engine/city3d/coverageIndex';
import type { CityCoverageBox } from '@/lib/map/cityTiles';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import { mercatorX, mercatorY } from '@goway.to/sdk/geo';

const SAGRADA = { latitude: 41.403589, longitude: 2.174347 };

const landmark = (id: string, position = SAGRADA): PreparedLandmark =>
  ({
    entry: { id },
    placement: { position },
    url: `https://goway.to/landmarks/${id}.glb`,
    hides: [],
  }) as unknown as PreparedLandmark;

/** The bounds of the tile (z, x, y) holding a position, in degrees. */
function cellBox(z: number, position = SAGRADA): CityCoverageBox {
  const n = 2 ** z;
  const x = Math.floor(mercatorX(position.longitude) * n);
  const y = Math.floor(mercatorY(position.latitude) * n);
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

/** Whether the engine draws a position's z14 cell from city tiles at full detail. */
function engineUsesCityTiles(coverage: readonly CityCoverageBox[]): boolean {
  const n = 2 ** 14;
  const tile = {
    z: 14,
    x: Math.floor(mercatorX(SAGRADA.longitude) * n),
    y: Math.floor(mercatorY(SAGRADA.latitude) * n),
    wrap: 0,
    lod: 0 as const,
    r: 0,
  };
  return assignSources([tile], { tileZoom: 15, coverage }).some((t) => t.format === 'goway');
}

describe('drawableLandmarks', () => {
  test('offered only where the engine draws city tiles: a wholly published z14 cell', () => {
    const none = new Set<string>();
    const whole = [cellBox(14)];
    expect(engineUsesCityTiles(whole)).toBe(true);
    expect(drawableLandmarks([landmark('sagrada')], whole, none, coverageCovers)).toHaveLength(1);

    // A region's edge: the landmark's z15 cell is published, the rest of its
    // z14 cell is not. The engine draws the basemap there — so no offer.
    const edge = [cellBox(15)];
    expect(engineUsesCityTiles(edge)).toBe(false);
    expect(drawableLandmarks([landmark('sagrada')], edge, none, coverageCovers)).toEqual([]);

    // Nothing published: nothing offered.
    expect(drawableLandmarks([landmark('sagrada')], [], none, coverageCovers)).toEqual([]);
  });

  test('a model that failed to load is never offered', () => {
    const coverage = [cellBox(14)];
    const all = [landmark('sagrada'), landmark('casa-batllo')];
    const offered = drawableLandmarks(all, coverage, new Set(['casa-batllo']), coverageCovers);
    expect(offered.map(({ entry }) => entry.id)).toEqual(['sagrada']);
  });
});

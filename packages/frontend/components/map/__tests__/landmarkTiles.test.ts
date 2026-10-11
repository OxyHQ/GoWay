/**
 * A landmark replaces its OSM buildings only while it is drawn, and the city
 * tiles that hold them are re-meshed when that changes
 * (`engine/city3d/landmarkTiles.ts`), and the adapter hands the engine only
 * the landmarks near the view, with hysteresis (`landmarksForView`).
 */
import { describe, expect, test } from 'bun:test';

import { landmarksForView } from '@/components/map/city3dLayer.web';
import {
  hiddenFeatureIds,
  tilesAround,
  withoutHidden,
} from '@/components/map/engine/city3d/landmarkTiles';
import {
  mercatorXFromLng,
  mercatorYFromLat,
  tileKey,
} from '@/components/map/engine/city3d/tileMath';
import { landmarksNear, type PreparedLandmark } from '@/lib/map/landmarks/load';

describe('hiddenFeatureIds', () => {
  const hides = new Map([
    ['a', [12, 22]],
    ['b', [32]],
  ]);
  test('only the DRAWN landmarks hide their buildings', () => {
    expect(hiddenFeatureIds([], hides)).toEqual([]);
    expect(hiddenFeatureIds(['b'], hides)).toEqual([32]);
    expect(hiddenFeatureIds(['a', 'b', 'unknown'], hides)).toEqual([12, 22, 32]);
  });
});

describe('withoutHidden (the mesh worker filter)', () => {
  const buildings = [{ id: 12 }, { id: 13 }, { id: 22 }];
  test('drops exactly the hidden ids', () => {
    expect(withoutHidden(buildings, [12, 22]).map((b) => b.id)).toEqual([13]);
    expect(withoutHidden(buildings, undefined)).toBe(buildings);
    expect(withoutHidden(buildings, [])).toBe(buildings);
  });
});

describe('tilesAround', () => {
  test("the anchor's tile and its eight neighbours", () => {
    const keys = tilesAround({ latitude: 41.4036, longitude: 2.1744 }, 15);
    expect(keys).toHaveLength(9);
    const x = Math.floor(mercatorXFromLng(2.1744) * 2 ** 15);
    const y = Math.floor(mercatorYFromLat(41.4036) * 2 ** 15);
    expect(keys).toContain(tileKey({ z: 15, x, y }));
    expect(keys).toContain(tileKey({ z: 15, x: x - 1, y: y + 1 }));
  });

  test('wraps across the antimeridian', () => {
    const keys = tilesAround({ latitude: 0, longitude: 179.999 }, 3);
    expect(keys).toContain('3/0/4');
    expect(keys).toContain('3/7/4');
  });
});

describe('landmarksForView', () => {
  const at = (id: string, latitude: number, longitude: number) =>
    ({
      entry: { id },
      placement: { position: { latitude, longitude } },
    }) as unknown as PreparedLandmark;
  // ~2.5 km and ~3.5 km north of the view centre.
  const near = at('near', 41.4225, 2.1744);
  const edge = at('edge', 41.4351, 2.1744);
  const all = [near, edge];
  const view = { zoom: 16, center: { lat: 41.4, lng: 2.1744 } };

  test('picks up landmarks within 3 km, nearest first', () => {
    expect(landmarksForView(all, new Set(), view, landmarksNear).map((l) => l.entry.id)).toEqual([
      'near',
    ]);
  });

  test('keeps a held landmark out to 4 km (no churn along the edge)', () => {
    expect(
      landmarksForView(all, new Set(['edge']), view, landmarksNear).map((l) => l.entry.id),
    ).toEqual(['near', 'edge']);
  });

  test('none below zoom 14', () => {
    expect(landmarksForView(all, new Set(), { ...view, zoom: 13 }, landmarksNear)).toEqual([]);
  });
});

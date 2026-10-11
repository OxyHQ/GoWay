/**
 * The tile ⇄ mercator ⇄ metre arithmetic behind the city-3D prototype.
 *
 * Every function here is wrong in a way nobody sees until a building lands a
 * tile away from its footprint, or swims by metres as the camera moves — so the
 * properties are pinned against independent facts (the equator's length, a
 * tile's corners, the absolute transform the centre-relative one must equal)
 * rather than against the implementation's own output.
 */
import { describe, expect, test } from 'bun:test';
import { MercatorCoordinate } from 'maplibre-gl';

import {
  centeredProjection,
  EARTH_CIRCUMFERENCE_M,
  latFromMercatorY,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
  multiplyMat4,
  tileCenterLatitude,
  tileKey,
  tileModelMatrix,
  tileOrigin,
  tileSizeMetres,
  tilesForView,
} from '@/components/map/engine/city3d/tileMath';

/** Apply a column-major 4×4 to a point (w = 1). */
function apply(
  m: ArrayLike<number>,
  [x, y, z]: [number, number, number],
): [number, number, number] {
  const w = m[3] * x + m[7] * y + m[11] * z + m[15];
  return [
    (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
    (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
    (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
  ];
}

const BARCELONA_Z14 = { z: 14, x: 8290, y: 6119 };

describe('mercator', () => {
  test('agrees with MapLibre’s own MercatorCoordinate', () => {
    for (const [lng, lat] of [
      [2.17, 41.39],
      [-73.99, 40.73],
      [139.7, 35.68],
      [0, 0],
    ]) {
      const reference = MercatorCoordinate.fromLngLat([lng, lat]);
      expect(mercatorXFromLng(lng)).toBeCloseTo(reference.x, 12);
      expect(mercatorYFromLat(lat)).toBeCloseTo(reference.y, 12);
      expect(latFromMercatorY(mercatorYFromLat(lat))).toBeCloseTo(lat, 9);
    }
  });

  test('a metre is 1/circumference of the map at the equator, and grows with latitude', () => {
    expect(mercatorPerMetre(0)).toBeCloseTo(1 / EARTH_CIRCUMFERENCE_M, 15);
    expect(mercatorPerMetre(60)).toBeCloseTo(2 / EARTH_CIRCUMFERENCE_M, 15);
    // MapLibre's own conformal height scale at the same latitude.
    const reference = MercatorCoordinate.fromLngLat([2.17, 41.39], 1).z;
    expect(mercatorPerMetre(41.39)).toBeCloseTo(reference, 12);
  });

  test('a z14 tile is ~2.4 km at the equator and ~1.83 km in Barcelona', () => {
    expect(tileSizeMetres({ z: 14, x: 0, y: 8191 })).toBeCloseTo(
      EARTH_CIRCUMFERENCE_M / 2 ** 14,
      -1,
    );
    expect(tileSizeMetres(BARCELONA_Z14)).toBeGreaterThan(1830);
    expect(tileSizeMetres(BARCELONA_Z14)).toBeLessThan(1840);
  });

  test('tile keys and origins', () => {
    expect(tileKey(BARCELONA_Z14)).toBe('14/8290/6119');
    expect(tileOrigin({ z: 1, x: 1, y: 1 })).toEqual({ x: 0.5, y: 0.5 });
    expect(tileCenterLatitude({ z: 0, x: 0, y: 0 })).toBeCloseTo(0, 9);
  });
});

describe('tileModelMatrix', () => {
  const tile = BARCELONA_Z14;
  const origin = tileOrigin(tile);
  const span = 1 / 2 ** tile.z;
  const size = tileSizeMetres(tile);
  const center = { x: origin.x + span * 0.3, y: origin.y + span * 0.6 };
  const model = tileModelMatrix(tile, center);

  test('local (0, 0) is the north-west corner, relative to the centre', () => {
    const [x, y, z] = apply(model, [0, 0, 0]);
    expect(x).toBeCloseTo(origin.x - center.x, 15);
    expect(y).toBeCloseTo(origin.y - center.y, 15);
    expect(z).toBe(0);
  });

  test('local (size, -size) is the south-east corner: y north is mercator y south', () => {
    const [x, y] = apply(model, [size, -size, 0]);
    expect(x + center.x).toBeCloseTo(origin.x + span, 12);
    expect(y + center.y).toBeCloseTo(origin.y + span, 12);
  });

  test('height is conformal: 100 m up is 100 m across', () => {
    const [x] = apply(model, [100, 0, 0]);
    const [, , z] = apply(model, [0, 0, 100]);
    expect(z).toBeCloseTo(x - (origin.x - center.x), 15);
  });

  test('it is a mirror (negative determinant) — the engine relies on knowing that', () => {
    const [a, , , , , b, , , , , c] = model;
    expect(a * b * c).toBeLessThan(0);
  });

  test('the centre-relative pair equals the absolute transform', () => {
    // Any mercator → clip matrix will do; this one is deliberately not affine.
    // biome-ignore format: a 4×4 matrix reads as four columns.
    const projection = [
      3, 0.2, 0, 0.1,
      0.1, -2, 0.3, 0,
      0, 0.4, 1, 0.5,
      -1.4, 1.1, 0.2, 1,
    ];
    // biome-ignore format: a 4×4 matrix reads as four columns.
    const absolute = multiplyMat4(projection, [
      model[0], 0, 0, 0,
      0, model[5], 0, 0,
      0, 0, model[10], 0,
      origin.x, origin.y, 0, 1,
    ]);
    const relative = multiplyMat4(centeredProjection(projection, center), model);
    for (const point of [
      [0, 0, 0],
      [size, -size, 50],
      [123.4, -987.6, 12],
    ] as [number, number, number][]) {
      const a = apply(absolute, point);
      const b = apply(relative, point);
      for (let i = 0; i < 3; i++) expect(b[i]).toBeCloseTo(a[i], 9);
    }
  });
});

describe('tilesForView', () => {
  const center = { lng: 2.17, lat: 41.39 };
  const bounds = { west: 2.1, south: 41.35, east: 2.25, north: 41.43 };

  test('the tile under the centre comes first', () => {
    const [first] = tilesForView(bounds, center, 14, 6);
    const n = 2 ** 14;
    expect(first).toEqual({
      z: 14,
      x: Math.floor(mercatorXFromLng(center.lng) * n),
      y: Math.floor(mercatorYFromLat(center.lat) * n),
      wrap: 0,
    });
  });

  test('is capped, nearest first, and unique', () => {
    const tiles = tilesForView(bounds, center, 14, 6);
    expect(tiles).toHaveLength(6);
    expect(new Set(tiles.map(tileKey)).size).toBe(6);
    const all = tilesForView(bounds, center, 14, 1000);
    expect(all.length).toBeGreaterThan(6);
    expect(all.slice(0, 6)).toEqual(tiles);
  });

  test('a whole-world view lists each canonical tile once', () => {
    const tiles = tilesForView(
      { west: -200, south: -89, east: 200, north: 89 },
      { lng: 0, lat: 0 },
      1,
      100,
    );
    expect(tiles).toHaveLength(4);
    for (const tile of tiles) {
      expect(tile.x).toBeGreaterThanOrEqual(0);
      expect(tile.x).toBeLessThan(2);
    }
  });

  // PR #119 review: the first version CLAMPED x, so a view straddling the
  // antimeridian never loaded the tiles east of it.
  describe('across the antimeridian', () => {
    const n = 2 ** 14;
    const lat = -17.6; // Taveuni, Fiji, where the line runs over land
    const keysOf = (tiles: { x: number; wrap: number }[]) =>
      tiles.map((t) => `${t.x}@${t.wrap}`).sort();

    test('unwrapped bounds load both sides, the east side one world over', () => {
      const tiles = tilesForView(
        { west: 179.97, south: lat - 0.02, east: 180.03, north: lat + 0.02 },
        { lng: 180, lat },
        14,
        6,
      );
      const xs = new Set(tiles.map((t) => `${t.x}@${t.wrap}`));
      expect(xs.has(`${n - 1}@0`)).toBe(true);
      expect(xs.has('0@1')).toBe(true);
      for (const tile of tiles) expect(tile.x).toBeLessThan(n);
    });

    test('wrapped bounds (east < west) and a centre in another world copy agree', () => {
      const unwrapped = tilesForView(
        { west: 179.97, south: lat - 0.02, east: 180.03, north: lat + 0.02 },
        { lng: 180, lat },
        14,
        6,
      );
      const wrappedBounds = tilesForView(
        { west: 179.97, south: lat - 0.02, east: -179.97, north: lat + 0.02 },
        { lng: -180, lat },
        14,
        6,
      );
      expect(keysOf(wrappedBounds)).toEqual(keysOf(unwrapped));
    });

    test('the two sides meet edge to edge when placed', () => {
      const center = { x: 1, y: mercatorYFromLat(lat) };
      const west = { z: 14, x: n - 1, y: 9000, wrap: 0 };
      const east = { z: 14, x: 0, y: 9000, wrap: 1 };
      const size = tileSizeMetres(west);
      // East edge of the last tile …
      const westEdge = tileModelMatrix(west, center)[0] * size + tileModelMatrix(west, center)[12];
      // … is the west edge of tile 0 drawn one world east.
      const eastEdge = tileModelMatrix(east, center)[12];
      expect(eastEdge).toBeCloseTo(westEdge, 12);
      expect(eastEdge).toBeCloseTo(0, 12);
    });

    test('a huge box is walked only near the centre', () => {
      const started = performance.now();
      const tiles = tilesForView(
        { west: -179, south: -80, east: 179, north: 80 },
        { lng: 2, lat: 41 },
        14,
        6,
      );
      expect(tiles).toHaveLength(6);
      expect(performance.now() - started).toBeLessThan(50);
    });
  });
});

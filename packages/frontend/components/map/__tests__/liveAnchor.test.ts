/**
 * Where a live shape is drawn in 3D: at its real altitude, turned to its real
 * heading, in the same centre-relative frame as the buildings — pinned
 * against MapLibre's own `MercatorCoordinate`, not against this code.
 */
import { describe, expect, test } from 'bun:test';
import { MercatorCoordinate } from 'maplibre-gl';

import {
  anchorMatrix,
  displayScale,
  metresPerPixel,
} from '@/components/map/engine/live3d/anchorMath';
import { mercatorPerMetre } from '@/components/map/engine/city3d/tileMath';

function apply(
  m: ArrayLike<number>,
  [x, y, z]: [number, number, number],
): [number, number, number] {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
  ];
}

const CENTER = MercatorCoordinate.fromLngLat({ lng: 2.17, lat: 41.39 });

describe('anchorMatrix', () => {
  test('puts the anchor exactly where MapLibre puts that lng/lat/altitude', () => {
    const anchor = { longitude: 2.08, latitude: 41.29, altitude: 1200, heading: 0, scale: 1 };
    const [x, y, z] = apply(anchorMatrix(anchor, CENTER), [0, 0, 0]);
    const expected = MercatorCoordinate.fromLngLat({ lng: 2.08, lat: 41.29 }, 1200);
    expect(x + CENTER.x).toBeCloseTo(expected.x, 12);
    expect(y + CENTER.y).toBeCloseTo(expected.y, 12);
    // MapLibre's mean-radius altitude scale, to a part in a million.
    expect(z / expected.z).toBeCloseTo(1, 6);
  });

  test('turns the nose (+y) to the heading, clockwise from north', () => {
    const k = mercatorPerMetre(41.29);
    for (const [heading, east, north] of [
      [0, 0, 1],
      [90, 1, 0],
      [180, 0, -1],
      [270, -1, 0],
    ] as const) {
      const m = anchorMatrix(
        { longitude: 2.08, latitude: 41.29, altitude: 0, heading, scale: 1 },
        CENTER,
      );
      const [x0, y0] = apply(m, [0, 0, 0]);
      const [x1, y1] = apply(m, [0, 1, 0]); // one metre towards the nose
      expect((x1 - x0) / k).toBeCloseTo(east, 9);
      // Mercator y grows SOUTH.
      expect(-(y1 - y0) / k).toBeCloseTo(north, 9);
    }
  });

  test('scales the shape, never the altitude', () => {
    const one = anchorMatrix(
      { longitude: 2, latitude: 41, altitude: 500, heading: 0, scale: 1 },
      CENTER,
    );
    const ten = anchorMatrix(
      { longitude: 2, latitude: 41, altitude: 500, heading: 0, scale: 10 },
      CENTER,
    );
    expect(apply(ten, [0, 0, 0])[2]).toBe(apply(one, [0, 0, 0])[2]);
    expect(apply(ten, [0, 0, 1])[2] - apply(ten, [0, 0, 0])[2]).toBeCloseTo(
      10 * (apply(one, [0, 0, 1])[2] - apply(one, [0, 0, 0])[2]),
      15,
    );
  });
});

describe('display size', () => {
  test('real size up close, a pixel floor far away', () => {
    expect(metresPerPixel(0, 0)).toBeCloseTo(40_030_173 / 512, -2);
    expect(displayScale(38, 18, 41, 30)).toBe(1); // ~0.45 m/px: real size
    expect(displayScale(38, 10, 41, 30)).toBeGreaterThan(10); // ~115 m/px: floored
  });
});

describe('size at Madrid', () => {
  test('a 100 m consist spans 100 m of MapLibre’s mercator at 40.42°N', () => {
    // Puerta del Sol: where the owner saw an over-sized train.
    const latitude = 40.4169;
    const centre = MercatorCoordinate.fromLngLat({ lng: -3.7035, lat: latitude });
    const m = anchorMatrix(
      { longitude: -3.7035, latitude, altitude: 0, heading: 90, scale: 1 },
      centre,
    );
    const [x0] = apply(m, [0, -50, 0]);
    const [x1] = apply(m, [0, 50, 0]);
    expect(
      (x1 - x0) /
        MercatorCoordinate.fromLngLat({
          lng: -3.7035,
          lat: latitude,
        }).meterInMercatorCoordinateUnits(),
    ).toBeCloseTo(100, 6);
  });
});

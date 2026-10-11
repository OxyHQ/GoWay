import { describe, expect, test } from 'bun:test';

import {
  ecefToEnu,
  geodeticToEcef,
  geodeticToEnu,
  invertSimilarity,
  sceneUp,
  transformPoint,
  WGS84_A,
  WGS84_F,
  type Vec3,
} from '../geodesy';

const close = (actual: readonly number[], expected: readonly number[], digits = 6) => {
  expect(actual.length).toBe(expected.length);
  for (const [index, value] of actual.entries()) {
    expect(value).toBeCloseTo(expected[index], digits);
  }
};

describe('geodeticToEcef', () => {
  test('the equator at the prime meridian is one semi-major axis out on X', () => {
    close(geodeticToEcef({ latitude: 0, longitude: 0, altitudeMeters: 0 }), [WGS84_A, 0, 0]);
  });

  test('the north pole is one semi-minor axis up on Z', () => {
    close(
      geodeticToEcef({ latitude: 90, longitude: 0, altitudeMeters: 0 }),
      [0, 0, WGS84_A * (1 - WGS84_F)],
      3,
    );
  });

  test('altitude is added along the ellipsoid normal', () => {
    const [x] = geodeticToEcef({ latitude: 0, longitude: 0, altitudeMeters: 100 });
    expect(x).toBeCloseTo(WGS84_A + 100, 6);
  });
});

describe('ENU around an anchor', () => {
  const anchor = { latitude: 41.3809, longitude: 2.1734, altitudeMeters: 12 };

  test('the anchor itself is the origin', () => {
    close(geodeticToEnu(anchor, anchor), [0, 0, 0], 6);
  });

  test('a point due north is on +N, due east on +E, above on +U', () => {
    const north = geodeticToEnu({ ...anchor, latitude: anchor.latitude + 0.001 }, anchor);
    // 0.001° of latitude is ~110.7 m at 41° N on WGS 84.
    expect(north[1]).toBeGreaterThan(110);
    expect(north[1]).toBeLessThan(111.5);
    expect(Math.abs(north[0])).toBeLessThan(1e-6);

    const east = geodeticToEnu({ ...anchor, longitude: anchor.longitude + 0.001 }, anchor);
    // cos(41.38°) × 111.32 km × 0.001 ≈ 83.6 m.
    expect(east[0]).toBeGreaterThan(83);
    expect(east[0]).toBeLessThan(84.2);
    expect(Math.abs(east[1])).toBeLessThan(0.01);

    const up = geodeticToEnu({ ...anchor, altitudeMeters: anchor.altitudeMeters + 7 }, anchor);
    close(up, [0, 0, 7], 6);
  });

  test('ecefToEnu agrees with the one-step helper', () => {
    const point = { latitude: 41.3815, longitude: 2.1741, altitudeMeters: 15 };
    close(ecefToEnu(geodeticToEcef(point), anchor), geodeticToEnu(point, anchor), 9);
  });
});

/** Column-major similarity: rotate `degrees` about Z, scale, translate. */
function similarityAboutZ(degrees: number, scale: number, t: Vec3): number[] {
  const r = (degrees * Math.PI) / 180;
  const c = Math.cos(r) * scale;
  const s = Math.sin(r) * scale;
  return [c, s, 0, 0, -s, c, 0, 0, 0, 0, scale, 0, t[0], t[1], t[2], 1];
}

describe('invertSimilarity', () => {
  test('round-trips a rotated, scaled, translated point', () => {
    const m = similarityAboutZ(30, 2.5, [10, -4, 3]);
    const inverse = invertSimilarity(m);
    expect(inverse).not.toBeNull();
    const p: Vec3 = [1.5, -7, 2];
    close(transformPoint(inverse as number[], transformPoint(m, p)), p, 9);
    close(transformPoint(m, transformPoint(inverse as number[], p)), p, 9);
  });

  test('the identity inverts to itself', () => {
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    close(invertSimilarity(identity) as number[], identity);
  });

  test('refuses a shear, a non-uniform scale, a projective row and junk', () => {
    const shear = [1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const stretched = [2, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const projective = [1, 0, 0, 0.1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    expect(invertSimilarity(shear)).toBeNull();
    expect(invertSimilarity(stretched)).toBeNull();
    expect(invertSimilarity(projective)).toBeNull();
    expect(invertSimilarity([1, 2, 3])).toBeNull();
    expect(invertSimilarity(new Array(16).fill(Number.NaN))).toBeNull();
    expect(invertSimilarity(new Array(16).fill(0))).toBeNull();
  });
});

describe('sceneUp', () => {
  test('a Z-up scene is Z-up', () => {
    close(sceneUp(similarityAboutZ(45, 3, [1, 2, 3])) as Vec3, [0, 0, 1], 9);
  });

  test('a Y-up scene (scene y → ENU up, scene z → ENU south) is Y-up', () => {
    // Columns are where scene x, y, z land in ENU.
    const yUp = [1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1];
    close(sceneUp(yUp) as Vec3, [0, 1, 0], 9);
  });

  test('a matrix that is not a similarity has no up', () => {
    expect(sceneUp([1, 0, 0, 0, 0.5, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])).toBeNull();
  });
});

/**
 * The sun's shadow camera (`engine/city3d/shadows.ts`): that it sees what it
 * must, that a shadow lands where geometry says, and that the cached map
 * survives the small pans a map makes all the time — the property that keeps
 * shadows from costing a full redraw of every building every frame.
 */
import { describe, expect, test } from 'bun:test';

import {
  SHADOW_MAP_SIZE,
  SHADOW_MAX_HEIGHT_M,
  SHADOW_RADIUS_RANGE_M,
  type ShadowFrame,
  shadowFrame,
  shadowMatrixForCentre,
  shadowMatrixForEnu,
  shadowRadiusForView,
} from '@/components/map/engine/city3d/shadows';
import {
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
} from '@/components/map/engine/city3d/tileMath';

const BARCELONA = { lng: 2.1686, lat: 41.3874 };
const SUNS = [
  { azimuthDeg: 77, altitudeDeg: 22 },
  { azimuthDeg: 163, altitudeDeg: 71 },
  { azimuthDeg: 297, altitudeDeg: 5 },
  { azimuthDeg: 0, altitudeDeg: 90 },
];

function apply(m: number[], p: readonly number[]): number[] {
  return [0, 1, 2, 3].map((r) => m[r] * p[0] + m[4 + r] * p[1] + m[8 + r] * p[2] + m[12 + r]);
}

/** A point `east`/`north`/`up` metres from the centre, in absolute mercator. */
function at(center: { lng: number; lat: number }, east: number, north: number, up: number) {
  const k = mercatorPerMetre(center.lat);
  return [
    mercatorXFromLng(center.lng) + east * k,
    mercatorYFromLat(center.lat) - north * k,
    up * k,
  ];
}

function frameFor(sun: (typeof SUNS)[number], center = BARCELONA, radiusM = 1000): ShadowFrame {
  const frame = shadowFrame({ sun, center, radiusM });
  if (!frame) throw new Error('expected a shadow frame');
  return frame;
}

describe('shadowFrame', () => {
  test('no map for a sun on or below the horizon, or for nonsense', () => {
    expect(
      shadowFrame({ sun: { azimuthDeg: 90, altitudeDeg: 0.2 }, center: BARCELONA, radiusM: 900 }),
    ).toBeNull();
    expect(
      shadowFrame({ sun: { azimuthDeg: 90, altitudeDeg: -10 }, center: BARCELONA, radiusM: 900 }),
    ).toBeNull();
    expect(
      shadowFrame({
        sun: { azimuthDeg: Number.NaN, altitudeDeg: 30 },
        center: BARCELONA,
        radiusM: 900,
      }),
    ).toBeNull();
  });

  test('everything within the radius, ground to the tallest caster, is inside the map', () => {
    for (const sun of SUNS) {
      const frame = frameFor(sun);
      // The receivers are a disc (the box is turned to the sun, so its
      // corners point wherever the sun says); every point of it, at every
      // height a caster can have.
      for (let i = 0; i <= 16; i++) {
        const angle = (i / 16) * 2 * Math.PI;
        const r = i === 16 ? 0 : 1000;
        for (const up of [0, SHADOW_MAX_HEIGHT_M]) {
          const point = at(BARCELONA, r * Math.cos(angle), r * Math.sin(angle), up);
          const clip = apply(frame.lightFromMercator, point);
          for (const c of clip.slice(0, 3)) expect(Math.abs(c)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  test('on 3D terrain: the box follows the ground, so lifted buildings still cast and receive', () => {
    // Review after #126 (terrain on by default): the basemap's shadows were
    // computed on sea level while the drawn ground stood tens of metres up.
    for (const sun of SUNS) {
      const groundM = 230;
      const frame = shadowFrame({ sun, center: BARCELONA, radiusM: 1000, groundM });
      if (!frame) throw new Error('expected a frame');
      for (const up of [groundM - 100, groundM, groundM + SHADOW_MAX_HEIGHT_M]) {
        const clip = apply(frame.lightFromMercator, at(BARCELONA, 300, -200, up));
        for (const c of clip.slice(0, 3)) expect(Math.abs(c)).toBeLessThanOrEqual(1);
      }
      // A sea-level box misses a tall roof on high ground (a hill town at
      // 500 m) — measurable under the zenith sun, whose box is only as deep as
      // the casters are tall (a lower sun's box is deepened by its own extent).
      if (sun.altitudeDeg === 90) {
        const flat = frameFor(sun);
        const roof = apply(flat.lightFromMercator, at(BARCELONA, 0, 0, 500 + SHADOW_MAX_HEIGHT_M));
        expect(Math.max(...roof.slice(0, 3).map(Math.abs))).toBeGreaterThan(1);
      }
    }
  });

  test('a terrain sample’s jitter does not redraw the map', () => {
    const sun = SUNS[0];
    const a = shadowFrame({ sun, center: BARCELONA, radiusM: 1000, groundM: 41.2 });
    const b = shadowFrame({ sun, center: BARCELONA, radiusM: 1000, groundM: 39.7 });
    expect(a?.key).toBe(b?.key);
  });

  test('a roof’s shadow lands where the sun says, and the roof is nearer the sun', () => {
    for (const sun of SUNS.filter((s) => s.altitudeDeg < 90)) {
      const frame = frameFor(sun);
      const height = 40;
      const az = (sun.azimuthDeg * Math.PI) / 180;
      const length = height / Math.tan((sun.altitudeDeg * Math.PI) / 180);
      const roof = apply(frame.lightFromMercator, at(BARCELONA, 0, 0, height));
      // The tip of the shadow, on the ground, away from the sun.
      const tip = apply(
        frame.lightFromMercator,
        at(BARCELONA, -Math.sin(az) * length, -Math.cos(az) * length, 0),
      );
      expect(Math.abs(roof[0] - tip[0])).toBeLessThan(1e-9);
      expect(Math.abs(roof[1] - tip[1])).toBeLessThan(1e-9);
      expect(roof[2]).toBeLessThan(tip[2]);
    }
  });

  test('a small pan reuses the map; a large one moves it on whole texels', () => {
    const sun = SUNS[0];
    const k = mercatorPerMetre(BARCELONA.lat);
    const base = frameFor(sun);
    // Two metres east: well inside one grid step (radius / 8).
    const nudged = frameFor(sun, { lng: BARCELONA.lng + 2 * k * 360, lat: BARCELONA.lat });
    expect(nudged.key).toBe(base.key);
    expect(nudged.lightFromMercator).toEqual(base.lightFromMercator);

    // Two kilometres: a new box, but a fixed world point keeps its sub-texel
    // position, so no shadow edge shimmers when the box moves.
    const moved = frameFor(sun, { lng: BARCELONA.lng + 2000 * k * 360, lat: BARCELONA.lat });
    expect(moved.key).not.toBe(base.key);
    const point = at(BARCELONA, 1100, 300, 0);
    const texel = (frame: ShadowFrame) => {
      const clip = apply(frame.lightFromMercator, point);
      return [((clip[0] + 1) / 2) * SHADOW_MAP_SIZE, ((clip[1] + 1) / 2) * SHADOW_MAP_SIZE];
    };
    const a = texel(base);
    const b = texel(moved);
    for (let i = 0; i < 2; i++) {
      const fa = a[i] - Math.floor(a[i]);
      const fb = b[i] - Math.floor(b[i]);
      expect(Math.min(Math.abs(fa - fb), 1 - Math.abs(fa - fb))).toBeLessThan(1e-4);
    }
  });

  test('the radius steps by √2, so zooming a little does not redraw', () => {
    const sun = SUNS[0];
    expect(frameFor(sun, BARCELONA, 900).key).toBe(frameFor(sun, BARCELONA, 1000).key);
    expect(frameFor(sun, BARCELONA, 700).key).not.toBe(frameFor(sun, BARCELONA, 1000).key);
  });

  test('texels stay under two metres at a street-level radius', () => {
    for (const sun of SUNS) expect(frameFor(sun, BARCELONA, 1000).texelM).toBeLessThan(2);
  });
});

describe('the matrices the GPU gets', () => {
  const frame = frameFor(SUNS[0]);
  const center = { x: mercatorXFromLng(BARCELONA.lng), y: mercatorYFromLat(BARCELONA.lat) };

  test('centre-relative mercator: the same transform as the absolute one', () => {
    const relative = shadowMatrixForCentre(frame, center);
    const q = [3e-6, -2e-6, 1e-6];
    const absolute = apply(frame.lightFromMercator, [center.x + q[0], center.y + q[1], q[2]]);
    const viaCentre = apply(relative, q);
    for (let i = 0; i < 3; i++) expect(Math.abs(absolute[i] - viaCentre[i])).toBeLessThan(1e-9);
  });

  test('ENU metres: east, NORTH (mercator y is south), up', () => {
    const k = mercatorPerMetre(BARCELONA.lat);
    const enu = shadowMatrixForEnu(frame, center, k);
    const viaEnu = apply(enu, [120, 80, 15]);
    const direct = apply(frame.lightFromMercator, at(BARCELONA, 120, 80, 15));
    for (let i = 0; i < 3; i++) expect(Math.abs(direct[i] - viaEnu[i])).toBeLessThan(1e-9);
  });
});

describe('shadowRadiusForView', () => {
  test('the farthest visible corner, clamped', () => {
    const tiny = { west: 2.168, east: 2.1692, south: 41.3871, north: 41.3877 };
    expect(shadowRadiusForView(tiny, BARCELONA)).toBe(SHADOW_RADIUS_RANGE_M[0]);
    const horizon = { west: 1, east: 3.5, south: 41, north: 43 };
    expect(shadowRadiusForView(horizon, BARCELONA)).toBe(SHADOW_RADIUS_RANGE_M[1]);
    const street = { west: 2.16, east: 2.1772, south: 41.382, north: 41.3928 };
    const r = shadowRadiusForView(street, BARCELONA);
    expect(r).toBeGreaterThan(SHADOW_RADIUS_RANGE_M[0]);
    expect(r).toBeLessThan(SHADOW_RADIUS_RANGE_M[1]);
  });
});

/**
 * The city-3D layer is lit by the SAME light as `building-3d`.
 *
 * `cityLightFromSpec` converts a MapLibre `light` into the engine's ENU light.
 * The claim worth pinning is that, for every face, the city shader's
 * `dot(outwardNormal, light)` equals the number maplibre-gl 6.10 computes for
 * the same face of the extrusion. So the reference below re-implements
 * MapLibre's OWN steps, independently of the conversion:
 *
 *  1. `sphericalToCartesian([r, azimuthal, polar])` — azimuth + 90°, then the
 *     spherical formula — in TILE coordinates (x east, y SOUTH, z up);
 *  2. under `anchor: 'viewport'`, `fromRotation(bearing)` applied to it;
 *  3. a wall normal from `p1.sub(p2)._perp()._unit()` on a vector-tile
 *     exterior (clockwise as drawn), which points INTO the building.
 *
 * The inputs are main's real sun lights (`sunLitBuildingsLight`,
 * `buildingsLightAt`) and the static fallback (`BUILDINGS_LIGHT`), so a change
 * to either side of the seam shows up here.
 */
import { describe, expect, test } from 'bun:test';

import { cityLightFromSpec, type LightLike, sameCityLight } from '@/components/map/city3dLight';
import { BUILDINGS_LIGHT, sunLitBuildingsLight } from '@/lib/map/style/buildings3d';
import { buildingsLightAt } from '@/lib/map/sunLight';

const DEG = Math.PI / 180;

/** maplibre-gl 6.10 `sphericalToCartesian`, verbatim in substance. */
function maplibreLightPosition(spec: LightLike, bearingDeg: number): [number, number, number] {
  const [r, azimuthal, polar] = spec.position as [number, number, number];
  const az = (azimuthal + 90) * DEG;
  const p = polar * DEG;
  let x = r * Math.cos(az) * Math.sin(p);
  let y = r * Math.sin(az) * Math.sin(p);
  const z = r * Math.cos(p);
  if (spec.anchor === 'viewport') {
    // gl-matrix `fromRotation` (mat3, column-major) then `transformMat3`.
    const c = Math.cos(bearingDeg * DEG);
    const s = Math.sin(bearingDeg * DEG);
    [x, y] = [c * x - s * y, s * x + c * y];
  }
  return [x, y, z];
}

/**
 * The four walls of a square exterior as a vector tile stores it (clockwise as
 * drawn, y down), with MapLibre's inward normals in tile coordinates and the
 * matching OUTWARD normals in ENU.
 */
function squareWalls(): { tile: [number, number, number]; enu: [number, number, number] }[] {
  const ring: [number, number][] = [
    [0, 0],
    [10, 0],
    [10, 10],
    [0, 10],
    [0, 0],
  ];
  const walls: { tile: [number, number, number]; enu: [number, number, number] }[] = [];
  for (let i = 1; i < ring.length; i++) {
    const [p1x, p1y] = ring[i];
    const [p2x, p2y] = ring[i - 1];
    // p1.sub(p2)._perp()._unit(): (x, y) → (−y, x)
    const dx = p1x - p2x;
    const dy = p1y - p2y;
    const length = Math.hypot(dx, dy);
    const inward: [number, number, number] = [-dy / length, dx / length, 0];
    // Outward is the opposite; tile y is south, ENU y is north.
    walls.push({ tile: inward, enu: [-inward[0], inward[1], 0] });
  }
  return walls;
}

const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const LIGHTS: [string, LightLike][] = [
  ['static light fallback', BUILDINGS_LIGHT.light],
  ['static dark fallback', BUILDINGS_LIGHT.dark],
  ['sun, morning, SE', sunLitBuildingsLight('light', { azimuthDeg: 120, altitudeDeg: 25 })],
  ['sun, noon, S', sunLitBuildingsLight('dark', { azimuthDeg: 180, altitudeDeg: 70 })],
  ['sun, evening, W', sunLitBuildingsLight('light', { azimuthDeg: 280, altitudeDeg: 5 })],
  ['sun, night', sunLitBuildingsLight('dark', { azimuthDeg: 10, altitudeDeg: -30 })],
  [
    'Barcelona, 2026-06-21 17:00 UTC',
    buildingsLightAt(
      'light',
      { latitude: 41.39, longitude: 2.17 },
      new Date('2026-06-21T17:00:00Z'),
    ),
  ],
];

describe('cityLightFromSpec agrees with MapLibre face for face', () => {
  for (const [name, spec] of LIGHTS) {
    for (const bearing of [0, 37, -120]) {
      test(`${name}, bearing ${bearing}°`, () => {
        const maplibre = maplibreLightPosition(spec, bearing);
        const city = cityLightFromSpec(spec, bearing);
        // Roof.
        expect(dot([0, 0, 1], city.position)).toBeCloseTo(dot([0, 0, 1], maplibre), 12);
        // Every wall.
        for (const wall of squareWalls()) {
          expect(dot(wall.enu, city.position)).toBeCloseTo(dot(wall.tile, maplibre), 12);
        }
        expect(city.intensity).toBe(spec.intensity as number);
      });
    }
  }

  test('the lit wall is the one facing the sun', () => {
    const city = cityLightFromSpec(
      sunLitBuildingsLight('light', { azimuthDeg: 90, altitudeDeg: 30 }),
      0,
    );
    const facing = (enu: [number, number, number]) => dot(enu, city.position);
    expect(facing([1, 0, 0])).toBeGreaterThan(0); // east wall, morning sun
    expect(facing([-1, 0, 0])).toBeLessThan(0);
  });

  test('a map-anchored sun ignores the bearing; a viewport light turns with it', () => {
    const sun = sunLitBuildingsLight('light', { azimuthDeg: 200, altitudeDeg: 40 });
    expect(cityLightFromSpec(sun, 0)).toEqual(cityLightFromSpec(sun, 90));
    expect(
      sameCityLight(
        cityLightFromSpec(BUILDINGS_LIGHT.light, 0),
        cityLightFromSpec(BUILDINGS_LIGHT.light, 90),
      ),
    ).toBe(false);
  });
});

describe('defaults and comparison', () => {
  test('an empty light is MapLibre’s default light', () => {
    const city = cityLightFromSpec({}, 0);
    expect(city.intensity).toBe(0.5);
    expect(city.color).toEqual([1, 1, 1]);
    const reference = maplibreLightPosition({ position: [1.15, 210, 30], anchor: 'viewport' }, 0);
    expect(dot([0, 0, 1], city.position)).toBeCloseTo(reference[2], 12);
    expect(cityLightFromSpec(null, 0)).toEqual(city);
  });

  test('non-literal values fall back rather than throw', () => {
    const city = cityLightFromSpec(
      { position: ['literal', [1, 2, 3]], intensity: ['get', 'x'], color: 'red' },
      0,
    );
    expect(city.intensity).toBe(0.5);
    expect(city.color).toEqual([1, 1, 1]);
    expect(city.position.every(Number.isFinite)).toBe(true);
  });

  test('colours parse as sRGB channels', () => {
    expect(cityLightFromSpec({ color: '#ff8000' }, 0).color).toEqual([1, 128 / 255, 0]);
    expect(cityLightFromSpec({ color: '#fff' }, 0).color).toEqual([1, 1, 1]);
  });

  test('sameCityLight', () => {
    const a = cityLightFromSpec(BUILDINGS_LIGHT.light, 10);
    expect(sameCityLight(null, a)).toBe(false);
    expect(sameCityLight(a, cityLightFromSpec(BUILDINGS_LIGHT.light, 10))).toBe(true);
    expect(sameCityLight(a, cityLightFromSpec(BUILDINGS_LIGHT.dark, 10))).toBe(false);
  });
});

/**
 * The sun light: the shaping in `buildings3d.ts` and the runtime policy in
 * `sunLight.ts`.
 *
 * What is pinned, and why each one matters on a screen:
 *
 *  - **The azimuth is the sun's, under `anchor: 'map'`.** A light measured
 *    from the viewport, or a bearing off by 180°, lights the shady side of
 *    every street and still looks like a perfectly good map.
 *  - **The polar angle never leaves the legible band** — not at the zenith
 *    (flat walls), not at the horizon (dark roofs), not at night.
 *  - **Nothing jumps.** Across sunset and through twilight the light changes
 *    by degrees, and across north it does not sweep the long way round.
 *  - **Intensity is the appearance's, never the hour's.**
 *  - **The output is a valid style light**, through the real style-spec
 *    validator, including an unwrapped azimuth.
 */
import { describe, expect, test } from 'bun:test';
import { validateStyleMin } from '@maplibre/maplibre-gl-style-spec';
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';

import { BUILDINGS_LIGHT, sunLitBuildingsLight, sunPolarDeg } from '@/lib/map/style/buildings3d';
import { buildingsLightAt, nextBuildingsLight, sameLight } from '@/lib/map/sunLight';

const BARCELONA = { latitude: 41.3874, longitude: 2.1686 };
const SYDNEY = { latitude: -33.8688, longitude: 151.2093 };

function position(light: LightSpecification): [number, number, number] {
  return light.position as [number, number, number];
}

describe('sunLitBuildingsLight', () => {
  test('is map-anchored, aimed at the sun, white, at the appearance intensity', () => {
    for (const appearance of ['light', 'dark'] as const) {
      const light = sunLitBuildingsLight(appearance, { azimuthDeg: 213.4, altitudeDeg: 40 });
      expect(light.anchor).toBe('map');
      expect(light.color).toBe('#ffffff');
      expect(light.intensity).toBe(BUILDINGS_LIGHT[appearance].intensity);
      expect(position(light)[0]).toBe(1.15);
      expect(position(light)[1]).toBe(213);
    }
  });

  test('rounds a bearing of 359.6° to north, not to 360', () => {
    const light = sunLitBuildingsLight('light', { azimuthDeg: 359.6, altitudeDeg: 10 });
    expect(position(light)[1]).toBe(0);
  });

  test('the zenith is drawn at the measured 30°, the horizon at 50°', () => {
    expect(sunPolarDeg(90)).toBe(30);
    expect(sunPolarDeg(0)).toBe(50);
    // The static light's polar is the high-sun end: noon reproduces the
    // measured look, rotated.
    expect(position(BUILDINGS_LIGHT.light)[2]).toBe(30);
  });

  test('day: a straight line in altitude — higher sun, steeper light', () => {
    let previous = sunPolarDeg(0);
    for (let altitude = 5; altitude <= 90; altitude += 5) {
      const polar = sunPolarDeg(altitude);
      expect(polar).toBeLessThan(previous);
      previous = polar;
    }
    // Barcelona: midsummer noon (72°) vs midwinter noon (26°) still differ.
    expect(Math.round(sunPolarDeg(72))).toBe(34);
    expect(Math.round(sunPolarDeg(26))).toBe(44);
  });

  test('night: eases back to 30° through civil twilight, then holds', () => {
    expect(sunPolarDeg(-3)).toBe(40);
    expect(sunPolarDeg(-6)).toBe(30);
    expect(sunPolarDeg(-30)).toBe(30);
    expect(sunPolarDeg(-90)).toBe(30);
  });

  test('never leaves [30°, 50°], at any altitude', () => {
    for (let altitude = -90; altitude <= 90; altitude += 0.5) {
      const polar = sunPolarDeg(altitude);
      expect(polar).toBeGreaterThanOrEqual(30);
      expect(polar).toBeLessThanOrEqual(50);
    }
  });

  test('is continuous: no jump at the horizon or at the end of twilight', () => {
    for (const edge of [0, -6]) {
      expect(Math.abs(sunPolarDeg(edge + 1e-9) - sunPolarDeg(edge - 1e-9))).toBeLessThan(1e-6);
    }
  });
});

describe('buildingsLightAt', () => {
  test('Barcelona, a summer afternoon: light from the south-west, high', () => {
    const light = buildingsLightAt('light', BARCELONA, new Date('2024-06-20T15:00:00Z'));
    const [, azimuth, polar] = position(light);
    expect(light.anchor).toBe('map');
    expect(azimuth).toBeGreaterThan(200);
    expect(azimuth).toBeLessThan(290);
    expect(polar).toBeGreaterThan(30);
    expect(polar).toBeLessThan(50);
  });

  test('Sydney at noon: light from the north', () => {
    // 02:00 UTC is 12:00 AEST; Sydney's solar noon is ~01:50 UTC in June.
    const light = buildingsLightAt('dark', SYDNEY, new Date('2024-06-20T01:55:00Z'));
    const azimuth = position(light)[1];
    expect(Math.min(azimuth, 360 - azimuth)).toBeLessThan(5);
    expect(light.intensity).toBe(BUILDINGS_LIGHT.dark.intensity);
  });

  test('the same instant and place give the same light in both themes but for intensity', () => {
    const now = new Date('2024-06-20T15:00:00Z');
    const light = buildingsLightAt('light', BARCELONA, now);
    const dark = buildingsLightAt('dark', BARCELONA, now);
    expect(light.position).toEqual(dark.position);
    expect(light.intensity).not.toBe(dark.intensity);
  });

  test('sunset into the night changes the light by degrees, never a jump', () => {
    // Barcelona, 2024-06-20: sunset ~19:29 UTC, civil dusk ~20:02 UTC.
    // Every five minutes — the refresh interval — from 18:30 to 21:30.
    let previous = buildingsLightAt('light', BARCELONA, new Date('2024-06-20T18:30:00Z'));
    for (let minute = 5; minute <= 180; minute += 5) {
      const now = new Date(Date.UTC(2024, 5, 20, 18, 30 + minute));
      const next = nextBuildingsLight(previous, buildingsLightAt('light', BARCELONA, now));
      expect(next.anchor).toBe('map');
      expect(Math.abs(position(next)[1] - position(previous)[1])).toBeLessThanOrEqual(3);
      expect(Math.abs(position(next)[2] - position(previous)[2])).toBeLessThanOrEqual(4);
      previous = next;
    }
  });

  test('falls back to the static style light for inputs the engine could not draw', () => {
    const now = new Date('2024-06-20T15:00:00Z');
    expect(buildingsLightAt('light', null, now)).toBe(BUILDINGS_LIGHT.light);
    expect(buildingsLightAt('dark', { latitude: Number.NaN, longitude: 2 }, now)).toBe(
      BUILDINGS_LIGHT.dark,
    );
    expect(buildingsLightAt('light', { latitude: 95, longitude: 2 }, now)).toBe(
      BUILDINGS_LIGHT.light,
    );
    expect(buildingsLightAt('light', BARCELONA, new Date(Number.NaN))).toBe(BUILDINGS_LIGHT.light);
  });
});

describe('nextBuildingsLight', () => {
  const at = (azimuthDeg: number, altitudeDeg = 20) =>
    sunLitBuildingsLight('light', { azimuthDeg, altitudeDeg });

  test('an unchanged light returns the PREVIOUS object, so React and the engine skip it', () => {
    const previous = at(120);
    expect(nextBuildingsLight(previous, at(120.3))).toBe(previous);
  });

  test('a changed light is returned', () => {
    const previous = at(120);
    const next = nextBuildingsLight(previous, at(125));
    expect(next).not.toBe(previous);
    expect(position(next)[1]).toBe(125);
  });

  test('crossing north steps 2°, it does not sweep 358° the long way round', () => {
    const next = nextBuildingsLight(at(359), at(1));
    expect(position(next)[1]).toBe(361);
    const back = nextBuildingsLight(at(1), at(359));
    expect(position(back)[1]).toBe(-1);
  });

  test('stays near a reference that has already drifted past 360°', () => {
    // A map left open for days: the applied azimuth is unwrapped.
    const drifted: LightSpecification = { ...at(0), position: [1.15, 725, 40] };
    expect(position(nextBuildingsLight(drifted, at(7)))[1]).toBe(727);
  });

  test('does not unwrap against a viewport-anchored light', () => {
    const next = nextBuildingsLight(BUILDINGS_LIGHT.light, at(10));
    expect(position(next)[1]).toBe(10);
    expect(next.anchor).toBe('map');
  });

  test('null previous: the next light as is', () => {
    const next = at(42);
    expect(nextBuildingsLight(null, next)).toBe(next);
  });

  test('sameLight compares the four fields GoWay sets', () => {
    expect(sameLight(at(10), at(10))).toBe(true);
    expect(sameLight(at(10), at(11))).toBe(false);
    expect(sameLight(at(10), at(10, 80))).toBe(false);
    expect(sameLight(at(10), { ...at(10), intensity: 0.45 })).toBe(false);
  });
});

test('every light it can produce is a valid style light — the real validator', () => {
  const lights: LightSpecification[] = [
    buildingsLightAt('light', BARCELONA, new Date('2024-06-20T15:00:00Z')),
    buildingsLightAt('dark', SYDNEY, new Date('2024-12-21T23:00:00Z')),
    // Polar night, and an azimuth unwrapped past 360°.
    buildingsLightAt(
      'dark',
      { latitude: 78.22, longitude: 15.65 },
      new Date('2024-12-21T12:00:00Z'),
    ),
    nextBuildingsLight(
      sunLitBuildingsLight('light', { azimuthDeg: 359, altitudeDeg: -20 }),
      sunLitBuildingsLight('light', { azimuthDeg: 1, altitudeDeg: -20 }),
    ),
  ];
  for (const light of lights) {
    const errors = validateStyleMin({ version: 8, sources: {}, layers: [], light });
    expect(errors).toEqual([]);
  }
});

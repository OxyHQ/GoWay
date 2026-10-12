/**
 * `sunPosition` against values that were not produced by `sun.ts`.
 *
 * Three kinds of reference, because each catches what the others cannot:
 *
 *  1. **Published worked examples.** Meeus's Example 25.a (the sun's apparent
 *     declination on 1992-10-13) and `suncalc`'s own test vector. A mistyped
 *     coefficient moves these and nothing else notices.
 *  2. **Geometry that holds by definition.** At local solar noon the sun's
 *     altitude is `90 − |latitude − declination|`, and at the poles the
 *     altitude IS the declination. With the solstice declination (±23.44°)
 *     these give exact expected values for any city, which is what pins the
 *     southern hemisphere and the polar day/night without trusting another
 *     implementation.
 *  3. **Conventions.** Azimuth clockwise from north, in `[0, 360)`: equinox
 *     sunrise due east, sunset due west, the noon sun due south north of the
 *     tropics and due NORTH south of them. A sign or zero error in the azimuth
 *     is exactly the bug that lights the wrong side of every street and still
 *     looks plausible.
 *
 * Tolerances are stated per test and are far tighter than the light needs —
 * it is rounded to whole degrees — so a failure here is a wrong formula, not
 * noise.
 */
import { describe, expect, test } from 'bun:test';

import { subsolarPoint, sunPosition } from '@/lib/map/sun';

/** Obliquity of the ecliptic, 2024 — the solstice declination. */
const SOLSTICE_DEC = 23.436;

/** Smallest signed difference between two bearings, in degrees. */
function bearingDelta(a: number, b: number): number {
  return ((((a - b) % 360) + 540) % 360) - 180;
}

/**
 * The sun's highest point over one UTC day at a place, found by scanning the
 * day minute by minute: local solar noon without trusting `sun.ts`'s own
 * equation of time to say when that is.
 */
function solarNoon(year: number, month: number, day: number, lat: number, lng: number) {
  let best = { altitudeDeg: -Infinity, azimuthDeg: Number.NaN };
  for (let minute = 0; minute < 1440; minute += 1) {
    const position = sunPosition(new Date(Date.UTC(year, month - 1, day, 0, minute)), lat, lng);
    if (position.altitudeDeg > best.altitudeDeg) best = position;
  }
  return best;
}

function lowestOfDay(year: number, month: number, day: number, lat: number, lng: number): number {
  let lowest = Infinity;
  for (let minute = 0; minute < 1440; minute += 1) {
    const { altitudeDeg } = sunPosition(
      new Date(Date.UTC(year, month - 1, day, 0, minute)),
      lat,
      lng,
    );
    lowest = Math.min(lowest, altitudeDeg);
  }
  return lowest;
}

describe('published reference values', () => {
  test('Meeus, Example 25.a: apparent declination on 1992-10-13 is −7.78507°', () => {
    // At the North Pole the altitude is the declination exactly, so the pole
    // reads the declination back without exporting an intermediate.
    const { altitudeDeg } = sunPosition(new Date('1992-10-13T00:00:00Z'), 90, 0);
    expect(altitudeDeg).toBeCloseTo(-7.78507, 2);
  });

  test("suncalc's test vector: 2013-03-05T00:00Z at 50.5°N 30.5°E", () => {
    // suncalc publishes azimuth −2.5003175907168385 rad (from south, towards
    // west) and altitude −0.7000406838781611 rad. suncalc's own series is
    // shorter, so the two agree to a few tenths of a degree, not better.
    const { azimuthDeg, altitudeDeg } = sunPosition(new Date('2013-03-05T00:00:00Z'), 50.5, 30.5);
    const suncalcAzimuth = (-2.5003175907168385 * 180) / Math.PI + 180;
    const suncalcAltitude = (-0.7000406838781611 * 180) / Math.PI;
    expect(Math.abs(bearingDelta(azimuthDeg, suncalcAzimuth))).toBeLessThan(0.3);
    expect(Math.abs(altitudeDeg - suncalcAltitude)).toBeLessThan(0.3);
  });
});

describe('solstice noon', () => {
  test.each([
    // name, month, lat, lng, expected altitude, expected azimuth
    ['Barcelona, June', 6, 41.3874, 2.1686, 90 - (41.3874 - SOLSTICE_DEC), 180],
    ['Barcelona, December', 12, 41.3874, 2.1686, 90 - (41.3874 + SOLSTICE_DEC), 180],
    ['the equator, June', 6, 0, 0, 90 - SOLSTICE_DEC, 0],
    // Southern hemisphere: the noon sun is in the NORTH all year.
    ['Sydney, June (winter)', 6, -33.8688, 151.2093, 90 - (33.8688 + SOLSTICE_DEC), 0],
    ['Sydney, December (summer)', 12, -33.8688, 151.2093, 90 - (33.8688 - SOLSTICE_DEC), 0],
    ['Buenos Aires, June', 6, -34.6037, -58.3816, 90 - (34.6037 + SOLSTICE_DEC), 0],
  ] as const)('%s', (_name, month, lat, lng, altitude, azimuth) => {
    const noon = solarNoon(2024, month, month === 6 ? 20 : 21, lat, lng);
    // A one-minute scan can miss the true peak by under 0.001°; the remaining
    // slack is the solstice instant not falling exactly at local noon.
    expect(Math.abs(noon.altitudeDeg - altitude)).toBeLessThan(0.05);
    expect(Math.abs(bearingDelta(noon.azimuthDeg, azimuth))).toBeLessThan(1);
  });

  test('the Tropic of Cancer at the June solstice: the sun is overhead', () => {
    expect(solarNoon(2024, 6, 20, SOLSTICE_DEC, 0).altitudeDeg).toBeGreaterThan(89.9);
  });
});

describe('the polar day and the polar night', () => {
  // Tromsø, 69.65°N: inside the Arctic Circle by 3.09°, which is exactly how
  // far the sun stays below (December) or above (June) the horizon at its
  // worst moment of the solstice day.
  const TROMSO = [69.6492, 18.9553] as const;
  const MARGIN = TROMSO[0] + SOLSTICE_DEC - 90;

  test('polar night: the sun never rises, peaking about 3.1° below the horizon', () => {
    const noon = solarNoon(2024, 12, 21, ...TROMSO);
    expect(noon.altitudeDeg).toBeLessThan(0);
    expect(Math.abs(noon.altitudeDeg + MARGIN)).toBeLessThan(0.05);
    // Due south, below the horizon.
    expect(Math.abs(bearingDelta(noon.azimuthDeg, 180))).toBeLessThan(1);
  });

  test('midnight sun: the sun never sets, bottoming out about 3.1° above it, due north', () => {
    const lowest = lowestOfDay(2024, 6, 20, ...TROMSO);
    expect(lowest).toBeGreaterThan(0);
    expect(Math.abs(lowest - MARGIN)).toBeLessThan(0.05);
    // Solar midnight in Tromsø is ~22:44 UTC (12h + 12h − 18.96° × 4 min).
    const midnight = sunPosition(new Date('2024-06-20T22:44:00Z'), ...TROMSO);
    expect(Math.abs(bearingDelta(midnight.azimuthDeg, 0))).toBeLessThan(1);
  });

  test('at the poles the altitude is the declination, all day', () => {
    for (const hour of [0, 6, 12, 18]) {
      const north = sunPosition(new Date(Date.UTC(2024, 5, 20, hour)), 90, 0);
      const south = sunPosition(new Date(Date.UTC(2024, 11, 21, hour)), -90, 0);
      expect(Math.abs(north.altitudeDeg - SOLSTICE_DEC)).toBeLessThan(0.05);
      expect(Math.abs(south.altitudeDeg - SOLSTICE_DEC)).toBeLessThan(0.05);
    }
  });
});

describe('the azimuth convention', () => {
  test('equinox at the equator: up due east, down due west, below at midnight', () => {
    // 2024-03-20, 0°N 0°E: the equation of time is about −7.5 min, so the
    // sun crosses the horizon near 06:07 and 18:07 UTC.
    const rise = sunPosition(new Date('2024-03-20T06:07:00Z'), 0, 0);
    const set = sunPosition(new Date('2024-03-20T18:07:00Z'), 0, 0);
    expect(Math.abs(bearingDelta(rise.azimuthDeg, 90))).toBeLessThan(0.5);
    expect(Math.abs(rise.altitudeDeg)).toBeLessThan(0.5);
    expect(Math.abs(bearingDelta(set.azimuthDeg, 270))).toBeLessThan(0.5);
    expect(Math.abs(set.altitudeDeg)).toBeLessThan(0.5);
    expect(sunPosition(new Date('2024-03-20T00:07:00Z'), 0, 0).altitudeDeg).toBeLessThan(-89);
  });

  test('a northern afternoon sun is in the south-west, a morning one in the south-east', () => {
    // Barcelona, CEST: 17:00 local is 15:00 UTC, 10:00 local is 08:00 UTC.
    const afternoon = sunPosition(new Date('2024-06-20T15:00:00Z'), 41.3874, 2.1686);
    const morning = sunPosition(new Date('2024-06-20T08:00:00Z'), 41.3874, 2.1686);
    expect(afternoon.azimuthDeg).toBeGreaterThan(180);
    expect(afternoon.azimuthDeg).toBeLessThan(290);
    expect(morning.azimuthDeg).toBeGreaterThan(70);
    expect(morning.azimuthDeg).toBeLessThan(180);
  });

  test('always in [0, 360)', () => {
    for (let hour = 0; hour < 24; hour += 1) {
      for (const [lat, lng] of [
        [41.3874, 2.1686],
        [-33.8688, 151.2093],
        [69.6492, 18.9553],
        [-90, 0],
      ]) {
        const { azimuthDeg } = sunPosition(new Date(Date.UTC(2024, 0, 1, hour)), lat, lng);
        expect(azimuthDeg).toBeGreaterThanOrEqual(0);
        expect(azimuthDeg).toBeLessThan(360);
      }
    }
  });

  test('an unwrapped longitude gives the same sun as its wrapped twin', () => {
    // MapLibre reports 181° for a point just past the antimeridian.
    const date = new Date('2024-06-20T03:00:00Z');
    const unwrapped = sunPosition(date, -17.7134, 181);
    const wrapped = sunPosition(date, -17.7134, -179);
    expect(unwrapped.azimuthDeg).toBeCloseTo(wrapped.azimuthDeg, 9);
    expect(unwrapped.altitudeDeg).toBeCloseTo(wrapped.altitudeDeg, 9);
  });
});

test('non-finite in, non-finite out — never a throw', () => {
  const position = sunPosition(new Date(Number.NaN), 41, 2);
  expect(Number.isFinite(position.azimuthDeg)).toBe(false);
  expect(Number.isFinite(position.altitudeDeg)).toBe(false);
});

describe('subsolarPoint', () => {
  test('the sun stands at the zenith there, at any instant', () => {
    for (const iso of [
      '2026-03-20T14:46:00Z',
      '2026-06-21T06:30:00Z',
      '2026-09-23T00:05:00Z',
      '2026-12-21T20:00:00Z',
      '2031-02-11T11:11:11Z',
    ]) {
      const date = new Date(iso);
      const point = subsolarPoint(date);
      expect(point.lng).toBeGreaterThanOrEqual(-180);
      expect(point.lng).toBeLessThan(180);
      expect(sunPosition(date, point.lat, point.lng).altitudeDeg).toBeGreaterThan(89.99);
    }
  });

  test('it stands over the tropics at the solstices, and moves west 15° an hour', () => {
    expect(subsolarPoint(new Date('2026-06-21T12:00:00Z')).lat).toBeCloseTo(23.44, 1);
    expect(subsolarPoint(new Date('2026-12-21T12:00:00Z')).lat).toBeCloseTo(-23.44, 1);
    const a = subsolarPoint(new Date('2026-06-21T12:00:00Z')).lng;
    const b = subsolarPoint(new Date('2026-06-21T13:00:00Z')).lng;
    expect(a - b).toBeCloseTo(15, 1);
  });
});

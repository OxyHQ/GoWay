/**
 * Where the sun is in the sky, for an instant and a point on the earth.
 *
 * It exists for one consumer — the light the extruded buildings are shaded by
 * (`style/buildings3d.ts` → `sunLitBuildingsLight`) — and it is deliberately a
 * pure function with no dependency: no clock read, no location read, no
 * package. The caller passes the instant and the point, which is what makes it
 * testable against published reference values and what keeps the PRIVACY rule
 * true by construction: the point is whatever the caller hands in (for the
 * map, the centre of the viewport the user is looking at, never their
 * position), and nothing here can remember it.
 *
 * ## The algorithm, and why this one
 *
 * NOAA's solar calculator — the equations behind its published spreadsheet,
 * which are Jean Meeus's *Astronomical Algorithms* (ch. 25, the "low accuracy"
 * solar coordinates) plus the equation of time. Stated accuracy is about
 * 0.01° in declination for dates within a few centuries of 2000, which is
 * three orders of magnitude finer than anything a light on a map can show: the
 * light this feeds is rounded to whole degrees before it reaches an engine.
 *
 * It was preferred over the shorter formulation `suncalc` uses for two reasons
 * that cost nothing: it carries the nutation and aberration corrections, so
 * the declination agrees with Meeus's own worked example to two decimals (the
 * test pins that), and every intermediate quantity has a name in a reference a
 * reader can open. `suncalc`'s published position is ALSO pinned by the tests,
 * to a looser tolerance — two independent implementations agreeing is the
 * evidence that neither is mistyped.
 *
 * ## What is deliberately left out
 *
 *  - **Atmospheric refraction.** NOAA adds up to ~0.6° near the horizon to give
 *    the *apparent* elevation. This returns the GEOMETRIC one. A light on a map
 *    has no horizon for the sun to appear over, and the one place refraction
 *    matters — the exact minute of sunrise — is a place this consumer shades
 *    through gradually anyway.
 *  - **Parallax, ΔT, elevation above sea level.** Each is well under the
 *    rounding above.
 */

/** The sun's place in the local sky. */
export interface SunPosition {
  /**
   * Compass bearing of the sun, in degrees CLOCKWISE FROM TRUE NORTH, in
   * `[0, 360)`. 90 is due east, 180 due south. The same convention as a
   * MapLibre `map`-anchored light's azimuthal angle, which is the point.
   */
  azimuthDeg: number;
  /**
   * Geometric elevation above the horizon, in degrees, in `[-90, 90]`.
   * Negative is below the horizon — night, or the polar night's whole day.
   */
  altitudeDeg: number;
}

const DEG = Math.PI / 180;
const MS_PER_DAY = 86_400_000;
/** Julian Date of the Unix epoch, 1970-01-01T00:00:00Z. */
const JD_UNIX_EPOCH = 2_440_587.5;
/** Julian Date of J2000.0, the epoch the series below are expanded around. */
const JD_J2000 = 2_451_545;
const DAYS_PER_JULIAN_CENTURY = 36_525;

/** Where the sun is against the earth at an instant: what every point's sky follows from. */
interface SolarEphemeris {
  /** Declination, radians. */
  declination: number;
  /** Equation of time, minutes: how far the sundial runs ahead of the clock. */
  equationOfTimeMin: number;
}

function solarEphemeris(date: Date): SolarEphemeris {
  const julianDay = date.getTime() / MS_PER_DAY + JD_UNIX_EPOCH;
  // Julian centuries since J2000. UT is used for TT; the ~70 s between them
  // moves the sun by about 0.0008°.
  const t = (julianDay - JD_J2000) / DAYS_PER_JULIAN_CENTURY;

  // Geometric mean longitude and mean anomaly of the sun (Meeus 25.2, 25.3).
  const meanLongitude = mod(280.46646 + t * (36000.76983 + t * 0.0003032), 360);
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  // Equation of centre, then the true and APPARENT longitude: the apparent one
  // corrects for nutation and aberration through the longitude of the Moon's
  // ascending node, Ω (Meeus 25.4–25.8).
  const m = meanAnomaly * DEG;
  const centre =
    Math.sin(m) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * m) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * m) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const omega = (125.04 - 1934.136 * t) * DEG;
  const apparentLongitude = (trueLongitude - 0.00569 - 0.00478 * Math.sin(omega)) * DEG;

  // Obliquity of the ecliptic, mean (Meeus 22.2) and corrected for nutation.
  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = (meanObliquity + 0.00256 * Math.cos(omega)) * DEG;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(apparentLongitude));

  // Equation of time, in minutes (Meeus 28.3): how far the sundial runs ahead
  // of the clock.
  const y = Math.tan(obliquity / 2) ** 2;
  const l0 = meanLongitude * DEG;
  const equationOfTimeMin =
    (4 / DEG) *
    (y * Math.sin(2 * l0) -
      2 * eccentricity * Math.sin(m) +
      4 * eccentricity * y * Math.sin(m) * Math.cos(2 * l0) -
      0.5 * y * y * Math.sin(4 * l0) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * m));

  return { declination, equationOfTimeMin };
}

/**
 * The sun's azimuth and altitude at `date`, seen from (`latitudeDeg`,
 * `longitudeDeg`).
 *
 * Longitude is degrees east and may be UNWRAPPED (MapLibre reports 181° for a
 * point just past the antimeridian): only its sine and cosine survive into the
 * hour angle, so 181 and −179 give the same answer.
 *
 * Total over numbers: a non-finite input gives a non-finite output rather than
 * a throw. Deciding what to do about that is the caller's business, and the
 * one caller falls back to the static style light.
 */
export function sunPosition(date: Date, latitudeDeg: number, longitudeDeg: number): SunPosition {
  const { declination, equationOfTimeMin } = solarEphemeris(date);

  // True solar time at the point, in minutes since solar midnight, and from
  // it the hour angle: 0 at local solar noon, positive in the afternoon.
  const utcMinutes = mod(date.getTime() / 60_000, 1440);
  const trueSolarMinutes = mod(utcMinutes + equationOfTimeMin + 4 * longitudeDeg, 1440);
  const hourAngle = (trueSolarMinutes / 4 - 180) * DEG;

  const phi = latitudeDeg * DEG;
  const sinAltitude =
    Math.sin(phi) * Math.sin(declination) +
    Math.cos(phi) * Math.cos(declination) * Math.cos(hourAngle);
  // Clamped because rounding can put the product a hair outside [-1, 1] when
  // the sun is exactly overhead or underfoot, and `asin` of that is NaN.
  const altitude = Math.asin(Math.min(1, Math.max(-1, sinAltitude)));

  // `atan2` rather than NOAA's `acos` with a branch on the hour angle's sign:
  // the `acos` form divides by `cos(latitude) * sin(zenith)`, which is zero at
  // a pole and with the sun overhead. This form is measured from SOUTH towards
  // west; +180° turns it into a compass bearing.
  const fromSouth = Math.atan2(
    Math.sin(hourAngle),
    Math.cos(hourAngle) * Math.sin(phi) - Math.tan(declination) * Math.cos(phi),
  );

  return {
    azimuthDeg: mod(fromSouth / DEG + 180, 360),
    altitudeDeg: altitude / DEG,
  };
}

/**
 * The SUBSOLAR POINT at `date`: where on the earth the sun stands at the
 * zenith (latitude = the declination; longitude where it is solar noon). The
 * globe's day and night are drawn from it (`style/globeNight.ts`): a point's
 * sun altitude is 90° minus its angle from here.
 */
export function subsolarPoint(date: Date): { lat: number; lng: number } {
  const { declination, equationOfTimeMin } = solarEphemeris(date);
  const utcMinutes = mod(date.getTime() / 60_000, 1440);
  // Solar noon: utc + EoT + 4·lng ≡ 720 minutes.
  const lng = mod((720 - utcMinutes - equationOfTimeMin) / 4 + 180, 360) - 180;
  return { lat: declination / DEG, lng };
}

/** Floored modulo: always in `[0, n)`, which `%` is not for a negative input. */
function mod(value: number, n: number): number {
  return ((value % n) + n) % n;
}

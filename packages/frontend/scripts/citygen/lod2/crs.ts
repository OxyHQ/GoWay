/**
 * The handful of projected coordinate systems official 3D building datasets
 * are published in, inverted to longitude/latitude — enough for the compiler,
 * with no PROJ dependency.
 *
 * Supported (`crsFromName` reads any of the usual spellings: `EPSG:2263`,
 * `urn:ogc:def:crs:EPSG::25831`, a compound `…crs,crs:EPSG::25831,crs:EPSG::5783`,
 * `http://www.opengis.net/def/crs/EPSG/0/25831`):
 *
 *  - **EPSG:2263** NAD83 / New York Long Island (US survey ft) — the NYC 3D
 *    Building Model. Lambert Conformal Conic, two standard parallels.
 *  - **EPSG:258xx** ETRS89 / UTM zones 28–38 (Barcelona's municipal and ICGC
 *    data, most of Europe), **EPSG:326xx / 327xx** WGS 84 / UTM north/south.
 *  - **EPSG:4326 / 4979** longitude/latitude, in the GML axis order the EPSG
 *    code declares (latitude first).
 *
 * Datums are taken as WGS 84 (a null transformation). NAD83 and ETRS89 differ
 * from WGS 84 by ~1–2 m and < 1 m respectively, which is below what a z15 tile
 * resolves for a footprint; more to the point, the OpenStreetMap footprints the
 * LOD2 data is conflated with were imported from the same official sources
 * with the same null transformation (NYC's building footprints are themselves
 * EPSG:2263), so applying a datum shift here would MISALIGN the two, not align
 * them. Accuracy against PROJ (`cs2cs`) is pinned in `__tests__/lod2Crs.test.ts`.
 */

export interface Crs {
  /** `EPSG:<code>`, for the receipt. */
  name: string;
  /** Source easting/northing (or the first two ordinates) → `[lon, lat]` in degrees. */
  toLonLat(x: number, y: number): [number, number];
  /** Metres per unit of the vertical ordinate. */
  verticalMetres: number;
}

const GRS80 = { a: 6378137, f: 1 / 298.257222101 };
const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
const US_FOOT = 1200 / 3937;
const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/** Transverse Mercator inverse (Snyder 1987, eqs. 8-12 … 8-25): mm-level inside a UTM zone. */
export function transverseMercator(options: {
  ellipsoid: { a: number; f: number };
  lon0: number;
  k0: number;
  falseEasting: number;
  falseNorthing: number;
}): (x: number, y: number) => [number, number] {
  const { a, f } = options.ellipsoid;
  const e2 = f * (2 - f);
  const ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const lon0 = options.lon0 * RAD;
  const mu0 = a * (1 - e2 / 4 - (3 * e2 * e2) / 64 - (5 * e2 * e2 * e2) / 256);
  return (x, y) => {
    const m = (y - options.falseNorthing) / options.k0;
    const mu = m / mu0;
    const phi1 =
      mu +
      ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) +
      ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) +
      ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) +
      ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
    const sin1 = Math.sin(phi1);
    const cos1 = Math.cos(phi1);
    const tan1 = Math.tan(phi1);
    const c1 = ep2 * cos1 * cos1;
    const t1 = tan1 * tan1;
    const n1 = a / Math.sqrt(1 - e2 * sin1 * sin1);
    const r1 = (a * (1 - e2)) / (1 - e2 * sin1 * sin1) ** 1.5;
    const d = (x - options.falseEasting) / (n1 * options.k0);
    const phi =
      phi1 -
      ((n1 * tan1) / r1) *
        ((d * d) / 2 -
          ((5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4) / 24 +
          ((61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6) / 720);
    const lambda =
      lon0 +
      (d -
        ((1 + 2 * t1 + c1) * d ** 3) / 6 +
        ((5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5) / 120) /
        cos1;
    return [lambda * DEG, phi * DEG];
  };
}

/** Lambert Conformal Conic (2SP) inverse (Snyder 1987, eqs. 15-1 … 15-11, 7-9). */
export function lambertConformalConic(options: {
  ellipsoid: { a: number; f: number };
  lat1: number;
  lat2: number;
  lat0: number;
  lon0: number;
  /** In metres. */
  falseEasting: number;
  falseNorthing: number;
  /** Metres per input unit. */
  unit: number;
}): (x: number, y: number) => [number, number] {
  const { a, f } = options.ellipsoid;
  const e2 = f * (2 - f);
  const e = Math.sqrt(e2);
  const m = (phi: number) => Math.cos(phi) / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const t = (phi: number) =>
    Math.tan(Math.PI / 4 - phi / 2) /
    ((1 - e * Math.sin(phi)) / (1 + e * Math.sin(phi))) ** (e / 2);
  const p1 = options.lat1 * RAD;
  const p2 = options.lat2 * RAD;
  const p0 = options.lat0 * RAD;
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const bigF = m(p1) / (n * t(p1) ** n);
  const rho0 = a * bigF * t(p0) ** n;
  const lon0 = options.lon0 * RAD;
  return (xIn, yIn) => {
    const x = xIn * options.unit - options.falseEasting;
    const y = rho0 - (yIn * options.unit - options.falseNorthing);
    const rho = Math.sign(n) * Math.hypot(x, y);
    const theta = Math.atan2(Math.sign(n) * x, Math.sign(n) * y);
    const tt = (rho / (a * bigF)) ** (1 / n);
    let phi = Math.PI / 2 - 2 * Math.atan(tt);
    for (let i = 0; i < 12; i++) {
      const s = e * Math.sin(phi);
      const next = Math.PI / 2 - 2 * Math.atan(tt * ((1 - s) / (1 + s)) ** (e / 2));
      if (Math.abs(next - phi) < 1e-13) {
        phi = next;
        break;
      }
      phi = next;
    }
    return [(theta / n + lon0) * DEG, phi * DEG];
  };
}

/** The EPSG code in an `srsName`, or `null` when there is none. Compound names give the horizontal one. */
export function epsgCode(srsName: string): number | null {
  const match =
    /EPSG(?::|::|\/0\/|\/)(\d{4,5})/i.exec(srsName) ?? /^\s*(\d{4,5})\s*$/.exec(srsName);
  return match ? Number(match[1]) : null;
}

/** The {@link Crs} for an EPSG code, or `null` when it is not one this module implements. */
export function crsFromEpsg(code: number): Crs | null {
  if (code === 2263) {
    return {
      name: 'EPSG:2263',
      verticalMetres: US_FOOT,
      toLonLat: lambertConformalConic({
        ellipsoid: GRS80,
        lat1: 41 + 2 / 60,
        lat2: 40 + 40 / 60,
        lat0: 40 + 10 / 60,
        lon0: -74,
        falseEasting: 300000,
        falseNorthing: 0,
        unit: US_FOOT,
      }),
    };
  }
  const utm = (ellipsoid: typeof GRS80, zone: number, south: boolean): Crs['toLonLat'] =>
    transverseMercator({
      ellipsoid,
      lon0: zone * 6 - 183,
      k0: 0.9996,
      falseEasting: 500000,
      falseNorthing: south ? 10000000 : 0,
    });
  if (code >= 25828 && code <= 25838) {
    return { name: `EPSG:${code}`, verticalMetres: 1, toLonLat: utm(GRS80, code - 25800, false) };
  }
  if (code >= 32601 && code <= 32660) {
    return { name: `EPSG:${code}`, verticalMetres: 1, toLonLat: utm(WGS84, code - 32600, false) };
  }
  if (code >= 32701 && code <= 32760) {
    return { name: `EPSG:${code}`, verticalMetres: 1, toLonLat: utm(WGS84, code - 32700, true) };
  }
  if (code === 4326 || code === 4979 || code === 4258 || code === 4937) {
    // EPSG's geographic codes are latitude-first in GML.
    return { name: `EPSG:${code}`, verticalMetres: 1, toLonLat: (lat, lon) => [lon, lat] };
  }
  return null;
}

export function crsFromName(srsName: string): Crs | null {
  const code = epsgCode(srsName);
  return code === null ? null : crsFromEpsg(code);
}

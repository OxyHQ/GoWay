/**
 * Placing a live thing in the city engine's frame — pure arithmetic.
 *
 * A live shape is built in LOCAL METRES, nose towards +y (north), up +z, like
 * a city tile's mesh (`../city3d/tileMath.ts`). {@link anchorMatrix} rotates
 * it to its heading, scales it, lifts it to its REAL altitude and puts it in
 * the same centre-relative mercator frame the buildings are drawn in, in
 * float64, so the GPU sees only small numbers (the precision rule of
 * `tileMath.ts`).
 *
 * Altitude is metres above sea level, converted with MapLibre's own conformal
 * factor (`mercatorPerMetre`), so an aircraft at 1,200 m is drawn exactly
 * where MapLibre's `MercatorCoordinate.fromLngLat(…, 1200)` puts it — pinned
 * in `__tests__/liveAnchor.test.ts`. The basemap's ground is at 0: without
 * terrain, a height above sea level is a height above the map.
 */

import {
  EARTH_CIRCUMFERENCE_M,
  type MercatorPoint,
  mercatorPerMetre,
  mercatorXFromLng,
  mercatorYFromLat,
} from '../city3d/tileMath';

export interface Anchor {
  longitude: number;
  latitude: number;
  /** Metres above sea level; 0 on the ground. */
  altitude: number;
  /** Degrees clockwise from north; 0 when unknown. */
  heading: number;
  /** Metres per local unit: how big the shape is drawn. */
  scale: number;
}

/**
 * Column-major 4×4: local metres (nose +y) → centre-relative mercator.
 *
 * `x' = k·s·(x cos h + y sin h)`, `y' = −k·s·(−x sin h + y cos h)`,
 * `z' = k·s·z + k·altitude` — a clockwise turn by the heading in the
 * east/north plane, then mercator's south-pointing `y` (the mirror) and its
 * conformal `z`.
 */
export function anchorMatrix(anchor: Anchor, center: MercatorPoint): number[] {
  const k = mercatorPerMetre(anchor.latitude);
  const h = (anchor.heading * Math.PI) / 180;
  const c = Math.cos(h);
  const s = Math.sin(h);
  const ks = k * anchor.scale;
  const x = mercatorXFromLng(anchor.longitude) - center.x;
  const y = mercatorYFromLat(anchor.latitude) - center.y;
  // A heading-h turn sends local north (0, 1) to (sin h, cos h) east/north.
  // biome-ignore format: a 4×4 matrix reads as four columns.
  return [
    ks * c, -ks * -s, 0, 0,
    ks * s, -ks * c, 0, 0,
    0, 0, ks, 0,
    x, y, k * anchor.altitude, 1,
  ];
}

/** Metres a CSS pixel covers on the ground at a zoom and latitude (512-px tiles, as MapLibre). */
export function metresPerPixel(zoom: number, latitude: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (512 * 2 ** zoom);
}

/**
 * How large to draw a shape whose real length is `lengthM`: real size, or
 * `minPixels` long on screen when real size would be smaller. Styling, stated
 * as such — the POSITION and the ALTITUDE are never scaled.
 */
export function displayScale(
  lengthM: number,
  zoom: number,
  latitude: number,
  minPixels: number,
): number {
  return Math.max(lengthM, minPixels * metresPerPixel(zoom, latitude)) / lengthM;
}

/**
 * A flat, metric working plane for camera paths.
 *
 * Splines, arc lengths, curvature and look-ahead all want a plane measured in
 * metres. The map itself is Web Mercator, so the plane here IS Mercator —
 * scaled to metres at one origin latitude — rather than an equirectangular
 * approximation: a curve that is smooth in this plane is smooth on the screen,
 * because the screen is Mercator too. Across a city the scale error against
 * true ground metres is the cosine of a few hundredths of a degree (nothing);
 * across a 100 km route it is a few per cent, which only changes how fast the
 * camera seems to travel, never where it goes.
 *
 * Pure arithmetic with no renderer. Deliberately NOT shared with
 * `components/map/engine/city3d/tileMath.ts`: that module lives in the
 * three.js chunk, and a module two lazy chunks import is hoisted into the
 * first-paint `__common` chunk (`components/engine3d/lazyChunk.ts`). The
 * formulas are the same Web Mercator, pinned by `__tests__/cameraPlane.test.ts`.
 */
import type { GeoCoordinate } from '@/components/map/types';

/** MapLibre's Earth: `2π × 6,371,008.8 m` (see `tileMath.ts` → `EARTH_CIRCUMFERENCE_M`). */
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

/** Web Mercator's latitude limit. */
export const MERCATOR_LATITUDE_LIMIT = 85.051129;

/** MapLibre's tile size: world width in px at zoom 0, on web and native alike. */
export const WORLD_TILE_SIZE = 512;

export interface PlanePoint {
  /** Metres east of the origin. */
  x: number;
  /** Metres NORTH of the origin. */
  y: number;
}

export function mercatorX(longitude: number): number {
  return (180 + longitude) / 360;
}

export function mercatorY(latitude: number): number {
  const clamped = Math.max(-MERCATOR_LATITUDE_LIMIT, Math.min(MERCATOR_LATITUDE_LIMIT, latitude));
  const phi = (clamped * Math.PI) / 180;
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + phi / 2))) / 360;
}

export function longitudeFromMercatorX(x: number): number {
  return x * 360 - 180;
}

export function latitudeFromMercatorY(y: number): number {
  const y2 = 180 - y * 360;
  return (360 / Math.PI) * Math.atan(Math.exp((y2 * Math.PI) / 180)) - 90;
}

/** Ground metres per screen pixel at a latitude and zoom (MapLibre's 512 px world). */
export function metresPerPixel(latitude: number, zoom: number): number {
  return (
    (EARTH_CIRCUMFERENCE_M * Math.cos((latitude * Math.PI) / 180)) / (WORLD_TILE_SIZE * 2 ** zoom)
  );
}

/** A metric plane anchored at one coordinate. */
export interface Plane {
  origin: GeoCoordinate;
  /** Metres per mercator unit at the origin latitude. */
  scale: number;
  toPlane(coordinate: GeoCoordinate): PlanePoint;
  toGeo(point: PlanePoint): GeoCoordinate;
}

export function createPlane(origin: GeoCoordinate): Plane {
  const ox = mercatorX(origin.longitude);
  const oy = mercatorY(origin.latitude);
  const scale = EARTH_CIRCUMFERENCE_M * Math.cos((origin.latitude * Math.PI) / 180);
  return {
    origin,
    scale,
    toPlane(coordinate) {
      // Unwrapped against the origin, so a path across the antimeridian stays
      // continuous instead of jumping a world's width.
      let dx = mercatorX(coordinate.longitude) - ox;
      dx -= Math.round(dx);
      return { x: dx * scale, y: -(mercatorY(coordinate.latitude) - oy) * scale };
    },
    toGeo(point) {
      let longitude = longitudeFromMercatorX(ox + point.x / scale);
      if (longitude > 180) longitude -= 360;
      if (longitude < -180) longitude += 360;
      return { latitude: latitudeFromMercatorY(oy - point.y / scale), longitude };
    },
  };
}

/** Bearing of a plane vector, degrees clockwise from north, in `[0, 360)`. */
export function bearingOf(dx: number, dy: number): number {
  const degrees = (Math.atan2(dx, dy) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

/** Fold an angle into `[0, 360)`. */
export function normalizeBearing(degrees: number): number {
  const folded = degrees % 360;
  return folded < 0 ? folded + 360 : folded;
}

/** The signed shortest turn from `from` to `to`, in `(-180, 180]`. */
export function bearingDelta(from: number, to: number): number {
  let delta = normalizeBearing(to - from);
  if (delta > 180) delta -= 360;
  return delta;
}

/** Interpolate along the shortest arc between two bearings. */
export function lerpBearing(from: number, to: number, t: number): number {
  return normalizeBearing(from + bearingDelta(from, to) * t);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Smoothstep: zero velocity at both ends. */
export function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

/**
 * A trapezoidal velocity profile, as a position-over-time curve.
 *
 * Accelerates for the first `ramp` of the time, cruises, decelerates for the
 * last `ramp`. Unlike a smoothstep it has a long constant-speed middle, which
 * is what a flyover wants: the ease is the take-off and the landing, not the
 * whole flight.
 */
export function trapezoidEase(t: number, ramp: number): number {
  const x = clamp(t, 0, 1);
  const a = clamp(ramp, 0, 0.5);
  if (a === 0) return x;
  // Cruise speed v satisfies: area = v·(1 − a) = 1.
  const v = 1 / (1 - a);
  if (x < a) return (v * x * x) / (2 * a);
  if (x > 1 - a) {
    const r = 1 - x;
    return 1 - (v * r * r) / (2 * a);
  }
  return v * (x - a / 2);
}

/**
 * Where a viewport-sized box fits a set of plane points, as a zoom.
 *
 * The same arithmetic as MapLibre's `fitBounds` at bearing 0 and pitch 0:
 * the box's span in world pixels at zoom 0 against the free viewport. Pure,
 * so a flyover can plan its opening and closing frames without asking the
 * engine (and so it is the same answer on web and native).
 */
export function fitZoom(
  points: readonly PlanePoint[],
  plane: Plane,
  viewport: { width: number; height: number },
  padding: number,
): number {
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const spanX = Math.max(1, maxX - minX) / plane.scale;
  const spanY = Math.max(1, maxY - minY) / plane.scale;
  const freeW = Math.max(1, viewport.width - 2 * padding);
  const freeH = Math.max(1, viewport.height - 2 * padding);
  return Math.log2(Math.min(freeW / (spanX * WORLD_TILE_SIZE), freeH / (spanY * WORLD_TILE_SIZE)));
}

/**
 * The geographic point under a screen pixel of a TOP-DOWN camera.
 *
 * Exact for pitch 0 at any bearing — which is why drawing a path in Camera
 * Studio levels the camera first. Screen `x` grows right and `y` down, from
 * the canvas's top-left; `viewport` is the camera at that moment.
 */
export function unprojectTopDown(
  viewport: { latitude: number; longitude: number; zoom: number; bearing: number },
  size: { width: number; height: number },
  point: { x: number; y: number },
): GeoCoordinate {
  const world = WORLD_TILE_SIZE * 2 ** viewport.zoom;
  const dx = point.x - size.width / 2;
  const dy = point.y - size.height / 2;
  const b = (viewport.bearing * Math.PI) / 180;
  // The map is drawn rotated by −bearing, so a screen offset is rotated back
  // by +bearing into the world.
  const wx = dx * Math.cos(b) - dy * Math.sin(b);
  const wy = dx * Math.sin(b) + dy * Math.cos(b);
  const mx = mercatorX(viewport.longitude) + wx / world;
  const my = mercatorY(viewport.latitude) + wy / world;
  let longitude = longitudeFromMercatorX(mx);
  longitude = ((((longitude + 180) % 360) + 360) % 360) - 180;
  return { latitude: latitudeFromMercatorY(my), longitude };
}

/** The inverse of {@link unprojectTopDown}: the pixel a coordinate is drawn at. */
export function projectTopDown(
  viewport: { latitude: number; longitude: number; zoom: number; bearing: number },
  size: { width: number; height: number },
  coordinate: GeoCoordinate,
): { x: number; y: number } {
  const world = WORLD_TILE_SIZE * 2 ** viewport.zoom;
  let mdx = mercatorX(coordinate.longitude) - mercatorX(viewport.longitude);
  mdx -= Math.round(mdx);
  const wx = mdx * world;
  const wy = (mercatorY(coordinate.latitude) - mercatorY(viewport.latitude)) * world;
  const b = (viewport.bearing * Math.PI) / 180;
  const dx = wx * Math.cos(b) + wy * Math.sin(b);
  const dy = -wx * Math.sin(b) + wy * Math.cos(b);
  return { x: dx + size.width / 2, y: dy + size.height / 2 };
}

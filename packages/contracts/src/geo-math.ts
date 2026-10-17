/**
 * Geographic arithmetic: Web Mercator, boxes, distances.
 *
 * The ONE copy for every GoWay package — the SDK's clients, `@goway.to/maps`,
 * GoWay's own app and its map workers. Pure functions over GoWay's own
 * `{ latitude, longitude }` and `{ west, south, east, north }` shapes, with no
 * schema and no `zod`, so `@goway.to/sdk/geo` loads in a worker without the
 * HTTP client.
 */
import type { GeoBoundingBox, GeoCoordinate } from './geo';

/** MapLibre's Earth: `2π × 6,371,008.8 m`, the circumference its zoom scale is defined by. */
export const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

/** Web Mercator's latitude limit, degrees: past it the projection is truncated. */
export const MERCATOR_MAX_LATITUDE = 85.051129;

/** Web Mercator tile size the MapLibre zoom scale is defined against (world px at zoom 0). */
export const WORLD_TILE_SIZE = 512;

const DEG = Math.PI / 180;

/** Longitude (degrees) → mercator x in `[0, 1]`. */
export function mercatorX(longitude: number): number {
  return (180 + longitude) / 360;
}

/** Latitude (degrees) → mercator y in `[0, 1]`, north at 0; clamped to the projection's limit. */
export function mercatorY(latitude: number): number {
  const clamped = Math.max(-MERCATOR_MAX_LATITUDE, Math.min(MERCATOR_MAX_LATITUDE, latitude));
  return (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (clamped * DEG) / 2))) / 360;
}

/** Mercator x in `[0, 1]` → longitude, degrees. */
export function longitudeFromMercatorX(x: number): number {
  return x * 360 - 180;
}

/** Mercator y in `[0, 1]` → latitude, degrees. */
export function latitudeFromMercatorY(y: number): number {
  return (360 / Math.PI) * Math.atan(Math.exp((180 - y * 360) * DEG)) - 90;
}

/** Reject NaN/Infinity and out-of-range values before they reach an engine. */
export function isValidCoordinate(value: unknown): value is GeoCoordinate {
  if (!value || typeof value !== 'object') return false;
  const { latitude, longitude } = value as GeoCoordinate;
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    latitude >= -90 &&
    latitude <= 90 &&
    longitude >= -180 &&
    longitude <= 180
  );
}

/** Metres per screen pixel at a latitude and zoom, in Web Mercator. */
export function metersPerPixel(latitude: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(latitude * DEG)) / (WORLD_TILE_SIZE * 2 ** zoom);
}

/** Screen pixels spanned by a ground distance at a latitude and zoom. */
export function metersToPixels(meters: number, latitude: number, zoom: number): number {
  const scale = metersPerPixel(latitude, zoom);
  return scale > 0 ? meters / scale : 0;
}

/** The smallest box containing every valid coordinate, or `null` when there is none. */
export function boundsOf(coordinates: readonly GeoCoordinate[]): GeoBoundingBox | null {
  const valid = coordinates.filter(isValidCoordinate);
  if (valid.length === 0) return null;

  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;

  for (const { latitude, longitude } of valid) {
    if (longitude < west) west = longitude;
    if (longitude > east) east = longitude;
    if (latitude < south) south = latitude;
    if (latitude > north) north = latitude;
  }

  return { west, south, east, north };
}

/**
 * The east edge of a box as an engine draws it: carried past 180 when the box
 * crosses the antimeridian (`west > east`), so `170 → -170` is the 20° strip it
 * describes and not the 340° of the rest of the world.
 */
export function unwrappedEast(bounds: Pick<GeoBoundingBox, 'west' | 'east'>): number {
  return bounds.east >= bounds.west ? bounds.east : bounds.east + 360;
}

/** Centre of a box, across the antimeridian when it crosses it. */
export function boundsCenter(bounds: GeoBoundingBox): GeoCoordinate {
  const middle = (bounds.west + unwrappedEast(bounds)) / 2;
  return {
    latitude: (bounds.south + bounds.north) / 2,
    longitude: middle > 180 ? middle - 360 : middle,
  };
}

/**
 * A box with no area — a single point, or a list of identical points.
 *
 * Both engines answer a zero-area fit with their maximum zoom, which is
 * certainly wrong: the caller asked to frame an AREA. Callers check this and
 * move to the centre at a sensible zoom instead.
 */
export function isDegenerateBounds(bounds: GeoBoundingBox): boolean {
  return unwrappedEast(bounds) - bounds.west <= 0 && bounds.north - bounds.south <= 0;
}

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: GeoCoordinate, b: GeoCoordinate): number {
  const radius = EARTH_CIRCUMFERENCE_M / (2 * Math.PI);
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const lat1 = a.latitude * DEG;
  const lat2 = b.latitude * DEG;

  const h = Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Web Mercator world-pixel coordinates at a zoom level.
 *
 * The origin is the top-left of the world at the given zoom; the world is
 * `WORLD_TILE_SIZE * 2^zoom` pixels square. Latitudes beyond ±85.05° are
 * clamped, because Mercator sends the poles to infinity.
 */
export function projectToPixels(coordinate: GeoCoordinate, zoom: number): { x: number; y: number } {
  const worldSize = WORLD_TILE_SIZE * 2 ** zoom;
  return {
    x: worldSize * mercatorX(coordinate.longitude),
    y: worldSize * mercatorY(coordinate.latitude),
  };
}

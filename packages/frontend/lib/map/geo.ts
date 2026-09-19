/**
 * Geographic helpers shared by both renderer forks and by feature code.
 *
 * Provider-neutral on purpose: everything here takes and returns GoWay's own
 * `{ latitude, longitude }` shapes, so a screen can reason about geometry
 * without importing a map engine.
 */
import type { GeoBounds, GeoCoordinate } from '@/components/map/types';

/** Equatorial circumference of the WGS84 ellipsoid, in metres. */
const EARTH_CIRCUMFERENCE_M = 40_075_016.686;

/** Web Mercator tile size the MapLibre zoom scale is defined against. */
const TILE_SIZE_PX = 512;

const DEG = Math.PI / 180;

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

/**
 * Metres per screen pixel at a latitude and zoom, in Web Mercator.
 *
 * Needed because Bloom's `MapAreaCircle` takes a radius in PIXELS — it is a UI
 * component floating over the map, not a geographic layer, so it cannot know
 * the projection. Converting a real radius ("places within 500 m") into the
 * pixels that circle should span is map work, so it lives here rather than
 * being re-derived at each call site.
 */
export function metersPerPixel(latitude: number, zoom: number): number {
  return (EARTH_CIRCUMFERENCE_M * Math.cos(latitude * DEG)) / (TILE_SIZE_PX * Math.pow(2, zoom));
}

/** Screen pixels spanned by a ground distance at a latitude and zoom. */
export function metersToPixels(meters: number, latitude: number, zoom: number): number {
  const scale = metersPerPixel(latitude, zoom);
  return scale > 0 ? meters / scale : 0;
}

/** The smallest box containing every coordinate, or `null` for an empty list. */
export function boundsOf(coordinates: readonly GeoCoordinate[]): GeoBounds | null {
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

/** Centre of a box. */
export function boundsCenter(bounds: GeoBounds): GeoCoordinate {
  return {
    latitude: (bounds.south + bounds.north) / 2,
    longitude: (bounds.west + bounds.east) / 2,
  };
}

/**
 * A box with no area — a single point, or a list of identical points.
 *
 * Both engines answer a zero-area `fitBounds` with their maximum zoom, which
 * is certainly wrong: the caller asked to frame an AREA. Callers check this and
 * fall back to a `moveTo` at a sensible zoom.
 */
export function isDegenerateBounds(bounds: GeoBounds): boolean {
  return bounds.east - bounds.west <= 0 && bounds.north - bounds.south <= 0;
}

/**
 * Great-circle distance in metres (haversine).
 *
 * Accurate enough for "how far is this place" and for deciding whether the
 * viewport moved far enough to offer "Search this area"; not a routing engine.
 */
export function distanceMeters(a: GeoCoordinate, b: GeoCoordinate): number {
  const radius = EARTH_CIRCUMFERENCE_M / (2 * Math.PI);
  const dLat = (b.latitude - a.latitude) * DEG;
  const dLon = (b.longitude - a.longitude) * DEG;
  const lat1 = a.latitude * DEG;
  const lat2 = b.latitude * DEG;

  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLon / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * radius * Math.asin(Math.min(1, Math.sqrt(h)));
}

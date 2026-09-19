/**
 * Provider-neutral geographic primitives.
 *
 * Two coordinate spellings coexist here on purpose, and mixing them up is the
 * single most expensive bug in geographic code — a transposed pair yields a
 * *plausible* point in the wrong hemisphere rather than an error:
 *
 * - {@link GeoCoordinate} is the ergonomic product contract: named fields, so
 *   a caller cannot transpose them by accident. Everything user-facing, every
 *   SDK argument and every API query parameter uses this.
 * - {@link GeoPosition} is GeoJSON's positional form, `[longitude, latitude]`,
 *   **longitude first**. It exists only where a real GeoJSON document is being
 *   produced or consumed (geometry, route lines, overlays), because that is
 *   what RFC 7946, MapLibre and PostGIS all speak.
 *
 * Convert at the boundary with {@link toGeoPosition} / {@link toGeoCoordinate}
 * rather than writing an array literal by hand.
 */

/** A point on Earth, in degrees, WGS 84 (EPSG:4326). */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
}

/**
 * GeoJSON position: `[longitude, latitude]`, optionally with elevation.
 * Longitude comes first. See RFC 7946 §3.1.1.
 */
export type GeoPosition = [longitude: number, latitude: number] | [longitude: number, latitude: number, elevation: number];

/** Converts the named form to GeoJSON's longitude-first positional form. */
export function toGeoPosition(coordinate: GeoCoordinate): GeoPosition {
  return [coordinate.longitude, coordinate.latitude];
}

/** Converts GeoJSON's longitude-first positional form to the named form. */
export function toGeoCoordinate(position: GeoPosition): GeoCoordinate {
  return { longitude: position[0], latitude: position[1] };
}

/**
 * An axis-aligned bounding box in degrees.
 *
 * A box that crosses the antimeridian has `west > east`; consumers that compare
 * numerically without handling that case will silently select the complement of
 * the intended area.
 */
export interface GeoBoundingBox {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** GeoJSON Point. */
export interface GeoJsonPoint {
  type: 'Point';
  coordinates: GeoPosition;
}

/** GeoJSON LineString — the shape route geometry takes on the wire. */
export interface GeoJsonLineString {
  type: 'LineString';
  coordinates: GeoPosition[];
}

/** GeoJSON Polygon. The first ring is the exterior; the rest are holes. */
export interface GeoJsonPolygon {
  type: 'Polygon';
  coordinates: GeoPosition[][];
}

/** GeoJSON MultiPolygon. */
export interface GeoJsonMultiPolygon {
  type: 'MultiPolygon';
  coordinates: GeoPosition[][][];
}

/** Any geometry GoWay currently publishes. */
export type GeoGeometry = GeoJsonPoint | GeoJsonLineString | GeoJsonPolygon | GeoJsonMultiPolygon;

/**
 * Map camera state, provider-neutral.
 *
 * This is the renderer seam: GoWay feature code and `@goway.to/sdk` speak this,
 * never MapLibre's own camera types, so the renderer stays replaceable.
 */
export interface MapViewport {
  latitude: number;
  longitude: number;
  /** Web-mercator zoom level. */
  zoom: number;
  /** Camera rotation in degrees clockwise from north. */
  bearing?: number;
  /** Camera tilt in degrees from straight down. */
  pitch?: number;
}

/** A distance in metres. Named so an API cannot quietly accept miles. */
export type Meters = number;

/** A duration in seconds. */
export type Seconds = number;

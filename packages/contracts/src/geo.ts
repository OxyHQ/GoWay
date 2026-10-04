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

import { z } from 'zod';

/** A latitude in degrees, WGS 84. */
export const latitudeSchema = z.number().min(-90).max(90);

/** A longitude in degrees, WGS 84. */
export const longitudeSchema = z.number().min(-180).max(180);

/** A point on Earth, in degrees, WGS 84 (EPSG:4326). */
export const geoCoordinateSchema = z.object({
  latitude: latitudeSchema,
  longitude: longitudeSchema,
});
export type GeoCoordinate = z.infer<typeof geoCoordinateSchema>;

/**
 * GeoJSON position: `[longitude, latitude]`, optionally with elevation.
 * Longitude comes first. See RFC 7946 §3.1.1.
 */
export const geoPositionSchema = z.union([
  z.tuple([longitudeSchema, latitudeSchema]),
  z.tuple([longitudeSchema, latitudeSchema, z.number()]),
]);
export type GeoPosition = z.infer<typeof geoPositionSchema>;

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
export const geoBoundingBoxSchema = z.object({
  west: longitudeSchema,
  south: latitudeSchema,
  east: longitudeSchema,
  north: latitudeSchema,
});
export type GeoBoundingBox = z.infer<typeof geoBoundingBoxSchema>;

/**
 * The east-west span of a box in degrees.
 *
 * A WRAP, not an inversion: `170 → -170` spans 20°, not 340°. Measuring it the
 * naive way would refuse every Pacific viewport while admitting the enormous
 * boxes a span cap exists for.
 */
export function boundingBoxWidth(box: Pick<GeoBoundingBox, 'west' | 'east'>): number {
  return box.east >= box.west ? box.east - box.west : 360 - box.west + box.east;
}

/** A closed linear ring: at least four positions. */
const linearRingSchema = z.array(geoPositionSchema).min(4, 'a linear ring needs at least four positions');

/** GeoJSON Point. */
export const geoJsonPointSchema = z.object({ type: z.literal('Point'), coordinates: geoPositionSchema });
export type GeoJsonPoint = z.infer<typeof geoJsonPointSchema>;

/** GeoJSON LineString — the shape route geometry takes on the wire. */
export const geoJsonLineStringSchema = z.object({
  type: z.literal('LineString'),
  coordinates: z.array(geoPositionSchema).min(2),
});
export type GeoJsonLineString = z.infer<typeof geoJsonLineStringSchema>;

/** GeoJSON Polygon. The first ring is the exterior; the rest are holes. */
export const geoJsonPolygonSchema = z.object({
  type: z.literal('Polygon'),
  coordinates: z.array(linearRingSchema).min(1),
});
export type GeoJsonPolygon = z.infer<typeof geoJsonPolygonSchema>;

/** GeoJSON MultiPolygon. */
export const geoJsonMultiPolygonSchema = z.object({
  type: z.literal('MultiPolygon'),
  coordinates: z.array(z.array(linearRingSchema).min(1)).min(1),
});
export type GeoJsonMultiPolygon = z.infer<typeof geoJsonMultiPolygonSchema>;

/** Any geometry GoWay currently publishes. */
export const geoGeometrySchema = z.discriminatedUnion('type', [
  geoJsonPointSchema,
  geoJsonLineStringSchema,
  geoJsonPolygonSchema,
  geoJsonMultiPolygonSchema,
]);
export type GeoGeometry = z.infer<typeof geoGeometrySchema>;

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

/**
 * `@goway.to/sdk/geo` — geographic arithmetic.
 *
 * Web Mercator, boxes (across the antimeridian), distances and screen
 * projection, over GoWay's own `{ latitude, longitude }` and
 * `{ west, south, east, north }` shapes. Pure functions with no transport and
 * no schema, so a map worker loads them without the HTTP client.
 *
 *     import { boundsOf, isDegenerateBounds } from '@goway.to/sdk/geo';
 *
 *     const box = boundsOf(places.map((place) => place.location));
 *     if (box && !isDegenerateBounds(box)) map.fitBounds(box);
 */

export {
  EARTH_CIRCUMFERENCE_M,
  MERCATOR_MAX_LATITUDE,
  WORLD_TILE_SIZE,
  boundsCenter,
  boundsOf,
  distanceMeters,
  isDegenerateBounds,
  isValidCoordinate,
  latitudeFromMercatorY,
  longitudeFromMercatorX,
  mercatorX,
  mercatorY,
  metersPerPixel,
  metersToPixels,
  projectToPixels,
  unwrappedEast,
} from './contract';

export type { GeoBoundingBox, GeoCoordinate } from './contract';

# @goway.to/sdk/geo

Geographic arithmetic over GoWay's `{ latitude, longitude }` coordinates and `{ west, south, east, north }` boxes: Web Mercator, boxes across the antimeridian, distances and screen projection. Pure functions with no transport and no schema, so a map worker can load them without the HTTP client.

Import from it like this: `import { boundsOf, distanceMeters, isDegenerateBounds } from '@goway.to/sdk/geo';`

For a walkthrough, see the [geo guide](../guides/geo.md).

## Functions

### Boxes

| Function | Signature | Description |
| --- | --- | --- |
| `boundsOf` | `boundsOf(coordinates: readonly GeoCoordinate[]): GeoBoundingBox \| null` | The smallest box containing every valid coordinate, or `null` when there is none. |
| `boundsCenter` | `boundsCenter(bounds: GeoBoundingBox): GeoCoordinate` | The centre of a box, across the antimeridian when it crosses it. |
| `isDegenerateBounds` | `isDegenerateBounds(bounds: GeoBoundingBox): boolean` | Whether a box has no area (one point, or identical points). Frame its centre at a chosen zoom instead of fitting it. |
| `unwrappedEast` | `unwrappedEast(bounds: Pick<GeoBoundingBox, 'west' \| 'east'>): number` | The east edge as an engine draws it: carried past 180 when `west > east`, so `170` to `-170` is a 20-degree strip. |

### Coordinates and distance

| Function | Signature | Description |
| --- | --- | --- |
| `isValidCoordinate` | `isValidCoordinate(value: unknown): value is GeoCoordinate` | Rejects `NaN`, `Infinity` and out-of-range values. |
| `distanceMeters` | `distanceMeters(a: GeoCoordinate, b: GeoCoordinate): number` | Great-circle (haversine) distance in metres. |

### Web Mercator

| Function | Signature | Description |
| --- | --- | --- |
| `mercatorX` | `mercatorX(longitude: number): number` | Longitude to Mercator x in `[0, 1]`. |
| `mercatorY` | `mercatorY(latitude: number): number` | Latitude to Mercator y in `[0, 1]`, north at 0, clamped to `MERCATOR_MAX_LATITUDE`. |
| `longitudeFromMercatorX` | `longitudeFromMercatorX(x: number): number` | Mercator x to longitude. |
| `latitudeFromMercatorY` | `latitudeFromMercatorY(y: number): number` | Mercator y to latitude. |
| `projectToPixels` | `projectToPixels(coordinate: GeoCoordinate, zoom: number): { x: number; y: number }` | World-pixel coordinates at a zoom. The world is `WORLD_TILE_SIZE * 2^zoom` pixels square, origin top-left. |
| `metersPerPixel` | `metersPerPixel(latitude: number, zoom: number): number` | Metres per screen pixel at a latitude and zoom. |
| `metersToPixels` | `metersToPixels(meters: number, latitude: number, zoom: number): number` | Screen pixels spanned by a ground distance. |

## Constants

| Name | Value | Description |
| --- | --- | --- |
| `EARTH_CIRCUMFERENCE_M` | `2 * Math.PI * 6371008.8` | The circumference MapLibre's zoom scale is defined by. |
| `MERCATOR_MAX_LATITUDE` | `85.051129` | Web Mercator's latitude limit, in degrees. |
| `WORLD_TILE_SIZE` | `512` | World size in pixels at zoom 0. |

## Types

| Type | Description |
| --- | --- |
| `GeoCoordinate` | `{ latitude: number; longitude: number }`. |
| `GeoBoundingBox` | `{ west: number; south: number; east: number; north: number }`. `west > east` crosses the antimeridian. |

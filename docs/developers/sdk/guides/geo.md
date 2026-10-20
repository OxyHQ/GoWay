# Geographic arithmetic

The `@goway.to/sdk/geo` entry point has the small pieces of geometry a map app needs over GoWay's own shapes: boxes that fit a set of points, box centres across the antimeridian, great-circle distance, and Web Mercator projection to pixels. It is pure, has no transport and no schema, and loads without the HTTP client.

GoWay's shapes are named, not positional: a coordinate is `{ latitude, longitude }` (`GeoCoordinate`) and a box is `{ west, south, east, north }` (`GeoBoundingBox`). A box with `west > east` crosses the antimeridian.

## Frame a set of places

```ts
import { boundsCenter, boundsOf, isDegenerateBounds } from '@goway.to/sdk/geo';

const box = boundsOf(places.map((place) => place.location));
if (box === null) {
  // no valid coordinates
} else if (isDegenerateBounds(box)) {
  centerOn(boundsCenter(box), 16); // one point: fitting it would zoom to the maximum
} else {
  fitBounds(box);
}
```

`boundsOf` skips invalid coordinates and returns `null` when none is left. A box with no area (one place, or several at the same point) should be shown by moving to its centre at a chosen zoom.

## Distance

```ts
import { distanceMeters } from '@goway.to/sdk/geo';

distanceMeters({ latitude: 41.3874, longitude: 2.1686 }, { latitude: 41.4036, longitude: 2.1744 }); // about 1865
```

Haversine, in metres. `isValidCoordinate(value)` checks a value before you use it: it rejects `NaN`, `Infinity` and out-of-range numbers.

## Web Mercator

| Function | What it does |
| --- | --- |
| `mercatorX(longitude)`, `mercatorY(latitude)` | Project to `[0, 1]`; y is 0 at the north edge and clamped at `MERCATOR_MAX_LATITUDE`. |
| `longitudeFromMercatorX(x)`, `latitudeFromMercatorY(y)` | The inverse. |
| `projectToPixels(coordinate, zoom)` | World pixels at a zoom; the world is `WORLD_TILE_SIZE * 2^zoom` pixels square. |
| `metersPerPixel(latitude, zoom)` | Ground resolution. |
| `metersToPixels(meters, latitude, zoom)` | How many pixels a distance spans, for example to draw an accuracy circle. |

These use MapLibre's definitions (`EARTH_CIRCUMFERENCE_M`, `WORLD_TILE_SIZE` of 512), so the numbers match what a MapLibre-based map draws.

## Across the antimeridian

A box from `170` to `-170` is the 20-degree strip over the Pacific, not the other 340 degrees. `unwrappedEast(box)` gives the east edge carried past 180 (here `190`), which is what a renderer's `fitBounds` expects. `boundingBoxWidth` (from the root entry) measures the span the same way.

## Converting to and from GeoJSON

GeoJSON positions are `[longitude, latitude]`. The root entry has the converters:

```ts
import { toGeoCoordinate, toGeoPosition } from '@goway.to/sdk';

toGeoCoordinate([2.1686, 41.3874]); // { latitude: 41.3874, longitude: 2.1686 }
toGeoPosition({ latitude: 41.3874, longitude: 2.1686 }); // [2.1686, 41.3874]
```

## See also

- [API reference: `@goway.to/sdk/geo`](../api-reference/geo.md)

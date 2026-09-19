/**
 * Every spatial predicate the Places read path uses, in one module.
 *
 * ## Each of these is answered by PostGIS, never by arithmetic
 *
 * `places.geo` is the `GENERATED ALWAYS AS (ST_SetSRID(ST_MakePoint(longitude,
 * latitude), 4326)::geography) STORED` column with the `places_geo_gist` index,
 * so `ST_DWithin` and `ST_Intersects` are index-backed and measure on the
 * spheroid. The two obvious alternatives are both wrong and both look right:
 *
 *  - **`ST_Distance(geo, p) < r` in a WHERE clause cannot use the index.** It
 *    degrades to a sequential scan over every place on Earth, and it does so
 *    silently — the results are correct, so only the latency says anything.
 *    `ST_Distance` is correct in a SELECT list or an ORDER BY, which is the only
 *    place {@link distanceTo} puts it.
 *  - **A lat/lon bounding box computed in TypeScript** (± radius / 111_320
 *    degrees) is a square pretending to be a circle, and its longitude term is
 *    wrong everywhere except the equator. A wrong "nearby" is worse than a slow
 *    one, because nothing reports it.
 *
 * ## `ST_MakeEnvelope` takes LONGITUDE first
 *
 * `ST_MakeEnvelope(xmin, ymin, xmax, ymax, 4326)` is `(west, south, east,
 * north)`. That is deliberately NOT the field order of the contract's
 * `GeoBoundingBox`, and transposing it produces a valid envelope somewhere else
 * on the planet rather than an error — which is why the argument order is
 * asserted against a real measured distance in `places-geo.realdb.test.ts`
 * instead of being trusted to this comment.
 *
 * ## The envelope's edges are GREAT CIRCLES once cast to `geography`
 *
 * `west > east` means the box crosses the antimeridian — `170 → -170` is the
 * 20° Pacific strip, not the 340° remainder — and `::geography` already reads
 * it that way. Drop the cast and every such query silently returns the exact
 * COMPLEMENT of what was asked for. This is also why the HTTP layer validates
 * `south <= north` and deliberately NOT `west <= east`: the asymmetry is the
 * contract, and "tidying" it would turn every antimeridian viewport into a 422.
 *
 * The other side of geodesic edges: a box tens of degrees wide in a narrow
 * latitude band bulges poleward and can exclude its own centre, and one exactly
 * 180° wide raises `Antipodal (180 degrees long) edge detected!`. Every
 * realistic map viewport is unaffected; `MAX_BOUNDS_SPAN_DEGREES` in the route
 * layer keeps a caller from reaching the pathological end.
 */

import { sql, type SQL } from 'drizzle-orm';
import { places } from '../schema';

/**
 * A `geography` point at `(longitude, latitude)`.
 *
 * Named parameters rather than a positional pair, because the single mistake
 * this whole column design exists to prevent is a transposition — and a
 * transposed pair is not an error, it is a perfectly valid point in the wrong
 * hemisphere. `ST_MakePoint` itself is `(x, y)`, i.e. `(lng, lat)`, the
 * opposite of every `lat, lng` the HTTP layer receives.
 */
export function geoPoint(longitude: number, latitude: number): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${longitude}, ${latitude}), 4326)::geography`;
}

/**
 * Places within `radiusMeters` of a centre — the index-backed radius filter.
 *
 * `ST_DWithin` on `geography` measures true spheroid distance in METRES, so the
 * radius needs no conversion and no earth-radius constant.
 */
export function withinRadius(longitude: number, latitude: number, radiusMeters: number): SQL {
  return sql`ST_DWithin(${places.geo}, ${geoPoint(longitude, latitude)}, ${radiusMeters})`;
}

/**
 * Places inside a viewport rectangle.
 *
 * `ST_Intersects` on `geography` is index-accelerated: it applies the GiST
 * bounding-box operator before the exact test.
 */
export function withinBoundingBox(box: {
  west: number;
  south: number;
  east: number;
  north: number;
}): SQL {
  return sql`ST_Intersects(${places.geo}, ST_MakeEnvelope(${box.west}, ${box.south}, ${box.east}, ${box.north}, 4326)::geography)`;
}

/**
 * Distance in metres from a place to a point, for a SELECT list or an ORDER BY.
 *
 * NEVER a WHERE predicate — see the module doc. Pair it with
 * {@link withinRadius}: the predicate uses the index to choose the rows, this
 * orders the few that survived and gives the client the number it renders.
 */
export function distanceTo(longitude: number, latitude: number): SQL<number> {
  return sql<number>`ST_Distance(${places.geo}, ${geoPoint(longitude, latitude)})`;
}

/**
 * `Route.legs[].maneuvers[]` → a flat list of steps a panel can render and a
 * map can highlight.
 *
 * The backend already populates maneuvers and, with them, `geometryIndex` —
 * "index into the parent Route's `geometry.coordinates` at which this maneuver
 * starts". That field is the whole reason this file is short: highlighting the
 * segment a step describes is a SLICE of the line the map is already drawing,
 * not a re-match of coordinates against the geometry. Re-matching is both
 * slower and wrong wherever a route passes the same point twice (a loop, an
 * out-and-back, a roundabout taken twice), which is exactly where a user is
 * most likely to be tapping a step to work out what it means.
 *
 * `geometryIndex` is OPTIONAL in the contract, so a router that omits it still
 * has to work. The fallback is the maneuver's own `coordinate`, which every
 * maneuver carries: the highlight degrades to a point rather than disappearing,
 * and {@link RouteStep.exact} says which of the two happened so the UI never
 * implies precision it does not have.
 *
 * Deliberately free of UI: no React, no Bloom, no map engine. The glyph for a
 * maneuver type lives with the list that draws it, which keeps this module
 * loadable — and therefore exercisable — outside the app.
 */
import type { GeoCoordinate, Route, RouteManeuver } from '@goway.to/sdk';

import { isValidCoordinate } from '@/lib/map/geo';

export interface RouteStep {
  /** Position in the flattened list — the selection key. */
  index: number;
  /** Which leg it belongs to, so the list can head each leg with its stop. */
  legIndex: number;
  /** `true` for the first step of a leg, which is where a heading goes. */
  firstOfLeg: boolean;
  maneuver: RouteManeuver;
  /**
   * The slice of `route.geometry.coordinates` this step covers, as
   * `[start, end]` INCLUSIVE of both ends.
   */
  range: readonly [number, number];
  /**
   * `false` when the router gave no `geometryIndex` and the range was inferred
   * from the maneuver's coordinate. The highlight is then a point, not a
   * segment, and the UI must not claim otherwise.
   */
  exact: boolean;
}

/**
 * Flatten a route's legs into steps with absolute geometry ranges.
 *
 * `geometryIndex` is documented against the PARENT ROUTE's geometry, so indices
 * are already absolute across legs and are used as they arrive. They are still
 * clamped and forced non-decreasing: a router that numbers per-leg, or emits a
 * stray index, would otherwise produce a `slice()` that is empty or reversed,
 * and an empty highlight looks exactly like a broken one.
 */
export function routeSteps(route: Route): RouteStep[] {
  const lineLength = route.geometry.coordinates.length;
  const last = Math.max(0, lineLength - 1);

  const flat: Array<{ legIndex: number; firstOfLeg: boolean; maneuver: RouteManeuver }> = [];
  route.legs.forEach((leg, legIndex) => {
    leg.maneuvers.forEach((maneuver, maneuverIndex) => {
      flat.push({ legIndex, firstOfLeg: maneuverIndex === 0, maneuver });
    });
  });

  // Pass one: a start index per step, monotonic by construction.
  let cursor = 0;
  const starts = flat.map(({ maneuver }) => {
    const declared = maneuver.geometryIndex;
    const start =
      typeof declared === 'number' && Number.isInteger(declared)
        ? Math.min(Math.max(declared, cursor), last)
        : nearestIndex(route.geometry.coordinates, maneuver.coordinate, cursor);
    cursor = start;
    return { start, exact: typeof declared === 'number' && Number.isInteger(declared) };
  });

  // Pass two: each step runs until the next one begins; the final step runs to
  // the end of the line. A step whose successor starts where it does collapses
  // to a single point, which is correct for an instantaneous maneuver.
  return flat.map((entry, index) => {
    const { start, exact } = starts[index];
    const end = index + 1 < starts.length ? Math.max(start, starts[index + 1].start) : last;
    return {
      index,
      legIndex: entry.legIndex,
      firstOfLeg: entry.firstOfLeg,
      maneuver: entry.maneuver,
      range: [start, end] as const,
      exact,
    };
  });
}

/**
 * The coordinates a step covers, ready for an overlay or a camera fit.
 *
 * Only points that are really on the earth come back, and the list may be
 * EMPTY. Both matter downstream: these coordinates become GeoJSON for an
 * overlay, and a `NaN` vertex there does not fail loudly — geojson-vt projects
 * it to a `NaN` tile coordinate, the feature belongs to no tile, and the
 * highlight the user asked for is simply absent with nothing in the console.
 * A caller that dereferences `[0]` without checking gets a `TypeError` instead.
 * Nothing here can produce such a point today (`@goway.to/sdk` validates every
 * position it decodes), so this is the guarantee, not a repair.
 */
export function stepCoordinates(route: Route, step: RouteStep): GeoCoordinate[] {
  const [start, end] = step.range;
  const slice = route.geometry.coordinates.slice(start, end + 1);
  const points = slice
    .map(([longitude, latitude]) => ({ latitude, longitude }))
    .filter(isValidCoordinate);
  // A one-point slice is still worth framing; the caller decides whether to
  // draw a line through it or simply centre on it.
  if (points.length > 0) return points;
  return isValidCoordinate(step.maneuver.coordinate) ? [step.maneuver.coordinate] : [];
}

/**
 * Nearest vertex to a maneuver, searched forward from where the previous step
 * ended.
 *
 * Forward-only on purpose: it keeps the result monotonic, and on a route that
 * revisits a point it picks the pass the user is actually on rather than the
 * first one in the array.
 */
function nearestIndex(
  coordinates: readonly (readonly number[])[],
  coordinate: GeoCoordinate,
  from: number,
): number {
  let best = Math.min(from, Math.max(0, coordinates.length - 1));
  let bestDistance = Infinity;
  for (let index = best; index < coordinates.length; index += 1) {
    const [longitude, latitude] = coordinates[index];
    // Squared degrees: this only has to ORDER candidates, and a haversine per
    // vertex per maneuver is real work for an answer that never changes.
    const distance =
      (latitude - coordinate.latitude) ** 2 + (longitude - coordinate.longitude) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

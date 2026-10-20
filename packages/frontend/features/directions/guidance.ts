/**
 * Where a traveller is on a route, and what to do next.
 *
 * Pure, so the claims guided navigation makes are tests (`__tests__/guidance.test.ts`):
 * the next maneuver is the first one AHEAD of the traveller's position along the
 * line, the distance to it is measured along the line (not as the crow flies —
 * a hairpin is not "10 m away"), and the traveller is off route only when they
 * are further from the line than the device's own uncertainty explains.
 *
 * The line is the route's `geometry`; the maneuvers are `routeSteps()` with
 * their absolute geometry ranges (`maneuvers.ts`), so no coordinate is
 * re-matched here.
 */
import type { GeoCoordinate, Route } from '@goway.to/sdk';

import type { RouteStep } from './maneuvers';

const EARTH_RADIUS_M = 6_371_008.8;

/** Never call a traveller off route for being closer to the line than this. */
export const OFF_ROUTE_MIN_METRES = 40;
/** A device unsure by ±accuracy can be that far from the line and still be on it. */
const ACCURACY_FACTOR = 1.5;
/** Within this of the last maneuver the traveller has arrived. */
export const ARRIVAL_METRES = 30;
/** A maneuver is announced "then …" only when the next one follows this soon. */
export const THEN_WITHIN_METRES = 300;

export interface GuidanceFix extends GeoCoordinate {
  /** ± metres, or `null` when the device reported none. */
  accuracy: number | null;
}

export interface Guidance {
  /** The maneuver to make next. */
  next: RouteStep;
  /** Metres along the route to it. */
  distanceToNext: number;
  /** The one after it, when it follows soon enough to be worth saying. */
  then: RouteStep | null;
  /** Metres from the line. */
  offsetMetres: number;
  offRoute: boolean;
  /** Within {@link ARRIVAL_METRES} of the end. */
  arrived: boolean;
}

interface Projection {
  /** The segment (vertex `index` to `index + 1`) the fix is nearest. */
  segment: number;
  /** Metres along the whole line to the foot of the perpendicular. */
  along: number;
  /** Metres from the line. */
  offset: number;
}

/** Metres from the route's start to each vertex. Computed once per line. */
const cumulativeCache = new WeakMap<object, number[]>();

function metresBetween(a: readonly number[], b: readonly number[]): number {
  const [lng1, lat1] = a;
  const [lng2, lat2] = b;
  const phi1 = (lat1 * Math.PI) / 180;
  const phi2 = (lat2 * Math.PI) / 180;
  const dPhi = phi2 - phi1;
  const dLambda = ((lng2 - lng1) * Math.PI) / 180;
  const h = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function cumulativeMetres(coordinates: readonly (readonly number[])[]): number[] {
  const cached = cumulativeCache.get(coordinates);
  if (cached) return cached;
  const total = [0];
  for (let index = 1; index < coordinates.length; index += 1) {
    total.push(total[index - 1] + metresBetween(coordinates[index - 1], coordinates[index]));
  }
  cumulativeCache.set(coordinates, total);
  return total;
}

/** The fix projected onto the nearest segment of the line. */
export function projectOnto(
  coordinates: readonly (readonly number[])[],
  fix: GeoCoordinate,
): Projection | null {
  if (coordinates.length < 2) return null;
  const cumulative = cumulativeMetres(coordinates);
  // A local flat plane around the fix: exact enough over a segment's length.
  const cosLat = Math.cos((fix.latitude * Math.PI) / 180);
  const toPlane = (longitude: number, latitude: number): [number, number] => [
    ((longitude - fix.longitude) * Math.PI * EARTH_RADIUS_M * cosLat) / 180,
    ((latitude - fix.latitude) * Math.PI * EARTH_RADIUS_M) / 180,
  ];

  let best: Projection | null = null;
  for (let segment = 0; segment < coordinates.length - 1; segment += 1) {
    const [ax, ay] = toPlane(coordinates[segment][0], coordinates[segment][1]);
    const [bx, by] = toPlane(coordinates[segment + 1][0], coordinates[segment + 1][1]);
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    // The fix is the origin: t is where the origin's foot falls on a→b.
    const t =
      lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, -(ax * dx + ay * dy) / lengthSquared));
    const offset = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || offset < best.offset) {
      const segmentMetres = cumulative[segment + 1] - cumulative[segment];
      best = { segment, along: cumulative[segment] + t * segmentMetres, offset };
    }
  }
  return best;
}

/** Where the traveller is and what comes next, or `null` for a route with no line or steps. */
export function guidanceAt(
  route: Pick<Route, 'geometry'>,
  steps: readonly RouteStep[],
  fix: GuidanceFix,
): Guidance | null {
  const coordinates = route.geometry.coordinates;
  const last = steps[steps.length - 1];
  if (!last) return null;
  const projection = projectOnto(coordinates, fix);
  if (!projection) return null;
  const cumulative = cumulativeMetres(coordinates);

  // The first maneuver that begins ahead of the foot of the perpendicular; past
  // the last one, the last (the arrival) is what remains.
  const next = steps.find((step) => cumulative[step.range[0]] > projection.along) ?? last;
  const distanceToNext = Math.max(0, cumulative[next.range[0]] - projection.along);
  const following = steps[next.index + 1] ?? null;
  const then =
    following && cumulative[following.range[0]] - cumulative[next.range[0]] <= THEN_WITHIN_METRES
      ? following
      : null;

  const tolerance = Math.max(OFF_ROUTE_MIN_METRES, (fix.accuracy ?? 0) * ACCURACY_FACTOR);
  const end = cumulative[cumulative.length - 1];
  return {
    next,
    distanceToNext,
    then,
    offsetMetres: projection.offset,
    offRoute: projection.offset > tolerance,
    arrived: next === last && end - projection.along <= ARRIVAL_METRES,
  };
}

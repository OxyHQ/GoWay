/**
 * The landmark tour's camera, as pure arithmetic (`docs/MAP_LANDMARKS.md` →
 * Tour): which landmarks a tour visits and in what order, where the camera is
 * while it orbits one, and how it travels to the next. The screen
 * (`features/landmarks/LandmarkTour.tsx`) only turns time into these
 * viewports and hands them to the map seam (`MapApi.moveTo`).
 */
import type { MapViewport } from '@/components/map/types';

import { distanceMeters } from '../geo';

/** What the tour needs to know of a landmark (a registry entry's subset). */
export interface TourStop {
  id: string;
  position: { latitude: number; longitude: number };
  /** The heading its main facade faces: the orbit starts looking at it. */
  heading: number;
  tour: {
    zoom: number;
    pitch: number;
    orbitSeconds: number;
    lookAtMeters: number;
    startAngle?: number;
  };
}

/** A tour only visits landmarks within this distance of where it starts (one city). */
export const TOUR_RADIUS_M = 40_000;
/**
 * The tour's lens: narrower than the map's (36.87°), so the city reads as a
 * maquette with little perspective and the camera stands far enough back
 * that a 400 m tower is in frame at a zoom where the city is fully drawn.
 */
export const TOUR_FIELD_OF_VIEW = 22;
/** The map's own lens, restored when the tour closes. */
export const DEFAULT_FIELD_OF_VIEW = 36.87;
/** MapLibre's default `maxPitch`, which the canvas keeps. */
export const MAX_TOUR_PITCH = 60;
// The sphere `distanceMeters` measures on (`lib/map/geo.ts`), so the two agree.
const EARTH_RADIUS_M = 40_075_016.686 / (2 * Math.PI);
const DEG = Math.PI / 180;

/**
 * The tour's order: from `startId`, always on to the NEAREST landmark not yet
 * visited (a greedy path, so ▶ never jumps across town and back), limited to
 * {@link TOUR_RADIUS_M} of the start. ◀ walks the same list backwards.
 */
export function tourOrder<T extends TourStop>(stops: readonly T[], startId: string): T[] {
  const start = stops.find((s) => s.id === startId);
  if (!start) return [];
  const pool = stops.filter(
    (s) => s.id !== startId && distanceMeters(start.position, s.position) <= TOUR_RADIUS_M,
  );
  const out: T[] = [start];
  let at = start;
  while (pool.length > 0) {
    let best = 0;
    for (let i = 1; i < pool.length; i++) {
      if (
        distanceMeters(at.position, pool[i].position) <
        distanceMeters(at.position, pool[best].position)
      ) {
        best = i;
      }
    }
    at = pool.splice(best, 1)[0];
    out.push(at);
  }
  return out;
}

/** A point `metres` from `from` along `bearingDeg` (spherical, exact enough for a camera). */
export function offsetBy(
  from: { latitude: number; longitude: number },
  bearingDeg: number,
  metres: number,
): { latitude: number; longitude: number } {
  const d = metres / EARTH_RADIUS_M;
  const b = bearingDeg * DEG;
  const lat1 = from.latitude * DEG;
  const lon1 = from.longitude * DEG;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { latitude: lat2 / DEG, longitude: ((((lon2 / DEG + 540) % 360) + 360) % 360) - 180 };
}

const wrap360 = (deg: number) => ((deg % 360) + 360) % 360;

/**
 * The camera orbiting `stop`, `angleDeg` round from its starting bearing.
 *
 * The map's camera looks at a GROUND point; a landmark is looked at by its
 * middle, `lookAtMeters` up. The ray through the screen's centre crosses that
 * height `h · tan(pitch)` before it reaches the ground, so the ground centre is
 * pushed that far on, away from the camera, and the landmark's middle sits in
 * the middle of the screen.
 *
 * The orbit starts looking at the main facade — the camera stands on the
 * facade's side, i.e. it looks along `heading + 180°` — turned by the
 * entry's `startAngle` where a neighbour hides that side.
 */
export function orbitViewport(stop: TourStop, angleDeg: number): MapViewport {
  const pitch = Math.min(MAX_TOUR_PITCH, Math.max(0, stop.tour.pitch));
  const bearing = wrap360(stop.heading + 180 + (stop.tour.startAngle ?? 0) + angleDeg);
  const push = stop.tour.lookAtMeters * Math.tan(pitch * DEG);
  const centre = offsetBy(stop.position, bearing, push);
  return { ...centre, zoom: stop.tour.zoom, pitch, bearing };
}

/** Degrees of orbit after `elapsedMs` of playing. */
export function orbitAngle(stop: TourStop, elapsedMs: number): number {
  return (elapsedMs / 1000 / stop.tour.orbitSeconds) * 360;
}

/** The shorter signed turn from `a` to `b`, degrees in (−180, 180]. */
export function shortestTurn(a: number, b: number): number {
  const d = wrap360(b - a);
  return d > 180 ? d - 360 : d;
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** How long a hop between two viewports takes: longer for farther, within bounds. */
export function transitionMs(from: MapViewport, to: MapViewport): number {
  const metres = distanceMeters(from, to);
  return Math.round(Math.min(5_000, Math.max(1_600, 1_400 + metres * 0.9)));
}

/**
 * The camera `t` (0 … 1, eased) of the way from `from` to `to`: position and
 * bearing on the shorter turn, and — for a hop longer than a few hundred
 * metres — a lift in the middle (zoom out, pitch eased off) so the city
 * passes under the camera instead of smearing past it.
 */
export function transitionViewport(from: MapViewport, to: MapViewport, t: number): MapViewport {
  const k = ease(Math.max(0, Math.min(1, t)));
  const metres = distanceMeters(from, to);
  const lift = Math.min(2.2, Math.max(0, Math.log2(Math.max(1, metres / 250))));
  const arc = Math.sin(Math.PI * k);
  const zoom = from.zoom + (to.zoom - from.zoom) * k - lift * arc;
  const fromPitch = from.pitch ?? 0;
  const toPitch = to.pitch ?? 0;
  const pitch = fromPitch + (toPitch - fromPitch) * k - Math.min(20, lift * 9) * arc;
  const fromBearing = from.bearing ?? 0;
  const bearing = wrap360(fromBearing + shortestTurn(fromBearing, to.bearing ?? 0) * k);
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * k,
    longitude: from.longitude + (to.longitude - from.longitude) * k,
    zoom,
    pitch: Math.max(0, pitch),
    bearing,
  };
}

/** The next index in a tour of `length`, wrapping both ways. */
export function stepIndex(index: number, length: number, direction: 1 | -1): number {
  if (length <= 0) return 0;
  return (((index + direction) % length) + length) % length;
}

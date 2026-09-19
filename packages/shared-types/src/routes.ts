/**
 * Provider-neutral directions and routing contracts.
 *
 * Valhalla is the initial engine, but its request and response shapes stop at
 * the backend adapter. Exposing raw Valhalla JSON as the stable contract would
 * make the engine unreplaceable, which is the whole thing this layer prevents.
 */

import type { GeoCoordinate, GeoJsonLineString, Meters, Seconds } from './geo';
import type { PlaceId } from './place';

/** Travel modes supported in v1. The contract leaves room for transit later. */
export const TRAVEL_MODES = ['drive', 'walk', 'bike'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/**
 * One end of a route leg.
 *
 * A caller may pass a bare coordinate or a GoWay place. When `placeId` is set
 * the backend resolves the routable point itself — a building centroid is not
 * necessarily reachable, and the entrance a router should aim at is GoWay's
 * knowledge, not the caller's.
 */
export interface RouteLocation {
  coordinate?: GeoCoordinate;
  placeId?: PlaceId;
  /** Optional label to echo back in the rendered directions. */
  name?: string;
}

/** A directions request. */
export interface RouteRequest {
  origin: RouteLocation;
  destination: RouteLocation;
  /** Intermediate stops, in order. */
  waypoints?: RouteLocation[];
  mode: TravelMode;
  /** Ask the engine for alternative routes where it supports them. */
  alternatives?: boolean;
  /** BCP-47 tag for maneuver instruction text. */
  locale?: string;
}

/** The kind of action a maneuver describes. Open-ended by design. */
export const MANEUVER_TYPES = [
  'depart',
  'continue',
  'turn-left',
  'turn-right',
  'turn-slight-left',
  'turn-slight-right',
  'turn-sharp-left',
  'turn-sharp-right',
  'uturn',
  'merge',
  'fork',
  'roundabout-enter',
  'roundabout-exit',
  'ferry',
  'arrive',
] as const;
export type ManeuverType = (typeof MANEUVER_TYPES)[number] | (string & {});

/** One instruction in a route leg. */
export interface RouteManeuver {
  type: ManeuverType;
  /** Rendered instruction text in the requested locale. */
  instruction: string;
  /** Road or path name this maneuver follows, when known. */
  streetName?: string;
  distanceMeters: Meters;
  durationSeconds: Seconds;
  /** Where the maneuver begins. */
  coordinate: GeoCoordinate;
  /**
   * Index into the parent {@link Route}'s `geometry.coordinates` at which this
   * maneuver starts, so a renderer can highlight a segment without re-matching
   * coordinates.
   */
  geometryIndex?: number;
}

/** A segment of a route between two consecutive stops. */
export interface RouteLeg {
  distanceMeters: Meters;
  durationSeconds: Seconds;
  maneuvers: RouteManeuver[];
}

/** A computed route. */
export interface Route {
  id: string;
  mode: TravelMode;
  distanceMeters: Meters;
  durationSeconds: Seconds;
  /** The full route line, in GeoJSON longitude-first order. */
  geometry: GeoJsonLineString;
  legs: RouteLeg[];
}

/**
 * A directions response.
 *
 * `routes` is ordered best-first and may be empty: "no route exists between
 * these points" is a normal answer for this domain, not a failure, and a
 * consumer must render it as such rather than as an error.
 */
export interface RouteResponse {
  routes: Route[];
}

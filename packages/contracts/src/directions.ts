/**
 * Provider-neutral directions and routing contracts.
 *
 * Valhalla is the initial engine, but its request and response shapes stop at
 * the backend adapter. Exposing raw Valhalla JSON as the stable contract would
 * make the engine unreplaceable, which is the whole thing this layer prevents.
 *
 * ## `details` names the FIELD and never the value
 *
 * Every value in a directions body is a precise location, and GoWay's privacy
 * rule is that those are transient request data that are never persisted —
 * including in somebody else's log index.
 */

import { z } from 'zod';
import { geoCoordinateSchema, geoJsonLineStringSchema } from './geo';
import { languageTagSchema } from './language';
import { placeIdSchema } from './place';

/** Travel modes supported in v1. The contract leaves room for transit later. */
export const TRAVEL_MODES = ['drive', 'walk', 'bike'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/**
 * The most intermediate stops one request may carry.
 *
 * A stock Valhalla refuses more than 20 locations for `auto` and fewer for the
 * pedestrian and bicycle models, and the refusal arrives as an engine error a
 * caller cannot interpret. Eight stops plus an origin and a destination is
 * comfortably inside every profile's limit.
 */
export const MAX_WAYPOINTS = 8;

/**
 * One end of a route leg.
 *
 * At least one of `coordinate` and `placeId`. When BOTH arrive, the place wins
 * and an unknown place id is still `not_found` — the caller's coordinate does
 * not rescue it. Which point a router should aim at is GoWay's knowledge (a
 * building centroid is not necessarily reachable), and silently falling back
 * would route to a point the caller guessed while reporting success.
 */
export const routeLocationSchema = z
  .object({
    coordinate: geoCoordinateSchema.optional(),
    placeId: placeIdSchema.optional(),
    /** Optional label to echo back in the rendered directions. */
    name: z.string().max(200).optional(),
  })
  .refine((value) => value.coordinate !== undefined || value.placeId !== undefined, {
    message: 'must carry a coordinate or a placeId',
  });
export type RouteLocation = z.input<typeof routeLocationSchema>;

/**
 * The body of `POST /routes`.
 *
 * `mode` is a bounded STRING here, not an enum of {@link TRAVEL_MODES}: an enum
 * would answer `validation_failed` for `transit`, which tells an integrator
 * their request was malformed. The vocabulary has a code that says the true
 * thing — `unsupported_mode` — and a client can hide a travel-mode button on
 * the strength of it.
 *
 * Unknown fields are DROPPED rather than refused, so a newer SDK sending a
 * field this backend has not learned yet still gets a route.
 */
export const routeRequestSchema = z.object({
  origin: routeLocationSchema,
  destination: routeLocationSchema,
  /** Intermediate stops, in order. */
  waypoints: z.array(routeLocationSchema).max(MAX_WAYPOINTS).optional(),
  mode: z.string().trim().min(1).max(32),
  /** Ask the engine for alternative routes where it supports them. */
  alternatives: z.boolean().optional(),
  /** BCP 47 tag for maneuver instruction text. */
  locale: languageTagSchema.optional(),
});

/** A directions request, with `mode` typed as the modes GoWay knows. */
export type RouteRequest = Omit<z.input<typeof routeRequestSchema>, 'mode'> & { mode: TravelMode };

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
export const routeManeuverSchema = z.object({
  /** One of {@link MANEUVER_TYPES}, or a newer one this client does not know. */
  type: z.string().min(1),
  /** Rendered instruction text in the requested locale. */
  instruction: z.string(),
  /** Road or path name this maneuver follows, when known. */
  streetName: z.string().optional(),
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
  /** Where the maneuver begins. */
  coordinate: geoCoordinateSchema,
  /**
   * Index into the parent route's `geometry.coordinates` at which this maneuver
   * starts, so a renderer can highlight a segment without re-matching
   * coordinates.
   */
  geometryIndex: z.number().int().min(0).optional(),
});
export type RouteManeuver = z.infer<typeof routeManeuverSchema>;

/** A segment of a route between two consecutive stops. */
export const routeLegSchema = z.object({
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
  maneuvers: z.array(routeManeuverSchema),
});
export type RouteLeg = z.infer<typeof routeLegSchema>;

/** A computed route. */
export const routeSchema = z.object({
  id: z.string().min(1),
  mode: z.enum(TRAVEL_MODES),
  distanceMeters: z.number().min(0),
  durationSeconds: z.number().min(0),
  /** The full route line, in GeoJSON longitude-first order. */
  geometry: geoJsonLineStringSchema,
  legs: z.array(routeLegSchema),
});
export type Route = z.infer<typeof routeSchema>;

/**
 * A directions response.
 *
 * `routes` is ordered best-first and may be empty: "no route exists between
 * these points" is a normal answer for this domain, not a failure, and a
 * consumer must render it as such rather than as an error. It is a fixed set of
 * alternatives, not a list that pages.
 */
export const routeResponseSchema = z.object({
  routes: z.array(routeSchema),
});
export type RouteResponse = z.infer<typeof routeResponseSchema>;

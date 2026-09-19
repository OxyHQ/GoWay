/**
 * The routing seam.
 *
 * Everything above this interface — the HTTP route, `@goway.to/sdk`, the app —
 * speaks `@goway/shared-types`' `Route`, `RouteLeg` and `RouteManeuver` and
 * nothing else. Everything below it is one engine's opinion about request
 * shapes, units, maneuver taxonomies and error codes, and stops here.
 *
 * `AGENTS.md`: "MapLibre, OpenFreeMap, Photon, Nominatim, Valhalla, COLMAP and
 * gsplat are replaceable adapters behind GoWay interfaces. Feature code imports
 * the GoWay abstraction, never the provider." This file is that abstraction for
 * routing; `valhalla.ts` is the first adapter behind it.
 *
 * ## What the interface deliberately does NOT take
 *
 * A provider is handed RESOLVED points, never a `RouteLocation`. Turning a
 * GoWay place id into the point a router should aim at is GoWay's own
 * knowledge — a building centroid is not necessarily reachable — and it needs
 * the Places repository, which an engine adapter has no business holding. The
 * HTTP layer resolves first and the provider routes between coordinates.
 *
 * ## What it leaves room for
 *
 * {@link RoutingRequest} is an object rather than a positional argument list so
 * transit and multimodal modes, avoid-tolls/highways/ferries, arrival and
 * departure times and accessibility preferences can be added as optional fields
 * without changing a single existing implementation. None of them are built
 * today; the shape simply does not stand in their way.
 */

import type { GeoCoordinate, Route, TravelMode } from '@goway/shared-types';

/** A point a route passes through, already resolved to a coordinate. */
export interface RoutePoint {
  coordinate: GeoCoordinate;
  /** The caller's label for this stop, echoed nowhere else. */
  name?: string;
}

/** What a provider is asked to compute. */
export interface RoutingRequest {
  /**
   * Origin, then any intermediate stops in order, then destination. At least
   * two. Each is a hard stop, so consecutive pairs are exactly the legs of the
   * resulting {@link Route}.
   */
  locations: readonly RoutePoint[];
  mode: TravelMode;
  /** Ask the engine for alternatives where it supports them. */
  alternatives: boolean;
  /** BCP-47 tag for maneuver instruction text. */
  locale?: string;
}

/** Per-call controls that are not part of the question being asked. */
export interface RoutingCallOptions {
  /**
   * Cancels the upstream call. A provider applies its OWN bounded timeout
   * regardless — this only lets a caller give up earlier.
   */
  signal?: AbortSignal;
}

export interface RoutingProvider {
  /** For logs and metrics. Never published to a caller. */
  readonly name: string;
  /** The modes this provider, as configured, will actually answer. */
  readonly supportedModes: readonly TravelMode[];

  /**
   * Compute routes, best first.
   *
   * An EMPTY array means "no route exists between these points", which is a
   * normal answer for this domain rather than a failure — see the note on
   * `RouteResponse` in `@goway/shared-types`. Everything that IS a failure is
   * thrown as an `ApiError` carrying a code from the shared vocabulary, so no
   * caller ever has to interpret an engine's own error shape.
   */
  route(request: RoutingRequest, options?: RoutingCallOptions): Promise<Route[]>;
}

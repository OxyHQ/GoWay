/**
 * The Valhalla adapter — and the wall Valhalla stops at.
 *
 * Valhalla's request body, its numeric maneuver taxonomy, its unit system, its
 * encoded shapes and its `error_code` table are all in this file and in no
 * other. What leaves is `@goway/shared-types`' `Route`: metres, seconds, a
 * GeoJSON LineString and a maneuver vocabulary GoWay owns. Issue #6 is explicit
 * that exposing Valhalla's raw response as the stable contract is the thing
 * this layer exists to prevent — a consumer that learned to read
 * `begin_shape_index` would make the engine unreplaceable.
 *
 * ## Which endpoint this talks to
 *
 * Whatever `ROUTING_VALHALLA_URL` names, and nothing by default. A public
 * community Valhalla instance is fine for local development — configure it in
 * `.env`, respect its fair-use policy, and send the identifying user agent this
 * adapter sends — but it is NOT an SLA-backed production dependency and no code
 * path here points at one.
 *
 * ## No retries
 *
 * One attempt, one bounded timeout. A directions request is interactive: a
 * client is waiting, and a second attempt inside the same request spends the
 * user's patience on the case least likely to succeed. `provider_unavailable`
 * is marked retryable in the shared vocabulary precisely so the decision to try
 * again belongs to the caller, who knows whether anyone is still looking.
 *
 * ## Privacy
 *
 * A route request IS a pair of precise locations. Nothing here logs one, puts
 * one in an error message, or puts one in `ApiErrorDetails` — which is the part
 * of a failure an integrator may log verbatim. Upstream diagnostics are logged
 * as status codes and engine error numbers only.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  toGeoCoordinate,
  type GeoPosition,
  type Route,
  type RouteLeg,
  type RouteManeuver,
  type TravelMode,
} from '@goway/shared-types';
import { ApiError } from '../http/apiError';
import { createLogger } from '../utils/logger';
import { decodePolyline, PolylineDecodeError } from './polyline';
import type { RoutingCallOptions, RoutingProvider, RoutingRequest } from './provider';

const log = createLogger('routing');

/** A `fetch` this adapter may be handed, so a test never opens a socket. */
export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ValhallaProviderOptions {
  /** The full route endpoint, e.g. `https://valhalla.example/route`. */
  url: string;
  /** Sent as the `api_key` query parameter when a hosted instance needs one. */
  apiKey?: string;
  timeoutMs: number;
  /** Modes this deployment offers; a subset of what the costing map covers. */
  modes: readonly TravelMode[];
  /** Alternatives requested when the caller asks for them. */
  maxAlternatives: number;
  userAgent: string;
  /** Injected in tests. Defaults to the runtime's global `fetch`. */
  fetch?: FetchLike;
}

/**
 * GoWay's travel modes to Valhalla's costing models.
 *
 * A TOTAL `Record<TravelMode, string>`: adding a mode to the shared contract
 * fails to compile here until somebody decides what it costs, instead of
 * reaching the engine as `undefined` and coming back as an opaque 400.
 */
const COSTING: Readonly<Record<TravelMode, string>> = {
  drive: 'auto',
  walk: 'pedestrian',
  bike: 'bicycle',
};

/**
 * Valhalla's numeric maneuver types, mapped onto GoWay's vocabulary.
 *
 * `ManeuverType` is an OPEN set by design, so the entries below that are not
 * one of the fifteen named members — transit, elevators, steps — pass through
 * as stable kebab-case strings rather than being flattened into `continue`.
 * That is what keeps transit and accessibility-aware routing addable later
 * without a contract change: the renderer that does not know `steps-enter`
 * falls back to the instruction text, which is always present.
 *
 * Numbers rather than names because Valhalla emits numbers. The comment on each
 * line is its `DirectionsLeg::Maneuver::Type` name.
 */
const MANEUVER_TYPES: Readonly<Record<number, string>> = {
  0: 'continue', // kNone
  1: 'depart', // kStart
  2: 'depart', // kStartRight
  3: 'depart', // kStartLeft
  4: 'arrive', // kDestination
  5: 'arrive', // kDestinationRight
  6: 'arrive', // kDestinationLeft
  7: 'continue', // kBecomes
  8: 'continue', // kContinue
  9: 'turn-slight-right', // kSlightRight
  10: 'turn-right', // kRight
  11: 'turn-sharp-right', // kSharpRight
  12: 'uturn', // kUturnRight
  13: 'uturn', // kUturnLeft
  14: 'turn-sharp-left', // kSharpLeft
  15: 'turn-left', // kLeft
  16: 'turn-slight-left', // kSlightLeft
  17: 'fork', // kRampStraight
  18: 'fork', // kRampRight
  19: 'fork', // kRampLeft
  20: 'fork', // kExitRight
  21: 'fork', // kExitLeft
  22: 'fork', // kStayStraight
  23: 'fork', // kStayRight
  24: 'fork', // kStayLeft
  25: 'merge', // kMerge
  26: 'roundabout-enter', // kRoundaboutEnter
  27: 'roundabout-exit', // kRoundaboutExit
  28: 'ferry', // kFerryEnter
  29: 'continue', // kFerryExit — back on land, so the ferry is behind you
  30: 'transit', // kTransit
  31: 'transit-transfer', // kTransitTransfer
  32: 'transit-remain-on', // kTransitRemainOn
  33: 'transit-connection-start', // kTransitConnectionStart
  34: 'transit-connection-transfer', // kTransitConnectionTransfer
  35: 'transit-connection-destination', // kTransitConnectionDestination
  36: 'continue', // kPostTransitConnectionDestination
  37: 'merge', // kMergeRight
  38: 'merge', // kMergeLeft
  39: 'elevator-enter', // kElevatorEnter
  40: 'steps-enter', // kStepsEnter
  41: 'escalator-enter', // kEscalatorEnter
  42: 'building-enter', // kBuildingEnter
  43: 'building-exit', // kBuildingExit
};

/**
 * Engine error codes that mean "there is no path", which is NOT a failure.
 *
 *  - 170 locations are in unconnected regions
 *  - 171 no suitable edges near location
 *  - 442/443/444 the path search itself found nothing
 *
 * These become an empty route list, because "no route exists between these
 * points" is a normal domain answer and a consumer must render it as such.
 */
const NO_ROUTE_CODES = new Set([170, 171, 442, 443, 444]);

/** Engine error codes that mean "this deployment has no such costing model". */
const UNSUPPORTED_MODE_CODES = new Set([124, 125]);

// ── The engine's own response shape. It does not leave this module. ──────────

const valhallaManeuverSchema = z.object({
  type: z.number().int().optional(),
  instruction: z.string().optional(),
  street_names: z.array(z.string()).optional(),
  begin_street_names: z.array(z.string()).optional(),
  time: z.number().optional(),
  length: z.number().optional(),
  begin_shape_index: z.number().int().nonnegative().optional(),
});

const valhallaSummarySchema = z.object({
  time: z.number().optional(),
  length: z.number().optional(),
});

const valhallaLegSchema = z.object({
  shape: z.string().optional(),
  summary: valhallaSummarySchema.optional(),
  maneuvers: z.array(valhallaManeuverSchema).optional(),
});

const valhallaTripSchema = z.object({
  legs: z.array(valhallaLegSchema).optional(),
  summary: valhallaSummarySchema.optional(),
  units: z.string().optional(),
  status: z.number().optional(),
});

const valhallaResponseSchema = z.object({
  trip: valhallaTripSchema.optional(),
  alternates: z.array(z.object({ trip: valhallaTripSchema.optional() })).optional(),
  error_code: z.number().int().optional(),
  error: z.string().optional(),
});

type ValhallaTrip = z.infer<typeof valhallaTripSchema>;
type ValhallaLeg = z.infer<typeof valhallaLegSchema>;

// ── Units ───────────────────────────────────────────────────────────────────

/**
 * Metres per the unit the engine actually answered in.
 *
 * The request asks for kilometres, but the ANSWER is what is trusted: an engine
 * configured with a different default, or one that ignores the option, would
 * otherwise turn 3 miles into 3 km — a 60 % error that still renders as a
 * believable ETA.
 */
function metresPerUnit(units: string | undefined): number {
  return units === 'miles' || units === 'mi' ? 1609.344 : 1000;
}

// ── Normalization ───────────────────────────────────────────────────────────

/** Whether two positions are the same point, to the engine's own precision. */
function samePosition(a: GeoPosition, b: GeoPosition): boolean {
  return Math.abs(a[0] - b[0]) < 1e-7 && Math.abs(a[1] - b[1]) < 1e-7;
}

/**
 * One line for the whole route, and where each leg starts inside it.
 *
 * Valhalla shapes each leg separately and the shared stop appears at the end of
 * one leg AND the start of the next. Concatenating naively duplicates it, which
 * a renderer draws as a zero-length segment and a `geometryIndex` then points
 * one place to the left of where it should for every leg after the first.
 */
function assembleGeometry(legs: readonly ValhallaLeg[]): {
  coordinates: GeoPosition[];
  legOffsets: number[];
} {
  const coordinates: GeoPosition[] = [];
  const legOffsets: number[] = [];

  for (const leg of legs) {
    const points = leg.shape === undefined || leg.shape === '' ? [] : decodePolyline(leg.shape);
    if (points.length === 0) {
      legOffsets.push(coordinates.length);
      continue;
    }

    const previous = coordinates[coordinates.length - 1];
    const shared = previous !== undefined && samePosition(previous, points[0]);
    legOffsets.push(shared ? coordinates.length - 1 : coordinates.length);
    // Spread-push would pass one argument per point, which blows the call stack
    // on a long route.
    for (let index = shared ? 1 : 0; index < points.length; index += 1) {
      coordinates.push(points[index]);
    }
  }

  return { coordinates, legOffsets };
}

function streetNameOf(maneuver: z.infer<typeof valhallaManeuverSchema>): string | undefined {
  const names = maneuver.street_names ?? maneuver.begin_street_names ?? [];
  const first = names.find((name) => name.trim().length > 0);
  return first === undefined ? undefined : first;
}

function toManeuver(
  raw: z.infer<typeof valhallaManeuverSchema>,
  coordinates: readonly GeoPosition[],
  legOffset: number,
  metres: number,
): RouteManeuver {
  // Clamped rather than trusted: an index past the end would make `coordinate`
  // undefined, and the SDK rejects the whole response for one bad maneuver.
  const geometryIndex = Math.min(legOffset + (raw.begin_shape_index ?? 0), coordinates.length - 1);
  const maneuver: RouteManeuver = {
    type: MANEUVER_TYPES[raw.type ?? 0] ?? 'continue',
    instruction: raw.instruction ?? '',
    distanceMeters: Math.max(0, (raw.length ?? 0) * metres),
    durationSeconds: Math.max(0, raw.time ?? 0),
    coordinate: toGeoCoordinate(coordinates[geometryIndex]),
    geometryIndex,
  };
  const streetName = streetNameOf(raw);
  // Absent, never an empty string: "GoWay does not know the name of this road"
  // is a different fact from "this road is called nothing".
  if (streetName !== undefined) maneuver.streetName = streetName;
  return maneuver;
}

function toLeg(
  raw: ValhallaLeg,
  coordinates: readonly GeoPosition[],
  legOffset: number,
  metres: number,
): RouteLeg {
  return {
    distanceMeters: Math.max(0, (raw.summary?.length ?? 0) * metres),
    durationSeconds: Math.max(0, raw.summary?.time ?? 0),
    maneuvers: (raw.maneuvers ?? []).map((maneuver) =>
      toManeuver(maneuver, coordinates, legOffset, metres),
    ),
  };
}

/** One engine trip, as a GoWay {@link Route}. */
function toRoute(trip: ValhallaTrip, mode: TravelMode): Route {
  const legs = trip.legs ?? [];
  const metres = metresPerUnit(trip.units);
  const { coordinates, legOffsets } = assembleGeometry(legs);

  if (coordinates.length < 2) {
    // A LineString needs two positions, and the SDK enforces that on the way
    // back in. A "route" that is one point is a broken answer, not a short one.
    throw new PolylineDecodeError('The route has no usable geometry.');
  }

  return {
    // Random rather than derived: a deterministic id would have to be built out
    // of the coordinates, and an identifier that encodes a user's precise
    // location is the same leak as logging it. Routes are transient request
    // data and are never persisted, so nothing needs to look this up later.
    id: randomUUID(),
    mode,
    distanceMeters: Math.max(0, (trip.summary?.length ?? 0) * metres),
    durationSeconds: Math.max(0, trip.summary?.time ?? 0),
    geometry: { type: 'LineString', coordinates },
    legs: legs.map((leg, index) => toLeg(leg, coordinates, legOffsets[index] ?? 0, metres)),
  };
}

// ── Failure mapping ─────────────────────────────────────────────────────────

/** Never carries a coordinate: `details` is the part an integrator may log. */
function unavailable(reason: string): ApiError {
  return new ApiError('provider_unavailable', 'The routing engine could not answer this request.', {
    reason,
  });
}

/**
 * An upstream failure, as a shared-vocabulary error — or `null` when it is not
 * a failure at all but the engine's way of saying "there is no path".
 */
function mapFailure(status: number, errorCode: number | undefined): ApiError | null {
  if (errorCode !== undefined) {
    if (NO_ROUTE_CODES.has(errorCode)) return null;
    if (UNSUPPORTED_MODE_CODES.has(errorCode)) {
      return new ApiError('unsupported_mode', 'The routing engine does not support this travel mode.');
    }
    // 1xx is request parsing and limits; 4xx below 425 is the path service
    // refusing the request it was given. Both mean GoWay asked for something
    // the engine will not answer, which is the caller's question, not an
    // outage — so it must not be reported as retryable.
    if ((errorCode >= 100 && errorCode < 170) || (errorCode >= 400 && errorCode < 425)) {
      return new ApiError('validation_failed', 'The routing engine refused this request.', {
        field: 'locations',
        issue: 'unroutable',
      });
    }
    return unavailable('upstream_error');
  }

  if (status === 429) {
    // The shared vocabulary reserves `rate_limited` for a limit GoWay applied
    // to THIS caller. An upstream throttling GoWay is `provider_unavailable` —
    // errors.ts says so in as many words — because the caller did nothing, and
    // telling them to slow down would be a lie.
    return unavailable('upstream_rate_limited');
  }
  if (status === 400 || status === 422) {
    return new ApiError('validation_failed', 'The routing engine refused this request.', {
      field: 'locations',
      issue: 'unroutable',
    });
  }
  return unavailable('upstream_error');
}

// ── The provider ────────────────────────────────────────────────────────────

/**
 * What one upstream call produced.
 *
 * `no-route` is deliberately not an error and deliberately not an empty
 * payload: the engine reports "no path" as an HTTP failure with an error code,
 * and collapsing that into either of the other two would either surface a
 * normal domain answer as an outage or hide a real one.
 */
type UpstreamResult = { kind: 'payload'; payload: unknown } | { kind: 'no-route' };

class ValhallaProvider implements RoutingProvider {
  readonly name = 'valhalla';
  readonly supportedModes: readonly TravelMode[];

  private readonly options: ValhallaProviderOptions;
  private readonly endpoint: string;

  constructor(options: ValhallaProviderOptions) {
    this.options = options;
    this.supportedModes = [...options.modes];
    const url = new URL(options.url);
    if (options.apiKey !== undefined) url.searchParams.set('api_key', options.apiKey);
    this.endpoint = url.toString();
  }

  async route(request: RoutingRequest, callOptions: RoutingCallOptions = {}): Promise<Route[]> {
    if (!this.supportedModes.includes(request.mode)) {
      throw new ApiError('unsupported_mode', 'This GoWay deployment does not route that travel mode.');
    }
    if (request.locations.length < 2) {
      throw new ApiError('validation_failed', 'A route needs an origin and a destination.', {
        field: 'locations',
        issue: 'too_small',
      });
    }

    const body = {
      locations: request.locations.map((point) => ({
        lat: point.coordinate.latitude,
        lon: point.coordinate.longitude,
        // Every stop is a hard break, so the engine's legs are exactly the
        // legs the contract promises: one per pair of consecutive stops.
        type: 'break' as const,
      })),
      costing: COSTING[request.mode],
      directions_options: {
        units: 'kilometers',
        ...(request.locale === undefined ? {} : { language: request.locale }),
      },
      ...(request.alternatives && this.options.maxAlternatives > 0
        ? { alternates: this.options.maxAlternatives }
        : {}),
    };

    const result = await this.post(body, callOptions.signal);
    // The engine said, in its own way, that no path exists. A normal answer.
    if (result.kind === 'no-route') return [];

    const parsed = valhallaResponseSchema.safeParse(result.payload);
    if (!parsed.success) throw unavailable('upstream_invalid_response');
    const { trip, alternates, error_code: errorCode } = parsed.data;

    if (trip === undefined) {
      // A 2xx carrying an error, or a body with neither. Both are the engine
      // answering something GoWay cannot turn into a route.
      const failure = mapFailure(200, errorCode);
      if (failure === null) return [];
      this.warn(200, errorCode);
      throw failure;
    }

    const trips = [trip, ...(alternates ?? []).map((entry) => entry.trip)];
    try {
      return trips
        .filter((trip): trip is ValhallaTrip => trip !== undefined)
        .map((trip) => toRoute(trip, request.mode));
    } catch (error) {
      if (error instanceof PolylineDecodeError) {
        // The engine answered something it called a route and GoWay cannot
        // read. That is an upstream fault, not the caller's.
        log.warn({ provider: this.name, reason: 'shape_undecodable' }, 'Routing engine returned an unreadable shape');
        throw unavailable('upstream_invalid_response');
      }
      throw error;
    }
  }

  /**
   * One bounded attempt.
   *
   * The timeout is the adapter's own `AbortController`; a caller's signal is
   * chained onto it so a client that has gone away can release the socket
   * early, but it can only make the deadline SOONER, never later.
   */
  private async post(body: unknown, signal: AbortSignal | undefined): Promise<UpstreamResult> {
    const fetchImpl = this.options.fetch ?? (globalThis.fetch as FetchLike | undefined);
    if (fetchImpl === undefined) throw unavailable('no_fetch_implementation');

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.options.timeoutMs);
    const forwardAbort = (): void => {
      controller.abort();
    };
    signal?.addEventListener('abort', forwardAbort, { once: true });

    let response: Response;
    try {
      response = await fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          // Community map services ask callers to identify themselves so abuse
          // is traceable to a project rather than to an IP range.
          'user-agent': this.options.userAgent,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch {
      // The error's own message can name the endpoint and, for some runtimes,
      // the request. It reaches neither the log line nor the response, so it
      // is not even bound to a name here.
      const reason = timedOut ? 'timeout' : signal?.aborted === true ? 'client_aborted' : 'unreachable';
      log.warn({ provider: this.name, reason }, 'Routing engine call did not complete');
      throw unavailable(reason);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', forwardAbort);
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const parsed = valhallaResponseSchema.safeParse(payload);
      const errorCode = parsed.success ? parsed.data.error_code : undefined;
      const failure = mapFailure(response.status, errorCode);
      if (failure === null) return { kind: 'no-route' };
      this.warn(response.status, errorCode);
      throw failure;
    }

    return { kind: 'payload', payload };
  }

  /** Status codes and engine error numbers only. Never a location. */
  private warn(status: number, errorCode: number | undefined): void {
    log.warn(
      { provider: this.name, providerStatus: status, providerErrorCode: errorCode ?? null },
      'Routing engine refused a request',
    );
  }
}

/** Build a Valhalla-backed {@link RoutingProvider}. */
export function createValhallaProvider(options: ValhallaProviderOptions): RoutingProvider {
  return new ValhallaProvider(options);
}

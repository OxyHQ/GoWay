/**
 * The GoWay Directions HTTP surface.
 *
 * ## The path is the SDK's, because the SDK is published contract
 *
 * `@goway.to/sdk` ships `GOWAY_API_BASE_PATH = '/api/v1'` and `goway.routes
 * .directions()` sends `POST /routes`. That is what this router answers. A
 * backend that answered anything else would 404 every consumer — FairCoin,
 * Moovo, Mercaria, Homiio — in exactly the environment where a contract test
 * that fakes `fetch` cannot see it.
 *
 * A 2xx body IS the contract value: `RouteResponse`, which is `{ routes }` and
 * nothing else. The SDK's `parseRouteResponse` reads exactly that.
 *
 * ## "No route" is a 200, not an error
 *
 * `@goway/shared-types` says it twice — `RouteResponse.routes` "may be empty:
 * 'no route exists between these points' is a normal answer for this domain,
 * not a failure, and a consumer must render it as such rather than as an
 * error" — and the SDK's `parseRouteResponse` documents an empty array as
 * valid. The `no_route` code exists and the SDK maps it to
 * `GoWayNoRouteError`, so either answer is accepted; this router chooses the
 * 200, because a domain answer delivered through a consumer's error path gets
 * retried, logged as a fault and rendered as "GoWay is broken" by generic
 * middleware that never looks at the code.
 *
 * ## Routing is PUBLIC
 *
 * `AGENTS.md`: the map opens without an account, and browsing, search and
 * routing must work signed out. So `optionalAuth`, never `requireAuth` — a
 * session is resolved when one is present and changes nothing about the answer.
 *
 * ## Privacy
 *
 * A directions request is a pair of precise locations. Nothing here writes one
 * down: no history row, no log field, no cache. `Cache-Control: no-store` says
 * the same thing to every proxy between GoWay and the user, because a shared
 * cache holding a route is a location history nobody decided to keep.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { GeoCoordinate, PlaceId, RouteResponse, TravelMode } from '@goway/shared-types';
import { TRAVEL_MODES } from '@goway/shared-types';
import { findPlaceById } from '../db/places/placesRepository';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { parseBody } from '../http/validation';
import { getRoutingProvider, type RoutePoint, type RoutingProvider } from '../routing';
import { routeRequestSchema, type RouteLocationInput, type RouteRequestInput } from './routeSchemas';

/**
 * Forward a rejected handler to the error middleware.
 *
 * Express 5 does this for a returned promise on its own. It is spelled out
 * anyway because the failure mode when it does not is a request that hangs
 * until the client's timeout with nothing logged — indistinguishable from the
 * service being down.
 */
function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/**
 * Resolves a GoWay place id to the point a router should aim at.
 *
 * `null` means no such place. This is the ONE seam where "which point is
 * routable" is decided: today it is the place's representative location, and
 * when GoWay learns about entrances, loading docks or step-free access points,
 * that knowledge plugs in here and every consumer gets it without changing a
 * line — which is the reason `RouteLocation` carries a place id at all.
 */
export type PlaceLocationResolver = (placeId: PlaceId) => Promise<GeoCoordinate | null>;

const resolveFromPlaces: PlaceLocationResolver = async (placeId) => {
  // No viewer id: routing needs the location and nothing else, and passing a
  // caller would load claim rows this endpoint has no use for. A place in ANY
  // status resolves — a deep link somebody already holds has to route.
  const place = await findPlaceById(getDb(), placeId);
  return place === null ? null : place.location;
};

export interface RoutesRouterDependencies {
  /** Resolves a session when one is present and continues regardless. */
  optionalAuth: RequestHandler;
  /**
   * The engine. Omit for the configured one; pass `null` to model a deployment
   * with none, and a fake in a test. INJECTED rather than imported so a test of
   * this router's own behaviour — validation, status codes, the error envelope,
   * place resolution — never opens a socket.
   */
  provider?: RoutingProvider | null;
  /** Omit for the Places repository. Injected in tests so none need a database. */
  resolvePlaceLocation?: PlaceLocationResolver;
}

/** Narrows the caller's `mode` to the contract, or says GoWay does not route it. */
function travelMode(mode: string): TravelMode {
  const match = (TRAVEL_MODES as readonly string[]).includes(mode);
  if (!match) {
    // NOT validation_failed: `transit` is a well-formed question GoWay cannot
    // answer yet, and a client can hide a button on the strength of the code.
    throw new ApiError('unsupported_mode', 'GoWay does not route that travel mode.', {
      mode,
      supported: TRAVEL_MODES.join(','),
    });
  }
  return mode as TravelMode;
}

async function resolvePoint(
  location: RouteLocationInput,
  what: string,
  resolvePlaceLocation: PlaceLocationResolver,
): Promise<RoutePoint> {
  let coordinate: GeoCoordinate;

  if (location.placeId !== undefined) {
    const resolved = await resolvePlaceLocation(location.placeId);
    if (resolved === null) {
      // The id is dead, not the request malformed. A consumer may drop a
      // persisted place id on the strength of this, which is the correct thing
      // for them to do — so it must not be said about a place that exists.
      throw new ApiError('not_found', `No place has the id given for ${what}.`, { field: what });
    }
    coordinate = resolved;
  } else if (location.coordinate !== undefined) {
    coordinate = location.coordinate;
  } else {
    // Unreachable behind the schema's refinement; if it is ever reached, the
    // schema has been relaxed and a route is about to be computed from nothing.
    throw new ApiError('bad_request', `${what} carries neither a coordinate nor a placeId.`, {
      field: what,
    });
  }

  const point: RoutePoint = { coordinate };
  if (location.name !== undefined) point.name = location.name;
  return point;
}

/** Origin, then waypoints in order, then destination — the engine's leg order. */
async function resolveLocations(
  input: RouteRequestInput,
  resolvePlaceLocation: PlaceLocationResolver,
): Promise<RoutePoint[]> {
  const ordered: { location: RouteLocationInput; what: string }[] = [
    { location: input.origin, what: 'origin' },
    ...(input.waypoints ?? []).map((location, index) => ({
      location,
      what: `waypoints.${String(index)}`,
    })),
    { location: input.destination, what: 'destination' },
  ];

  // Sequential rather than concurrent: the first unknown place id should be the
  // one reported, and a fan-out of place lookups per directions request is a
  // load pattern nobody asked for.
  const points: RoutePoint[] = [];
  for (const entry of ordered) {
    points.push(await resolvePoint(entry.location, entry.what, resolvePlaceLocation));
  }
  return points;
}

/**
 * Build the Directions router.
 *
 * Mounted in `app.ts` onto the `/api/v1` router:
 *
 *     v1.use(createRoutesRouter({ optionalAuth }));
 */
export function createRoutesRouter(dependencies: RoutesRouterDependencies): Router {
  const { optionalAuth } = dependencies;
  const resolvePlaceLocation = dependencies.resolvePlaceLocation ?? resolveFromPlaces;
  // `undefined` means "ask configuration"; an explicit `null` means "there is
  // none", which is a state a test has to be able to express.
  const providerOf = (): RoutingProvider | null =>
    dependencies.provider === undefined ? getRoutingProvider() : dependencies.provider;

  const router: Router = Router();

  /** `POST /routes` — directions between two or more points. */
  router.post(
    '/routes',
    optionalAuth,
    route(async (request, response) => {
      const input = parseBody(routeRequestSchema, request.body);
      const mode = travelMode(input.mode);

      const provider = providerOf();
      if (provider === null) {
        // GoWay itself is not able to answer, which is what
        // `service_unavailable` means — as distinct from
        // `provider_unavailable`, which would tell a caller the map data source
        // is down and invite a retry that cannot succeed until an operator acts.
        throw new ApiError('service_unavailable', 'Routing is not configured for this deployment.');
      }
      if (!provider.supportedModes.includes(mode)) {
        throw new ApiError('unsupported_mode', 'This GoWay deployment does not route that travel mode.', {
          mode,
          supported: provider.supportedModes.join(','),
        });
      }

      const locations = await resolveLocations(input, resolvePlaceLocation);
      const routes = await provider.route({
        locations,
        mode,
        alternatives: input.alternatives ?? false,
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      });

      // A route is a user's precise movement. No shared cache keeps a copy.
      response.set('Cache-Control', 'no-store');
      const body: RouteResponse = { routes };
      response.json(body);
    }),
  );

  return router;
}

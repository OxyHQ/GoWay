/**
 * The GoWay Places HTTP surface.
 *
 * ## Paths are the SDK's, because the SDK is published contract
 *
 * `@goway.to/sdk` ships `GOWAY_API_BASE_PATH = '/api/v1'` and calls
 * `/places/:id`, `/places/nearby`, `/places/bounds` and `POST|PATCH /places`.
 * Those spellings are what this router answers. Issue #4 sketches
 * `GET /places?bbox=…`, which is what a `curl` or a map embed reaches for, so
 * the collection route accepts it too and resolves to the same handler — an SDK
 * that cannot reach its own API is a silent integration break, and so is a
 * documented URL that 404s.
 *
 * A 2xx body IS the contract value. GoWay wraps success in no envelope, so a
 * place is a `Place`, a viewport is an array of `Place`, and a nearby search is
 * an array of `PlaceWithDistance` — the SDK's parsers read exactly that.
 *
 * ## Reads are public; writes are authenticated
 *
 * The map opens without an account, so every GET here is behind `optionalAuth`
 * and must answer a signed-out visitor. A signed-in one additionally sees claim
 * details on places they themselves have claimed. Writes require a verified Oxy
 * session, because a contribution without an identity cannot be reviewed,
 * attributed or reverted.
 *
 * ## Nothing here touches the ORM
 *
 * Every statement goes through `db/places/placesRepository`, which is also the
 * only thing that maps a row to the published contract. A handler that reached
 * for a drizzle table would be one `select(places)` away from serving an
 * internal column as an API field.
 */

import { Router, type RequestHandler, type Request, type Response, type NextFunction } from 'express';
import type { PlaceActor } from '../db/places/placesRepository';
import {
  createPlace,
  findPlaceById,
  findPlacesInBounds,
  findPlacesNearby,
  getPlaceAuthorization,
  updatePlace,
} from '../db/places/placesRepository';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { parseBody, parseQuery } from '../http/validation';
import {
  boundsQuerySchema,
  createPlaceSchema,
  nearbyQuerySchema,
  updatePlaceSchema,
  withQueryAliases,
} from './placeSchemas';

/**
 * Forward a rejected handler to the error middleware.
 *
 * Express 5 does this for a returned promise on its own. It is spelled out
 * anyway because the failure mode when it does not is a request that hangs
 * until the client's timeout with nothing logged — and that is indistinguishable
 * from the service being down.
 */
function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** The Oxy session on the request, or null. Never read from the body or the query. */
function callerId(request: Request): string | null {
  return typeof request.userId === 'string' && request.userId.length > 0 ? request.userId : null;
}

/**
 * The `:id` path parameter as a string.
 *
 * Express 5 types a route parameter as `string | string[]`, and the array case
 * is reachable: a path pattern can bind a parameter more than once. A place id
 * is one segment, so anything else is a malformed request rather than a place
 * that does not exist — answering 404 would tell a consumer their stored id is
 * dead when it was never sent.
 */
function placeIdParam(request: Request): string {
  const id = request.params.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new ApiError('bad_request', 'A place id must be a single path segment.');
  }
  return id;
}

function requiredCallerId(request: Request): string {
  const id = callerId(request);
  if (id === null) {
    // Behind `requireAuth` this is unreachable; if it is ever reached, the
    // middleware has been rewired and a write is about to run unattributed.
    throw new ApiError('unauthorized', 'This request requires an Oxy session.');
  }
  return id;
}

export interface PlacesRouterDependencies {
  /** Resolves a session when one is present and continues regardless. */
  optionalAuth: RequestHandler;
  /** Fail-closed: refuses the request unless it carries a valid Oxy session. */
  requireAuth: RequestHandler;
}

/**
 * Build the Places router.
 *
 * The two auth middlewares are INJECTED rather than imported, for one reason
 * that matters: `createOxyAuthMiddleware` verifies a token against the Oxy
 * identity service over HTTP, so a test of this router's own behaviour —
 * validation, status codes, the error envelope, the claim-visibility rule —
 * would otherwise need a live Oxy. Injection keeps the composition in `app.ts`,
 * where the real middlewares are the only thing ever passed.
 */
export function createPlacesRouter(dependencies: PlacesRouterDependencies): Router {
  const { optionalAuth, requireAuth } = dependencies;
  const router: Router = Router();

  /**
   * `GET /places/nearby?latitude&longitude&radiusMeters` — radius search,
   * nearest first, each result carrying its distance in metres.
   *
   * Registered BEFORE `/places/:id`: Express matches in registration order, and
   * a `:id` route mounted first would swallow `nearby` as a place id and answer
   * 404 for the whole endpoint.
   */
  router.get(
    '/places/nearby',
    optionalAuth,
    route(async (request, response) => {
      const query = parseQuery(nearbyQuerySchema, withQueryAliases({ ...request.query }));
      const results = await findPlacesNearby(getDb(), query);
      response.json(results);
    }),
  );

  /** `GET /places/bounds?west&south&east&north` — the viewport read. */
  router.get(
    '/places/bounds',
    optionalAuth,
    route(async (request, response) => {
      const query = parseQuery(boundsQuerySchema, withQueryAliases({ ...request.query }));
      const results = await findPlacesInBounds(getDb(), query);
      response.json(results);
    }),
  );

  /**
   * `GET /places?bbox=west,south,east,north` — the same viewport read under the
   * spelling issue #4 documents.
   *
   * There is deliberately no unbounded form: a `GET /places` with no box would
   * be a scan of every place on Earth truncated by a `LIMIT`, which reads to a
   * client as missing data rather than as a refused question.
   */
  router.get(
    '/places',
    optionalAuth,
    route(async (request, response) => {
      const query = parseQuery(boundsQuerySchema, withQueryAliases({ ...request.query }));
      const results = await findPlacesInBounds(getDb(), query);
      response.json(results);
    }),
  );

  /**
   * `GET /places/:id` — one place by its stable GoWay id.
   *
   * Answers in any status, `removed` included. A deep link somebody already
   * holds has to resolve to something: the SDK reads a 404 as "this id is
   * dead", and a consumer may drop a persisted place id on the strength of it.
   *
   * Claim details are published only to an account that itself holds a claim on
   * the place. Everyone else gets no `claims` field at all — absent, which the
   * contract distinguishes from an empty list.
   */
  router.get(
    '/places/:id',
    optionalAuth,
    route(async (request, response) => {
      const place = await findPlaceById(getDb(), placeIdParam(request), callerId(request));
      if (!place) throw new ApiError('not_found', 'No place has that id.');
      response.json(place);
    }),
  );

  /**
   * `POST /places` — a GoWay-created place or a community submission.
   *
   * Created `unverified` with `community_reported` capabilities, whatever the
   * body says. Verification is a statement GoWay makes about a place, not one a
   * caller can make about their own submission.
   *
   * 409 when a source record the body names is already linked to another place:
   * that identifier is how reconciliation decides two records are the same
   * thing, so a second place claiming it is a collision to resolve, never a
   * second copy to create.
   */
  router.post(
    '/places',
    requireAuth,
    route(async (request, response) => {
      const input = parseBody(createPlaceSchema, request.body);
      const actor: PlaceActor = {
        oxyUserId: requiredCallerId(request),
        // A place that does not exist yet can carry no approved claim, so a
        // creator is a community reporter by construction. Claiming it is a
        // separate, reviewed act.
        assertedVerification: 'community_reported',
      };
      const place = await createPlace(getDb(), input, actor);
      response
        .status(201)
        .location(`/api/v1/places/${encodeURIComponent(place.id)}`)
        .json(place);
    }),
  );

  /**
   * `PATCH /places/:id` — edit a place.
   *
   * An UNCLAIMED place is community-editable: that is what makes GoWay an open
   * map. A place somebody has an APPROVED claim on is not — only an account
   * holding one of those claims may edit it, and an outsider's edit is 403
   * rather than a silent no-op.
   *
   * The same fact decides how much the caller's capability assertions weigh: a
   * claimant asserts `business_asserted`, everyone else `community_reported`.
   * Neither can assert `oxy_verified`, and a capability that names a source is
   * recorded as `external_source` regardless of who sent it.
   */
  router.patch(
    '/places/:id',
    requireAuth,
    route(async (request, response) => {
      const input = parseBody(updatePlaceSchema, request.body);
      const oxyUserId = requiredCallerId(request);
      const db = getDb();

      const authorization = await getPlaceAuthorization(db, placeIdParam(request), oxyUserId);
      if (!authorization.exists) throw new ApiError('not_found', 'No place has that id.');
      if (authorization.claimed && authorization.callerRoles.length === 0) {
        throw new ApiError('forbidden', 'This place is claimed; only an approved claimant may edit it.');
      }

      const actor: PlaceActor = {
        oxyUserId,
        assertedVerification:
          authorization.callerRoles.length > 0 ? 'business_asserted' : 'community_reported',
      };
      const place = await updatePlace(db, placeIdParam(request), input, actor);
      // The place existed a moment ago and does not now — a concurrent delete.
      if (!place) throw new ApiError('not_found', 'No place has that id.');
      response.json(place);
    }),
  );

  return router;
}

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
 * Issue #8 adds the authorization-aware write surface beside them:
 * `PUT|DELETE /places/:id/capabilities/:key`, `POST|GET /places/:id/claims` and
 * `GET /claims`. The capability routes are generic over any
 * `<namespace>.<capability>` key — FairCoin is the first consumer of them, not
 * a shape they are built around.
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
import type { CapabilityKeyParts, PlaceActor } from '../db/places/placesRepository';
import {
  assertPlaceCapability,
  createPlace,
  findAccountClaims,
  findPlaceById,
  findPlacesInBounds,
  findPlacesNearby,
  getPlaceAuthorization,
  listPlaceClaims,
  requestClaim,
  updatePlace,
  withdrawPlaceCapability,
} from '../db/places/placesRepository';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { parseBody, parseQuery } from '../http/validation';
import { assertableVerification, withdrawableVerification } from '../places/capabilityAuthority';
import {
  assertCapabilitySchema,
  boundsQuerySchema,
  capabilityKeyPathSchema,
  createClaimSchema,
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

/**
 * The `:key` path parameter, split into a namespace and a capability.
 *
 * `bad_request` rather than `validation_failed`, matching {@link placeIdParam}:
 * a path segment that is not a capability key is a URL the client built wrong,
 * not a well-formed question this endpoint refuses to answer. An integrator
 * acts differently on the two — the first is a bug in their URL construction.
 */
function capabilityKeyParam(request: Request): CapabilityKeyParts {
  const key = request.params.key;
  const parsed = typeof key === 'string' ? capabilityKeyPathSchema.safeParse(key) : null;
  if (!parsed?.success) {
    throw new ApiError(
      'bad_request',
      'A capability key must be a lower-case <namespace>.<capability>, such as payments.faircoin.accepted.',
    );
  }
  return parsed.data;
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
        assertedVerification: assertableVerification(authorization),
      };
      const place = await updatePlace(db, placeIdParam(request), input, actor);
      // The place existed a moment ago and does not now — a concurrent delete.
      if (!place) throw new ApiError('not_found', 'No place has that id.');
      response.json(place);
    }),
  );

  // ── Capability assertions ─────────────────────────────────────────────────
  //
  // The write half of the mechanism `GET /places/nearby?capabilities=…` already
  // reads. Generic over `<namespace>.<capability>` and deliberately not shaped
  // around FairCoin: `payments.faircoin.accepted`, `commerce.mercaria.store`
  // and `housing.homiio.listings` are the same URL with a different segment,
  // which is what "the architecture must generalize" cashes out to. There is no
  // `/faircoin-merchants` here and there must never be one.
  //
  // The key is a PATH segment rather than a body field because it identifies
  // the thing being written: `PUT /places/:id/capabilities/payments.faircoin.accepted`
  // is idempotent in the way PUT promises, it gives the assertion a URL that
  // DELETE can name, and it reads against the existing routes the same way
  // `/places/:id` does.

  /**
   * `PUT /places/:id/capabilities/:key` — assert or refresh one capability.
   *
   * The VERIFICATION TIER is derived from the caller's approved claims on this
   * place and never from the body — `places/capabilityAuthority` is the only
   * thing that decides it. A body that names a `source` is recorded as
   * `external_source` instead, because the tier then rests on a row in
   * `places_sources` that a reviewer can go and check.
   *
   * ## Why a claimed place is NOT closed to outside assertions
   *
   * `PATCH /places/:id` refuses an outsider on a claimed place, and this does
   * not. The difference is what each write touches. A PATCH rewrites shared
   * columns — the name, the position, the opening hours — where a stranger's
   * edit overwrites the business's own. A capability assertion cannot: the
   * table is unique on `(place, namespace, capability, VERIFICATION)`, so a
   * passer-by's `community_reported` row lands BESIDE the business's
   * `business_asserted` one, outranked by it in every published ordering, and
   * neither can overwrite or demote the other. Closing this route to
   * non-claimants would buy no protection the schema does not already give, and
   * it would cost the thing that makes a community map worth reading: a
   * customer who sees a FairCoin sticker in a claimed shop can say so.
   */
  router.put(
    '/places/:id/capabilities/:key',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const key = capabilityKeyParam(request);
      const input = parseBody(assertCapabilitySchema, request.body);
      const oxyUserId = requiredCallerId(request);
      const db = getDb();

      const authorization = await getPlaceAuthorization(db, placeId, oxyUserId);
      if (!authorization.exists) throw new ApiError('not_found', 'No place has that id.');

      const actor: PlaceActor = {
        oxyUserId,
        assertedVerification: assertableVerification(authorization),
      };
      const place = await assertPlaceCapability(
        db,
        placeId,
        { ...key, value: input.value, ...(input.source ? { source: input.source } : {}) },
        actor,
      );
      // The place existed a moment ago and does not now — a concurrent delete.
      if (!place) throw new ApiError('not_found', 'No place has that id.');

      // The whole Place, not the one capability. `@goway/shared-types` names no
      // standalone capability response, the SDK already parses a `Place`, and
      // the full record is what shows the caller the EVIDENCE their write now
      // sits in: every tier asserted for this key, each with its own
      // `observedAt`, including the ones they are not entitled to write.
      response.json(place);
    }),
  );

  /**
   * `DELETE /places/:id/capabilities/:key` — withdraw the business's own
   * assertion.
   *
   * Scoped to ONE tier, and the type of that tier cannot hold `oxy_verified` or
   * `external_source`: an Oxy-verified fact has no API path out, exactly as it
   * has none in.
   *
   * Only an approved claimant may withdraw, because only their tier is
   * attributable — `places_capabilities` records no author, so the community
   * row is shared and a stranger deleting it would erase a report they did not
   * write. A community reporter retracts with `PUT … {"value": false}` instead,
   * which is better evidence than a deletion: an absent row means "nobody has
   * said", and a wallet cannot tell that from "somebody checked and it stopped
   * being true".
   */
  router.delete(
    '/places/:id/capabilities/:key',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const key = capabilityKeyParam(request);
      const oxyUserId = requiredCallerId(request);
      const db = getDb();

      const authorization = await getPlaceAuthorization(db, placeId, oxyUserId);
      if (!authorization.exists) throw new ApiError('not_found', 'No place has that id.');

      const verification = withdrawableVerification(authorization);
      if (verification === null) {
        throw new ApiError(
          'forbidden',
          'Only an approved claimant may withdraw an assertion. Report that a place ' +
            'no longer has a capability by asserting the value false instead.',
        );
      }

      const withdrawn = await withdrawPlaceCapability(db, placeId, key, verification);
      if (!withdrawn) {
        throw new ApiError(
          'not_found',
          'This place carries no business-asserted claim of that capability to withdraw.',
        );
      }

      const place = await findPlaceById(db, placeId, oxyUserId);
      if (!place) throw new ApiError('not_found', 'No place has that id.');
      response.json(place);
    }),
  );

  // ── Claims ────────────────────────────────────────────────────────────────
  //
  // Deferred from #4 and reachable now, because an approved claim is what
  // raises a capability assertion to `business_asserted` — the write path is
  // only authorization-aware if there is a way to acquire the authorization.
  //
  // Creating and READING claims is all that is here. Approving one is not: it
  // needs an authority GoWay does not model — there is no admin role, no
  // moderator and no verification workflow in this repository — and inventing
  // one would be inventing the very escalation this issue exists to prevent.
  // Until then an approval is an operator act against the database, which is
  // reviewable in a way a half-designed endpoint would not be.

  /**
   * `POST /places/:id/claims` — ask to be recognised as running this place.
   *
   * Always `pending`, and not because the route checks: `requestClaim` takes no
   * state, so there is no value a body could carry into one. 409 when the same
   * account already holds a claim in the same role, so a caller learns their
   * earlier request is still pending rather than assuming this one is new.
   */
  router.post(
    '/places/:id/claims',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const input = parseBody(createClaimSchema, request.body);
      const oxyAccountId = requiredCallerId(request);
      const db = getDb();

      // Checked before the insert so an unknown place is a 404 rather than the
      // 500 a foreign-key violation would produce.
      const authorization = await getPlaceAuthorization(db, placeId, oxyAccountId);
      if (!authorization.exists) throw new ApiError('not_found', 'No place has that id.');

      const claim = await requestClaim(db, {
        placeId,
        oxyAccountId,
        role: input.role,
        ...(input.brandId ? { brandId: input.brandId } : {}),
      });
      response.status(201).json(claim);
    }),
  );

  /**
   * `GET /places/:id/claims` — the claims on one place.
   *
   * Visible to an account that itself holds a claim on the place — its own, and
   * the ones it is competing with — and to nobody else, which is the rule
   * `GET /places/:id` already applies to the embedded `claims` field. A pending
   * claimant counts: they have to be able to see that their request is pending.
   *
   * 403 rather than an empty list for everyone else. An empty array would
   * assert that a claimed place has no claims, which is false and is exactly
   * the kind of confident wrong answer a consumer caches.
   */
  router.get(
    '/places/:id/claims',
    requireAuth,
    route(async (request, response) => {
      const oxyAccountId = requiredCallerId(request);
      const { exists, entitled, claims } = await listPlaceClaims(
        getDb(),
        placeIdParam(request),
        oxyAccountId,
      );
      // 404 first: answering 403 for an id that does not exist would confirm to
      // a stranger that an id they guessed is real.
      if (!exists) throw new ApiError('not_found', 'No place has that id.');
      if (!entitled) {
        throw new ApiError('forbidden', 'Claim details are visible only to an account that holds a claim on this place.');
      }
      response.json(claims);
    }),
  );

  /**
   * `GET /claims` — every claim the CALLER holds, in every state.
   *
   * The multi-location read: a chain's account gets its locations back in one
   * request instead of one per place. Keyed on the session and on nothing a
   * caller can send — a `?oxyAccountId=` parameter here would be an enumeration
   * of who has claimed what.
   */
  router.get(
    '/claims',
    requireAuth,
    route(async (request, response) => {
      const claims = await findAccountClaims(getDb(), requiredCallerId(request));
      response.json(claims);
    }),
  );

  return router;
}

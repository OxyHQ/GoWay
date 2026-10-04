/**
 * The GoWay Places HTTP surface.
 *
 * ## Paths are the SDK's, because the SDK is published contract
 *
 * Every route here is an operation in `@goway/contracts`' registry
 * (`API_OPERATIONS`), which is what the SDK calls and what the OpenAPI document
 * publishes: `GET /places/nearby`, `GET /places/bounds`, `GET|PATCH
 * /places/{placeId}` and `POST /places`. Each request is parsed with the
 * registry's own schema for it, so a parameter cannot mean one thing here and
 * another in the SDK.
 *
 * A 2xx body IS the contract value. GoWay wraps success in no envelope, so a
 * place is a `Place` and a list is a page — `{ items, nextCursor }` — of them.
 *
 * Issue #8 adds the authorization-aware write surface beside them:
 * `PUT|DELETE /places/:id/capabilities/:key`, `POST|GET /places/:id/claims` and
 * `GET /claims`. The capability routes are generic over any
 * `<namespace>.<capability>` key — FairCoin is the first consumer of them, not
 * a shape they are built around.
 *
 * ## `locale` is a QUERY PARAMETER, never `Accept-Language`
 *
 * Every read takes `?locale=` and none of them reads the inbound
 * `Accept-Language` header, which would be the HTTP-native spelling and is
 * deliberately not used. `GET /places/bounds` is the response a CDN is most
 * worth caching, a header that is not in the cache key is a header that does
 * not vary the cached copy, and the failure mode is one visitor's language
 * served to the next. A parameter is in the URL, so it is in the key by
 * construction — and it also means a caller can ask for a language that is not
 * their browser's, which a header cannot express at all.
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
import { z } from 'zod';
import {
  capabilityPathSchema,
  claimListQuerySchema,
  nearbyPlacesQuerySchema,
  placeCapabilityAssertionSchema,
  placeClaimInputSchema,
  placeCreateInputSchema,
  placePathSchema,
  placeReadQuerySchema,
  placesInBoundsQuerySchema,
  placeUpdateInputSchema,
  splitCapabilityKey,
} from '@goway/contracts';
import type { PlaceActor, PlaceAuthorization } from '../db/places/placesRepository';
import {
  assertPlaceCapability,
  createPlace,
  findAccountClaims,
  findPlaceById,
  findPlaceStatus,
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
import { cursorBinding, decodeCursor, pageOf, timePageOf, timeWindowOf } from '../http/cursor';
import { parseBody, parsePath, parseQuery } from '../http/validation';
import { assertableVerification, withdrawableVerification } from '../places/capabilityAuthority';

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

/** The `{placeId}` path parameter. Malformed is `bad_request`, never a 404 for an id that was not sent. */
function placeIdParam(request: Request): string {
  return parsePath(placePathSchema, request.params).placeId;
}

/** The answer for a place that is not there: `410` if moderation removed it, `404` if it never existed. */
function missingPlace(removed: boolean): ApiError {
  return removed
    ? new ApiError('gone', 'This place was removed from GoWay.')
    : new ApiError('not_found', 'No place has that id.');
}

/** Refuse a write to a place that does not exist or was removed. */
function assertWritable(authorization: PlaceAuthorization): void {
  if (!authorization.exists || authorization.removed) throw missingPlace(authorization.removed);
}

/** A nearby page resumes at `(distanceMeters, placeId)`. */
const nearbyKeysetSchema = z.tuple([z.number().min(0), z.string().min(1)]);
/** A viewport page resumes after a place id. */
const boundsKeysetSchema = z.string().min(1);

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
   * nearest first, each result carrying its distance in metres. Keyset-paged
   * by `(distance, id)`.
   *
   * Registered BEFORE `/places/:id`: Express matches in registration order, and
   * a `:id` route mounted first would swallow `nearby` as a place id and answer
   * 404 for the whole endpoint.
   */
  router.get(
    '/places/nearby',
    optionalAuth,
    route(async (request, response) => {
      const { cursor, limit, ...query } = parseQuery(nearbyPlacesQuerySchema, request.query);
      const binding = cursorBinding('places-nearby', query);
      const rows = await findPlacesNearby(getDb(), {
        ...query,
        limit: limit + 1,
        after: decodeCursor(cursor, binding, nearbyKeysetSchema),
      });
      response.json(pageOf(rows, limit, binding, (place) => [place.distanceMeters, place.id], (place) => place));
    }),
  );

  /** `GET /places/bounds?west&south&east&north` — the viewport read, keyset-paged by place id. */
  router.get(
    '/places/bounds',
    optionalAuth,
    route(async (request, response) => {
      const { cursor, limit, ...query } = parseQuery(placesInBoundsQuerySchema, request.query);
      const binding = cursorBinding('places-bounds', query);
      const rows = await findPlacesInBounds(getDb(), {
        ...query,
        limit: limit + 1,
        after: decodeCursor(cursor, binding, boundsKeysetSchema),
      });
      response.json(pageOf(rows, limit, binding, (place) => place.id, (place) => place));
    }),
  );

  /**
   * `GET /places/{placeId}` — one place by its stable GoWay id.
   *
   * A place moderation REMOVED answers `410 gone`, not 404: a deep link
   * somebody already holds has to resolve to something they can act on, and
   * "this place was withdrawn" is a different thing to tell a consumer holding
   * a persisted id than "this id was never real".
   *
   * Claim details are published only to an account that itself holds a claim on
   * the place. Everyone else gets no `claims` field at all — absent, which the
   * contract distinguishes from an empty list.
   */
  router.get(
    '/places/:placeId',
    optionalAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const { locale } = parseQuery(placeReadQuerySchema, request.query);
      const db = getDb();
      const place = await findPlaceById(db, placeId, callerId(request), locale);
      if (!place) throw missingPlace((await findPlaceStatus(db, placeId)) === 'removed');
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
      const input = parseBody(placeCreateInputSchema, request.body);
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
   * `PATCH /places/{placeId}` — edit a place.
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
    '/places/:placeId',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const input = parseBody(placeUpdateInputSchema, request.body);
      const oxyUserId = requiredCallerId(request);
      const db = getDb();

      const authorization = await getPlaceAuthorization(db, placeId, oxyUserId);
      assertWritable(authorization);
      if (authorization.claimed && authorization.callerRoles.length === 0) {
        throw new ApiError('forbidden', 'This place is claimed; only an approved claimant may edit it.');
      }

      const actor: PlaceActor = {
        oxyUserId,
        assertedVerification: assertableVerification(authorization),
      };
      const place = await updatePlace(db, placeId, input, actor);
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
   * `PUT /places/{placeId}/capabilities/{key}` — assert or refresh one capability.
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
    '/places/:placeId/capabilities/:key',
    requireAuth,
    route(async (request, response) => {
      const { placeId, key } = parsePath(capabilityPathSchema, request.params);
      const input = parseBody(placeCapabilityAssertionSchema, request.body);
      const oxyUserId = requiredCallerId(request);
      const db = getDb();

      const authorization = await getPlaceAuthorization(db, placeId, oxyUserId);
      assertWritable(authorization);

      const actor: PlaceActor = {
        oxyUserId,
        assertedVerification: assertableVerification(authorization),
      };
      const place = await assertPlaceCapability(
        db,
        placeId,
        { ...splitCapabilityKey(key), value: input.value, ...(input.source ? { source: input.source } : {}) },
        actor,
      );
      // The place existed a moment ago and does not now — a concurrent delete.
      if (!place) throw new ApiError('not_found', 'No place has that id.');

      // The whole Place, not the one capability: the full record is what shows
      // the caller the EVIDENCE their write now sits in — every tier asserted
      // for this key, each with its own `observedAt`, including the ones they
      // are not entitled to write.
      response.json(place);
    }),
  );

  /**
   * `DELETE /places/{placeId}/capabilities/{key}` — withdraw the business's
   * own assertion. `204`, no body.
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
    '/places/:placeId/capabilities/:key',
    requireAuth,
    route(async (request, response) => {
      const { placeId, key } = parsePath(capabilityPathSchema, request.params);
      const oxyUserId = requiredCallerId(request);
      const db = getDb();

      const authorization = await getPlaceAuthorization(db, placeId, oxyUserId);
      assertWritable(authorization);

      const verification = withdrawableVerification(authorization);
      if (verification === null) {
        throw new ApiError(
          'forbidden',
          'Only an approved claimant may withdraw an assertion. Report that a place ' +
            'no longer has a capability by asserting the value false instead.',
        );
      }

      const withdrawn = await withdrawPlaceCapability(db, placeId, splitCapabilityKey(key), verification);
      if (!withdrawn) {
        throw new ApiError(
          'not_found',
          'This place carries no business-asserted claim of that capability to withdraw.',
        );
      }
      response.status(204).end();
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
   * `POST /places/{placeId}/claims` — ask to be recognised as running this place.
   *
   * Always `pending`, and not because the route checks: `requestClaim` takes no
   * state, so there is no value a body could carry into one. 409 when the same
   * account already holds a claim in the same role, so a caller learns their
   * earlier request is still pending rather than assuming this one is new.
   */
  router.post(
    '/places/:placeId/claims',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const input = parseBody(placeClaimInputSchema, request.body);
      const oxyAccountId = requiredCallerId(request);
      const db = getDb();

      // Checked before the insert so an unknown place is a 404 rather than the
      // 500 a foreign-key violation would produce.
      assertWritable(await getPlaceAuthorization(db, placeId, oxyAccountId));

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
   * `GET /places/{placeId}/claims` — the claims on one place, oldest first,
   * keyset-paged by claim time.
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
    '/places/:placeId/claims',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const query = parseQuery(claimListQuerySchema, request.query);
      const oxyAccountId = requiredCallerId(request);
      const binding = cursorBinding('place-claims', { placeId, oxyAccountId });
      const { exists, removed, entitled, claims } = await listPlaceClaims(
        getDb(),
        placeId,
        oxyAccountId,
        timeWindowOf(query, binding),
      );
      // 404 first: answering 403 for an id that does not exist would confirm to
      // a stranger that an id they guessed is real.
      if (!exists || removed) throw missingPlace(removed);
      if (!entitled) {
        throw new ApiError('forbidden', 'Claim details are visible only to an account that holds a claim on this place.');
      }
      response.json(timePageOf(claims, query.limit, binding));
    }),
  );

  /**
   * `GET /claims` — every claim the CALLER holds, in every state, oldest
   * first, keyset-paged by claim time.
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
      const query = parseQuery(claimListQuerySchema, request.query);
      const oxyAccountId = requiredCallerId(request);
      // The account is in the binding, so a cursor minted for one session is
      // refused under another rather than resuming somebody else's list.
      const binding = cursorBinding('my-claims', { oxyAccountId });
      const claims = await findAccountClaims(getDb(), oxyAccountId, timeWindowOf(query, binding));
      response.json(timePageOf(claims, query.limit, binding));
    }),
  );

  return router;
}

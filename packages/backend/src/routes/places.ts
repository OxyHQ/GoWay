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
 * another in the SDK. `GET /places?ids=` reads up to fifty places by id at once,
 * each as the single read would answer it.
 *
 * A 2xx body IS the contract value. GoWay wraps success in no envelope, so a
 * place is a `Place` and a list is a page — `{ items, nextCursor }` — of them.
 *
 * Issue #8 adds the authorization-aware write surface beside them:
 * `PUT|DELETE /places/:id/capabilities/:key`, `POST|GET /places/:id/claims` and
 * `GET /claims`; the hours exceptions under `/places/:id/hours-exceptions`
 * follow the capability routes' authority rules. The capability routes are generic over any
 * `<namespace>.<capability>` key — FairCoin is the first consumer of them, not
 * a shape they are built around. `GET /places/:id/revisions` publishes a
 * place's history and `POST /places/:id/reports` flags it for moderation.
 *
 * ## A business is an Oxy organization
 *
 * A claim names an Oxy account, usually an organization, and Oxy decides who
 * may act for it: the session that switched into it, or a member Oxy reports
 * as `owner`, `admin` or `editor` (`places/claimAuthority`). The membership is
 * asked with the caller's own bearer and cached briefly; when Oxy cannot
 * answer, a write that depends on the answer is `503 service_unavailable`,
 * never a guess. A place nobody has claimed needs no answer and costs no call.
 *
 * Every write records a revision in its own transaction (`db/places/revisions`),
 * naming the account it was made as and the person who made it.
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

import {
  Router,
  type RequestHandler,
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { z } from 'zod';
import {
  accountClaimListQuerySchema,
  capabilityPathSchema,
  capabilityValueSchemaFor,
  claimListQuerySchema,
  hoursExceptionListQuerySchema,
  hoursExceptionPathSchema,
  localDateSchema,
  nearbyPlacesQuerySchema,
  placeBatchQuerySchema,
  placeCapabilityAssertionSchema,
  placeClaimInputSchema,
  placeCreateInputSchema,
  placeHoursExceptionInputSchema,
  placePathSchema,
  placeReadQuerySchema,
  placeReportInputSchema,
  placesInBoundsQuerySchema,
  placeUpdateInputSchema,
  revisionListQuerySchema,
  splitCapabilityKey,
  type PlaceBatch,
} from '@goway/contracts';
import { assertCategoryFilter, categoryCatalog } from '../categories/catalog';
import { createPlaceReport } from '../db/places/moderationRepository';
import type { PlaceActor } from '../db/places/placesRepository';
import {
  assertPlaceCapability,
  createHoursException,
  createPlace,
  findAccountClaims,
  findHoursException,
  findPlaceById,
  findPlaceLifecycle,
  findPlaceLifecycles,
  findPlacesByIds,
  findPlacesInBounds,
  findPlacesNearby,
  getPlaceAuthorization,
  listHoursExceptions,
  listPlaceClaims,
  replaceHoursException,
  requestClaim,
  updatePlace,
  withdrawHoursException,
  withdrawPlaceCapability,
} from '../db/places/placesRepository';
import { listPlaceRevisions, revisionAuthor } from '../db/places/revisions';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { cursorBinding, decodeCursor, pageOf, timePageOf, timeWindowOf } from '../http/cursor';
import { parseBody, parsePath, parseQuery, parseValue } from '../http/validation';
import { requiredOxyCaller } from '../oxy/caller';
import type { AccountRoleResolver } from '../oxy/accountRoles';
import { assertableVerification, withdrawableVerification } from '../places/capabilityAuthority';
import { mayActFor, mayActForAny, mayFileFor, standingOn } from '../places/claimAuthority';
import { assertPublished, mergedIntoOf, unpublishedPlace } from '../places/placeLifecycle';

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

/** A nearby page resumes at `(distanceMeters, placeId)`. */
const nearbyKeysetSchema = z.tuple([z.number().min(0), z.string().min(1)]);
/** A viewport page resumes after a place id. */
const boundsKeysetSchema = z.string().min(1);
/** An hours-exception page resumes at `(startsOn, exceptionId)`. */
const hoursExceptionKeysetSchema = z.tuple([localDateSchema, z.string().min(1).max(128)]);

export interface PlacesRouterDependencies {
  /** Resolves a session when one is present and continues regardless. */
  optionalAuth: RequestHandler;
  /** Fail-closed: refuses the request unless it carries a valid Oxy session. */
  requireAuth: RequestHandler;
  /** The caller's role in an Oxy account — what organization-scoped authorization asks. */
  accountRoles: AccountRoleResolver;
  /** Applied to reports only, in addition to the API-wide limit. */
  reportRateLimit: RequestHandler;
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
  const { optionalAuth, requireAuth, accountRoles, reportRateLimit } = dependencies;
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
      const db = getDb();
      if (query.categories)
        assertCategoryFilter(await categoryCatalog(db), query.categories, 'categories');
      const binding = cursorBinding('places-nearby', query);
      const rows = await findPlacesNearby(db, {
        ...query,
        limit: limit + 1,
        after: decodeCursor(cursor, binding, nearbyKeysetSchema),
      });
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (place) => [place.distanceMeters, place.id],
          (place) => place,
        ),
      );
    }),
  );

  /** `GET /places/bounds?west&south&east&north` — the viewport read, keyset-paged by place id. */
  router.get(
    '/places/bounds',
    optionalAuth,
    route(async (request, response) => {
      const { cursor, limit, ...query } = parseQuery(placesInBoundsQuerySchema, request.query);
      const db = getDb();
      if (query.categories)
        assertCategoryFilter(await categoryCatalog(db), query.categories, 'categories');
      const binding = cursorBinding('places-bounds', query);
      const rows = await findPlacesInBounds(db, {
        ...query,
        limit: limit + 1,
        after: decodeCursor(cursor, binding, boundsKeysetSchema),
      });
      response.json(
        pageOf(
          rows,
          limit,
          binding,
          (place) => place.id,
          (place) => place,
        ),
      );
    }),
  );

  /**
   * `GET /places?ids=a,b,c` — up to fifty places by id, in one round trip.
   *
   * Every id lands in exactly one of three lists, in the order it was asked
   * for, and each says what `GET /places/{placeId}` would have answered for
   * it: `items` the published places in the single read's full shape (names,
   * descriptions, hours exceptions, and claims by the same rule), `gone` the
   * ones it answers `410` for — removed, or merged with `mergedInto` naming the
   * survivor — and `missing` the ones it answers `404` for. A consumer holding
   * a list of persisted ids refreshes them all without fifty requests, and
   * learns which to replace and which to drop.
   *
   * Not a page: the request bounds it, so there is no cursor.
   */
  router.get(
    '/places',
    optionalAuth,
    route(async (request, response) => {
      const { ids, locale } = parseQuery(placeBatchQuerySchema, request.query);
      const db = getDb();
      const items = await findPlacesByIds(db, ids, callerId(request), locale);
      const published = new Set(items.map((place) => place.id));
      const lifecycles = await findPlaceLifecycles(
        db,
        ids.filter((id) => !published.has(id)),
      );

      const batch: PlaceBatch = { items, gone: [], missing: [] };
      for (const id of ids) {
        if (published.has(id)) continue;
        const lifecycle = lifecycles.get(id);
        if (lifecycle === undefined) {
          batch.missing.push(id);
          continue;
        }
        // The single read's `410` and its pointer, decided by the same rule.
        const mergedInto = mergedIntoOf(lifecycle);
        batch.gone.push(mergedInto === undefined ? { id } : { id, mergedInto });
      }
      response.json(batch);
    }),
  );

  /**
   * `GET /places/{placeId}` — one place by its stable GoWay id.
   *
   * A place moderation REMOVED answers `410 gone`, not 404: a deep link
   * somebody already holds has to resolve to something they can act on, and
   * "this place was withdrawn" is a different thing to tell a consumer holding
   * a persisted id than "this id was never real". A MERGED place answers
   * `410 gone` with `details.mergedInto`, the id to use instead.
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
      if (!place) throw unpublishedPlace(await findPlaceLifecycle(db, placeId));
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
        author: revisionAuthor(requiredOxyCaller(request), 'api'),
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
   * map. A place somebody has an APPROVED claim on is not — only a caller who
   * acts for one of those claims may edit it, and an outsider's edit is 403
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
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const standing = await standingOn(approvedClaims, caller, accountRoles);
      if (standing.claimed && standing.callerRoles.length === 0) {
        throw new ApiError(
          'forbidden',
          'This place is claimed; only an approved claimant may edit it.',
        );
      }

      const actor: PlaceActor = {
        author: revisionAuthor(caller, 'api'),
        assertedVerification: assertableVerification(standing),
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
      // The path named the key, so the value is held to that key's registry
      // entry — and comes back normalized by it (a handle as its URL).
      const value = parseValue(capabilityValueSchemaFor(key), input.value, 'value');
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const standing = await standingOn(approvedClaims, caller, accountRoles);

      const actor: PlaceActor = {
        author: revisionAuthor(caller, 'api'),
        assertedVerification: assertableVerification(standing),
      };
      const place = await assertPlaceCapability(
        db,
        placeId,
        { ...splitCapabilityKey(key), value, ...(input.source ? { source: input.source } : {}) },
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
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);

      const verification = withdrawableVerification(
        await standingOn(approvedClaims, caller, accountRoles),
      );
      if (verification === null) {
        throw new ApiError(
          'forbidden',
          'Only an approved claimant may withdraw an assertion. Report that a place ' +
            'no longer has a capability by asserting the value false instead.',
        );
      }

      const withdrawn = await withdrawPlaceCapability(
        db,
        placeId,
        splitCapabilityKey(key),
        verification,
        revisionAuthor(caller, 'api'),
      );
      if (!withdrawn) {
        throw new ApiError(
          'not_found',
          'This place carries no business-asserted claim of that capability to withdraw.',
        );
      }
      response.status(204).end();
    }),
  );

  // ── History and reports ───────────────────────────────────────────────────

  /**
   * `GET /places/{placeId}/revisions` — what changed on a place and when,
   * newest first, keyset-paged by time.
   *
   * Public and identical for every caller, so it reads no session at all. It
   * never says WHO: no account, no person, and none of the moderation-only
   * actions (claims, reports, duplicate reviews) — see `@goway/contracts`
   * `revision.ts` for the rule and `docs/BUSINESS_OWNERSHIP.md` for why.
   */
  router.get(
    '/places/:placeId/revisions',
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const query = parseQuery(revisionListQuerySchema, request.query);
      const binding = cursorBinding('place-revisions', { placeId });
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const revisions = await listPlaceRevisions(
        db,
        placeId,
        'public',
        timeWindowOf(query, binding),
      );
      response.json(timePageOf(revisions, query.limit, binding));
    }),
  );

  /**
   * `POST /places/{placeId}/reports` — tell moderation something about a place
   * is wrong.
   *
   * Any signed-in account, behind the report rate limit. The report is keyed on
   * the PERSON, so switching into an organization does not buy a second open
   * report. A repeat while the first is open answers it with `200`, so a retry
   * never files twice. Nothing about the place changes until an operator
   * decides.
   */
  router.post(
    '/places/:placeId/reports',
    reportRateLimit,
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const input = parseBody(placeReportInputSchema, request.body ?? {});
      const caller = requiredOxyCaller(request);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const { report, created } = await createPlaceReport(
        db,
        placeId,
        caller.operatedByOxyUserId ?? caller.oxyAccountId,
        input,
      );
      response.status(created ? 201 : 200).json(report);
    }),
  );

  // ── Hours exceptions ──────────────────────────────────────────────────────
  //
  // A closure or special hours is a CLAIM, so these routes follow the
  // capability routes' authority rules exactly: any signed-in account may
  // report one (`community_reported`), a report made by whoever may act for an
  // approved claimant is `business_asserted`, the tier is never the body's,
  // and a claimed place is NOT closed to outside reports — the tier is in the
  // unique key, so a passer-by's report lands beside the business's own and
  // cannot overwrite it. Every write records a revision in its transaction.

  /**
   * `GET /places/{placeId}/hours-exceptions` — every exception, past ones
   * included, earliest first, keyset-paged by start date. Public, as the place
   * is; a single-place read already embeds the ones that have not ended.
   */
  router.get(
    '/places/:placeId/hours-exceptions',
    optionalAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const query = parseQuery(hoursExceptionListQuerySchema, request.query);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const binding = cursorBinding('place-hours-exceptions', { placeId });
      const rows = await listHoursExceptions(db, placeId, {
        limit: query.limit + 1,
        after: decodeCursor(query.cursor, binding, hoursExceptionKeysetSchema),
      });
      response.json(
        pageOf(
          rows,
          query.limit,
          binding,
          (row) => [row.startsOn, row.id],
          (row) => row,
        ),
      );
    }),
  );

  /**
   * `POST /places/{placeId}/hours-exceptions` — report a closure or special
   * hours. 409 when the caller's tier already holds an exception for exactly
   * those dates: they rewrite that one instead.
   */
  router.post(
    '/places/:placeId/hours-exceptions',
    requireAuth,
    route(async (request, response) => {
      const placeId = placeIdParam(request);
      const input = parseBody(placeHoursExceptionInputSchema, request.body);
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const standing = await standingOn(approvedClaims, caller, accountRoles);

      const actor: PlaceActor = {
        author: revisionAuthor(caller, 'api'),
        assertedVerification: assertableVerification(standing),
      };
      const exception = await createHoursException(db, placeId, input, actor);
      // The place existed a moment ago and does not now — a concurrent delete.
      if (!exception) throw new ApiError('not_found', 'No place has that id.');
      response
        .status(201)
        .location(
          `/api/v1/places/${encodeURIComponent(placeId)}/hours-exceptions/${encodeURIComponent(exception.id)}`,
        )
        .json(exception);
    }),
  );

  /**
   * `PUT /places/{placeId}/hours-exceptions/{exceptionId}` — rewrite one
   * exception, whole. Only at the caller's OWN tier: a community reporter
   * corrects the community report, a claimant the business's notice, and
   * neither can rewrite the other's — the same line a capability write draws.
   */
  router.put(
    '/places/:placeId/hours-exceptions/:exceptionId',
    requireAuth,
    route(async (request, response) => {
      const { placeId, exceptionId } = parsePath(hoursExceptionPathSchema, request.params);
      const input = parseBody(placeHoursExceptionInputSchema, request.body);
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const existing = await findHoursException(db, placeId, exceptionId);
      if (!existing) throw new ApiError('not_found', 'This place has no exception with that id.');

      const verification = assertableVerification(
        await standingOn(approvedClaims, caller, accountRoles),
      );
      if (existing.verification !== verification) {
        throw new ApiError(
          'forbidden',
          'An exception can be rewritten only at the tier that wrote it. Report your own instead.',
        );
      }
      const exception = await replaceHoursException(
        db,
        placeId,
        exceptionId,
        input,
        verification,
        revisionAuthor(caller, 'api'),
      );
      if (!exception) throw new ApiError('not_found', 'This place has no exception with that id.');
      response.json(exception);
    }),
  );

  /**
   * `DELETE /places/{placeId}/hours-exceptions/{exceptionId}` — withdraw the
   * business's own exception. `204`. Only whoever may act for an approved
   * claimant, and only at `business_asserted`, for the reason a capability
   * withdrawal is: that tier is attributable, and the community's is a shared
   * row nobody may erase.
   */
  router.delete(
    '/places/:placeId/hours-exceptions/:exceptionId',
    requireAuth,
    route(async (request, response) => {
      const { placeId, exceptionId } = parsePath(hoursExceptionPathSchema, request.params);
      const caller = requiredOxyCaller(request);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);

      const verification = withdrawableVerification(
        await standingOn(approvedClaims, caller, accountRoles),
      );
      if (verification === null) {
        throw new ApiError(
          'forbidden',
          'Only an approved claimant may withdraw an exception. Correct a report by rewriting it instead.',
        );
      }
      const withdrawn = await withdrawHoursException(
        db,
        placeId,
        exceptionId,
        verification,
        revisionAuthor(caller, 'api'),
      );
      if (!withdrawn) {
        throw new ApiError(
          'not_found',
          'This place carries no business-asserted exception with that id.',
        );
      }
      response.status(204).end();
    }),
  );

  // ── Claims ────────────────────────────────────────────────────────────────
  //
  // Filing and reading claims is here; deciding them is moderation's
  // (`routes/moderation.ts`), behind the operator allow-list.

  /**
   * `POST /places/{placeId}/claims` — ask to be recognised as running this place.
   *
   * For the session's own account by default, or for `oxyAccountId` — usually
   * the business's organization — when the caller owns or administers it in
   * Oxy. An editor may run a claimed place but not claim one in the
   * organization's name: filing is a statement about who the business is.
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
      const caller = requiredOxyCaller(request);
      const oxyAccountId = input.oxyAccountId ?? caller.oxyAccountId;
      const db = getDb();

      // 404/410 before 403, and checked before the insert so an unknown place
      // is a 404 rather than the 500 a foreign-key violation would produce.
      assertPublished(await findPlaceLifecycle(db, placeId));
      if (!(await mayFileFor(caller, oxyAccountId, accountRoles))) {
        throw new ApiError(
          'forbidden',
          'Only an owner or admin of that Oxy account may claim a place in its name.',
        );
      }

      const claim = await requestClaim(
        db,
        { placeId, oxyAccountId, role: input.role },
        revisionAuthor(caller, 'api'),
      );
      response.status(201).json(claim);
    }),
  );

  /**
   * `GET /places/{placeId}/claims` — the claims on one place, oldest first,
   * keyset-paged by claim time.
   *
   * Visible to a caller who acts for an account holding a claim on the place —
   * its own, and the ones it is competing with — and to nobody else. A pending
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
      const caller = requiredOxyCaller(request);
      const binding = cursorBinding('place-claims', { placeId, oxyAccountId: caller.oxyAccountId });
      const { lifecycle, claimantAccountIds, claims } = await listPlaceClaims(
        getDb(),
        placeId,
        timeWindowOf(query, binding),
      );
      // 404 first: answering 403 for an id that does not exist would confirm to
      // a stranger that an id they guessed is real.
      assertPublished(lifecycle);
      if (!(await mayActForAny(caller, claimantAccountIds, accountRoles))) {
        throw new ApiError(
          'forbidden',
          'Claim details are visible only to an account that holds a claim on this place.',
        );
      }
      response.json(timePageOf(claims, query.limit, binding));
    }),
  );

  /**
   * `GET /claims` — every claim one account holds, in every state, oldest
   * first, keyset-paged by claim time; with `placeId`, only its claims on that
   * place — how a dashboard asks "where does my claim on this place stand"
   * without walking every location the business has.
   *
   * The session's own account by default, or `oxyAccountId` — an organization
   * the caller acts for in Oxy — which is how a business's dashboard lists its
   * locations without switching into the organization first. Any other account
   * is 403: a claim list is a business relationship GoWay shows to the parties
   * involved and to nobody else.
   */
  router.get(
    '/claims',
    requireAuth,
    route(async (request, response) => {
      const {
        oxyAccountId: requested,
        placeId,
        ...query
      } = parseQuery(accountClaimListQuerySchema, request.query);
      const caller = requiredOxyCaller(request);
      const oxyAccountId = requested ?? caller.oxyAccountId;
      if (!(await mayActFor(caller, oxyAccountId, accountRoles))) {
        throw new ApiError(
          'forbidden',
          'You may list the claims of your own account or of one you act for.',
        );
      }
      // Both accounts are in the binding, so a cursor minted for one session is
      // refused under another rather than resuming somebody else's list.
      const binding = cursorBinding('account-claims', {
        oxyAccountId,
        placeId,
        session: caller.oxyAccountId,
      });
      const claims = await findAccountClaims(
        getDb(),
        oxyAccountId,
        placeId,
        timeWindowOf(query, binding),
      );
      response.json(timePageOf(claims, query.limit, binding));
    }),
  );

  return router;
}

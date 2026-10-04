/**
 * The GoWay moderation surface — `/moderation/*`.
 *
 *     GET  /moderation/claims                            the claim review queue
 *     POST /moderation/claims/{claimId}/decision         approve, reject or revoke
 *     PATCH /moderation/places/{placeId}                  verification state, remove or restore
 *     PUT|DELETE /moderation/places/{placeId}/capabilities/{key}   the oxy_verified tier
 *     GET  /moderation/places/{placeId}/revisions        full history, with who
 *     GET  /moderation/duplicates                        the duplicate review queue
 *     POST /moderation/duplicates/{candidateId}/resolution   merge or keep both
 *     GET  /moderation/reports                           the report queue
 *     POST /moderation/reports/{reportId}/resolution     close a report
 *
 * ## Who may call it
 *
 * Every route is behind `requireAuth` and then the operator gate: an Oxy
 * session whose PERSON is on `MODERATION_OPERATOR_OXY_USER_IDS` — the same
 * Oxy-id allow-list mechanism the Street 3D contribution pilot uses. Anybody
 * else is `403`, which says nothing about whether the claim, place or report
 * they named exists. Nothing here is in the public CORS lane.
 *
 * ## What it guarantees
 *
 * Every decision is one transaction with the revision that records it
 * (`db/places/moderationRepository`), attributed to the session's account and
 * to the operator. The operator's decision is the only way a claim is approved,
 * a capability reaches `oxy_verified`, or two places become one.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import {
  capabilityPathSchema,
  claimDecisionInputSchema,
  claimPathSchema,
  duplicateListQuerySchema,
  duplicatePathSchema,
  duplicateResolutionInputSchema,
  moderationCapabilityInputSchema,
  moderationClaimListQuerySchema,
  moderationPlaceUpdateInputSchema,
  moderationReportListQuerySchema,
  placePathSchema,
  placeReportResolutionInputSchema,
  reportPathSchema,
  revisionListQuerySchema,
  splitCapabilityKey,
} from '@goway/contracts';
import {
  decideClaim,
  listDuplicateCandidates,
  listPlaceReports,
  moderatePlace,
  resolveDuplicateCandidate,
  resolvePlaceReport,
  verifyPlaceCapability,
  withdrawVerifiedCapability,
} from '../db/places/moderationRepository';
import { findClaimsInState, findPlaceById, findPlaceLifecycle } from '../db/places/placesRepository';
import { listPlaceRevisions, revisionAuthor } from '../db/places/revisions';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { cursorBinding, timePageOf, timeWindowOf } from '../http/cursor';
import { parseBody, parsePath, parseQuery } from '../http/validation';
import { requiredOxyCaller } from '../oxy/caller';
import { unpublishedPlace } from '../places/placeLifecycle';

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** The author of an operator's decision. */
function operator(request: Request) {
  return revisionAuthor(requiredOxyCaller(request), 'moderation');
}

export interface ModerationRouterDependencies {
  /** Fail-closed: refuses the request unless it carries a valid Oxy session. */
  requireAuth: RequestHandler;
  /** Refuses everybody whose person is not on the operator allow-list. */
  requireOperator: RequestHandler;
}

export function createModerationRouter(dependencies: ModerationRouterDependencies): Router {
  const router: Router = Router();
  // On every route rather than as a `router.use`, so each route carries its own
  // guards — which is what the CORS suite reads to prove no public-lane entry
  // admits an authenticated route.
  const operatorOnly = [dependencies.requireAuth, dependencies.requireOperator];

  // ── Claims ────────────────────────────────────────────────────────────────

  router.get(
    '/moderation/claims',
    ...operatorOnly,
    route(async (request, response) => {
      const { state, ...query } = parseQuery(moderationClaimListQuerySchema, request.query);
      const binding = cursorBinding('moderation-claims', { state });
      const claims = await findClaimsInState(getDb(), state, timeWindowOf(query, binding));
      response.json(timePageOf(claims, query.limit, binding));
    }),
  );

  /** Approve or reject a pending claim, or revoke an approved one. Anything else is `409`. */
  router.post(
    '/moderation/claims/:claimId/decision',
    ...operatorOnly,
    route(async (request, response) => {
      const { claimId } = parsePath(claimPathSchema, request.params);
      const { state } = parseBody(claimDecisionInputSchema, request.body);
      const claim = await decideClaim(getDb(), claimId, state, operator(request));
      if (!claim) throw new ApiError('not_found', 'No claim has that id.');
      response.json(claim);
    }),
  );

  // ── Places ────────────────────────────────────────────────────────────────

  /** Set the verification state, or remove or restore the place. `204`: a removed place has no published body. */
  router.patch(
    '/moderation/places/:placeId',
    ...operatorOnly,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const input = parseBody(moderationPlaceUpdateInputSchema, request.body);
      const moderated = await moderatePlace(getDb(), placeId, input, operator(request));
      if (!moderated) throw new ApiError('not_found', 'No place has that id.');
      response.status(204).end();
    }),
  );

  /** Assert one capability at `oxy_verified`, beside every other tier's assertion of it. */
  router.put(
    '/moderation/places/:placeId/capabilities/:key',
    ...operatorOnly,
    route(async (request, response) => {
      const { placeId, key } = parsePath(capabilityPathSchema, request.params);
      const { value } = parseBody(moderationCapabilityInputSchema, request.body);
      const db = getDb();
      if (!(await verifyPlaceCapability(db, placeId, splitCapabilityKey(key), value, operator(request)))) {
        throw new ApiError('not_found', 'No place has that id.');
      }
      const place = await findPlaceById(db, placeId);
      if (!place) throw unpublishedPlace(await findPlaceLifecycle(db, placeId));
      response.json(place);
    }),
  );

  router.delete(
    '/moderation/places/:placeId/capabilities/:key',
    ...operatorOnly,
    route(async (request, response) => {
      const { placeId, key } = parsePath(capabilityPathSchema, request.params);
      const withdrawn = await withdrawVerifiedCapability(getDb(), placeId, splitCapabilityKey(key), operator(request));
      if (withdrawn === null) throw new ApiError('not_found', 'No place has that id.');
      if (!withdrawn) throw new ApiError('not_found', 'This place carries no oxy_verified assertion of that capability.');
      response.status(204).end();
    }),
  );

  /**
   * Every revision of a place, newest first, with the account and person behind
   * each — removed and merged places included, because reading back what
   * happened to them is what this is for.
   */
  router.get(
    '/moderation/places/:placeId/revisions',
    ...operatorOnly,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const query = parseQuery(revisionListQuerySchema, request.query);
      const binding = cursorBinding('moderation-revisions', { placeId });
      const db = getDb();
      if ((await findPlaceLifecycle(db, placeId)) === null) throw new ApiError('not_found', 'No place has that id.');
      const revisions = await listPlaceRevisions(db, placeId, 'moderation', timeWindowOf(query, binding));
      response.json(timePageOf(revisions, query.limit, binding));
    }),
  );

  // ── Duplicates ────────────────────────────────────────────────────────────

  router.get(
    '/moderation/duplicates',
    ...operatorOnly,
    route(async (request, response) => {
      const { state, ...query } = parseQuery(duplicateListQuerySchema, request.query);
      const binding = cursorBinding('moderation-duplicates', { state });
      const candidates = await listDuplicateCandidates(getDb(), state, timeWindowOf(query, binding));
      response.json(timePageOf(candidates, query.limit, binding));
    }),
  );

  /** Merge the pair into the survivor, or keep both. A decided candidate is `409`. */
  router.post(
    '/moderation/duplicates/:candidateId/resolution',
    ...operatorOnly,
    route(async (request, response) => {
      const { candidateId } = parsePath(duplicatePathSchema, request.params);
      const input = parseBody(duplicateResolutionInputSchema, request.body);
      const candidate = await resolveDuplicateCandidate(getDb(), candidateId, input, operator(request));
      if (!candidate) throw new ApiError('not_found', 'No duplicate candidate has that id.');
      response.json(candidate);
    }),
  );

  // ── Reports ───────────────────────────────────────────────────────────────

  router.get(
    '/moderation/reports',
    ...operatorOnly,
    route(async (request, response) => {
      const { state, ...query } = parseQuery(moderationReportListQuerySchema, request.query);
      const binding = cursorBinding('moderation-reports', { state });
      const reports = await listPlaceReports(getDb(), state, timeWindowOf(query, binding));
      response.json(timePageOf(reports, query.limit, binding));
    }),
  );

  /** Close an open report. A resolved one is `409`. */
  router.post(
    '/moderation/reports/:reportId/resolution',
    ...operatorOnly,
    route(async (request, response) => {
      const { reportId } = parsePath(reportPathSchema, request.params);
      const { resolution } = parseBody(placeReportResolutionInputSchema, request.body);
      const report = await resolvePlaceReport(getDb(), reportId, resolution, operator(request));
      if (!report) throw new ApiError('not_found', 'No report has that id.');
      response.json(report);
    }),
  );

  return router;
}

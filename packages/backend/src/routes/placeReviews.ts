/**
 * Place reviews — `/places/{placeId}/reviews`.
 *
 *     GET    /places/{placeId}/reviews                         published reviews (public)
 *     GET    /places/{placeId}/reviews/mine                    your own, with its status
 *     PUT    /places/{placeId}/reviews/mine                    write or rewrite yours
 *     DELETE /places/{placeId}/reviews/mine                    withdraw yours
 *     PUT    /places/{placeId}/reviews/{reviewId}/reply        the business answers
 *     DELETE /places/{placeId}/reviews/{reviewId}/reply        the business withdraws its answer
 *     POST   /places/{placeId}/reviews/{reviewId}/reports      flag one for moderation
 *
 * ## A review is a person's, and never the business's own
 *
 * The author is the PERSON behind the session (Oxy's actor chain). A session
 * switched into an organization is refused: an organization does not have an
 * experience of a place. Anybody AFFILIATED with an approved claimant is
 * refused too — the claimant account itself, or anybody Oxy reports in ANY
 * role in it (`places/claimAuthority#affiliatedWithAny`) — so a business cannot
 * review itself through its owner, its staff, or a switched session. Oxy is
 * asked only when the place is claimed, and an Oxy failure is a `503`.
 *
 * The business answers with a reply instead, written by whoever acts for the
 * claim and published as the business's — never naming the person.
 *
 * Writes sit behind a contribution rate limit on top of the API-wide one.
 */

import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { z } from 'zod';
import {
  contentReportInputSchema,
  placePathSchema,
  placeReviewInputSchema,
  placeReviewReplyInputSchema,
  reviewListQuerySchema,
  reviewPathSchema,
} from '@goway/contracts';
import { createPlaceReport } from '../db/places/moderationRepository';
import { findPlaceLifecycle, getPlaceAuthorization } from '../db/places/placesRepository';
import {
  findOwnReview,
  findPublishedReview,
  listPlaceReviews,
  putReview,
  replyToReview,
  withdrawReply,
  withdrawReview,
  type ReviewKeyset,
} from '../db/places/reviewsRepository';
import { revisionAuthor } from '../db/places/revisions';
import { getDb } from '../db/postgres';
import { ApiError } from '../http/apiError';
import { cursorBinding, decodeCursor, pageOf, timeKeysetSchema, timestampTextSchema } from '../http/cursor';
import { parseBody, parsePath, parseQuery } from '../http/validation';
import type { AccountRoleResolver, OxyCaller } from '../oxy/accountRoles';
import { requiredOxyCaller } from '../oxy/caller';
import { withdrawableVerification } from '../places/capabilityAuthority';
import { affiliatedWithAny, standingOn } from '../places/claimAuthority';
import { assertPublished } from '../places/placeLifecycle';

function route(handler: (request: Request, response: Response) => Promise<void>): RequestHandler {
  return (request, response, next: NextFunction) => {
    handler(request, response).catch(next);
  };
}

/** A newest-first page resumes at `(createdAt, id)`; a by-rating page at `(rating, createdAt, id)`. */
const reviewKeysetSchema: z.ZodType<ReviewKeyset> = z.union([
  timeKeysetSchema,
  z.tuple([z.number().int().min(1).max(5), timestampTextSchema, z.string().min(1).max(128)]),
]);

/**
 * The person a review is BY. A session switched into an organization is
 * refused; one whose actor Oxy did not report is its own account, which is the
 * person whenever nobody switched — the rule the operator gate applies.
 */
function reviewerOf(caller: OxyCaller): string {
  if (caller.operatedByOxyUserId !== null && caller.operatedByOxyUserId !== caller.oxyAccountId) {
    throw new ApiError('forbidden', 'Review as yourself: an organization does not review places.');
  }
  return caller.oxyAccountId;
}

export interface PlaceReviewsRouterDependencies {
  requireAuth: RequestHandler;
  accountRoles: AccountRoleResolver;
  /** Applied to reports, in addition to the API-wide limit. */
  reportRateLimit: RequestHandler;
  /** Applied to review and reply writes, in addition to the API-wide limit. */
  contributionRateLimit: RequestHandler;
}

export function createPlaceReviewsRouter(dependencies: PlaceReviewsRouterDependencies): Router {
  const { requireAuth, accountRoles, reportRateLimit, contributionRateLimit } = dependencies;
  const router: Router = Router();

  /**
   * `GET /places/{placeId}/reviews` — the published reviews, newest, highest
   * or lowest first. Public and identical for every caller, so it reads no
   * session at all.
   */
  router.get(
    '/places/:placeId/reviews',
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const { sort, limit, cursor } = parseQuery(reviewListQuerySchema, request.query);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const binding = cursorBinding('place-reviews', { placeId, sort });
      const after = decodeCursor(cursor, binding, reviewKeysetSchema);
      if (after !== undefined && after.length !== (sort === 'newest' ? 2 : 3)) {
        throw new ApiError('bad_request', 'The cursor is not one this list issued for these filters.', {
          field: 'cursor',
          issue: 'foreign_cursor',
        });
      }
      const rows = await listPlaceReviews(db, placeId, { sort, limit: limit + 1, after });
      response.json(pageOf(rows, limit, binding, (row) => row.position, (row) => row.review));
    }),
  );

  /** `GET /places/{placeId}/reviews/mine` — your review of this place, with its status. 404 when you have none. */
  router.get(
    '/places/:placeId/reviews/mine',
    requireAuth,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const caller = requiredOxyCaller(request);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      const review = await findOwnReview(db, placeId, reviewerOf(caller));
      if (!review) throw new ApiError('not_found', 'You have not reviewed this place.');
      response.json(review);
    }),
  );

  /**
   * `PUT /places/{placeId}/reviews/mine` — write your review, or rewrite it
   * whole. `201` for a new review, `200` for a rewrite. An operator's hide
   * survives a rewrite.
   */
  router.put(
    '/places/:placeId/reviews/mine',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const input = parseBody(placeReviewInputSchema, request.body);
      const caller = requiredOxyCaller(request);
      const reviewer = reviewerOf(caller);
      const db = getDb();

      const { lifecycle, approvedClaims } = await getPlaceAuthorization(db, placeId);
      assertPublished(lifecycle);
      const claimants = approvedClaims.map((claim) => claim.oxyAccountId);
      if (await affiliatedWithAny(caller, claimants, accountRoles)) {
        throw new ApiError('forbidden', 'A business may not review its own place. Reply to its reviews instead.');
      }

      const written = await putReview(db, placeId, reviewer, input, revisionAuthor(caller, 'api'));
      // The place existed a moment ago and does not now — a concurrent delete.
      if (!written) throw new ApiError('not_found', 'No place has that id.');
      response.status(written.created ? 201 : 200).json(written.review);
    }),
  );

  /** `DELETE /places/{placeId}/reviews/mine` — withdraw your review; its words are erased. `204`. */
  router.delete(
    '/places/:placeId/reviews/mine',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId } = parsePath(placePathSchema, request.params);
      const caller = requiredOxyCaller(request);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      if (!(await withdrawReview(db, placeId, reviewerOf(caller), revisionAuthor(caller, 'api')))) {
        throw new ApiError('not_found', 'You have no review of this place to withdraw.');
      }
      response.status(204).end();
    }),
  );

  /** Refuse anybody who may not answer for the business. */
  async function assertBusiness(caller: OxyCaller, placeId: string): Promise<void> {
    const { lifecycle, approvedClaims } = await getPlaceAuthorization(getDb(), placeId);
    assertPublished(lifecycle);
    if (withdrawableVerification(await standingOn(approvedClaims, caller, accountRoles)) === null) {
      throw new ApiError('forbidden', 'Only an approved claimant may answer for the business.');
    }
  }

  /**
   * `PUT /places/{placeId}/reviews/{reviewId}/reply` — the business's reply to
   * a published review, written or rewritten. The account and person are
   * recorded and never published.
   */
  router.put(
    '/places/:placeId/reviews/:reviewId/reply',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId, reviewId } = parsePath(reviewPathSchema, request.params);
      const { body } = parseBody(placeReviewReplyInputSchema, request.body);
      const caller = requiredOxyCaller(request);
      await assertBusiness(caller, placeId);
      const review = await replyToReview(getDb(), placeId, reviewId, body, revisionAuthor(caller, 'api'));
      if (!review) throw new ApiError('not_found', 'This place has no published review with that id.');
      response.json(review);
    }),
  );

  /** `DELETE /places/{placeId}/reviews/{reviewId}/reply` — the business withdraws its reply. `204`. */
  router.delete(
    '/places/:placeId/reviews/:reviewId/reply',
    contributionRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId, reviewId } = parsePath(reviewPathSchema, request.params);
      const caller = requiredOxyCaller(request);
      await assertBusiness(caller, placeId);
      if (!(await withdrawReply(getDb(), placeId, reviewId, revisionAuthor(caller, 'api')))) {
        throw new ApiError('not_found', 'That review carries no reply to withdraw.');
      }
      response.status(204).end();
    }),
  );

  /**
   * `POST /places/{placeId}/reviews/{reviewId}/reports` — flag a published
   * review for moderation, in the place report queue. A repeat while the first
   * is open answers it with `200`.
   */
  router.post(
    '/places/:placeId/reviews/:reviewId/reports',
    reportRateLimit,
    requireAuth,
    route(async (request, response) => {
      const { placeId, reviewId } = parsePath(reviewPathSchema, request.params);
      const input = parseBody(contentReportInputSchema, request.body ?? {});
      const caller = requiredOxyCaller(request);
      const db = getDb();
      assertPublished(await findPlaceLifecycle(db, placeId));
      if (!(await findPublishedReview(db, placeId, reviewId))) {
        throw new ApiError('not_found', 'This place has no published review with that id.');
      }
      const { report, created } = await createPlaceReport(
        db,
        placeId,
        caller.operatedByOxyUserId ?? caller.oxyAccountId,
        input,
        { reviewId },
      );
      response.status(created ? 201 : 200).json(report);
    }),
  );

  return router;
}

/**
 * Place reviews — what people who went there say about a place.
 *
 * ## A review is a person's, and only a person's
 *
 * One review per person per place, written by the human behind the session:
 * a session switched into an organization may not review, and nobody who may
 * act for — or holds any role in — an organization with an approved claim on
 * the place may review it. The business answers with a REPLY, one per review,
 * shown as the business's and never as a person's.
 *
 * A published review carries its author's Oxy user id: a review is a public,
 * signed statement, and a client resolves the id to the author's public Oxy
 * profile. It carries nothing else about them — never a location, never the
 * account a reply was written as.
 *
 * ## The rating is derived
 *
 * `Place.rating` is recomputed from the published reviews inside every write
 * that changes them — a new review, an edit, a withdrawal, a moderation
 * decision, a merge — never incremented, so a hidden review leaves the average
 * by construction.
 *
 * ## History
 *
 * Every review write records a place revision, classified `moderation`: the
 * public history describes the place, and a review is the reviewer's. A
 * revision never holds the text of a review or a reply, so withdrawing one
 * withdraws its words.
 */

import { z } from 'zod';
import { canonicalLanguageTagSchema, languageTagSchema } from './language';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { placeIdSchema } from './place';
import { instantSchema } from './time';

/** The lowest and highest rating. */
export const MIN_REVIEW_RATING = 1;
export const MAX_REVIEW_RATING = 5;

export const MAX_REVIEW_TITLE_LENGTH = 120;
export const MAX_REVIEW_BODY_LENGTH = 4000;
export const MAX_REVIEW_REPLY_LENGTH = 2000;

/**
 * Where a review stands.
 *
 * - `published` — public, and counted in the place's rating.
 * - `hidden` — withdrawn by a GoWay operator, or set aside when a merge
 *   brought two reviews by one person together; reversible by an operator.
 * - `removed` — withdrawn by its author. Its title, body and reply are erased.
 */
export const PLACE_REVIEW_STATUSES = ['published', 'hidden', 'removed'] as const;
export type PlaceReviewStatus = (typeof PLACE_REVIEW_STATUSES)[number];

/** The statuses an operator may move a review between. */
export const MODERATED_PLACE_REVIEW_STATUSES = [
  'published',
  'hidden',
] as const satisfies readonly PlaceReviewStatus[];
export type ModeratedPlaceReviewStatus = (typeof MODERATED_PLACE_REVIEW_STATUSES)[number];

/** The business's answer to a review. Never names the person who wrote it. */
export const placeReviewReplySchema = z.object({
  body: z.string(),
  repliedAt: instantSchema,
  /** When the reply was last rewritten. Absent if it never was. */
  editedAt: instantSchema.optional(),
});
export type PlaceReviewReply = z.infer<typeof placeReviewReplySchema>;

/** A review as the public list publishes it. */
export const placeReviewSchema = z.object({
  id: z.string().min(1),
  placeId: placeIdSchema,
  rating: z.number().int().min(MIN_REVIEW_RATING).max(MAX_REVIEW_RATING),
  title: z.string().optional(),
  body: z.string().optional(),
  /** The language it is written in, when the author said. Canonical BCP 47. */
  locale: canonicalLanguageTagSchema.optional(),
  /** The author's Oxy user id. Resolve it to their public Oxy profile. */
  authorOxyUserId: z.string().min(1),
  createdAt: instantSchema,
  /** When the author last rewrote it. Absent if they never did. */
  editedAt: instantSchema.optional(),
  reply: placeReviewReplySchema.optional(),
});
export type PlaceReview = z.infer<typeof placeReviewSchema>;

export const placeReviewPageSchema = pageSchema(placeReviewSchema);
export type PlaceReviewPage = z.infer<typeof placeReviewPageSchema>;

/**
 * A review with where it stands: what its author reads back
 * (`GET /places/{placeId}/reviews/mine`) and what an operator reads.
 */
export const placeReviewWithStatusSchema = placeReviewSchema.extend({
  status: z.enum(PLACE_REVIEW_STATUSES),
});
export type PlaceReviewWithStatus = z.infer<typeof placeReviewWithStatusSchema>;

export const placeReviewWithStatusPageSchema = pageSchema(placeReviewWithStatusSchema);
export type PlaceReviewWithStatusPage = z.infer<typeof placeReviewWithStatusPageSchema>;

/**
 * The body of `PUT /places/{placeId}/reviews/mine`: the caller's whole review.
 *
 * A PUT replaces: a title or body left out is cleared. The author is the
 * session's person and never a field.
 */
export const placeReviewInputSchema = z
  .object({
    rating: z.number().int().min(MIN_REVIEW_RATING).max(MAX_REVIEW_RATING),
    title: z.string().trim().min(1).max(MAX_REVIEW_TITLE_LENGTH).optional(),
    body: z.string().trim().min(1).max(MAX_REVIEW_BODY_LENGTH).optional(),
    /** The language it is written in. Normalized (`ES` → `es`). */
    locale: languageTagSchema.optional(),
  })
  .strict();
export type PlaceReviewInput = z.input<typeof placeReviewInputSchema>;

/** The body of `PUT /places/{placeId}/reviews/{reviewId}/reply`. */
export const placeReviewReplyInputSchema = z
  .object({ body: z.string().trim().min(1).max(MAX_REVIEW_REPLY_LENGTH) })
  .strict();
export type PlaceReviewReplyInput = z.input<typeof placeReviewReplyInputSchema>;

/** The body of `PATCH /moderation/places/{placeId}/reviews/{reviewId}`. */
export const moderationReviewInputSchema = z
  .object({ status: z.enum(MODERATED_PLACE_REVIEW_STATUSES) })
  .strict();
export type ModerationReviewInput = z.input<typeof moderationReviewInputSchema>;

/**
 * How a review list is ordered.
 *
 * - `newest` — most recently written first.
 * - `highest` / `lowest` — by rating, newest first within a rating.
 */
export const REVIEW_SORTS = ['newest', 'highest', 'lowest'] as const;
export type ReviewSort = (typeof REVIEW_SORTS)[number];

export const MAX_REVIEW_LIST_LIMIT = 50;
export const DEFAULT_REVIEW_LIST_LIMIT = 20;

/** `GET /places/{placeId}/reviews` — the published reviews, keyset-paged in the chosen order. */
export const reviewListQuerySchema = z
  .object({
    sort: z.enum(REVIEW_SORTS).default('newest'),
    limit: limitSchema(MAX_REVIEW_LIST_LIMIT, DEFAULT_REVIEW_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type ReviewListQuery = z.input<typeof reviewListQuerySchema>;

/** `GET /moderation/places/{placeId}/reviews` — every review in one status, or in every status, newest first. */
export const moderationReviewListQuerySchema = z
  .object({
    status: z.enum(PLACE_REVIEW_STATUSES).optional(),
    limit: limitSchema(MAX_REVIEW_LIST_LIMIT, DEFAULT_REVIEW_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type ModerationReviewListQuery = z.input<typeof moderationReviewListQuerySchema>;

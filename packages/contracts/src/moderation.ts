/**
 * Place reports and moderation — what anybody may flag, and what a GoWay
 * operator may decide.
 *
 * Reporting is open to every signed-in account. Everything else in this module
 * is the operator surface under `/moderation`, refused with `403` to anybody
 * outside GoWay's operator allow-list. Each operator decision writes a place
 * revision in the same transaction, so a decision is never untraceable.
 *
 * ## Duplicate review is published HERE, and only here
 *
 * Why two places were flagged as one is matching machinery, and the public
 * place contract never names it. Moderation has to: an operator weighing a
 * candidate needs to know which rule fired. So the reasons and states below are
 * part of the operator contract and of nothing a map client reads.
 */

import { z } from 'zod';
import {
  capabilityValueInputSchema,
  capabilityValueSchemaFor,
  type CapabilityKey,
} from './capability-registry';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import {
  MODERATED_PLACE_STATUSES,
  PLACE_CLAIM_STATES,
  PLACE_VERIFICATION_STATES,
  placeIdSchema,
  type PlaceClaimState,
} from './place';
import { instantSchema } from './time';

// ── Reports ─────────────────────────────────────────────────────────────────

/** Why somebody reported a place. Closed: a reason outside it is `validation_failed`. */
export const PLACE_REPORT_REASONS = [
  'does_not_exist',
  'permanently_closed',
  'wrong_location',
  'wrong_details',
  'duplicate',
  'spam',
  'offensive',
  'privacy',
  'not_this_place',
  'conflict_of_interest',
] as const;
export type PlaceReportReason = (typeof PLACE_REPORT_REASONS)[number];

/**
 * Why somebody reported one gallery item or one review: the reasons that are
 * about CONTENT rather than about whether the place is real. `not_this_place`
 * is a photo or review of somewhere else; `conflict_of_interest` is a review by
 * the business or a competitor.
 */
export const CONTENT_REPORT_REASONS = [
  'spam',
  'offensive',
  'privacy',
  'not_this_place',
  'conflict_of_interest',
] as const satisfies readonly PlaceReportReason[];
export type ContentReportReason = (typeof CONTENT_REPORT_REASONS)[number];

/**
 * How an operator closed a report.
 *
 * `actioned` means the report was right and something was done about it —
 * through the other moderation routes, each of which records its own revision.
 * `dismissed` means it was wrong or not actionable.
 */
export const PLACE_REPORT_RESOLUTIONS = ['actioned', 'dismissed'] as const;
export type PlaceReportResolution = (typeof PLACE_REPORT_RESOLUTIONS)[number];

/** The body of `POST /places/{placeId}/reports`. */
export const placeReportInputSchema = z
  .object({
    reason: z.enum(PLACE_REPORT_REASONS),
    /** Optional free text, at most 500 characters. Read by operators; never published. */
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type PlaceReportInput = z.input<typeof placeReportInputSchema>;

/**
 * The body of `POST /places/{placeId}/media/{mediaId}/reports` and
 * `POST /places/{placeId}/reviews/{reviewId}/reports`: a report about one item
 * of content on a place, filed in the same queue as reports about the place.
 */
export const contentReportInputSchema = z
  .object({
    reason: z.enum(CONTENT_REPORT_REASONS),
    /** Optional free text, at most 500 characters. Read by operators; never published. */
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type ContentReportInput = z.input<typeof contentReportInputSchema>;

/**
 * A report as its reporter gets it back: no note, no reporter. `mediaId` or
 * `reviewId` names the item it is about; neither means the place itself.
 */
export const placeReportSchema = z.object({
  id: z.string().min(1),
  placeId: placeIdSchema,
  reason: z.enum(PLACE_REPORT_REASONS),
  mediaId: z.string().min(1).optional(),
  reviewId: z.string().min(1).optional(),
  createdAt: instantSchema,
});
export type PlaceReport = z.infer<typeof placeReportSchema>;

/**
 * A report as an operator reads it.
 *
 * The note is here because acting on a report means reading it. The reporter is
 * NOT: an operator decides on what was said about a place, and who said it is
 * the one thing that could turn a moderation queue into a list of people to
 * contact.
 */
export const moderationPlaceReportSchema = placeReportSchema.extend({
  note: z.string().optional(),
  /** Absent while the report is open. */
  resolution: z.enum(PLACE_REPORT_RESOLUTIONS).optional(),
  resolvedAt: instantSchema.optional(),
});
export type ModerationPlaceReport = z.infer<typeof moderationPlaceReportSchema>;

export const moderationPlaceReportPageSchema = pageSchema(moderationPlaceReportSchema);
export type ModerationPlaceReportPage = z.infer<typeof moderationPlaceReportPageSchema>;

/** The body of `POST /moderation/reports/{reportId}/resolution`. */
export const placeReportResolutionInputSchema = z
  .object({ resolution: z.enum(PLACE_REPORT_RESOLUTIONS) })
  .strict();
export type PlaceReportResolutionInput = z.input<typeof placeReportResolutionInputSchema>;

// ── Claims ──────────────────────────────────────────────────────────────────

/**
 * The states an operator may move a claim to, and from where.
 *
 * `approved` and `rejected` decide a `pending` claim; `revoked` withdraws an
 * `approved` one. Every other transition is a `conflict`: a rejected claim is
 * re-requested, not re-decided, so its history stays legible.
 */
export const CLAIM_DECISION_STATES = ['approved', 'rejected', 'revoked'] as const satisfies readonly PlaceClaimState[];
export type ClaimDecisionState = (typeof CLAIM_DECISION_STATES)[number];

/** The state a claim must be in for each decision. Total, so a new decision cannot skip its precondition. */
export const CLAIM_DECISION_FROM: Readonly<Record<ClaimDecisionState, PlaceClaimState>> = {
  approved: 'pending',
  rejected: 'pending',
  revoked: 'approved',
};

/** The body of `POST /moderation/claims/{claimId}/decision`. */
export const claimDecisionInputSchema = z.object({ state: z.enum(CLAIM_DECISION_STATES) }).strict();
export type ClaimDecisionInput = z.input<typeof claimDecisionInputSchema>;

// ── Places ──────────────────────────────────────────────────────────────────

/**
 * The body of `PATCH /moderation/places/{placeId}`: what only GoWay may say
 * about a place.
 *
 * `verificationState` is GoWay's statement about the record; `status` can also
 * withdraw a place from the map (`removed`) or restore one. At least one field.
 */
export const moderationPlaceUpdateInputSchema = z
  .object({
    status: z.enum(MODERATED_PLACE_STATUSES).optional(),
    verificationState: z.enum(PLACE_VERIFICATION_STATES).optional(),
  })
  .strict()
  .refine((body) => body.status !== undefined || body.verificationState !== undefined, {
    message: 'a moderation update must change at least one field',
    path: ['(root)'],
  });
export type ModerationPlaceUpdateInput = z.input<typeof moderationPlaceUpdateInputSchema>;

/**
 * The body of `PUT /moderation/places/{placeId}/capabilities/{key}`.
 *
 * Writes the `oxy_verified` tier — and nothing else can. The value is required
 * for the reason the public assertion's is: the key's registry entry, not this
 * schema, says which kind of value it is. Once the path has named the key the
 * value is held to that entry ({@link moderationCapabilityInputSchemaFor}), so
 * an operator cannot verify a value the registry would refuse from anybody.
 */
export const moderationCapabilityInputSchema = z.object({ value: capabilityValueInputSchema }).strict();
export type ModerationCapabilityInput = z.input<typeof moderationCapabilityInputSchema>;

/** The same body, held to one key's registry entry: what the API applies once the path has named the key. */
export function moderationCapabilityInputSchemaFor(key: CapabilityKey) {
  return moderationCapabilityInputSchema.extend({ value: capabilityValueSchemaFor(key) });
}

// ── Duplicates ──────────────────────────────────────────────────────────────

/**
 * Why two places were flagged as possibly one.
 *
 * - `shared_source_id` — both claimed the same external record. Deterministic,
 *   and still a candidate: which of the two survives is a review.
 * - `proximity_and_name` — identical normalized default names within a few
 *   tens of metres. Name alone is never a reason.
 * - `proximity_and_translated_name` — the same co-signal across every name
 *   each place holds, where their default names differ.
 * - `manual_report` — somebody said so.
 */
export const DUPLICATE_CANDIDATE_REASONS = [
  'shared_source_id',
  'proximity_and_name',
  'proximity_and_translated_name',
  'manual_report',
] as const;
export type DuplicateCandidateReason = (typeof DUPLICATE_CANDIDATE_REASONS)[number];

/** `open` until an operator merges the pair (`confirmed`) or keeps both (`rejected`). */
export const DUPLICATE_CANDIDATE_STATES = ['open', 'confirmed', 'rejected'] as const;
export type DuplicateCandidateState = (typeof DUPLICATE_CANDIDATE_STATES)[number];

/** A pair of places that might be one, in canonical order (`placeId < candidatePlaceId`). */
export const duplicateCandidateSchema = z.object({
  id: z.string().min(1),
  placeId: placeIdSchema,
  candidatePlaceId: placeIdSchema,
  reason: z.enum(DUPLICATE_CANDIDATE_REASONS),
  /** Detector confidence in [0, 1], when the detector produced one. */
  score: z.number().min(0).max(1).optional(),
  state: z.enum(DUPLICATE_CANDIDATE_STATES),
  createdAt: instantSchema,
  /** Absent while open. */
  decidedAt: instantSchema.optional(),
});
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;

export const duplicateCandidatePageSchema = pageSchema(duplicateCandidateSchema);
export type DuplicateCandidatePage = z.infer<typeof duplicateCandidatePageSchema>;

/**
 * The body of `POST /moderation/duplicates/{candidateId}/resolution`.
 *
 * `merge` folds one of the pair into the other: `survivorPlaceId` names the one
 * that stays, and must be one of the pair. The other place's sources move to
 * the survivor, its names, capabilities and claims follow wherever the survivor
 * holds no assertion of its own, and its id answers `410 gone` pointing at the
 * survivor from then on. `reject` keeps both.
 */
export const duplicateResolutionInputSchema = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('merge'), survivorPlaceId: placeIdSchema }).strict(),
  z.object({ decision: z.literal('reject') }).strict(),
]);
export type DuplicateResolutionInput = z.input<typeof duplicateResolutionInputSchema>;

// ── Lists ───────────────────────────────────────────────────────────────────

export const MAX_MODERATION_LIST_LIMIT = 100;
export const DEFAULT_MODERATION_LIST_LIMIT = 25;

const moderationListFields = {
  limit: limitSchema(MAX_MODERATION_LIST_LIMIT, DEFAULT_MODERATION_LIST_LIMIT),
  cursor: cursorSchema.optional(),
};

/** `GET /moderation/claims` — oldest first. `state` defaults to `pending`: the review queue. */
export const moderationClaimListQuerySchema = z
  .object({ state: z.enum(PLACE_CLAIM_STATES).default('pending'), ...moderationListFields })
  .strict();
export type ModerationClaimListQuery = z.input<typeof moderationClaimListQuerySchema>;

/** `GET /moderation/duplicates` — oldest first. `state` defaults to `open`. */
export const duplicateListQuerySchema = z
  .object({ state: z.enum(DUPLICATE_CANDIDATE_STATES).default('open'), ...moderationListFields })
  .strict();
export type DuplicateListQuery = z.input<typeof duplicateListQuerySchema>;

/** Whether a report is waiting for an operator. */
export const PLACE_REPORT_STATES = ['open', 'resolved'] as const;
export type PlaceReportState = (typeof PLACE_REPORT_STATES)[number];

/** `GET /moderation/reports` — oldest first. `state` defaults to `open`. */
export const moderationReportListQuerySchema = z
  .object({ state: z.enum(PLACE_REPORT_STATES).default('open'), ...moderationListFields })
  .strict();
export type ModerationReportListQuery = z.input<typeof moderationReportListQuerySchema>;

/**
 * The route registry: every operation of the GoWay API under `/api/v1`.
 *
 * Each entry names its method, path, auth, path parameters, query schema, body
 * and responses by contract name. `openapi.ts` turns this list into the OpenAPI
 * document, the backend's tests hold every entry to a mounted route, and the
 * SDK's client is checked against the same paths — so an operation exists in
 * exactly one place, and the document cannot describe a route the server does
 * not answer, or miss one it does.
 *
 * Paths use OpenAPI's `{name}` placeholders. Express spells them `:name`;
 * {@link expressPath} converts.
 */

import { z } from 'zod';
import { captureListQuerySchema } from './capture';
import type { ApiErrorCode } from './errors';
import type { ContractSchemaName } from './json-schema';
import { capabilityKeySchema } from './capability-registry';
import { hoursExceptionListQuerySchema } from './hours';
import { mediaListQuerySchema, moderationMediaListQuerySchema } from './media';
import {
  duplicateListQuerySchema,
  moderationClaimListQuerySchema,
  moderationReportListQuerySchema,
} from './moderation';
import {
  accountClaimListQuerySchema,
  claimListQuerySchema,
  nearbyPlacesQuerySchema,
  placeIdSchema,
  placeReadQuerySchema,
  placesInBoundsQuerySchema,
} from './place';
import { moderationReviewListQuerySchema, reviewListQuerySchema } from './review';
import { revisionListQuerySchema } from './revision';
import { reverseGeocodeQuerySchema, searchParametersSchema, structuredGeocodeQuerySchema } from './search';
import { streetCoverageQuerySchema } from './street3d';

/**
 * Who may call an operation.
 *
 * - `public` — no session is read at all.
 * - `optional` — answers signed out; a session, when present, may widen what is
 *   shown (claim details on a place you claimed).
 * - `required` — a verified Oxy session, or `401 unauthorized`.
 */
export type ApiAuth = 'public' | 'optional' | 'required';

export type ApiMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export type ApiTag =
  | 'Places'
  | 'Categories'
  | 'Hours'
  | 'Media'
  | 'Reviews'
  | 'Claims'
  | 'Moderation'
  | 'Search'
  | 'Directions'
  | 'Captures'
  | 'Street 3D';

export interface ApiOperation {
  readonly operationId: string;
  readonly method: ApiMethod;
  readonly path: string;
  readonly tag: ApiTag;
  readonly summary: string;
  readonly auth: ApiAuth;
  readonly pathParameters?: z.ZodObject;
  readonly query?: z.ZodObject;
  readonly body?: ContractSchemaName;
  /** Success statuses and the contract each answers with; `null` is an empty body. */
  readonly responses: Readonly<Partial<Record<200 | 201 | 204, ContractSchemaName | null>>>;
  /** The error codes this operation may answer beyond the ones every operation can. */
  readonly errors: readonly ApiErrorCode[];
}

/**
 * Codes any operation may answer: the rate limiter's `rate_limited` and the
 * defect handler's `internal_error`.
 */
export const UNIVERSAL_ERROR_CODES = ['rate_limited', 'internal_error'] as const satisfies readonly ApiErrorCode[];

/** `{placeId}` */
export const placePathSchema = z.object({ placeId: placeIdSchema });
/** `{placeId}` and a capability `{key}` such as `payments.faircoin.accepted`. */
export const capabilityPathSchema = z.object({ placeId: placeIdSchema, key: capabilityKeySchema });
/** `{claimId}` */
export const claimPathSchema = z.object({ claimId: z.string().min(1).max(128) });
/** `{candidateId}` — a duplicate candidate. */
export const duplicatePathSchema = z.object({ candidateId: z.string().min(1).max(128) });
/** `{reportId}` — a place report. */
export const reportPathSchema = z.object({ reportId: z.string().min(1).max(128) });
/** `{placeId}` and an hours exception's `{exceptionId}`. */
export const hoursExceptionPathSchema = z.object({ placeId: placeIdSchema, exceptionId: z.string().min(1).max(128) });
/** `{placeId}` and a gallery item's `{mediaId}`. */
export const mediaPathSchema = z.object({ placeId: placeIdSchema, mediaId: z.string().min(1).max(128) });
/** `{placeId}` and a review's `{reviewId}`. */
export const reviewPathSchema = z.object({ placeId: placeIdSchema, reviewId: z.string().min(1).max(128) });
/** `{sceneId}` */
export const scenePathSchema = z.object({ sceneId: z.string().min(1).max(64) });
/** `{sessionId}` */
export const sessionPathSchema = z.object({ sessionId: z.string().min(1).max(128) });
/** `{assetId}` */
export const assetPathSchema = z.object({ assetId: z.string().min(1).max(128) });

const READ_ERRORS = ['bad_request', 'validation_failed'] as const satisfies readonly ApiErrorCode[];
const WRITE_ERRORS = ['bad_request', 'validation_failed', 'unauthorized'] as const satisfies readonly ApiErrorCode[];
const SEARCH_ERRORS = [...READ_ERRORS, 'provider_unavailable', 'service_unavailable'] as const;
/**
 * What every `/moderation` route may answer besides its own codes: no session,
 * or a session outside the operator allow-list.
 */
const MODERATION_ERRORS = [...WRITE_ERRORS, 'forbidden'] as const satisfies readonly ApiErrorCode[];

export const API_OPERATIONS: readonly ApiOperation[] = [
  // ── Places ────────────────────────────────────────────────────────────────
  {
    operationId: 'listPlacesNearby',
    method: 'get',
    path: '/places/nearby',
    tag: 'Places',
    summary: 'Places within a radius, nearest first, each with its distance.',
    auth: 'optional',
    query: nearbyPlacesQuerySchema,
    responses: { 200: 'PlaceWithDistancePage' },
    errors: READ_ERRORS,
  },
  {
    operationId: 'listPlacesInBounds',
    method: 'get',
    path: '/places/bounds',
    tag: 'Places',
    summary: 'Places inside a bounding box — the map-viewport read.',
    auth: 'optional',
    query: placesInBoundsQuerySchema,
    responses: { 200: 'PlacePage' },
    errors: READ_ERRORS,
  },
  {
    operationId: 'getPlace',
    method: 'get',
    path: '/places/{placeId}',
    tag: 'Places',
    summary: 'One place by its stable GoWay Place ID.',
    auth: 'optional',
    pathParameters: placePathSchema,
    query: placeReadQuerySchema,
    responses: { 200: 'Place' },
    errors: [...READ_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'createPlace',
    method: 'post',
    path: '/places',
    tag: 'Places',
    summary: 'Create a GoWay-owned place or a community submission.',
    auth: 'required',
    body: 'PlaceCreateInput',
    responses: { 201: 'Place' },
    errors: [...WRITE_ERRORS, 'conflict'],
  },
  {
    operationId: 'updatePlace',
    method: 'patch',
    path: '/places/{placeId}',
    tag: 'Places',
    summary: 'Edit a place: community-editable until claimed, then claimant-only.',
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceUpdateInput',
    responses: { 200: 'Place' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'conflict', 'service_unavailable'],
  },
  {
    operationId: 'assertPlaceCapability',
    method: 'put',
    path: '/places/{placeId}/capabilities/{key}',
    tag: 'Places',
    summary: "Assert or refresh one capability at the tier the caller's claims earn.",
    auth: 'required',
    pathParameters: capabilityPathSchema,
    body: 'PlaceCapabilityAssertion',
    responses: { 200: 'Place' },
    errors: [...WRITE_ERRORS, 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'withdrawPlaceCapability',
    method: 'delete',
    path: '/places/{placeId}/capabilities/{key}',
    tag: 'Places',
    summary: "Withdraw the business's own assertion of one capability.",
    auth: 'required',
    pathParameters: capabilityPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'listPlaceRevisions',
    method: 'get',
    path: '/places/{placeId}/revisions',
    tag: 'Places',
    summary: 'What changed on a place and when, newest first. Never who.',
    auth: 'public',
    pathParameters: placePathSchema,
    query: revisionListQuerySchema,
    responses: { 200: 'PlaceRevisionPage' },
    errors: [...READ_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'reportPlace',
    method: 'post',
    path: '/places/{placeId}/reports',
    tag: 'Places',
    summary: 'Report a place to moderation. Repeating an open report answers the existing one with 200.',
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceReportInput',
    responses: { 201: 'PlaceReport', 200: 'PlaceReport' },
    errors: [...WRITE_ERRORS, 'not_found', 'gone'],
  },

  // ── Categories ────────────────────────────────────────────────────────────
  {
    operationId: 'listCategories',
    method: 'get',
    path: '/categories',
    tag: 'Categories',
    summary: 'The place category taxonomy: every key, its parent, its glyph and its labels.',
    auth: 'public',
    responses: { 200: 'CategoryPage' },
    errors: [],
  },

  // ── Hours exceptions ──────────────────────────────────────────────────────
  {
    operationId: 'listPlaceHoursExceptions',
    method: 'get',
    path: '/places/{placeId}/hours-exceptions',
    tag: 'Hours',
    summary: 'Dated exceptions to a place\'s weekly hours, earliest first, past ones included.',
    auth: 'optional',
    pathParameters: placePathSchema,
    query: hoursExceptionListQuerySchema,
    responses: { 200: 'PlaceHoursExceptionPage' },
    errors: [...READ_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'createPlaceHoursException',
    method: 'post',
    path: '/places/{placeId}/hours-exceptions',
    tag: 'Hours',
    summary: "Report a closure or special hours, at the tier the caller's claims earn.",
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceHoursExceptionInput',
    responses: { 201: 'PlaceHoursException' },
    errors: [...WRITE_ERRORS, 'not_found', 'gone', 'conflict', 'service_unavailable'],
  },
  {
    operationId: 'replacePlaceHoursException',
    method: 'put',
    path: '/places/{placeId}/hours-exceptions/{exceptionId}',
    tag: 'Hours',
    summary: "Rewrite an exception at the caller's own tier.",
    auth: 'required',
    pathParameters: hoursExceptionPathSchema,
    body: 'PlaceHoursExceptionInput',
    responses: { 200: 'PlaceHoursException' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'conflict', 'service_unavailable'],
  },
  {
    operationId: 'withdrawPlaceHoursException',
    method: 'delete',
    path: '/places/{placeId}/hours-exceptions/{exceptionId}',
    tag: 'Hours',
    summary: "Withdraw the business's own exception.",
    auth: 'required',
    pathParameters: hoursExceptionPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },

  // ── Media ─────────────────────────────────────────────────────────────────
  {
    operationId: 'listPlaceMedia',
    method: 'get',
    path: '/places/{placeId}/media',
    tag: 'Media',
    summary: "A place's visible gallery, in the business's order. Each item is an Oxy file id.",
    auth: 'optional',
    pathParameters: placePathSchema,
    query: mediaListQuerySchema,
    responses: { 200: 'PlaceMediaPage' },
    errors: [...READ_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'addPlaceMedia',
    method: 'post',
    path: '/places/{placeId}/media',
    tag: 'Media',
    summary: 'Add an image you uploaded to Oxy as public to the gallery. GoWay checks the file with Oxy.',
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceMediaInput',
    responses: { 201: 'PlaceMedia' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'conflict', 'service_unavailable'],
  },
  {
    operationId: 'reorderPlaceMedia',
    method: 'put',
    path: '/places/{placeId}/media/order',
    tag: 'Media',
    summary: 'Put the named gallery items first, in this order. The business only.',
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceMediaOrderInput',
    responses: { 204: null },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'removePlaceMedia',
    method: 'delete',
    path: '/places/{placeId}/media/{mediaId}',
    tag: 'Media',
    summary: 'Withdraw a gallery item: its contributor, or the business.',
    auth: 'required',
    pathParameters: mediaPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'reportPlaceMedia',
    method: 'post',
    path: '/places/{placeId}/media/{mediaId}/reports',
    tag: 'Media',
    summary: 'Report a gallery item to moderation. Repeating an open report answers the existing one with 200.',
    auth: 'required',
    pathParameters: mediaPathSchema,
    body: 'ContentReportInput',
    responses: { 201: 'PlaceReport', 200: 'PlaceReport' },
    errors: [...WRITE_ERRORS, 'not_found', 'gone'],
  },

  // ── Reviews ───────────────────────────────────────────────────────────────
  {
    operationId: 'listPlaceReviews',
    method: 'get',
    path: '/places/{placeId}/reviews',
    tag: 'Reviews',
    summary: "A place's published reviews: newest, highest or lowest first.",
    auth: 'public',
    pathParameters: placePathSchema,
    query: reviewListQuerySchema,
    responses: { 200: 'PlaceReviewPage' },
    errors: [...READ_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'getMyPlaceReview',
    method: 'get',
    path: '/places/{placeId}/reviews/mine',
    tag: 'Reviews',
    summary: 'Your own review of a place, with where it stands.',
    auth: 'required',
    pathParameters: placePathSchema,
    responses: { 200: 'PlaceReviewWithStatus' },
    errors: ['bad_request', 'unauthorized', 'not_found', 'gone'],
  },
  {
    operationId: 'putMyPlaceReview',
    method: 'put',
    path: '/places/{placeId}/reviews/mine',
    tag: 'Reviews',
    summary: "Write or rewrite your review. Refused to the place's business and to an organization session.",
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceReviewInput',
    responses: { 201: 'PlaceReviewWithStatus', 200: 'PlaceReviewWithStatus' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'withdrawMyPlaceReview',
    method: 'delete',
    path: '/places/{placeId}/reviews/mine',
    tag: 'Reviews',
    summary: 'Withdraw your review; its words are erased.',
    auth: 'required',
    pathParameters: placePathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'not_found', 'gone'],
  },
  {
    operationId: 'replyToPlaceReview',
    method: 'put',
    path: '/places/{placeId}/reviews/{reviewId}/reply',
    tag: 'Reviews',
    summary: "Write or rewrite the business's reply to a review. The business only.",
    auth: 'required',
    pathParameters: reviewPathSchema,
    body: 'PlaceReviewReplyInput',
    responses: { 200: 'PlaceReview' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'withdrawPlaceReviewReply',
    method: 'delete',
    path: '/places/{placeId}/reviews/{reviewId}/reply',
    tag: 'Reviews',
    summary: "Withdraw the business's reply to a review. The business only.",
    auth: 'required',
    pathParameters: reviewPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'reportPlaceReview',
    method: 'post',
    path: '/places/{placeId}/reviews/{reviewId}/reports',
    tag: 'Reviews',
    summary: 'Report a review to moderation. Repeating an open report answers the existing one with 200.',
    auth: 'required',
    pathParameters: reviewPathSchema,
    body: 'ContentReportInput',
    responses: { 201: 'PlaceReport', 200: 'PlaceReport' },
    errors: [...WRITE_ERRORS, 'not_found', 'gone'],
  },

  // ── Claims ────────────────────────────────────────────────────────────────
  {
    operationId: 'createPlaceClaim',
    method: 'post',
    path: '/places/{placeId}/claims',
    tag: 'Claims',
    summary: 'Ask to be recognised as running this place, for your account or an organization you own or administer. Always created pending.',
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceClaimInput',
    responses: { 201: 'PlaceClaim' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'conflict', 'service_unavailable'],
  },
  {
    operationId: 'listPlaceClaims',
    method: 'get',
    path: '/places/{placeId}/claims',
    tag: 'Claims',
    summary: 'The claims on one place, visible to whoever may act for an account that holds one.',
    auth: 'required',
    pathParameters: placePathSchema,
    query: claimListQuerySchema,
    responses: { 200: 'PlaceClaimPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden', 'not_found', 'gone', 'service_unavailable'],
  },
  {
    operationId: 'listAccountClaims',
    method: 'get',
    path: '/claims',
    tag: 'Claims',
    summary: 'Every claim one account holds, in every state: your own, or an organization you may act for.',
    auth: 'required',
    query: accountClaimListQuerySchema,
    responses: { 200: 'PlaceClaimPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden', 'service_unavailable'],
  },

  // ── Moderation ────────────────────────────────────────────────────────────
  {
    operationId: 'listModerationClaims',
    method: 'get',
    path: '/moderation/claims',
    tag: 'Moderation',
    summary: 'Claims in one state, oldest first — pending by default: the review queue.',
    auth: 'required',
    query: moderationClaimListQuerySchema,
    responses: { 200: 'PlaceClaimPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden'],
  },
  {
    operationId: 'decidePlaceClaim',
    method: 'post',
    path: '/moderation/claims/{claimId}/decision',
    tag: 'Moderation',
    summary: 'Approve or reject a pending claim, or revoke an approved one.',
    auth: 'required',
    pathParameters: claimPathSchema,
    body: 'ClaimDecisionInput',
    responses: { 200: 'PlaceClaim' },
    errors: [...MODERATION_ERRORS, 'not_found', 'conflict'],
  },
  {
    operationId: 'moderatePlace',
    method: 'patch',
    path: '/moderation/places/{placeId}',
    tag: 'Moderation',
    summary: "Set a place's verification state, or withdraw or restore it.",
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'ModerationPlaceUpdateInput',
    responses: { 204: null },
    errors: [...MODERATION_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'verifyPlaceCapability',
    method: 'put',
    path: '/moderation/places/{placeId}/capabilities/{key}',
    tag: 'Moderation',
    summary: 'Assert one capability at the oxy_verified tier.',
    auth: 'required',
    pathParameters: capabilityPathSchema,
    body: 'ModerationCapabilityInput',
    responses: { 200: 'Place' },
    errors: [...MODERATION_ERRORS, 'not_found', 'gone'],
  },
  {
    operationId: 'withdrawVerifiedCapability',
    method: 'delete',
    path: '/moderation/places/{placeId}/capabilities/{key}',
    tag: 'Moderation',
    summary: 'Withdraw the oxy_verified assertion of one capability.',
    auth: 'required',
    pathParameters: capabilityPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'gone'],
  },
  {
    operationId: 'listModerationPlaceRevisions',
    method: 'get',
    path: '/moderation/places/{placeId}/revisions',
    tag: 'Moderation',
    summary: 'Every revision of a place, newest first, with the account and person behind each.',
    auth: 'required',
    pathParameters: placePathSchema,
    query: revisionListQuerySchema,
    responses: { 200: 'ModerationPlaceRevisionPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden', 'not_found'],
  },
  {
    operationId: 'listModerationPlaceMedia',
    method: 'get',
    path: '/moderation/places/{placeId}/media',
    tag: 'Moderation',
    summary: "A place's gallery items in one state, or in every state, oldest first, with who added each.",
    auth: 'required',
    pathParameters: placePathSchema,
    query: moderationMediaListQuerySchema,
    responses: { 200: 'ModerationPlaceMediaPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden', 'not_found'],
  },
  {
    operationId: 'moderatePlaceMedia',
    method: 'patch',
    path: '/moderation/places/{placeId}/media/{mediaId}',
    tag: 'Moderation',
    summary: 'Hide a gallery item, or restore a hidden one.',
    auth: 'required',
    pathParameters: mediaPathSchema,
    body: 'ModerationMediaInput',
    responses: { 200: 'ModerationPlaceMedia' },
    errors: [...MODERATION_ERRORS, 'not_found', 'conflict'],
  },
  {
    operationId: 'listModerationPlaceReviews',
    method: 'get',
    path: '/moderation/places/{placeId}/reviews',
    tag: 'Moderation',
    summary: "A place's reviews in one status, or in every status, newest first.",
    auth: 'required',
    pathParameters: placePathSchema,
    query: moderationReviewListQuerySchema,
    responses: { 200: 'PlaceReviewWithStatusPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden', 'not_found'],
  },
  {
    operationId: 'moderatePlaceReview',
    method: 'patch',
    path: '/moderation/places/{placeId}/reviews/{reviewId}',
    tag: 'Moderation',
    summary: 'Hide a review, or restore a hidden one.',
    auth: 'required',
    pathParameters: reviewPathSchema,
    body: 'ModerationReviewInput',
    responses: { 200: 'PlaceReviewWithStatus' },
    errors: [...MODERATION_ERRORS, 'not_found', 'conflict'],
  },
  {
    operationId: 'removePlaceReviewReply',
    method: 'delete',
    path: '/moderation/places/{placeId}/reviews/{reviewId}/reply',
    tag: 'Moderation',
    summary: "Remove the business's reply to a review.",
    auth: 'required',
    pathParameters: reviewPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found'],
  },
  {
    operationId: 'listDuplicateCandidates',
    method: 'get',
    path: '/moderation/duplicates',
    tag: 'Moderation',
    summary: 'Pairs of places that might be one, oldest first — open by default.',
    auth: 'required',
    query: duplicateListQuerySchema,
    responses: { 200: 'DuplicateCandidatePage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden'],
  },
  {
    operationId: 'resolveDuplicateCandidate',
    method: 'post',
    path: '/moderation/duplicates/{candidateId}/resolution',
    tag: 'Moderation',
    summary: 'Merge a pair into the survivor, or keep both.',
    auth: 'required',
    pathParameters: duplicatePathSchema,
    body: 'DuplicateResolutionInput',
    responses: { 200: 'DuplicateCandidate' },
    errors: [...MODERATION_ERRORS, 'not_found', 'conflict'],
  },
  {
    operationId: 'listPlaceReports',
    method: 'get',
    path: '/moderation/reports',
    tag: 'Moderation',
    summary: 'Place reports, oldest first — open by default.',
    auth: 'required',
    query: moderationReportListQuerySchema,
    responses: { 200: 'ModerationPlaceReportPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden'],
  },
  {
    operationId: 'resolvePlaceReport',
    method: 'post',
    path: '/moderation/reports/{reportId}/resolution',
    tag: 'Moderation',
    summary: 'Close a report as actioned or dismissed.',
    auth: 'required',
    pathParameters: reportPathSchema,
    body: 'PlaceReportResolutionInput',
    responses: { 200: 'ModerationPlaceReport' },
    errors: [...MODERATION_ERRORS, 'not_found', 'conflict'],
  },

  // ── Search ────────────────────────────────────────────────────────────────
  {
    operationId: 'search',
    method: 'get',
    path: '/search',
    tag: 'Search',
    summary: 'The blended search box: GoWay Places and the interactive geocoders.',
    auth: 'optional',
    query: searchParametersSchema,
    responses: { 200: 'SearchResults' },
    errors: SEARCH_ERRORS,
  },
  {
    operationId: 'geocode',
    method: 'get',
    path: '/geocode',
    tag: 'Search',
    summary: 'An explicit forward geocode; every configured provider may answer.',
    auth: 'optional',
    query: searchParametersSchema,
    responses: { 200: 'SearchResults' },
    errors: SEARCH_ERRORS,
  },
  {
    operationId: 'reverseGeocode',
    method: 'get',
    path: '/geocode/reverse',
    tag: 'Search',
    summary: 'What is at this coordinate.',
    auth: 'optional',
    query: reverseGeocodeQuerySchema,
    responses: { 200: 'SearchResults' },
    errors: SEARCH_ERRORS,
  },
  {
    operationId: 'structuredGeocode',
    method: 'get',
    path: '/geocode/structured',
    tag: 'Search',
    summary: 'An address lookup with the parts already separated.',
    auth: 'optional',
    query: structuredGeocodeQuerySchema,
    responses: { 200: 'SearchResults' },
    errors: SEARCH_ERRORS,
  },

  // ── Directions ────────────────────────────────────────────────────────────
  {
    operationId: 'getDirections',
    method: 'post',
    path: '/routes',
    tag: 'Directions',
    summary: 'Directions between two or more points. An empty `routes` is a normal answer.',
    auth: 'optional',
    body: 'RouteRequest',
    responses: { 200: 'RouteResponse' },
    errors: [
      'bad_request',
      'validation_failed',
      'not_found',
      'no_route',
      'unsupported_mode',
      'provider_unavailable',
      'service_unavailable',
    ],
  },

  // ── Captures ──────────────────────────────────────────────────────────────
  {
    operationId: 'getCapturePolicy',
    method: 'get',
    path: '/captures/policy',
    tag: 'Captures',
    summary: 'What a client must know before asking a contributor to pick a file.',
    auth: 'optional',
    responses: { 200: 'CaptureUploadPolicy' },
    errors: [],
  },
  {
    operationId: 'listCaptureSessions',
    method: 'get',
    path: '/captures/sessions',
    tag: 'Captures',
    summary: "The signed-in contributor's sessions, newest first.",
    auth: 'required',
    query: captureListQuerySchema,
    responses: { 200: 'CaptureSessionPage' },
    errors: [...READ_ERRORS, 'unauthorized'],
  },
  {
    operationId: 'createCaptureSession',
    method: 'post',
    path: '/captures/sessions',
    tag: 'Captures',
    summary: 'Open a contribution session under the current consent version.',
    auth: 'required',
    body: 'CaptureSessionInput',
    responses: { 201: 'CaptureSession' },
    errors: [...WRITE_ERRORS, 'forbidden', 'conflict'],
  },
  {
    operationId: 'getCaptureSession',
    method: 'get',
    path: '/captures/sessions/{sessionId}',
    tag: 'Captures',
    summary: 'One of your sessions.',
    auth: 'required',
    pathParameters: sessionPathSchema,
    responses: { 200: 'CaptureSession' },
    errors: ['bad_request', 'unauthorized', 'not_found'],
  },
  {
    operationId: 'listCaptureAssets',
    method: 'get',
    path: '/captures/sessions/{sessionId}/assets',
    tag: 'Captures',
    summary: 'The contributions registered against one of your sessions, oldest first.',
    auth: 'required',
    pathParameters: sessionPathSchema,
    query: captureListQuerySchema,
    responses: { 200: 'CaptureAssetPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'not_found'],
  },
  {
    operationId: 'registerCaptureAsset',
    method: 'post',
    path: '/captures/sessions/{sessionId}/assets',
    tag: 'Captures',
    summary: 'Register a photo or video and get an upload target unless the bytes are already stored.',
    auth: 'required',
    pathParameters: sessionPathSchema,
    body: 'CaptureAssetInput',
    responses: { 201: 'CaptureUploadTicket' },
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'conflict', 'payload_too_large', 'service_unavailable'],
  },
  {
    operationId: 'getCaptureAsset',
    method: 'get',
    path: '/captures/assets/{assetId}',
    tag: 'Captures',
    summary: 'One of your contributions.',
    auth: 'required',
    pathParameters: assetPathSchema,
    responses: { 200: 'CaptureAsset' },
    errors: ['bad_request', 'unauthorized', 'not_found'],
  },
  {
    operationId: 'finalizeCaptureAsset',
    method: 'post',
    path: '/captures/assets/{assetId}/finalize',
    tag: 'Captures',
    summary: 'Confirm the upload; GoWay checks the stored bytes against the registration.',
    auth: 'required',
    pathParameters: assetPathSchema,
    body: 'CaptureFinalizeInput',
    responses: { 200: 'CaptureAsset' },
    errors: [...WRITE_ERRORS, 'not_found', 'conflict', 'service_unavailable'],
  },
  {
    operationId: 'withdrawCaptureAsset',
    method: 'delete',
    path: '/captures/assets/{assetId}',
    tag: 'Captures',
    summary: 'Withdraw a contribution; its media is deleted and it never feeds a scene.',
    auth: 'required',
    pathParameters: assetPathSchema,
    responses: { 204: null },
    errors: ['bad_request', 'unauthorized', 'not_found'],
  },

  // ── Street 3D ─────────────────────────────────────────────────────────────
  {
    operationId: 'getStreetCoverage',
    method: 'get',
    path: '/street3d/coverage',
    tag: 'Street 3D',
    summary: 'Published scenes and coarse coverage areas in a box.',
    auth: 'public',
    query: streetCoverageQuerySchema,
    responses: { 200: 'StreetCoverage' },
    errors: [...READ_ERRORS, 'service_unavailable'],
  },
  {
    operationId: 'getStreetScene',
    method: 'get',
    path: '/street3d/scenes/{sceneId}',
    tag: 'Street 3D',
    summary: 'The served manifest of one published scene.',
    auth: 'public',
    pathParameters: scenePathSchema,
    responses: { 200: 'StreetSceneManifest' },
    errors: ['bad_request', 'not_found'],
  },
  {
    operationId: 'reportStreetScene',
    method: 'post',
    path: '/street3d/scenes/{sceneId}/reports',
    tag: 'Street 3D',
    summary: 'Report a scene to moderation. Repeating a report answers the existing one with 200.',
    auth: 'required',
    pathParameters: scenePathSchema,
    body: 'StreetSceneReportInput',
    responses: { 201: 'StreetSceneReport', 200: 'StreetSceneReport' },
    errors: [...WRITE_ERRORS, 'not_found'],
  },
];

/** An OpenAPI path in Express's spelling: `/places/{placeId}` → `/places/:placeId`. */
export function expressPath(path: string): string {
  return path.replace(/\{([A-Za-z]+)\}/g, ':$1');
}

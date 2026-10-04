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
import {
  capabilityKeySchema,
  claimListQuerySchema,
  nearbyPlacesQuerySchema,
  placeIdSchema,
  placeReadQuerySchema,
  placesInBoundsQuerySchema,
} from './place';
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

export type ApiTag = 'Places' | 'Claims' | 'Search' | 'Directions' | 'Captures' | 'Street 3D';

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
/** `{sceneId}` */
export const scenePathSchema = z.object({ sceneId: z.string().min(1).max(64) });
/** `{sessionId}` */
export const sessionPathSchema = z.object({ sessionId: z.string().min(1).max(128) });
/** `{assetId}` */
export const assetPathSchema = z.object({ assetId: z.string().min(1).max(128) });

const READ_ERRORS = ['bad_request', 'validation_failed'] as const satisfies readonly ApiErrorCode[];
const WRITE_ERRORS = ['bad_request', 'validation_failed', 'unauthorized'] as const satisfies readonly ApiErrorCode[];
const SEARCH_ERRORS = [...READ_ERRORS, 'provider_unavailable', 'service_unavailable'] as const;

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
    errors: [...WRITE_ERRORS, 'forbidden', 'not_found', 'gone', 'conflict'],
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
    errors: [...WRITE_ERRORS, 'not_found', 'gone'],
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
    errors: ['bad_request', 'unauthorized', 'forbidden', 'not_found', 'gone'],
  },

  // ── Claims ────────────────────────────────────────────────────────────────
  {
    operationId: 'createPlaceClaim',
    method: 'post',
    path: '/places/{placeId}/claims',
    tag: 'Claims',
    summary: 'Ask to be recognised as running this place. Always created pending.',
    auth: 'required',
    pathParameters: placePathSchema,
    body: 'PlaceClaimInput',
    responses: { 201: 'PlaceClaim' },
    errors: [...WRITE_ERRORS, 'not_found', 'gone', 'conflict'],
  },
  {
    operationId: 'listPlaceClaims',
    method: 'get',
    path: '/places/{placeId}/claims',
    tag: 'Claims',
    summary: 'The claims on one place, visible to an account that holds one.',
    auth: 'required',
    pathParameters: placePathSchema,
    query: claimListQuerySchema,
    responses: { 200: 'PlaceClaimPage' },
    errors: [...READ_ERRORS, 'unauthorized', 'forbidden', 'not_found', 'gone'],
  },
  {
    operationId: 'listMyClaims',
    method: 'get',
    path: '/claims',
    tag: 'Claims',
    summary: 'Every claim the signed-in account holds, in every state.',
    auth: 'required',
    query: claimListQuerySchema,
    responses: { 200: 'PlaceClaimPage' },
    errors: [...READ_ERRORS, 'unauthorized'],
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

/**
 * The named contract schemas, and the same contracts as JSON Schema.
 *
 * {@link CONTRACT_SCHEMAS} is the one list of every request and response shape
 * GoWay publishes by name. The OpenAPI document's `components.schemas` is built
 * from it, so a name here is a name an integrator's generated client sees.
 *
 * Each entry says which DIRECTION it travels in, because zod converts the two
 * differently: a request is described as what a caller may SEND (`io: 'input'`
 * — before defaults and normalization), a response as what GoWay RETURNS
 * (`io: 'output'`).
 *
 * **What JSON Schema does NOT carry.** Zod refinements have no JSON Schema
 * equivalent and are dropped by the conversion: `south <= north`, the viewport
 * span cap, "exactly one of `coordinate` and `exifGps`", "an update must change
 * a field", `key === namespace + '.' + capability`, a capability value
 * held to its key's registry entry, an hours exception's date order, and the
 * language-tag normalization. So a payload that passes the JSON Schema is well-FORMED, not
 * accepted. The server validates with zod, and that is the authority.
 */

import { z } from 'zod';
import {
  captureAssetInputSchema,
  captureAssetPageSchema,
  captureAssetSchema,
  captureFinalizeInputSchema,
  captureSessionInputSchema,
  captureSessionPageSchema,
  captureSessionSchema,
  captureUploadPolicySchema,
  captureUploadTicketSchema,
} from './capture';
import { routeRequestSchema, routeResponseSchema, routeSchema } from './directions';
import { categoryPageSchema, categorySchema } from './category';
import { apiErrorBodySchema } from './errors';
import { geoBoundingBoxSchema, geoCoordinateSchema, geoGeometrySchema } from './geo';
import {
  placeHoursExceptionInputSchema,
  placeHoursExceptionPageSchema,
  placeHoursExceptionSchema,
} from './hours';
import {
  placeCapabilityAssertionSchema,
  placeCapabilitySchema,
  placeClaimInputSchema,
  placeClaimPageSchema,
  placeClaimSchema,
  placeBatchSchema,
  placeCreateInputSchema,
  placeDescriptionSchema,
  placeNameSchema,
  placeRatingSchema,
  placePageSchema,
  placeSchema,
  placeUpdateInputSchema,
  placeWithDistancePageSchema,
  placeWithDistanceSchema,
} from './place';
import {
  moderationMediaInputSchema,
  moderationPlaceMediaPageSchema,
  moderationPlaceMediaSchema,
  placeMediaInputSchema,
  placeMediaOrderInputSchema,
  placeMediaPageSchema,
  placeMediaSchema,
} from './media';
import {
  moderationReviewInputSchema,
  placeReviewInputSchema,
  placeReviewPageSchema,
  placeReviewReplyInputSchema,
  placeReviewSchema,
  placeReviewWithStatusPageSchema,
  placeReviewWithStatusSchema,
} from './review';
import {
  claimDecisionInputSchema,
  contentReportInputSchema,
  duplicateCandidatePageSchema,
  duplicateCandidateSchema,
  duplicateResolutionInputSchema,
  moderationCapabilityInputSchema,
  moderationPlaceReportPageSchema,
  moderationPlaceReportSchema,
  moderationPlaceUpdateInputSchema,
  placeReportInputSchema,
  placeReportResolutionInputSchema,
  placeReportSchema,
} from './moderation';
import {
  moderationPlaceRevisionPageSchema,
  moderationPlaceRevisionSchema,
  placeRevisionPageSchema,
  placeRevisionSchema,
  revisionValueSchema,
} from './revision';
import { searchResultSchema, searchResultsSchema } from './search';
import {
  streetCoverageSchema,
  streetSceneManifestSchema,
  streetSceneReportInputSchema,
  streetSceneReportSchema,
} from './street3d';

/** A JSON Schema document, as produced by the conversion. */
export type JsonSchemaDocument = z.core.JSONSchema.BaseSchema;

/** Which way a named schema travels. */
export type ContractSchemaDirection = 'request' | 'response';

export interface ContractSchemaEntry {
  readonly schema: z.ZodType;
  readonly direction: ContractSchemaDirection;
}

export const CONTRACT_SCHEMA_NAMES = [
  'ApiErrorBody',
  'GeoCoordinate',
  'GeoBoundingBox',
  'GeoGeometry',
  'Place',
  'PlaceName',
  'PlaceDescription',
  'PlaceRating',
  'PlaceCapability',
  'PlaceClaim',
  'PlaceWithDistance',
  'PlacePage',
  'PlaceWithDistancePage',
  'PlaceBatch',
  'PlaceClaimPage',
  'PlaceCreateInput',
  'PlaceUpdateInput',
  'PlaceCapabilityAssertion',
  'PlaceClaimInput',
  'Category',
  'CategoryPage',
  'PlaceHoursException',
  'PlaceHoursExceptionPage',
  'PlaceHoursExceptionInput',
  'PlaceMedia',
  'PlaceMediaPage',
  'PlaceMediaInput',
  'PlaceMediaOrderInput',
  'PlaceReview',
  'PlaceReviewPage',
  'PlaceReviewWithStatus',
  'PlaceReviewWithStatusPage',
  'PlaceReviewInput',
  'PlaceReviewReplyInput',
  'ContentReportInput',
  'ModerationPlaceMedia',
  'ModerationPlaceMediaPage',
  'ModerationMediaInput',
  'ModerationReviewInput',
  'RevisionValue',
  'PlaceRevision',
  'PlaceRevisionPage',
  'PlaceReport',
  'PlaceReportInput',
  'ModerationPlaceRevision',
  'ModerationPlaceRevisionPage',
  'ModerationPlaceReport',
  'ModerationPlaceReportPage',
  'DuplicateCandidate',
  'DuplicateCandidatePage',
  'ClaimDecisionInput',
  'ModerationPlaceUpdateInput',
  'ModerationCapabilityInput',
  'DuplicateResolutionInput',
  'PlaceReportResolutionInput',
  'SearchResult',
  'SearchResults',
  'Route',
  'RouteResponse',
  'RouteRequest',
  'CaptureSession',
  'CaptureAsset',
  'CaptureUploadPolicy',
  'CaptureUploadTicket',
  'CaptureSessionPage',
  'CaptureAssetPage',
  'CaptureSessionInput',
  'CaptureAssetInput',
  'CaptureFinalizeInput',
  'StreetCoverage',
  'StreetSceneManifest',
  'StreetSceneReport',
  'StreetSceneReportInput',
] as const;

export type ContractSchemaName = (typeof CONTRACT_SCHEMA_NAMES)[number];

const response = (schema: z.ZodType): ContractSchemaEntry => ({ schema, direction: 'response' });
const request = (schema: z.ZodType): ContractSchemaEntry => ({ schema, direction: 'request' });

/**
 * The schema behind each published name.
 *
 * Typed as an exhaustive `Record` so adding a name without a schema — or a
 * schema without a name — is a compile error rather than a runtime hole in the
 * exported contract set.
 */
export const CONTRACT_SCHEMAS: Readonly<Record<ContractSchemaName, ContractSchemaEntry>> = {
  ApiErrorBody: response(apiErrorBodySchema),
  GeoCoordinate: response(geoCoordinateSchema),
  GeoBoundingBox: response(geoBoundingBoxSchema),
  GeoGeometry: response(geoGeometrySchema),
  Place: response(placeSchema),
  PlaceName: response(placeNameSchema),
  PlaceDescription: response(placeDescriptionSchema),
  PlaceRating: response(placeRatingSchema),
  PlaceCapability: response(placeCapabilitySchema),
  PlaceClaim: response(placeClaimSchema),
  PlaceWithDistance: response(placeWithDistanceSchema),
  PlacePage: response(placePageSchema),
  PlaceWithDistancePage: response(placeWithDistancePageSchema),
  PlaceBatch: response(placeBatchSchema),
  PlaceClaimPage: response(placeClaimPageSchema),
  PlaceCreateInput: request(placeCreateInputSchema),
  PlaceUpdateInput: request(placeUpdateInputSchema),
  PlaceCapabilityAssertion: request(placeCapabilityAssertionSchema),
  PlaceClaimInput: request(placeClaimInputSchema),
  Category: response(categorySchema),
  CategoryPage: response(categoryPageSchema),
  PlaceHoursException: response(placeHoursExceptionSchema),
  PlaceHoursExceptionPage: response(placeHoursExceptionPageSchema),
  PlaceHoursExceptionInput: request(placeHoursExceptionInputSchema),
  PlaceMedia: response(placeMediaSchema),
  PlaceMediaPage: response(placeMediaPageSchema),
  PlaceMediaInput: request(placeMediaInputSchema),
  PlaceMediaOrderInput: request(placeMediaOrderInputSchema),
  PlaceReview: response(placeReviewSchema),
  PlaceReviewPage: response(placeReviewPageSchema),
  PlaceReviewWithStatus: response(placeReviewWithStatusSchema),
  PlaceReviewWithStatusPage: response(placeReviewWithStatusPageSchema),
  PlaceReviewInput: request(placeReviewInputSchema),
  PlaceReviewReplyInput: request(placeReviewReplyInputSchema),
  ContentReportInput: request(contentReportInputSchema),
  ModerationPlaceMedia: response(moderationPlaceMediaSchema),
  ModerationPlaceMediaPage: response(moderationPlaceMediaPageSchema),
  ModerationMediaInput: request(moderationMediaInputSchema),
  ModerationReviewInput: request(moderationReviewInputSchema),
  RevisionValue: response(revisionValueSchema),
  PlaceRevision: response(placeRevisionSchema),
  PlaceRevisionPage: response(placeRevisionPageSchema),
  PlaceReport: response(placeReportSchema),
  PlaceReportInput: request(placeReportInputSchema),
  ModerationPlaceRevision: response(moderationPlaceRevisionSchema),
  ModerationPlaceRevisionPage: response(moderationPlaceRevisionPageSchema),
  ModerationPlaceReport: response(moderationPlaceReportSchema),
  ModerationPlaceReportPage: response(moderationPlaceReportPageSchema),
  DuplicateCandidate: response(duplicateCandidateSchema),
  DuplicateCandidatePage: response(duplicateCandidatePageSchema),
  ClaimDecisionInput: request(claimDecisionInputSchema),
  ModerationPlaceUpdateInput: request(moderationPlaceUpdateInputSchema),
  ModerationCapabilityInput: request(moderationCapabilityInputSchema),
  DuplicateResolutionInput: request(duplicateResolutionInputSchema),
  PlaceReportResolutionInput: request(placeReportResolutionInputSchema),
  SearchResult: response(searchResultSchema),
  SearchResults: response(searchResultsSchema),
  Route: response(routeSchema),
  RouteResponse: response(routeResponseSchema),
  RouteRequest: request(routeRequestSchema),
  CaptureSession: response(captureSessionSchema),
  CaptureAsset: response(captureAssetSchema),
  CaptureUploadPolicy: response(captureUploadPolicySchema),
  CaptureUploadTicket: response(captureUploadTicketSchema),
  CaptureSessionPage: response(captureSessionPageSchema),
  CaptureAssetPage: response(captureAssetPageSchema),
  CaptureSessionInput: request(captureSessionInputSchema),
  CaptureAssetInput: request(captureAssetInputSchema),
  CaptureFinalizeInput: request(captureFinalizeInputSchema),
  StreetCoverage: response(streetCoverageSchema),
  StreetSceneManifest: response(streetSceneManifestSchema),
  StreetSceneReport: response(streetSceneReportSchema),
  StreetSceneReportInput: request(streetSceneReportInputSchema),
};

/** JSON Schema draft 2020-12 — the dialect OpenAPI 3.1 speaks. */
export const JSON_SCHEMA_TARGET = 'draft-2020-12';

/** The conversion mode for a direction: what a caller sends, or what GoWay returns. */
export function jsonSchemaIo(direction: ContractSchemaDirection): 'input' | 'output' {
  return direction === 'request' ? 'input' : 'output';
}

/**
 * The conversion options for a direction.
 *
 * A response object is published OPEN: zod's output mode closes every object
 * (`additionalProperties: false`), which would tell an integrator that a new
 * response field is a breaking change — and it is not, the SDK strips unknown
 * keys exactly so GoWay can add one. A `.strict()` request object stays closed,
 * because there an unknown key really is refused.
 */
export function jsonSchemaOptions(direction: ContractSchemaDirection) {
  return {
    target: JSON_SCHEMA_TARGET,
    io: jsonSchemaIo(direction),
    override: (context: { zodSchema: z.core.$ZodTypes; jsonSchema: z.core.JSONSchema.BaseSchema }) => {
      const definition = context.zodSchema._zod.def;
      if (definition.type === 'object' && definition.catchall === undefined) {
        delete context.jsonSchema.additionalProperties;
      }
    },
  } as const;
}

/** The JSON Schema for one published contract, self-contained. */
export function gowayJsonSchema(name: ContractSchemaName): JsonSchemaDocument {
  const entry = CONTRACT_SCHEMAS[name];
  return z.toJSONSchema(entry.schema, jsonSchemaOptions(entry.direction));
}

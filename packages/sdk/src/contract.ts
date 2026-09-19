/**
 * The public contract, taken from its ONE definition.
 *
 * Every shape and closed value set below is defined in `@goway/shared-types`,
 * the package the GoWay backend validates against. That package is PRIVATE and
 * never published, so the build BUNDLES what this module reaches — declarations
 * into the `.d.ts`, the handful of runtime values into the JavaScript — and
 * `scripts/smoke.mjs` fails the release if any shipped file still names the
 * private scope. Nothing here re-declares a type: an SDK holding its own copy of
 * `Place` would be the second source of truth that `packages/shared-types`
 * exists to prevent.
 *
 * This is the only module in `src/` that imports the private package.
 */

export {
  API_ERROR_CODES,
  API_ERROR_RETRYABLE,
  API_ERROR_STATUS,
  CAPABILITY_VERIFICATIONS,
  isApiErrorCode,
  MANEUVER_TYPES,
  PLACE_CLAIM_ROLES,
  PLACE_CLAIM_STATES,
  PLACE_STATUSES,
  PLACE_VERIFICATION_STATES,
  SEARCH_RESULT_KINDS,
  SEARCH_SOURCES,
  toGeoCoordinate,
  toGeoPosition,
  TRAVEL_MODES,
  WELL_KNOWN_CAPABILITIES,
} from '@goway/shared-types';

export type {
  ApiErrorBody,
  ApiErrorCode,
  CapabilityKey,
  CapabilityVerification,
  GeoBoundingBox,
  GeoCoordinate,
  GeoGeometry,
  GeoJsonLineString,
  GeoJsonMultiPolygon,
  GeoJsonPoint,
  GeoJsonPolygon,
  GeoPosition,
  ManeuverType,
  MapViewport,
  Meters,
  NearbyPlacesQuery,
  OpeningHours,
  OpeningHoursInterval,
  Place,
  PlaceCapability,
  PlaceClaim,
  PlaceClaimRole,
  PlaceClaimState,
  PlaceContact,
  PlaceId,
  PlacesInBoundsQuery,
  PlaceSourceRef,
  PlaceStatus,
  PlaceVerification,
  PlaceVerificationState,
  PlaceWithDistance,
  ReverseGeocodeQuery,
  Route,
  RouteLeg,
  RouteLocation,
  RouteManeuver,
  RouteRequest,
  RouteResponse,
  SearchQuery,
  SearchResult,
  SearchResultContext,
  SearchResultKind,
  SearchResults,
  SearchSource,
  Seconds,
  StructuredAddress,
  StructuredGeocodeQuery,
  TravelMode,
  WellKnownCapability,
} from '@goway/shared-types';

/**
 * The path every public GoWay API route hangs off.
 *
 * Versioned in the PATH rather than in a header so a cached URL is a complete
 * description of what was requested, and so a consumer pinned to v1 keeps
 * working when v2 ships beside it.
 */
export const GOWAY_API_BASE_PATH = '/api/v1';

/**
 * `@goway.to/sdk` — the canonical integration boundary for GoWay.
 *
 * Everything a consumer may rely on is exported from here, and nothing else is
 * part of the contract. Domain shapes are re-exported from GoWay's own
 * `packages/shared-types`, so a consumer never imports a private GoWay package
 * and never keeps its own copy of `Place`.
 *
 * Nothing in this package knows which map renderer, geocoder or router GoWay is
 * running: MapLibre, OpenFreeMap, Photon, Nominatim and Valhalla are
 * replaceable adapters BEHIND these shapes. Installing this SDK pulls in no
 * renderer, no provider client and no dependency at all.
 */

export {
  createGoWayClient,
  DEFAULT_GOWAY_API_BASE_URL,
  DEFAULT_GOWAY_TIMEOUT_MS,
  DEFAULT_GOWAY_WEB_BASE_URL,
} from './client';
export type {
  GoWayClient,
  GoWayClientOptions,
  GoWayGeocodeApi,
  GoWayLinks,
  GoWayPlacesApi,
  GoWayRequestOptions,
  GoWayRoutesApi,
  GoWaySearchApi,
  PlaceCapabilityInput,
  PlaceCreateInput,
  PlaceLinkTarget,
  PlaceUpdateInput,
} from './client';

export {
  GoWayAbortError,
  GoWayApiError,
  GoWayConflictError,
  GoWayError,
  GoWayForbiddenError,
  GoWayNetworkError,
  GoWayNoRouteError,
  GoWayNotFoundError,
  GoWayRateLimitError,
  GoWayResponseError,
  GoWayTimeoutError,
  GoWayUnauthorizedError,
  GoWayUnavailableError,
  GoWayUnsupportedModeError,
  GoWayValidationError,
  isGoWayError,
} from './errors';
export type { GoWayErrorCode, GoWayErrorOptions, GoWayRateLimitErrorOptions } from './errors';

export type { GoWayAccessTokenGetter } from './transport';
export type {
  GoWayAbortSignal,
  GoWayFetch,
  GoWayFetchInit,
  GoWayFetchResponse,
  GoWayHeadersLike,
  GoWayHttpMethod,
} from './runtime';

export {
  API_ERROR_CODES,
  API_ERROR_RETRYABLE,
  API_ERROR_STATUS,
  CAPABILITY_VERIFICATIONS,
  GOWAY_API_BASE_PATH,
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
} from './contract';
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
} from './contract';

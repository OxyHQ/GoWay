/**
 * Provider-neutral search, geocoding and reverse geocoding contracts.
 *
 * Photon is the initial interactive geocoder and Nominatim an additional
 * adapter for explicit lookups, but neither shape reaches this file: a client
 * that can tell which geocoder answered is a client that breaks when GoWay
 * changes one. Consumers always receive {@link SearchResult}.
 */

import type { GeoBoundingBox, GeoCoordinate } from './geo';
import type { Place, PlaceId, StructuredAddress, CapabilityKey } from './place';

/** What kind of thing a search result denotes. */
export const SEARCH_RESULT_KINDS = ['place', 'address', 'street', 'locality', 'region', 'country', 'poi'] as const;
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

/** Where a search candidate came from. */
export const SEARCH_SOURCES = ['goway', 'photon', 'nominatim'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number] | (string & {});

/** Administrative context, as far as the source supplies it. */
export interface SearchResultContext {
  city?: string;
  region?: string;
  country?: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode?: string;
}

/**
 * One normalized search candidate.
 *
 * `id` is deterministic for a given (source, sourceId) pair so a result list can
 * be diffed and de-duplicated across requests rather than re-keyed by index.
 */
export interface SearchResult {
  id: string;
  /** Human-readable label, ready to render. */
  displayName: string;
  kind: SearchResultKind;
  coordinate: GeoCoordinate;
  /** Present when the source supplies an extent — use it to frame the camera. */
  boundingBox?: GeoBoundingBox;
  address?: StructuredAddress;
  context?: SearchResultContext;
  /** Which provider produced this candidate. Never dropped. */
  source: SearchSource;
  /** The provider's own identifier, verbatim. */
  sourceId?: string;
  /**
   * Set when this candidate reconciles to a GoWay-owned place. Its presence is
   * what lets a result carry ecosystem capabilities and Oxy verification.
   */
  placeId?: PlaceId;
  /** The reconciled GoWay place, when the caller asked for it to be embedded. */
  place?: Place;
  /** Provider relevance, normalized to 0..1. Not comparable across providers. */
  relevance?: number;
}

/**
 * A free-text search.
 *
 * Exactly one biasing strategy applies at a time, strongest first: `near` beats
 * `viewport`, and neither is a filter — both only re-rank.
 */
export interface SearchQuery {
  query: string;
  /** Bias results toward this coordinate. */
  near?: GeoCoordinate;
  /** Bias results toward the visible map area. */
  viewport?: GeoBoundingBox;
  /** Only return candidates whose reconciled place asserts every listed capability. */
  capabilities?: CapabilityKey[];
  categories?: string[];
  limit?: number;
  /** BCP-47 tag used for localized names, where the provider supports it. */
  locale?: string;
}

/** A structured address lookup, for providers that support one. */
export interface StructuredGeocodeQuery {
  street?: string;
  houseNumber?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  limit?: number;
  locale?: string;
}

/** Reverse geocoding: what is at this coordinate. */
export interface ReverseGeocodeQuery {
  latitude: number;
  longitude: number;
  /** Search radius around the coordinate. */
  radiusMeters?: number;
  limit?: number;
  locale?: string;
}

/**
 * A page of search results.
 *
 * `providers` reports which adapters actually answered. A degraded provider
 * produces a short result list rather than an error, so a consumer that wants
 * to say "some sources are unavailable" needs this to tell the two apart.
 */
export interface SearchResults {
  results: SearchResult[];
  /** Providers that contributed to this response. */
  providers: SearchSource[];
  /** Providers that were asked but failed or timed out. */
  degradedProviders?: SearchSource[];
}

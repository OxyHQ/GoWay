/**
 * The seam every geocoder sits behind.
 *
 * `AGENTS.md`: "MapLibre, OpenFreeMap, Photon, Nominatim, Valhalla, COLMAP and
 * gsplat are replaceable adapters behind GoWay interfaces. Feature code imports
 * the GoWay abstraction, never the provider." This file IS that abstraction for
 * search — an adapter takes a GoWay request and returns `SearchResult[]` from
 * `@goway/shared-types`, so nothing above it can tell Photon from Nominatim
 * from whatever replaces them.
 *
 * ## Why the interface returns results rather than raw payloads
 *
 * Normalization belongs to the adapter that knows the payload. A "normalize
 * later" design leaks a discriminated union of provider shapes upward, and the
 * first consumer that branches on it is a consumer that breaks when the
 * provider changes — which is the exact coupling this issue exists to prevent.
 * An adapter returns a {@link ProviderCandidate}: the finished
 * `SearchResult` plus the one reconciliation key the layer above is entitled to
 * use, and nothing else of the payload survives the boundary.
 *
 * ## Autocomplete permission is a property of the PROVIDER, not of the config
 *
 * `allowsInteractiveSearch` is a constant on each adapter, not a setting.
 * Nominatim's usage policy forbids autocomplete against the public instance, so
 * `NominatimProvider` declares `false` and the interactive `/search` endpoint
 * filters on it. An operator cannot switch that on by editing an environment
 * variable, which is the point: a policy breach should not be one typo away.
 */

import type { GeoBoundingBox, GeoCoordinate, SearchResult } from '@goway/shared-types';
import type { SearchProviderId } from '../config/search';

/**
 * `globalThis.fetch`, or a test double.
 *
 * Structural rather than `typeof globalThis.fetch`: that type carries runtime
 * extras (Bun adds `preconnect`) which a test double has no business
 * implementing, and requiring them would make the double impossible to write
 * without a cast.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Fields every upstream call carries. */
export interface ProviderRequestBase {
  /** How many candidates to ask for. Already clamped to the configured maximum. */
  limit: number;
  /** BCP-47 tag, forwarded only where the provider supports the language. */
  locale?: string;
  /**
   * The caller's cancellation, when there is one. The adapter combines it with
   * its own timeout; it never replaces it, because a client that hangs up is a
   * different event from an upstream that stopped answering.
   */
  signal?: AbortSignal;
}

/** A free-text lookup. `near` and `viewport` BIAS the ranking; neither filters. */
export interface ProviderForwardRequest extends ProviderRequestBase {
  query: string;
  near?: GeoCoordinate;
  viewport?: GeoBoundingBox;
  /**
   * Category keys. Only `key:value` members — an explicit OSM tag — reach an
   * external provider; anything else is a GoWay Places category and is applied
   * there. Guessing an OSM tag for a GoWay category would silently change the
   * question being asked, and the caller would have no way to see it happen.
   */
  categories?: readonly string[];
}

/** A structured address lookup, for providers that support one. */
export interface ProviderStructuredRequest extends ProviderRequestBase {
  street?: string;
  houseNumber?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
}

/** What is at this coordinate. */
export interface ProviderReverseRequest extends ProviderRequestBase {
  coordinate: GeoCoordinate;
  radiusMeters?: number;
}

export interface SearchProvider {
  readonly id: SearchProviderId;
  /**
   * Whether this provider's terms permit per-keystroke, interactive use. A
   * `false` here keeps the adapter out of `/search` entirely, whatever the
   * configuration says.
   */
  readonly allowsInteractiveSearch: boolean;
  forward(request: ProviderForwardRequest): Promise<ProviderCandidate[]>;
  reverse(request: ProviderReverseRequest): Promise<ProviderCandidate[]>;
  /** Absent when the provider has no structured endpoint. */
  structured?(request: ProviderStructuredRequest): Promise<ProviderCandidate[]>;
}

/**
 * The OpenStreetMap record a candidate came from, when the provider names one.
 *
 * This is the ONLY key GoWay reconciles a candidate to a place on, and the only
 * key it groups two providers' candidates on. Both Photon and Nominatim derive
 * from OSM and both publish the element's own type and id, so `node/240109189`
 * means the same real-world record whichever of them answered — which is what
 * makes the grouping deterministic rather than a similarity guess.
 */
export interface OsmRef {
  /** Always `openstreetmap`: the SOURCE, not the geocoder that relayed it. */
  source: 'openstreetmap';
  /** `node/<id>`, `way/<id>` or `relation/<id>`. */
  sourceId: string;
}

/** A normalized candidate plus the reconciliation key the adapter recovered. */
export interface ProviderCandidate {
  result: SearchResult;
  osmRef?: OsmRef;
}

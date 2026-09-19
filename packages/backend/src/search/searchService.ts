/**
 * The GoWay Search API's behaviour, independent of HTTP.
 *
 * ```text
 * GoWay Search API
 *       ↓
 * SearchProvider interface ── PhotonProvider ── NominatimProvider ── …
 *       ↓
 * normalize → reconcile → group → rank → enrich with GoWay Places
 * ```
 *
 * ## A degraded provider is a short list, not a failure
 *
 * `SearchResults.degradedProviders` exists so that "some sources are
 * unavailable" and "there is nothing there" are different answers. A provider
 * that times out, rate-limits GoWay or returns nonsense is recorded and stepped
 * over; the request still answers with whatever the other providers and GoWay
 * Places produced. Only when NOTHING answered does the failure surface as an
 * error — and then as `provider_unavailable`/`rate_limited`, never a 500, which
 * would tell an integrator that GoWay itself broke and that retrying is
 * pointless.
 *
 * The database is treated as one more provider in this respect: an outage in
 * GoWay Places degrades `goway` and leaves search working off the geocoders,
 * rather than taking the map's search box down with it.
 *
 * ## Precise coordinates are transient here, and they stay transient
 *
 * A `near` bias or a reverse lookup is the user's location. It is used to
 * build one upstream request and to rank one response; it is never written to a
 * table, never put in a log field, and never made a cache key — see
 * `shouldCache` below, and `cache.ts` for why that last one is a deliberate
 * loss of hit rate rather than an oversight.
 */

import type {
  CapabilityKey,
  GeoBoundingBox,
  GeoCoordinate,
  Place,
  SearchResults,
  SearchSource,
} from '@goway/shared-types';
import type { SearchConfig } from '../config/search';
import { BoundedCache } from './cache';
import { mergeCandidates, type CandidateList } from './merge';
import type { PlacesGateway } from './placesGateway';
import type { ProviderCandidate, SearchProvider } from './provider';
import { spatialBiasFor, type SpatialBias } from './ranking';
import { isUpstreamError, UpstreamError } from './upstream';
import { ApiError } from '../http/apiError';

/**
 * How far around a reverse-geocoded point GoWay Places is scanned.
 *
 * Tight on purpose: a reverse lookup asks "what is AT this point", and a
 * kilometre-wide scan would answer with the neighbourhood instead. A caller who
 * wants a wider sweep says so with `radiusMeters`.
 */
const REVERSE_PLACES_RADIUS_METERS = 150;

/** How many GoWay places to pull before the in-memory text filter narrows them. */
const PLACES_CANDIDATE_MULTIPLIER = 4;
const MAX_PLACES_CANDIDATES = 100;

/** Just enough of pino for this module; injected so the service stays testable. */
export interface SearchLogger {
  warn(fields: Record<string, string | number | boolean>, message: string): void;
}

const SILENT_LOGGER: SearchLogger = { warn: () => undefined };

export interface SearchRequestContext {
  gateway: PlacesGateway;
  /** The caller's cancellation, when the transport offers one. */
  signal?: AbortSignal;
}

/** A free-text query with every default already applied. */
export interface ResolvedSearchQuery {
  query: string;
  near?: GeoCoordinate;
  viewport?: GeoBoundingBox;
  capabilities?: readonly CapabilityKey[];
  categories?: readonly string[];
  limit: number;
  locale?: string;
}

export interface ResolvedReverseQuery {
  coordinate: GeoCoordinate;
  radiusMeters?: number;
  limit: number;
  locale?: string;
}

export interface ResolvedStructuredQuery {
  street?: string;
  houseNumber?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
  limit: number;
  locale?: string;
}

export interface SearchService {
  /** The search box: interactive providers only, blended with GoWay Places. */
  search(query: ResolvedSearchQuery, context: SearchRequestContext): Promise<SearchResults>;
  /** An explicit forward geocode. Every configured provider may answer. */
  forward(query: ResolvedSearchQuery, context: SearchRequestContext): Promise<SearchResults>;
  reverse(query: ResolvedReverseQuery, context: SearchRequestContext): Promise<SearchResults>;
  structured(query: ResolvedStructuredQuery, context: SearchRequestContext): Promise<SearchResults>;
}

export interface SearchServiceOptions {
  providers: readonly SearchProvider[];
  config: Pick<SearchConfig, 'cacheMaxEntries' | 'cacheTtlSeconds' | 'placesRadiusMeters'>;
  logger?: SearchLogger;
  /** Overridable so a test can control eviction and expiry without sleeping. */
  cache?: BoundedCache<readonly ProviderCandidate[]>;
}

/** One provider's outcome. Exactly one of `candidates`/`error` is set. */
interface ProviderOutcome {
  source: SearchSource;
  candidates?: readonly ProviderCandidate[];
  error?: UpstreamError;
}

/**
 * Which failure to report when NOTHING answered.
 *
 * A rate limit wins over a generic outage: it is the only one of the two that
 * carries an actionable `retryAfterSeconds`, and telling a client "unavailable,
 * retry freely" when the truth is "you are being throttled" is how a fair-use
 * allowance turns into a block.
 */
function worstFailure(outcomes: readonly ProviderOutcome[]): UpstreamError | undefined {
  const failures = outcomes.flatMap((outcome) => (outcome.error ? [outcome.error] : []));
  return failures.find((failure) => failure.kind === 'rate_limited') ?? failures[0];
}

/**
 * Normalized text, for comparing a GoWay place name against what was typed.
 *
 * Diacritics are folded (NFD, then the combining marks dropped) so that a
 * search for "cafe" finds "Café" — every user typing on a phone keyboard in
 * Spain expects that, and a plain lower-case comparison denies it.
 */
function foldText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLocaleLowerCase()
    .trim();
}

/**
 * Whether a GoWay place answers the typed text.
 *
 * A substring match over the name, the categories and the street/city, run in
 * memory over a bounded, spatially-scoped candidate set. It is a FILTER on
 * GoWay's own rows, never a merge rule: nothing in this package decides two
 * records are the same thing because their names look alike (see `merge.ts`).
 *
 * The repository has no text index yet, which is why this is not a query. That
 * is also why the Places side only contributes when the request is anchored
 * somewhere — see `loadPlaces`.
 */
export function placeMatchesText(place: Place, query: string): boolean {
  const needle = foldText(query);
  if (needle === '') return true;
  const haystack = [place.name, ...place.categories, place.address?.street, place.address?.city]
    .filter((part): part is string => typeof part === 'string')
    .map(foldText);
  return haystack.some((part) => part.includes(needle));
}

export function createSearchService(options: SearchServiceOptions): SearchService {
  const logger = options.logger ?? SILENT_LOGGER;
  const cache =
    options.cache ??
    new BoundedCache<readonly ProviderCandidate[]>({
      maxEntries: options.config.cacheMaxEntries,
      ttlMs: options.config.cacheTtlSeconds * 1_000,
    });

  const interactiveProviders = options.providers.filter((provider) => provider.allowsInteractiveSearch);

  /**
   * Run one provider, converting any failure into a recorded outcome.
   *
   * A non-`UpstreamError` is re-thrown: that is a defect in this package, not
   * an upstream condition, and swallowing it would hide a bug behind a
   * permanently degraded provider.
   */
  const run = async (
    provider: SearchProvider,
    call: (provider: SearchProvider) => Promise<ProviderCandidate[]>,
    cacheKey: string | undefined,
  ): Promise<ProviderOutcome> => {
    if (cacheKey !== undefined) {
      const cached = cache.get(cacheKey);
      if (cached !== undefined) return { source: provider.id, candidates: cached };
    }
    try {
      const candidates = await call(provider);
      if (cacheKey !== undefined) cache.set(cacheKey, candidates);
      return { source: provider.id, candidates };
    } catch (error) {
      if (!isUpstreamError(error)) throw error;
      // Fixed fields only. No URL, no query text, no coordinate.
      logger.warn(
        {
          provider: String(provider.id),
          kind: error.kind,
          ...(error.status !== undefined ? { status: error.status } : {}),
        },
        'A geocoding provider was skipped for this request',
      );
      return { source: provider.id, error };
    }
  };

  /**
   * A gateway that degrades instead of throwing.
   *
   * Wrapping rather than try/catching at each call site is what makes "the
   * database is just another provider" true rather than aspirational: every
   * path through the merge gets the same behaviour, including the reconciliation
   * lookups buried inside it.
   */
  const resilient = (gateway: PlacesGateway, onFailure: () => void): PlacesGateway => {
    const guard = async <T>(operation: () => Promise<T>, fallback: T): Promise<T> => {
      try {
        return await operation();
      } catch (error) {
        onFailure();
        logger.warn(
          { provider: 'goway', kind: 'places_unavailable', error: error instanceof Error ? error.name : 'unknown' },
          'GoWay Places was skipped for this request',
        );
        return fallback;
      }
    };
    return {
      findPlaceIdsBySourceRefs: (refs) => guard(() => gateway.findPlaceIdsBySourceRefs(refs), new Map()),
      findPlacesByIds: (ids) => guard(() => gateway.findPlacesByIds(ids), new Map()),
      findPlacesNearby: (query) => guard(() => gateway.findPlacesNearby(query), []),
      findPlacesInBounds: (query) => guard(() => gateway.findPlacesInBounds(query), []),
    };
  };

  /**
   * GoWay's own places for a query, when the query is anchored somewhere.
   *
   * With neither a `near` nor a `viewport` there is nothing to scan around: the
   * alternative would be a name scan of every place on Earth, truncated by a
   * `LIMIT`, which reads to a user as missing data. An unanchored search still
   * surfaces GoWay places — through reconciliation, when a geocoder finds the
   * same record — it just cannot surface one the geocoders have never heard of.
   */
  const loadPlaces = async (
    gateway: PlacesGateway,
    query: ResolvedSearchQuery,
  ): Promise<{ places: Place[]; consulted: boolean }> => {
    const filters = {
      ...(query.capabilities && query.capabilities.length > 0 ? { capabilities: [...query.capabilities] } : {}),
      ...(query.categories && query.categories.length > 0 ? { categories: [...query.categories] } : {}),
      limit: Math.min(MAX_PLACES_CANDIDATES, query.limit * PLACES_CANDIDATE_MULTIPLIER),
    };

    let found: Place[];
    if (query.near) {
      found = await gateway.findPlacesNearby({
        latitude: query.near.latitude,
        longitude: query.near.longitude,
        radiusMeters: options.config.placesRadiusMeters,
        ...filters,
      });
    } else if (query.viewport) {
      found = await gateway.findPlacesInBounds({ ...query.viewport, ...filters });
    } else {
      return { places: [], consulted: false };
    }

    // An explicit category or capability filter IS the question; the typed text
    // then biases the order rather than excluding rows. Without one, the text is
    // all there is to go on, so a place has to match it.
    const filtered =
      (query.categories?.length ?? 0) > 0 || (query.capabilities?.length ?? 0) > 0
        ? found
        : found.filter((place) => placeMatchesText(place, query.query));
    return { places: filtered.slice(0, query.limit), consulted: true };
  };

  /** Assemble the response from provider outcomes plus the Places side. */
  const assemble = async (
    outcomes: readonly ProviderOutcome[],
    context: {
      gateway: PlacesGateway;
      places: readonly Place[];
      placesConsulted: boolean;
      placesDegraded: boolean;
      limit: number;
      capabilities?: readonly CapabilityKey[];
      bias?: SpatialBias | undefined;
    },
  ): Promise<SearchResults> => {
    const lists: CandidateList[] = outcomes.flatMap((outcome) =>
      outcome.candidates ? [{ source: outcome.source, candidates: outcome.candidates }] : [],
    );

    const results = await mergeCandidates({
      lists,
      places: context.places,
      gateway: context.gateway,
      limit: context.limit,
      ...(context.capabilities ? { capabilities: context.capabilities } : {}),
      bias: context.bias,
    });

    const answered = outcomes.filter((outcome) => outcome.candidates !== undefined);
    if (answered.length === 0 && results.length === 0) {
      const failure = worstFailure(outcomes);
      // Nothing answered and nothing was found: this is not an empty result,
      // it is an outage, and a caller that cannot tell them apart will cache
      // "no such place" for a place that exists.
      if (failure) throw failure.toApiError();
    }

    const providers: SearchSource[] = answered.map((outcome) => outcome.source);
    const degraded: SearchSource[] = outcomes.flatMap((outcome) => (outcome.error ? [outcome.source] : []));
    // GoWay Places contributed if it was scanned for candidates OR if it
    // reconciled one — an unanchored search never scans, but a result carrying
    // a `placeId` came from the same database and was answered by it.
    const placesContributed =
      context.placesConsulted || results.some((result) => result.placeId !== undefined);
    if (placesContributed && !context.placesDegraded) providers.push('goway');
    if (context.placesDegraded) degraded.push('goway');

    return {
      results,
      providers,
      ...(degraded.length > 0 ? { degradedProviders: degraded } : {}),
    };
  };

  /**
   * Whether this request's upstream answers may be cached.
   *
   * Only a query with NO coordinate in it. See `cache.ts`: a bounded in-process
   * entry is not "history", but it is a copy of a precise location held past
   * the request that carried it, in a process that writes logs and dumps heap.
   */
  const shouldCache = (query: { near?: GeoCoordinate; viewport?: GeoBoundingBox }): boolean =>
    query.near === undefined && query.viewport === undefined;

  const forwardWith = async (
    selected: readonly SearchProvider[],
    query: ResolvedSearchQuery,
    context: SearchRequestContext,
    mode: 'search' | 'geocode',
  ): Promise<SearchResults> => {
    let placesDegraded = false;
    const gateway = resilient(context.gateway, () => {
      placesDegraded = true;
    });
    const cacheable = shouldCache(query);

    const [outcomes, places] = await Promise.all([
      Promise.all(
        selected.map((provider) =>
          run(
            provider,
            (target) =>
              target.forward({
                query: query.query,
                limit: query.limit,
                ...(query.locale !== undefined ? { locale: query.locale } : {}),
                ...(query.near ? { near: query.near } : {}),
                ...(query.viewport ? { viewport: query.viewport } : {}),
                ...(query.categories ? { categories: query.categories } : {}),
                ...(context.signal ? { signal: context.signal } : {}),
              }),
            cacheable
              ? [
                  mode,
                  provider.id,
                  query.query.toLowerCase(),
                  String(query.limit),
                  query.locale ?? '',
                  (query.categories ?? []).join(','),
                ].join('|')
              : undefined,
          ),
        ),
      ),
      loadPlaces(gateway, query),
    ]);

    return assemble(outcomes, {
      gateway,
      places: places.places,
      placesConsulted: places.consulted,
      placesDegraded,
      limit: query.limit,
      ...(query.capabilities ? { capabilities: query.capabilities } : {}),
      bias: spatialBiasFor(query),
    });
  };

  return {
    search: (query, context) => forwardWith(interactiveProviders, query, context, 'search'),

    forward: (query, context) => forwardWith(options.providers, query, context, 'geocode'),

    async reverse(query, context) {
      let placesDegraded = false;
      const gateway = resilient(context.gateway, () => {
        placesDegraded = true;
      });
      const radiusMeters = query.radiusMeters ?? REVERSE_PLACES_RADIUS_METERS;

      const [outcomes, places] = await Promise.all([
        Promise.all(
          options.providers.map((provider) =>
            run(
              provider,
              (target) =>
                target.reverse({
                  coordinate: query.coordinate,
                  limit: query.limit,
                  ...(query.radiusMeters !== undefined ? { radiusMeters: query.radiusMeters } : {}),
                  ...(query.locale !== undefined ? { locale: query.locale } : {}),
                  ...(context.signal ? { signal: context.signal } : {}),
                }),
              // Never cached: the key would BE the user's coordinate.
              undefined,
            ),
          ),
        ),
        gateway.findPlacesNearby({
          latitude: query.coordinate.latitude,
          longitude: query.coordinate.longitude,
          radiusMeters,
          limit: query.limit,
        }),
      ]);

      return assemble(outcomes, {
        gateway,
        places,
        placesConsulted: true,
        placesDegraded,
        limit: query.limit,
        bias: { center: query.coordinate, decayMeters: radiusMeters },
      });
    },

    async structured(query, context) {
      let placesDegraded = false;
      const gateway = resilient(context.gateway, () => {
        placesDegraded = true;
      });

      // Providers with no structured endpoint are SKIPPED, not degraded: they
      // did not fail, they were never asked, and reporting them as degraded
      // would tell a client a source is down when it is merely not applicable.
      const capable = options.providers.filter((provider) => provider.structured !== undefined);
      if (capable.length === 0 && options.providers.length > 0) {
        throw new ApiError(
          'provider_unavailable',
          'No configured geocoding provider supports structured address lookup.',
        );
      }

      const outcomes = await Promise.all(
        capable.map((provider) =>
          run(
            provider,
            (target) => {
              // Narrowed above; the check is restated because `capable` and the
              // call site are separated by a closure the compiler cannot follow.
              if (!target.structured) throw new ApiError('internal_error', 'Provider lost its structured endpoint.');
              return target.structured({
                limit: query.limit,
                ...(query.street !== undefined ? { street: query.street } : {}),
                ...(query.houseNumber !== undefined ? { houseNumber: query.houseNumber } : {}),
                ...(query.city !== undefined ? { city: query.city } : {}),
                ...(query.region !== undefined ? { region: query.region } : {}),
                ...(query.postalCode !== undefined ? { postalCode: query.postalCode } : {}),
                ...(query.countryCode !== undefined ? { countryCode: query.countryCode } : {}),
                ...(query.locale !== undefined ? { locale: query.locale } : {}),
                ...(context.signal ? { signal: context.signal } : {}),
              });
            },
            [
              'structured',
              provider.id,
              query.street ?? '',
              query.houseNumber ?? '',
              query.city ?? '',
              query.region ?? '',
              query.postalCode ?? '',
              query.countryCode ?? '',
              String(query.limit),
              query.locale ?? '',
            ].join('|'),
          ),
        ),
      );

      return assemble(outcomes, {
        gateway,
        places: [],
        // A structured lookup has no coordinate to scan GoWay Places around, so
        // the Places side contributes only through reconciliation.
        placesConsulted: false,
        placesDegraded,
        limit: query.limit,
      });
    },
  };
}

/**
 * Provider-neutral search, geocoding and reverse geocoding contracts.
 *
 * Photon is the initial interactive geocoder and Nominatim an additional
 * adapter for explicit lookups, but neither shape reaches this file: a client
 * that can tell which geocoder answered is a client that breaks when GoWay
 * changes one. Consumers always receive {@link SearchResult}.
 *
 * ## The wire parameters are flat
 *
 * A query string has no nesting, so the HTTP parameters spell a `near` bias as
 * `latitude`/`longitude` and a viewport as bare `west`/`south`/`east`/`north`
 * ({@link searchParametersSchema}). The SDK's {@link SearchQuery} keeps the
 * named shapes and {@link searchParametersOf} flattens them — one mapping, here,
 * so the SDK and the server cannot disagree about it.
 *
 * ## Results page by OFFSET, to a fixed depth
 *
 * A blended result list has no keyset: its order is a fused score over several
 * providers' rankings, recomputed per request. So a search cursor is an offset
 * into that order, and the list ends at {@link SEARCH_MAX_DEPTH} — past it, a
 * search box is not the tool, and every provider's own relevance is noise.
 */

import { z } from 'zod';
import { boundingBoxWidth, geoBoundingBoxSchema, geoCoordinateSchema, latitudeSchema, longitudeSchema } from './geo';
import type { GeoBoundingBox, GeoCoordinate } from './geo';
import { capabilityFilterSchema } from './capability-registry';
import { categoryKeySchema } from './category';
import { languageTagSchema } from './language';
import { cursorSchema } from './pagination';
import {
  MAX_BOUNDS_SPAN_DEGREES,
  MAX_RADIUS_METERS,
  placeIdSchema,
  placeSchema,
  structuredAddressSchema,
} from './place';

/** What kind of thing a search result denotes. */
export const SEARCH_RESULT_KINDS = ['place', 'address', 'street', 'locality', 'region', 'country', 'poi'] as const;
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];

/** Where a search candidate came from. Open-ended: a new provider is not a contract change. */
export const SEARCH_SOURCES = ['goway', 'photon', 'nominatim'] as const;
export type SearchSource = (typeof SEARCH_SOURCES)[number] | (string & {});

/** Administrative context, as far as the source supplies it. */
export const searchResultContextSchema = z.object({
  city: z.string().optional(),
  region: z.string().optional(),
  country: z.string().optional(),
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: z.string().optional(),
});
export type SearchResultContext = z.infer<typeof searchResultContextSchema>;

/**
 * One normalized search candidate.
 *
 * `id` is deterministic for a given (source, sourceId) pair so a result list can
 * be diffed and de-duplicated across requests rather than re-keyed by index.
 */
export const searchResultSchema = z.object({
  id: z.string().min(1),
  /** Human-readable label, ready to render. */
  displayName: z.string().min(1),
  kind: z.enum(SEARCH_RESULT_KINDS),
  coordinate: geoCoordinateSchema,
  /** Present when the source supplies an extent — use it to frame the camera. */
  boundingBox: geoBoundingBoxSchema.optional(),
  address: structuredAddressSchema.optional(),
  context: searchResultContextSchema.optional(),
  /** Which provider produced this candidate. Never dropped. */
  source: z.string().min(1),
  /** The provider's own identifier, verbatim. */
  sourceId: z.string().min(1).optional(),
  /**
   * Set when this candidate reconciles to a GoWay-owned place. Its presence is
   * what lets a result carry ecosystem capabilities and Oxy verification.
   */
  placeId: placeIdSchema.optional(),
  /** The reconciled GoWay place, when GoWay holds one. */
  place: placeSchema.optional(),
  /** Provider relevance, normalized to 0..1. Not comparable across providers. */
  relevance: z.number().min(0).max(1).optional(),
});
export type SearchResult = z.infer<typeof searchResultSchema>;

/**
 * A page of search results.
 *
 * `{ items, nextCursor }` like every GoWay list, plus `providers`: a degraded
 * provider produces a short list rather than an error, so a consumer that wants
 * to say "some sources are unavailable" needs this to tell the two apart.
 */
export const searchResultsSchema = z.object({
  items: z.array(searchResultSchema),
  nextCursor: cursorSchema.nullable(),
  /** Providers that contributed to this response. */
  providers: z.array(z.string().min(1)),
  /** Providers that were asked but failed or timed out. */
  degradedProviders: z.array(z.string().min(1)).optional(),
});
export type SearchResults = z.infer<typeof searchResultsSchema>;

// ── Requests ────────────────────────────────────────────────────────────────

/** The most results one search page returns. A deployment may configure a lower ceiling. */
export const SEARCH_MAX_LIMIT = 50;

/** The deepest result position a search lists, across all its pages. */
export const SEARCH_MAX_DEPTH = 50;

/** Longest accepted query text, in characters. */
export const MAX_SEARCH_QUERY_LENGTH = 256;

/**
 * Absent means "the deployment's default" (`SEARCH_DEFAULT_LIMIT`), which the
 * server applies — a default baked in here would make that variable a lie.
 */
const searchLimitSchema = z.number().int().min(1).max(SEARCH_MAX_LIMIT);

const searchListFields = {
  limit: searchLimitSchema.optional(),
  /** BCP 47 tag for localized names, where the provider supports it. */
  locale: languageTagSchema.optional(),
  cursor: cursorSchema.optional(),
};

/**
 * `GET /search` and `GET /geocode` — free text, as it travels.
 *
 * `near` (`latitude`/`longitude`) and the viewport are each all-or-nothing: a
 * half-specified bias is a client bug, and quietly ignoring the half that
 * arrived would produce a differently-ordered list than the caller asked for.
 */
export const searchParametersSchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
    latitude: latitudeSchema.optional(),
    longitude: longitudeSchema.optional(),
    west: longitudeSchema.optional(),
    south: latitudeSchema.optional(),
    east: longitudeSchema.optional(),
    north: latitudeSchema.optional(),
    /** Only candidates whose reconciled place has every listed capability (`key` or `key:value`). */
    capabilities: z.array(capabilityFilterSchema).max(64).optional(),
    /** Taxonomy keys; a parent matches its descendants. A key that is not a category is `validation_failed`. */
    categories: z.array(categoryKeySchema).max(64).optional(),
    ...searchListFields,
  })
  .strict()
  .refine((query) => (query.latitude === undefined) === (query.longitude === undefined), {
    message: 'latitude and longitude must be given together',
    path: ['latitude'],
  })
  .refine(
    (query) =>
      [query.west, query.south, query.east, query.north].every((value) => value === undefined) ||
      [query.west, query.south, query.east, query.north].every((value) => value !== undefined),
    { message: 'a viewport needs west, south, east and north', path: ['west'] },
  )
  .refine((query) => query.south === undefined || query.north === undefined || query.south <= query.north, {
    message: 'south must not be north of north',
    path: ['south'],
  })
  .refine(
    (query) =>
      query.south === undefined || query.north === undefined || query.north - query.south <= MAX_BOUNDS_SPAN_DEGREES,
    { message: 'the viewport is too tall', path: ['north'] },
  )
  .refine(
    (query) =>
      query.west === undefined ||
      query.east === undefined ||
      boundingBoxWidth({ west: query.west, east: query.east }) <= MAX_BOUNDS_SPAN_DEGREES,
    { message: 'the viewport is too wide', path: ['east'] },
  );
export type SearchParameters = z.input<typeof searchParametersSchema>;

/**
 * A free-text search, as an SDK caller writes it.
 *
 * Exactly one biasing strategy applies at a time, strongest first: `near` beats
 * `viewport`, and neither is a filter — both only re-rank.
 */
export type SearchQuery = Omit<SearchParameters, 'q' | 'latitude' | 'longitude' | 'west' | 'south' | 'east' | 'north'> & {
  query: string;
  /** Bias results toward this coordinate. */
  near?: GeoCoordinate;
  /** Bias results toward the visible map area. */
  viewport?: GeoBoundingBox;
};

/** The flat wire parameters for a {@link SearchQuery}. */
export function searchParametersOf(query: SearchQuery): SearchParameters {
  const { query: text, near, viewport, ...rest } = query;
  return {
    ...rest,
    q: text,
    ...(near ? { latitude: near.latitude, longitude: near.longitude } : {}),
    ...(viewport ? { west: viewport.west, south: viewport.south, east: viewport.east, north: viewport.north } : {}),
  };
}

/** `GET /geocode/reverse` — what is at this coordinate. */
export const reverseGeocodeQuerySchema = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    /** Search radius around the coordinate. */
    radiusMeters: z.number().positive().max(MAX_RADIUS_METERS).optional(),
    ...searchListFields,
  })
  .strict();
export type ReverseGeocodeQuery = z.input<typeof reverseGeocodeQuerySchema>;

/** One optional structured-address component. */
const addressPartSchema = z.string().trim().min(1).max(256).optional();

/** The fields a structured lookup may name. */
export const STRUCTURED_GEOCODE_FIELDS = ['street', 'houseNumber', 'city', 'region', 'postalCode', 'countryCode'] as const;

/** `GET /geocode/structured` — an address lookup with the parts already separated. */
export const structuredGeocodeQuerySchema = z
  .object({
    street: addressPartSchema,
    houseNumber: addressPartSchema,
    city: addressPartSchema,
    region: addressPartSchema,
    postalCode: addressPartSchema,
    /** Upper-cased, as the contract spells it. */
    countryCode: z
      .string()
      .trim()
      .regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')
      .transform((code) => code.toUpperCase())
      .optional(),
    ...searchListFields,
  })
  .strict()
  .refine((query) => STRUCTURED_GEOCODE_FIELDS.some((field) => query[field] !== undefined), {
    // An empty structured lookup is not "match everything": it is a request
    // with no question in it, and answering it would be a scan of the planet.
    message: `a structured lookup needs at least one of ${STRUCTURED_GEOCODE_FIELDS.join(', ')}`,
    path: ['(root)'],
  });
export type StructuredGeocodeQuery = z.input<typeof structuredGeocodeQuerySchema>;

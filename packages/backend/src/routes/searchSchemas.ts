/**
 * The search, geocoding and reverse-geocoding request schemas.
 *
 * ## Parameter names are the SDK's, verbatim
 *
 * `@goway.to/sdk` is published contract. It sends `q`, `latitude`/`longitude`
 * for a `near` bias, bare `west`/`south`/`east`/`north` for a viewport,
 * comma-joined `capabilities`/`categories`, `limit` and `locale`; reverse takes
 * `latitude`, `longitude`, `radiusMeters`; structured takes `street`,
 * `houseNumber`, `city`, `region`, `postalCode`, `countryCode`. Those spellings
 * are what these schemas read. The short forms a hand-written `curl` reaches
 * for (`lat`, `lng`, `radius`, `bbox`) are resolved onto them first, exactly as
 * the Places endpoints do — one alias table, so the two surfaces cannot drift.
 *
 * ## Everything here is `validation_failed`, never a 500
 *
 * `parseQuery` answers every failure as `validation_failed` (422): a query
 * string carries only strings, so nothing in it can be "the wrong type" — a
 * latitude of `abc` is a refused VALUE, not a serialisation bug. And the error
 * details name the FIELD and never the value, because a validation failure on a
 * coordinate must not be the thing that writes a user's location into a log.
 */

import { z } from 'zod';
import {
  capabilityKeyParam,
  MAX_BOUNDS_SPAN_DEGREES,
  MAX_RADIUS_METERS,
  setParam,
  withQueryAliases,
} from './placeSchemas';

/**
 * The most results one search response will return.
 *
 * The configured `SEARCH_MAX_LIMIT` clamps further; this is the outer bound the
 * HTTP layer will even parse, so an absurd `limit` is refused rather than
 * silently reinterpreted.
 */
export const MAX_SEARCH_LIMIT = 50;

/** Longest accepted query text, in characters. */
const MAX_QUERY_LENGTH = 256;

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const latitudeParam = z.coerce.number().min(-90).max(90);
const longitudeParam = z.coerce.number().min(-180).max(180);

/**
 * Absent means "apply the configured default", which the service does — not
 * this schema. A default baked in here would override a deployment's
 * `SEARCH_DEFAULT_LIMIT` and make that variable a lie.
 */
const limitParam = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().min(1).max(MAX_SEARCH_LIMIT).optional(),
);

/**
 * A BCP-47 language tag.
 *
 * Shape-checked only. Whether a given provider can localize into it is the
 * adapter's problem (Photon answers 400 for a language it was not built with,
 * so it filters); refusing an unknown-but-well-formed tag here would make GoWay
 * the arbiter of a registry it does not hold.
 */
const localeParam = z.preprocess(
  emptyAsUndefined,
  z
    .string()
    .trim()
    .max(35)
    .regex(/^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/, 'must be a BCP-47 language tag')
    .optional(),
);

const listFilters = {
  capabilities: capabilityKeyParam,
  categories: setParam,
  limit: limitParam,
  locale: localeParam,
};

/** One optional structured-address component. */
const addressPart = z.preprocess(emptyAsUndefined, z.string().trim().min(1).max(256).optional());

/**
 * Free-text search.
 *
 * `near` and the viewport are each all-or-nothing: a half-specified bias is a
 * client bug, and quietly ignoring the half that arrived would produce a
 * differently-ordered list than the caller asked for with nothing to show why.
 */
export const searchQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(MAX_QUERY_LENGTH),
    latitude: latitudeParam.optional(),
    longitude: longitudeParam.optional(),
    west: longitudeParam.optional(),
    south: latitudeParam.optional(),
    east: longitudeParam.optional(),
    north: latitudeParam.optional(),
    ...listFilters,
  })
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
    // A wrap, not an inversion: `170 → -170` spans 20°, not 340°.
    (query) =>
      query.west === undefined ||
      query.east === undefined ||
      (query.east >= query.west ? query.east - query.west : 360 - query.west + query.east) <=
        MAX_BOUNDS_SPAN_DEGREES,
    { message: 'the viewport is too wide', path: ['east'] },
  );

export type SearchQueryInput = z.infer<typeof searchQuerySchema>;

export const reverseQuerySchema = z.object({
  latitude: latitudeParam,
  longitude: longitudeParam,
  radiusMeters: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().positive().max(MAX_RADIUS_METERS).optional(),
  ),
  limit: limitParam,
  locale: localeParam,
});

export type ReverseQueryInput = z.infer<typeof reverseQuerySchema>;

const STRUCTURED_FIELDS = ['street', 'houseNumber', 'city', 'region', 'postalCode', 'countryCode'] as const;

export const structuredQuerySchema = z
  .object({
    street: addressPart,
    houseNumber: addressPart,
    city: addressPart,
    region: addressPart,
    postalCode: addressPart,
    /**
     * Upper-cased, as the contract spells it. Case-folding a country code is
     * not inventing a fact — unlike deriving a missing one, which nothing does.
     */
    countryCode: z.preprocess(
      emptyAsUndefined,
      z
        .string()
        .trim()
        .regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')
        .transform((code) => code.toUpperCase())
        .optional(),
    ),
    limit: limitParam,
    locale: localeParam,
  })
  .refine((query) => STRUCTURED_FIELDS.some((field) => query[field] !== undefined), {
    // An empty structured lookup is not "match everything": it is a request
    // with no question in it, and answering it would be a scan of the planet.
    message: `a structured lookup needs at least one of ${STRUCTURED_FIELDS.join(', ')}`,
    path: ['(root)'],
  });

export type StructuredQueryInput = z.infer<typeof structuredQuerySchema>;

/**
 * Resolve the short parameter names onto the SDK's, plus `query` → `q`.
 *
 * The Places alias table (`lat`, `lng`, `radius`, `bbox`) is reused rather than
 * restated: two tables would be two chances for `bbox` to mean a different
 * order on a different endpoint.
 */
export function withSearchQueryAliases(query: Record<string, unknown>): Record<string, unknown> {
  const resolved = withQueryAliases(query);
  if (resolved.q === undefined && resolved.query !== undefined) resolved.q = resolved.query;
  return resolved;
}

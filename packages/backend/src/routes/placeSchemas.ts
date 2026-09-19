/**
 * The Places request schemas.
 *
 * These are the OUTER boundary: everything below them — the repository, the
 * spatial predicates, the table CHECK constraints — is entitled to assume a
 * latitude is a latitude. Each schema is deliberately at least as strict as the
 * constraint behind it, so a value the database would refuse is a 422 naming
 * the field rather than a 500 carrying a constraint name.
 *
 * ## Parameter names come from the SDK, not from the issue text
 *
 * `@goway.to/sdk` is published contract and it sends `latitude`, `longitude`,
 * `radiusMeters` and `west/south/east/north`. Issue #4 sketches `lat`, `lng`,
 * `radius` and `bbox`, which is the spelling a hand-written `curl` or a map
 * embed reaches for. Both are accepted — the SDK's spelling is canonical and
 * the short forms are aliases resolved before parsing — because a mismatch
 * between the SDK and the API is a silent integration break, and refusing the
 * documented short form would be a second one.
 *
 * ## `south <= north` is validated and `west <= east` is NOT
 *
 * The asymmetry is the contract, not an oversight. `west > east` is how a box
 * crossing the antimeridian is spelled (`170 → -170` is the 20° Pacific strip),
 * and refusing it would make the Pacific unmappable. `south > north` describes
 * no box at all.
 */

import { z } from 'zod';
import type { OpeningHoursInterval, PlaceStatus } from '@goway/shared-types';

/** The most places one list response will return. */
export const MAX_LIST_LIMIT = 200;
/** What a caller gets when they ask for no particular number. */
export const DEFAULT_LIST_LIMIT = 50;

/**
 * The largest radius a nearby query may ask for, in metres.
 *
 * 50 km: past that the question is no longer "what is near me" and the answer
 * is a scan of a continent that the `LIMIT` truncates arbitrarily, which looks
 * like missing data rather than a refused query.
 */
export const MAX_RADIUS_METERS = 50_000;

/**
 * The widest viewport a bounds query may ask for, in degrees on either axis.
 *
 * A `geography` envelope's edges are GREAT CIRCLES. Past roughly 50–58° of
 * longitude in a narrow latitude band the edges bulge poleward enough that the
 * box can exclude its own centre, and a box exactly 180° wide makes PostGIS
 * raise `Antipodal (180 degrees long) edge detected!` — a 500 for a request
 * that is merely unreasonable. Every realistic map viewport is far inside this;
 * a caller who wants the planet wants a different endpoint.
 */
export const MAX_BOUNDS_SPAN_DEGREES = 90;

/** Longest accepted place name, in characters. */
const MAX_NAME_LENGTH = 200;
const MAX_CATEGORIES = 32;
const MAX_SOURCES = 32;
const MAX_CAPABILITIES = 64;

// ── Query primitives ────────────────────────────────────────────────────────

/** A shell and a URL both spell "absent" as an empty string; zod should not see one. */
const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const latitudeParam = z.coerce.number().min(-90).max(90);
const longitudeParam = z.coerce.number().min(-180).max(180);

const limitParam = z.preprocess(
  emptyAsUndefined,
  z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).default(DEFAULT_LIST_LIMIT),
);

/**
 * A set-valued query parameter.
 *
 * The SDK joins members with an unencoded comma into ONE parameter; a
 * hand-written client is as likely to repeat the parameter. Both arrive here.
 * Members are de-duplicated and empty members dropped, so `a,,b` is `[a, b]`
 * rather than a filter that matches nothing.
 */
const setParam = z.preprocess((value) => {
  if (value === undefined || value === null) return undefined;
  const members = (Array.isArray(value) ? value : [value])
    .flatMap((entry) => String(entry).split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return members.length === 0 ? undefined : [...new Set(members)];
}, z.array(z.string().max(128)).max(64).optional());

/**
 * A capability filter key: `<namespace>.<capability>`, at least two parts.
 *
 * A bare `faircoin` would match nothing and is far more likely a typo than an
 * intent, so it is refused rather than answered with an empty list — the SDK
 * makes the same check before sending, and this is the half that also covers
 * every non-SDK caller.
 */
const capabilityKeyParam = z.preprocess(
  (value) => setParam.parse(value),
  z
    .array(z.string().regex(/^[^.\s]+(?:\.[^.\s]+)+$/, 'must be a dotted capability key'))
    .optional(),
);

const listFilters = {
  capabilities: capabilityKeyParam,
  categories: setParam,
  limit: limitParam,
};

// ── Query schemas ───────────────────────────────────────────────────────────

export const nearbyQuerySchema = z.object({
  latitude: latitudeParam,
  longitude: longitudeParam,
  radiusMeters: z.coerce.number().positive().max(MAX_RADIUS_METERS),
  ...listFilters,
});

export type NearbyQueryInput = z.infer<typeof nearbyQuerySchema>;

export const boundsQuerySchema = z
  .object({
    west: longitudeParam,
    south: latitudeParam,
    east: longitudeParam,
    north: latitudeParam,
    ...listFilters,
  })
  .refine((box) => box.south <= box.north, {
    message: 'south must not be north of north',
    path: ['south'],
  })
  .refine((box) => box.north - box.south <= MAX_BOUNDS_SPAN_DEGREES, {
    message: 'the box is too tall',
    path: ['north'],
  })
  .refine(
    // The antimeridian case is a WRAP, not an inversion: `170 → -170` spans 20°,
    // not 340°. Measuring it the naive way would refuse every Pacific viewport
    // while admitting the enormous boxes this guard exists for.
    (box) => (box.east >= box.west ? box.east - box.west : 360 - box.west + box.east) <= MAX_BOUNDS_SPAN_DEGREES,
    { message: 'the box is too wide', path: ['east'] },
  );

export type BoundsQueryInput = z.infer<typeof boundsQuerySchema>;

/**
 * Resolve the documented short parameter names onto the SDK's.
 *
 * Only when the canonical name is absent — a request carrying both is answered
 * against the canonical one rather than being refused, because the two never
 * disagree in practice and a 422 for a redundant alias helps nobody.
 */
export function withQueryAliases(query: Record<string, unknown>): Record<string, unknown> {
  const resolved: Record<string, unknown> = { ...query };
  const alias = (canonical: string, short: string): void => {
    if (resolved[canonical] === undefined && resolved[short] !== undefined) {
      resolved[canonical] = resolved[short];
    }
  };
  alias('latitude', 'lat');
  alias('longitude', 'lng');
  alias('radiusMeters', 'radius');

  // `bbox=west,south,east,north` — GeoJSON's own order (RFC 7946 §5),
  // LONGITUDE first, which is the order every map library emits.
  const bbox = resolved.bbox;
  if (typeof bbox === 'string' && resolved.west === undefined) {
    const parts = bbox.split(',').map((part) => part.trim());
    if (parts.length === 4) {
      [resolved.west, resolved.south, resolved.east, resolved.north] = parts;
    }
  }
  return resolved;
}

// ── Write schemas ───────────────────────────────────────────────────────────

const coordinate = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
});

/**
 * A GeoJSON position — `[longitude, latitude]`, LONGITUDE FIRST (RFC 7946
 * §3.1.1).
 *
 * The ranges are checked PER AXIS, which is what catches a transposed pair: a
 * latitude in the longitude slot is legal arithmetic and an absurd place, and
 * only the ±90 bound tells the two apart.
 */
const position = z.union([
  z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]),
  z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90), z.number().finite()]),
]);

const ring = z.array(position).min(4, 'a linear ring needs at least four positions');

const geometry = z.discriminatedUnion('type', [
  z.object({ type: z.literal('Point'), coordinates: position }),
  z.object({ type: z.literal('LineString'), coordinates: z.array(position).min(2) }),
  z.object({ type: z.literal('Polygon'), coordinates: z.array(ring).min(1) }),
  z.object({ type: z.literal('MultiPolygon'), coordinates: z.array(z.array(ring).min(1)).min(1) }),
]);

const address = z.object({
  houseNumber: z.string().max(64).optional(),
  street: z.string().max(256).optional(),
  locality: z.string().max(128).optional(),
  city: z.string().max(128).optional(),
  region: z.string().max(128).optional(),
  postalCode: z.string().max(32).optional(),
  /**
   * Normalized to uppercase, which the table's CHECK requires. Case-folding a
   * country code is not inventing a fact — unlike deriving a missing one, which
   * nothing here does: an inferred `postalCode` is indistinguishable from a
   * real one downstream.
   */
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')
    .transform((code) => code.toUpperCase())
    .optional(),
  country: z.string().max(128).optional(),
  formatted: z.string().max(512).optional(),
});

const contact = z.object({
  phone: z.string().max(64).optional(),
  email: z.string().email().max(320).optional(),
  website: z
    .string()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL')
    .optional(),
});

const CLOCK_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const openingHours = z.object({
  intervals: z
    .array(
      z.object({
        // Narrowed to the contract's literal union after the range check, so
        // the parsed value is assignable to `OpeningHoursInterval` without a
        // cast at the call site — and a `z.union` of seven literals, which
        // would do the same, reports `invalid_union` instead of naming the
        // range a caller actually got wrong.
        day: z
          .number()
          .int()
          .min(0)
          .max(6)
          .transform((day) => day as OpeningHoursInterval['day']),
        opens: z.string().regex(CLOCK_TIME, 'must be a local 24-hour time, HH:mm'),
        closes: z.string().regex(CLOCK_TIME, 'must be a local 24-hour time, HH:mm'),
      }),
    )
    .max(64),
  /** IANA timezone. Required to evaluate the intervals; not validated against the tz database here. */
  timezone: z.string().max(64).optional(),
  raw: z.string().max(512).optional(),
});

const sourceRef = z.object({
  source: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(256),
});

/**
 * A capability assertion as a caller may write it.
 *
 * `verification` and `observedAt` are absent from this schema on purpose. Even
 * if a caller sends them they are dropped rather than refused — the server
 * derives both from who is asking and from whether a source is named, which is
 * the whole mechanism that stops a community report arriving labelled
 * `oxy_verified`. The shapes mirror the table's CHECK constraints so a bad key
 * is a 422 naming the field instead of a 500 naming a constraint.
 */
const capability = z.object({
  namespace: z.string().regex(/^[a-z0-9_-]+([.][a-z0-9_-]+)*$/, 'must be a lower-case dotted namespace').max(128),
  capability: z.string().regex(/^[a-z0-9_-]+$/, 'must be a lower-case capability name').max(64),
  value: z.union([z.boolean(), z.string().max(512), z.number().finite()]),
  source: sourceRef.optional(),
});

/**
 * The statuses a caller may set.
 *
 * `removed` is deliberately absent. Withdrawing a place from the map is a
 * moderation act that has to record who did it; a contributor saying a shop has
 * shut says `closed`. `satisfies readonly PlaceStatus[]` is what ties this to
 * the published tuple: renaming a status in `@goway/shared-types` fails this
 * file to compile rather than silently leaving an unwritable value behind.
 */
export const WRITABLE_PLACE_STATUSES = ['active', 'closed', 'proposed'] as const satisfies readonly PlaceStatus[];

/**
 * The fields a caller may set.
 *
 * `verification`, `id`, `createdAt`, `updatedAt` and the claim list are not
 * here and never will be: each is either GoWay's own statement about a place or
 * an act that has to be reviewed. A schema that merely ignored them would be
 * the same thing until somebody spread the parsed object into an update.
 */
const writableFields = {
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  location: coordinate,
  geometry,
  categories: z.array(z.string().trim().min(1).max(64)).max(MAX_CATEGORIES),
  address,
  contact,
  openingHours,
  status: z.enum(WRITABLE_PLACE_STATUSES),
  sources: z.array(sourceRef).max(MAX_SOURCES),
  capabilities: z.array(capability).max(MAX_CAPABILITIES),
};

export const createPlaceSchema = z.object({
  name: writableFields.name,
  location: writableFields.location,
  geometry: writableFields.geometry.optional(),
  categories: writableFields.categories.optional(),
  address: writableFields.address.optional(),
  contact: writableFields.contact.optional(),
  openingHours: writableFields.openingHours.optional(),
  status: writableFields.status.optional(),
  sources: writableFields.sources.optional(),
  capabilities: writableFields.capabilities.optional(),
});

export const updatePlaceSchema = z
  .object({
    name: writableFields.name.optional(),
    location: writableFields.location.optional(),
    geometry: writableFields.geometry.optional(),
    categories: writableFields.categories.optional(),
    address: writableFields.address.optional(),
    contact: writableFields.contact.optional(),
    openingHours: writableFields.openingHours.optional(),
    status: writableFields.status.optional(),
    sources: writableFields.sources.optional(),
    capabilities: writableFields.capabilities.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'an update must change at least one field',
    path: ['(root)'],
  });

export type CreatePlaceInput = z.infer<typeof createPlaceSchema>;
export type UpdatePlaceInput = z.infer<typeof updatePlaceSchema>;

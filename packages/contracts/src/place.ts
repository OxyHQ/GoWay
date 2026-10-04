/**
 * GoWay Places — the public contract for GoWay-owned place identity.
 *
 * ## Ownership boundary
 *
 * External/open map sources (OpenStreetMap and friends) own base geometry,
 * public labels and source-native POI facts. GoWay Places owns stable identity,
 * enrichment, claimed business relationships, ecosystem capabilities,
 * verification state and reconciliation metadata.
 *
 * These are *contracts*, not rows. The canonical Drizzle/PostGIS schema lives in
 * `packages/backend` and is deliberately not published: SDK consumers depend on
 * these stable shapes, never on GoWay's internal tables, columns or migrations.
 *
 * ## Requests are as strict as the table behind them
 *
 * The request schemas below are the OUTER boundary: everything under them — the
 * repository, the spatial predicates, the table CHECK constraints — is entitled
 * to assume a latitude is a latitude. Each is at least as strict as the
 * constraint behind it, so a value the database would refuse is a 422 naming
 * the field rather than a 500 carrying a constraint name. Response schemas are
 * looser on purpose: a published place may carry data an importer wrote, and a
 * client must still be able to read it.
 *
 * ## `south <= north` is validated and `west <= east` is NOT
 *
 * The asymmetry is the contract, not an oversight. `west > east` is how a box
 * crossing the antimeridian is spelled (`170 → -170` is the 20° Pacific strip),
 * and refusing it would make the Pacific unmappable. `south > north` describes
 * no box at all.
 */

import { z } from 'zod';
import {
  boundingBoxWidth,
  geoCoordinateSchema,
  geoGeometrySchema,
  latitudeSchema,
  longitudeSchema,
} from './geo';
import {
  CAPABILITY_VERIFICATIONS,
  capabilityFilterOf,
  capabilityFilterSchema,
  capabilityHolds,
  capabilityValueInputSchema,
  capabilityValueSchema,
  capabilityValueSchemaFor,
  isCapabilityKey,
  type CapabilityKey,
} from './capability-registry';
import { categoryKeySchema, publishedCategoryKeySchema } from './category';
import { openingHoursInputSchema, openingHoursSchema, placeHoursExceptionSchema, timezoneSchema } from './hours';
import { canonicalLanguageTagSchema, languageTagSchema } from './language';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { instantSchema } from './time';

/**
 * A stable GoWay place identifier.
 *
 * Deliberately independent of every provider ID: an OSM node can be deleted,
 * renumbered or replaced without GoWay losing the identity of the real place,
 * and a GoWay-created place has an ID before it matches anything external.
 * This is the ID deep links use (`https://goway.to/place/<placeId>`).
 */
export type PlaceId = string;

/** A place id as it appears in a path or a body. Opaque: never parsed. */
export const placeIdSchema = z.string().trim().min(1).max(128);

/**
 * Lifecycle state of a place as GoWay understands it.
 *
 * `removed` and `merged` are stored states and never published ones. A removed
 * place answers `410 gone` by id and is absent from every list. A merged place
 * answers `410 gone` too, with `details.mergedInto` naming the place that
 * absorbed it (see {@link GONE_MERGED_INTO_DETAIL}).
 */
export const PLACE_STATUSES = ['active', 'closed', 'proposed', 'removed', 'merged'] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

/**
 * The statuses a caller may set.
 *
 * `removed` is deliberately absent. Withdrawing a place from the map is a
 * moderation act that has to record who did it; a contributor saying a shop has
 * shut says `closed`. `satisfies` ties this to the full tuple: renaming a
 * status fails this file to compile rather than leaving an unwritable value.
 */
export const WRITABLE_PLACE_STATUSES = ['active', 'closed', 'proposed'] as const satisfies readonly PlaceStatus[];
export type WritablePlaceStatus = (typeof WRITABLE_PLACE_STATUSES)[number];

/** The statuses a published place can carry: everything but `removed` and `merged`. */
export const PUBLISHED_PLACE_STATUSES = WRITABLE_PLACE_STATUSES;

/**
 * The statuses moderation may set directly.
 *
 * Everything a caller may write plus `removed`, which withdraws a place from the
 * map. `merged` is absent: a place becomes merged only by resolving a duplicate
 * candidate, which is what records the place that absorbed it.
 */
export const MODERATED_PLACE_STATUSES = [
  ...WRITABLE_PLACE_STATUSES,
  'removed',
] as const satisfies readonly PlaceStatus[];
export type ModeratedPlaceStatus = (typeof MODERATED_PLACE_STATUSES)[number];

/**
 * The `details` key of a `410 gone` that names where a MERGED place went.
 *
 * A merged place's id keeps answering, and the answer is a pointer rather than
 * a body: `{ "error": { "code": "gone", "details": { "mergedInto": "<placeId>" } } }`.
 * A consumer holding the old id replaces it with this one. The pointer is
 * always one hop: merging the survivor later re-points every place merged into
 * it. A removed place's `gone` carries no such key.
 */
export const GONE_MERGED_INTO_DETAIL = 'mergedInto';

// ── Address and contact ─────────────────────────────────────────────────────

/**
 * A postal address broken into parts, as far as the source actually supports.
 *
 * Every field is optional by design. Do not invent a missing structured field —
 * an inferred `postalCode` is indistinguishable from a real one downstream.
 */
export const structuredAddressSchema = z.object({
  /** House/building number. */
  houseNumber: z.string().optional(),
  street: z.string().optional(),
  /** Neighbourhood, district or suburb. */
  locality: z.string().optional(),
  /** City, town or village. */
  city: z.string().optional(),
  /** State, province or other first-level subdivision. */
  region: z.string().optional(),
  postalCode: z.string().optional(),
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: z.string().optional(),
  country: z.string().optional(),
  /** The source's own single-line rendering, when it provides one. */
  formatted: z.string().optional(),
});
export type StructuredAddress = z.infer<typeof structuredAddressSchema>;

/** A written address: bounded, and the country code case-folded as the table's CHECK requires. */
export const structuredAddressInputSchema = z.object({
  houseNumber: z.string().max(64).optional(),
  street: z.string().max(256).optional(),
  locality: z.string().max(128).optional(),
  city: z.string().max(128).optional(),
  region: z.string().max(128).optional(),
  postalCode: z.string().max(32).optional(),
  /**
   * Normalized to uppercase. Case-folding a country code is not inventing a
   * fact — unlike deriving a missing one, which nothing here does.
   */
  countryCode: z
    .string()
    .regex(/^[A-Za-z]{2}$/, 'must be an ISO 3166-1 alpha-2 code')
    .transform((code) => code.toUpperCase())
    .optional(),
  country: z.string().max(128).optional(),
  formatted: z.string().max(512).optional(),
});

/** Contact details, where a source actually publishes them. */
export const placeContactSchema = z.object({
  /** E.164 where available. */
  phone: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional(),
});
export type PlaceContact = z.infer<typeof placeContactSchema>;

export const placeContactInputSchema = z.object({
  phone: z.string().max(64).optional(),
  email: z.email().max(320).optional(),
  website: z
    .string()
    .max(2048)
    .refine((value) => /^https?:\/\//i.test(value), 'must be an http(s) URL')
    .optional(),
});

// ── Verification and provenance ─────────────────────────────────────────────

/** How strongly GoWay vouches for a place record itself. */
export const PLACE_VERIFICATION_STATES = ['unverified', 'community_reviewed', 'oxy_verified', 'owner_verified'] as const;
export type PlaceVerificationState = (typeof PLACE_VERIFICATION_STATES)[number];

/** Verification state plus when it was last established. */
export const placeVerificationSchema = z.object({
  state: z.enum(PLACE_VERIFICATION_STATES),
  /** ISO 8601 instant at which this state was last established. */
  verifiedAt: instantSchema.optional(),
});
export type PlaceVerification = z.infer<typeof placeVerificationSchema>;

/**
 * A link back to the source a fact came from.
 *
 * Provenance is never discarded and a source fact is never destructively
 * overwritten: GoWay enrichment layers *over* source data, so a later source
 * refresh can be reconciled instead of guessed at.
 */
export const placeSourceRefSchema = z.object({
  /** `openstreetmap`, `goway`, or another registered source key. Open-ended. */
  source: z.string().min(1),
  /** The identifier this source uses, verbatim. */
  sourceId: z.string().min(1),
  /** ISO 8601 instant at which this source last confirmed the record. */
  observedAt: instantSchema.optional(),
});
export type PlaceSourceRef = z.infer<typeof placeSourceRefSchema>;

/** A source reference as a writer names it. `observedAt` is the server's clock. */
export const placeSourceRefInputSchema = z.object({
  source: z.string().min(1).max(64),
  sourceId: z.string().min(1).max(256),
});
export type PlaceSourceRefInput = z.input<typeof placeSourceRefInputSchema>;

// ── Capabilities ────────────────────────────────────────────────────────────

/** A key split at its last dot: `payments.faircoin.accepted` → `payments.faircoin` + `accepted`. */
export function splitCapabilityKey(key: string): { namespace: string; capability: string } {
  const separator = key.lastIndexOf('.');
  return { namespace: key.slice(0, separator), capability: key.slice(separator + 1) };
}

/**
 * The two halves of a capability key, mirroring the table's CHECK constraints.
 *
 * A namespace may contain dots (`payments.faircoin`); a capability may not.
 * That asymmetry is what makes `<namespace>.<capability>` unambiguous to split
 * at the LAST dot, and it is why the generated `key` column can be a plain
 * concatenation without two different rows ever generating the same key.
 */
const CAPABILITY_NAMESPACE = /^[a-z0-9_-]+(?:[.][a-z0-9_-]+)*$/;
const CAPABILITY_NAME = /^[a-z0-9_-]+$/;

/**
 * One asserted capability of a place, with the provenance needed to decide how
 * much to trust it and how loudly to present it.
 */
export const placeCapabilitySchema = z
  .object({
    /** e.g. `payments.faircoin` */
    namespace: z.string().min(1),
    /** e.g. `accepted` */
    capability: z.string().min(1),
    /** The full `<namespace>.<capability>` key, for filtering. */
    key: z.string().min(1),
    /** Typed by the key's registry entry: a flag, an enum value, a set of them, a number, a URL or a text. */
    value: capabilityValueSchema,
    verification: z.enum(CAPABILITY_VERIFICATIONS),
    /**
     * ISO 8601 instant this claim was last observed. Freshness is part of the
     * contract: a two-year-old community report is not a current fact.
     */
    observedAt: instantSchema,
    /** The source that asserted it, when it came from outside GoWay. */
    source: placeSourceRefSchema.optional(),
  })
  .refine((capability) => capability.key === `${capability.namespace}.${capability.capability}`, {
    message: 'key must be <namespace>.<capability>',
    path: ['key'],
  });
export type PlaceCapability = z.infer<typeof placeCapabilitySchema>;

/**
 * A capability assertion as a caller may write it inside a place body.
 *
 * `verification` and `observedAt` are absent on purpose. Even if a caller sends
 * them they are dropped rather than refused — the server derives both from who
 * is asking and from whether a source is named, which is the whole mechanism
 * that stops a community report arriving labelled `oxy_verified`.
 *
 * The key must be registered and the value must fit its entry; the value comes
 * out normalized by that entry (a handle as its URL, a set in registry order).
 */
export const placeCapabilityInputSchema = z
  .object({
    /** e.g. `payments.faircoin` */
    namespace: z.string().max(128).regex(CAPABILITY_NAMESPACE, 'must be a lower-case dotted namespace'),
    /** e.g. `accepted` */
    capability: z.string().max(64).regex(CAPABILITY_NAME, 'must be a lower-case capability name'),
    value: capabilityValueInputSchema,
    /** The outside source this claim came from, when it did. */
    source: placeSourceRefInputSchema.optional(),
  })
  .transform((input, context) => {
    const key = `${input.namespace}.${input.capability}`;
    if (!isCapabilityKey(key)) {
      context.addIssue({ code: 'custom', message: 'must be a registered capability', path: ['capability'] });
      return z.NEVER;
    }
    const value = capabilityValueSchemaFor(key).safeParse(input.value);
    if (!value.success) {
      for (const issue of value.error.issues) {
        context.addIssue({ code: 'custom', message: issue.message, path: ['value', ...issue.path] });
      }
      return z.NEVER;
    }
    return { ...input, value: value.data };
  });
export type PlaceCapabilityInput = z.input<typeof placeCapabilityInputSchema>;

/**
 * The body of `PUT /places/{placeId}/capabilities/{key}`.
 *
 * `value` is REQUIRED rather than defaulted to `true`: a flag is one of seven
 * value kinds, and the key's registry entry — not this schema — says which.
 * Once the path has named the key the value is held to that entry
 * ({@link placeCapabilityAssertionSchemaFor}). A community reporter retracts
 * with `false` (or `no`), which is better evidence than a deletion.
 */
export const placeCapabilityAssertionSchema = z.object({
  value: capabilityValueInputSchema,
  source: placeSourceRefInputSchema.optional(),
});
export type PlaceCapabilityAssertion = z.input<typeof placeCapabilityAssertionSchema>;

/**
 * The same body, held to one key's registry entry. What the API applies once
 * the path has named the key, and what the SDK checks before sending.
 */
export function placeCapabilityAssertionSchemaFor(key: CapabilityKey) {
  return placeCapabilityAssertionSchema.extend({ value: capabilityValueSchemaFor(key) });
}

/**
 * The strongest assertion a place carries for one key, or `undefined`.
 *
 * Strongest by {@link CAPABILITY_VERIFICATIONS} order, then freshest. This is
 * the one answer to "does this place accept FairCoin": a business that asserts
 * `false` outranks a community report of `true`, and Oxy verification outranks
 * both.
 */
export function strongestCapability(
  place: { capabilities: readonly PlaceCapability[] },
  key: string,
): PlaceCapability | undefined {
  let strongest: PlaceCapability | undefined;
  for (const capability of place.capabilities) {
    if (capability.key !== key) continue;
    if (
      strongest === undefined ||
      CAPABILITY_VERIFICATIONS.indexOf(capability.verification) >
        CAPABILITY_VERIFICATIONS.indexOf(strongest.verification) ||
      (capability.verification === strongest.verification &&
        Date.parse(capability.observedAt) > Date.parse(strongest.observedAt))
    ) {
      strongest = capability;
    }
  }
  return strongest;
}

/**
 * Whether a place HAS a capability: its strongest assertion for the key holds
 * ({@link capabilityHolds}).
 *
 * The same rule the `?capabilities=` filter applies server-side. A place that
 * merely MENTIONS `payments.faircoin.accepted` — with `false`, because it
 * stopped — does not have it, and neither does one whose strongest wheelchair
 * assertion is `no`.
 */
export function placeHasCapability(place: { capabilities: readonly PlaceCapability[] }, key: string): boolean {
  const strongest = strongestCapability(place, key);
  return strongest !== undefined && capabilityHolds(key, strongest.value);
}

/**
 * Whether a place matches one `?capabilities=` entry — `key` or `key:value` —
 * by the rule the server's filter applies: its STRONGEST assertion of the key
 * holds, or carries the value (is it, for an enum or a price level; includes
 * it, for an enum set). A malformed filter matches nothing.
 */
export function placeMatchesCapabilityFilter(
  place: { capabilities: readonly PlaceCapability[] },
  filter: string,
): boolean {
  const parsed = capabilityFilterOf(filter);
  if (parsed === undefined) return false;
  if (parsed.value === undefined) return placeHasCapability(place, parsed.key);
  const strongest = strongestCapability(place, parsed.key);
  if (strongest === undefined) return false;
  return Array.isArray(strongest.value)
    ? strongest.value.includes(String(parsed.value))
    : strongest.value === parsed.value;
}

// ── Claims ──────────────────────────────────────────────────────────────────

/**
 * How an Oxy account relates to a physical place.
 *
 * A place and a business are related but distinct concepts, so this is
 * deliberately a list of claims rather than a single `ownerId` field — that
 * would make chains, franchises, shared venues and delegated management
 * unrepresentable without a later migration.
 */
export const PLACE_CLAIM_ROLES = ['owner', 'operator', 'manager', 'brand'] as const;
export type PlaceClaimRole = (typeof PLACE_CLAIM_ROLES)[number];

export const PLACE_CLAIM_STATES = ['pending', 'approved', 'rejected', 'revoked'] as const;
export type PlaceClaimState = (typeof PLACE_CLAIM_STATES)[number];

/** An Oxy account id as a caller names it. Opaque: never parsed. */
export const oxyAccountIdSchema = z.string().trim().min(1).max(128);

/**
 * A claimed relationship between an Oxy account and a place.
 *
 * The account is usually an Oxy ORGANIZATION: the business is the organization,
 * and Oxy decides who may act for it. A chain is an organization claiming each
 * of its locations in the `brand` role; there is no separate brand id.
 */
export const placeClaimSchema = z.object({
  id: z.string().min(1),
  /** The place this claim is over. */
  placeId: placeIdSchema,
  role: z.enum(PLACE_CLAIM_ROLES),
  state: z.enum(PLACE_CLAIM_STATES),
  /** The claiming Oxy account, usually an organization. Oxy owns identity; GoWay stores the reference only. */
  oxyAccountId: z.string().min(1),
  /** ISO 8601. */
  claimedAt: instantSchema,
  /** ISO 8601. When the claim left `pending`; absent while it is pending. */
  decidedAt: instantSchema.optional(),
});
export type PlaceClaim = z.infer<typeof placeClaimSchema>;

/**
 * The body of `POST /places/{placeId}/claims`.
 *
 * `state` is not here, and that absence is load-bearing: an APPROVED claim is
 * what earns `business_asserted` on this place's capabilities, so a caller who
 * could name their own state could promote their own assertions a tier.
 */
export const placeClaimInputSchema = z.object({
  role: z.enum(PLACE_CLAIM_ROLES),
  /**
   * The Oxy account to file the claim for — usually the business's
   * organization. Defaults to the session's own account. Naming another account
   * requires an `owner` or `admin` role in it, which GoWay checks with Oxy.
   */
  oxyAccountId: oxyAccountIdSchema.optional(),
});
export type PlaceClaimInput = z.input<typeof placeClaimInputSchema>;

// ── Names ───────────────────────────────────────────────────────────────────

/**
 * One of a place's names, in one language, from one source.
 *
 * A row rather than a key in a map, for the same reason {@link PlaceSourceRef}
 * is a row: a name has provenance. OpenStreetMap's `name:es` and a GoWay-owned
 * correction to the Spanish name are two statements about the same language,
 * and a `Record<string, string>` can hold only one of them.
 */
export const placeNameSchema = z.object({
  /**
   * Canonical BCP 47 tag — `es`, `ca`, `en-GB`, `zh-Hant`.
   *
   * This is the `xx` of OpenStreetMap's `name:xx`, normalized. It is never the
   * bare `name` key: that one is the place's DEFAULT name, published as
   * `Place.name`, and its language is frequently not recorded anywhere.
   */
  language: canonicalLanguageTagSchema,
  name: z.string(),
  /** Which source supplies this spelling. `goway` is GoWay's own correction. */
  source: z.string().min(1),
});
export type PlaceName = z.infer<typeof placeNameSchema>;

/** Longest accepted place name, in characters. */
const MAX_NAME_LENGTH = 200;

/**
 * One translated name as a caller may write it.
 *
 * There is no `source` field and there will not be one: a name written through
 * this API is a GoWay-owned correction and is stored as `goway`. A caller who
 * could label their own row `openstreetmap` could put words in OpenStreetMap's
 * mouth that the next import would then appear to confirm. The tag is
 * normalized, so `ES` and `es` are one row rather than two.
 */
export const placeNameInputSchema = z.object({
  language: languageTagSchema,
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
});
export type PlaceNameInput = z.input<typeof placeNameInputSchema>;

// ── Description ─────────────────────────────────────────────────────────────

/** The longest description GoWay stores, in characters. */
export const MAX_DESCRIPTION_LENGTH = 2000;

/**
 * A place's description in one language, from one source — the grain
 * {@link PlaceName} has, for the reason it has it: a business's own wording
 * and a source's must both survive, and the next import may only ever restate
 * its own.
 */
export const placeDescriptionSchema = z.object({
  /** Canonical BCP 47 tag. */
  language: canonicalLanguageTagSchema,
  description: z.string(),
  /** Which source supplies this wording. `goway` is written through this API. */
  source: z.string().min(1),
});
export type PlaceDescription = z.infer<typeof placeDescriptionSchema>;

/** A description as a writer supplies one: trimmed, bounded, never blank. */
const descriptionTextSchema = z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH);

/**
 * One translated description as a caller may write it.
 *
 * As for a name, there is no `source`: anything written here is GoWay's
 * (`goway`). `description: null` withdraws GoWay's wording in that language;
 * a source's own wording, if any, is untouched.
 */
export const placeDescriptionInputSchema = z.object({
  language: languageTagSchema,
  description: descriptionTextSchema.nullable(),
});
export type PlaceDescriptionInput = z.input<typeof placeDescriptionInputSchema>;

// ── Media references and the rating summary ─────────────────────────────────

/**
 * An Oxy file id. Opaque: never parsed. Render it through the Oxy SDK
 * (`oxy.assets.publicUrl(fileId, variant)`) — GoWay itself never fetches or
 * serves an image.
 */
export const oxyFileIdSchema = z.string().trim().min(1).max(128);

/**
 * The published reviews of a place, summarised.
 *
 * DERIVED from the reviews every time one is written, hidden or merged, never
 * incremented — so a hidden review leaves the average by construction.
 */
export const placeRatingSchema = z.object({
  /** The mean of the published ratings, to one decimal place. */
  average: z.number().min(1).max(5),
  /** How many published reviews the average is over. At least one. */
  count: z.number().int().min(1),
});
export type PlaceRating = z.infer<typeof placeRatingSchema>;

// ── The place ───────────────────────────────────────────────────────────────

/** A place as GoWay publishes it. */
export const placeSchema = z.object({
  id: placeIdSchema,
  /**
   * The place's DEFAULT name — what is written on the shopfront.
   *
   * The LOCAL-language name, never translated, transliterated or resolved
   * against a locale. A request that names a `locale` additionally gets
   * `localizedName`; this field does not change with it, so a cached `Place`
   * means the same thing whoever fetched it.
   */
  name: z.string(),
  /**
   * Every language GoWay holds a name for this place in, strongest provenance
   * first within a language.
   *
   * Published on a single-place read and on search results; ABSENT — not
   * empty — from a viewport or nearby list. Absent means "not published here",
   * exactly as it does for `claims`; `[]` means GoWay holds no translation.
   */
  names: z.array(placeNameSchema).optional(),
  /**
   * The name for the locale the request asked for, resolved by GoWay. Absent
   * when no `locale` was asked for or none matched; render with
   * {@link placeDisplayName} rather than restating the fallback.
   */
  localizedName: placeNameSchema.optional(),
  /** Representative point — what a marker sits on. */
  location: geoCoordinateSchema,
  /** Footprint or service area, when GoWay has one. */
  geometry: geoGeometrySchema.optional(),
  /**
   * Taxonomy keys (`food.cafe`), most specific first. Read them with
   * `categoryLabel`; a key this build does not know is still a key.
   */
  categories: z.array(publishedCategoryKeySchema),
  address: structuredAddressSchema.optional(),
  contact: placeContactSchema.optional(),
  /** The weekly schedule, read in {@link Place.timezone}. Evaluate with `openingStatusAt`. */
  openingHours: openingHoursSchema.optional(),
  /**
   * The IANA zone the place's clock reads in, derived by GoWay from its
   * position. Absent only where no zone could be derived.
   */
  timezone: timezoneSchema.optional(),
  /**
   * Dated exceptions to the weekly schedule that have not yet ended, earliest
   * first. Published on a single-place read; ABSENT from lists, as `names` is.
   */
  hoursExceptions: z.array(placeHoursExceptionSchema).optional(),
  /**
   * The place's own description, in its default language — what `name` is to
   * `names`. Published on a single-place read; ABSENT from lists, as `names` is.
   */
  description: z.string().optional(),
  /**
   * Every language GoWay holds a description in, GoWay's own wording first
   * within a language. Single-place read only.
   */
  descriptions: z.array(placeDescriptionSchema).optional(),
  /**
   * The description for the locale the request asked for, resolved by the
   * rule {@link Place.localizedName} follows. Single-place read only.
   */
  localizedDescription: placeDescriptionSchema.optional(),
  /**
   * The place's logo: the Oxy file of one of its visible `logo` media items.
   * Absent when none is set, or when the item it named left the gallery.
   */
  logoFileId: oxyFileIdSchema.optional(),
  /** The place's cover image: the Oxy file of one of its visible `cover` media items. */
  coverFileId: oxyFileIdSchema.optional(),
  /** The published reviews, summarised. Absent until the place has one. */
  rating: placeRatingSchema.optional(),
  status: z.enum(PUBLISHED_PLACE_STATUSES),
  verification: placeVerificationSchema,
  /** Every source this record reconciles against. Never empty for an imported place. */
  sources: z.array(placeSourceRefSchema),
  /** Every assertion, by key, strongest first. Use {@link placeHasCapability} to ask a yes/no question. */
  capabilities: z.array(placeCapabilitySchema),
  /** Present only where the caller is entitled to see claim details. */
  claims: z.array(placeClaimSchema).optional(),
  /** ISO 8601. */
  createdAt: instantSchema,
  /** ISO 8601. */
  updatedAt: instantSchema,
});
export type Place = z.infer<typeof placeSchema>;

/** A place plus its distance from the query point, for nearby results. */
export const placeWithDistanceSchema = placeSchema.extend({
  /** Great-circle distance from the query coordinate, in metres. */
  distanceMeters: z.number().min(0),
});
export type PlaceWithDistance = z.infer<typeof placeWithDistanceSchema>;

export const placePageSchema = pageSchema(placeSchema);
export type PlacePage = z.infer<typeof placePageSchema>;

export const placeWithDistancePageSchema = pageSchema(placeWithDistanceSchema);
export type PlaceWithDistancePage = z.infer<typeof placeWithDistancePageSchema>;

export const placeClaimPageSchema = pageSchema(placeClaimSchema);
export type PlaceClaimPage = z.infer<typeof placeClaimPageSchema>;

/**
 * The name to put on screen: the resolved one if GoWay resolved one, and the
 * default otherwise.
 *
 * A function in a contracts package, deliberately. The alternative is every
 * consumer writing `place.localizedName?.name ?? place.name` — and the one
 * that writes `place.name` instead, because it is shorter and works, is a
 * client that silently ignores the locale it asked for.
 */
export function placeDisplayName(place: Pick<Place, 'name' | 'localizedName'>): string {
  return place.localizedName?.name ?? place.name;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * The fields a caller may set.
 *
 * `verification`, `id`, `createdAt`, `updatedAt` and the claim list are not
 * here and never will be: each is either GoWay's own statement about a place or
 * an act that has to be reviewed. A schema that merely ignored them would be
 * the same thing until somebody spread the parsed object into an update.
 */
const writablePlaceFields = {
  name: z.string().trim().min(1).max(MAX_NAME_LENGTH),
  /** Translations, written as GoWay-owned corrections. Merged by language; absent languages are untouched. */
  names: z.array(placeNameInputSchema).max(64),
  location: geoCoordinateSchema,
  geometry: geoGeometrySchema,
  /** Taxonomy keys, most specific first. Repeats collapse. */
  categories: z
    .array(categoryKeySchema)
    .max(32)
    .transform((keys) => [...new Set(keys)]),
  address: structuredAddressInputSchema,
  contact: placeContactInputSchema,
  openingHours: openingHoursInputSchema,
  status: z.enum(WRITABLE_PLACE_STATUSES),
  /** The outside records this place reconciles against, when the caller knows them. */
  sources: z.array(placeSourceRefInputSchema).max(32),
  capabilities: z.array(placeCapabilityInputSchema).max(64),
  /** The default-language description. `null` clears it. */
  description: descriptionTextSchema.nullable(),
  /** Translations, written as GoWay's own. Merged by language; absent languages are untouched. */
  descriptions: z.array(placeDescriptionInputSchema).max(64),
  /**
   * The Oxy file of one of this place's visible `logo` media items — add the
   * item first (`POST /places/{placeId}/media`). `null` clears the logo.
   */
  logoFileId: oxyFileIdSchema.nullable(),
  /** The Oxy file of one of this place's visible `cover` media items. `null` clears it. */
  coverFileId: oxyFileIdSchema.nullable(),
};

/** The body of `POST /places`. */
export const placeCreateInputSchema = z.object({
  name: writablePlaceFields.name,
  names: writablePlaceFields.names.optional(),
  location: writablePlaceFields.location,
  geometry: writablePlaceFields.geometry.optional(),
  categories: writablePlaceFields.categories.optional(),
  address: writablePlaceFields.address.optional(),
  contact: writablePlaceFields.contact.optional(),
  openingHours: writablePlaceFields.openingHours.optional(),
  status: writablePlaceFields.status.optional(),
  sources: writablePlaceFields.sources.optional(),
  capabilities: writablePlaceFields.capabilities.optional(),
  description: writablePlaceFields.description.optional(),
  descriptions: writablePlaceFields.descriptions.optional(),
});
export type PlaceCreateInput = z.input<typeof placeCreateInputSchema>;

/**
 * The body of `PATCH /places/{placeId}`.
 *
 * Every field is optional and only the ones present are touched: GoWay layers
 * enrichment OVER source data and never destructively overwrites a source fact,
 * so an update that omits `address` leaves the address alone rather than
 * clearing it. An update that names nothing is refused.
 *
 * `logoFileId` and `coverFileId` are here and not on a create: each names an
 * item already in the place's gallery, and a place that does not exist yet has
 * none.
 */
export const placeUpdateInputSchema = placeCreateInputSchema
  .partial()
  .extend({
    logoFileId: writablePlaceFields.logoFileId.optional(),
    coverFileId: writablePlaceFields.coverFileId.optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'an update must change at least one field',
    path: ['(root)'],
  });
export type PlaceUpdateInput = z.input<typeof placeUpdateInputSchema>;

// ── Reads ───────────────────────────────────────────────────────────────────

/** The most places one list response will return. */
export const MAX_PLACE_LIST_LIMIT = 200;
/** What a caller gets when they ask for no particular number. */
export const DEFAULT_PLACE_LIST_LIMIT = 50;

/**
 * The largest radius a nearby query may ask for, in metres.
 *
 * 50 km: past that the question is no longer "what is near me" and the answer
 * is a scan of a continent, which pages forever rather than answering.
 */
export const MAX_RADIUS_METERS = 50_000;

/**
 * The widest viewport a bounds query may ask for, in degrees on either axis.
 *
 * A `geography` envelope's edges are GREAT CIRCLES. Past roughly 50–58° of
 * longitude in a narrow latitude band the edges bulge poleward enough that the
 * box can exclude its own centre, and a box exactly 180° wide makes PostGIS
 * raise `Antipodal (180 degrees long) edge detected!` — a 500 for a request
 * that is merely unreasonable.
 */
export const MAX_BOUNDS_SPAN_DEGREES = 90;

/** `?locale=` — a hint, never a filter. */
const localeField = {
  /**
   * BCP 47 tag to resolve `localizedName` against. A place with no name in that
   * language is still returned, carrying its default name.
   */
  locale: languageTagSchema.optional(),
};

/** The filters and paging every place list shares. */
const placeListFields = {
  /**
   * A CONJUNCTION: only places whose strongest assertion of EVERY listed key
   * holds — or, for `key:value`, carries that value.
   */
  capabilities: z.array(capabilityFilterSchema).max(64).optional(),
  /** A DISJUNCTION: places carrying ANY listed category or any category below it. */
  categories: z.array(categoryKeySchema).max(64).optional(),
  limit: limitSchema(MAX_PLACE_LIST_LIMIT, DEFAULT_PLACE_LIST_LIMIT),
  ...localeField,
  cursor: cursorSchema.optional(),
};

/** `GET /places/{placeId}` */
export const placeReadQuerySchema = z.object(localeField).strict();
export type PlaceReadQuery = z.input<typeof placeReadQuerySchema>;

/** `GET /places/nearby` — nearest first, keyset-paged by distance. */
export const nearbyPlacesQuerySchema = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    radiusMeters: z.number().positive().max(MAX_RADIUS_METERS),
    ...placeListFields,
  })
  .strict();
export type NearbyPlacesQuery = z.input<typeof nearbyPlacesQuerySchema>;

/** `GET /places/bounds` — ordered by place id, keyset-paged by it. */
export const placesInBoundsQuerySchema = z
  .object({
    west: longitudeSchema,
    south: latitudeSchema,
    east: longitudeSchema,
    north: latitudeSchema,
    ...placeListFields,
  })
  .strict()
  .refine((box) => box.south <= box.north, { message: 'south must not be north of north', path: ['south'] })
  .refine((box) => box.north - box.south <= MAX_BOUNDS_SPAN_DEGREES, { message: 'the box is too tall', path: ['north'] })
  .refine((box) => boundingBoxWidth(box) <= MAX_BOUNDS_SPAN_DEGREES, { message: 'the box is too wide', path: ['east'] });
export type PlacesInBoundsQuery = z.input<typeof placesInBoundsQuerySchema>;

/** The most claims one page returns. */
export const MAX_CLAIM_LIST_LIMIT = 200;
export const DEFAULT_CLAIM_LIST_LIMIT = 50;

/** `GET /places/{placeId}/claims` — oldest first, keyset-paged by claim time. */
export const claimListQuerySchema = z
  .object({
    limit: limitSchema(MAX_CLAIM_LIST_LIMIT, DEFAULT_CLAIM_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type ClaimListQuery = z.input<typeof claimListQuerySchema>;

/** `GET /claims` — one account's claims, oldest first, keyset-paged by claim time. */
export const accountClaimListQuerySchema = z
  .object({
    /**
     * Whose claims: an Oxy account the caller may act for (an `owner`, `admin`
     * or `editor` of it). Defaults to the session's own account.
     */
    oxyAccountId: oxyAccountIdSchema.optional(),
    limit: limitSchema(MAX_CLAIM_LIST_LIMIT, DEFAULT_CLAIM_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type AccountClaimListQuery = z.input<typeof accountClaimListQuerySchema>;

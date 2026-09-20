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
 */

import type { GeoCoordinate, GeoGeometry } from './geo';

/**
 * A stable GoWay place identifier.
 *
 * Deliberately independent of every provider ID: an OSM node can be deleted,
 * renumbered or replaced without GoWay losing the identity of the real place,
 * and a GoWay-created place has an ID before it matches anything external.
 * This is the ID deep links use (`https://goway.to/place/<placeId>`).
 */
export type PlaceId = string;

/** Lifecycle state of a place as GoWay understands it. */
export const PLACE_STATUSES = ['active', 'closed', 'proposed', 'removed'] as const;
export type PlaceStatus = (typeof PLACE_STATUSES)[number];

/**
 * A postal address broken into parts, as far as the source actually supports.
 *
 * Every field is optional by design. Do not invent a missing structured field —
 * an inferred `postalCode` is indistinguishable from a real one downstream.
 */
export interface StructuredAddress {
  /** House/building number. */
  houseNumber?: string;
  street?: string;
  /** Neighbourhood, district or suburb. */
  locality?: string;
  /** City, town or village. */
  city?: string;
  /** State, province or other first-level subdivision. */
  region?: string;
  postalCode?: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode?: string;
  country?: string;
  /** The source's own single-line rendering, when it provides one. */
  formatted?: string;
}

/** Contact details, where a source actually publishes them. */
export interface PlaceContact {
  /** E.164 where available. */
  phone?: string;
  email?: string;
  website?: string;
}

/**
 * One interval in a weekly opening schedule.
 *
 * `day` is 0 = Sunday through 6 = Saturday. Times are local wall-clock `HH:mm`
 * in the place's own timezone, not UTC: a place does not change its opening
 * hours when the reader travels.
 */
export interface OpeningHoursInterval {
  day: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  /** Local `HH:mm`, 24-hour. */
  opens: string;
  /** Local `HH:mm`, 24-hour. May be `<= opens` when the interval crosses midnight. */
  closes: string;
}

/** A weekly opening schedule plus the raw source expression it came from. */
export interface OpeningHours {
  intervals: OpeningHoursInterval[];
  /** IANA timezone, e.g. `Europe/Madrid`. Required to evaluate `intervals`. */
  timezone?: string;
  /** The source's own unparsed expression (e.g. an OSM `opening_hours` string). */
  raw?: string;
}

/** How strongly GoWay vouches for a place record itself. */
export const PLACE_VERIFICATION_STATES = ['unverified', 'community_reviewed', 'oxy_verified', 'owner_verified'] as const;
export type PlaceVerificationState = (typeof PLACE_VERIFICATION_STATES)[number];

/** Verification state plus when it was last established. */
export interface PlaceVerification {
  state: PlaceVerificationState;
  /** ISO 8601 instant at which this state was last established. */
  verifiedAt?: string;
}

/**
 * A link back to the source a fact came from.
 *
 * Provenance is never discarded and a source fact is never destructively
 * overwritten: GoWay enrichment layers *over* source data, so a later source
 * refresh can be reconciled instead of guessed at.
 */
export interface PlaceSourceRef {
  /** `openstreetmap`, `goway`, or another registered source key. */
  source: 'openstreetmap' | 'goway' | (string & {});
  /** The identifier this source uses, verbatim. */
  sourceId: string;
  /** ISO 8601 instant at which this source last confirmed the record. */
  observedAt?: string;
}

/**
 * How a capability claim came to be believed.
 *
 * Ordered weakest to strongest. A historic community report must never be
 * presented as guaranteed current acceptance without qualification — see
 * `observedAt` on {@link PlaceCapability}.
 */
export const CAPABILITY_VERIFICATIONS = [
  'community_reported',
  'external_source',
  'business_asserted',
  'oxy_verified',
] as const;
export type CapabilityVerification = (typeof CAPABILITY_VERIFICATIONS)[number];

/**
 * Well-known ecosystem capability keys, `<domain>.<product>.<capability>`.
 *
 * The namespace exists so a new Oxy product does not add a product-specific
 * table or a schema fork to Places. The list is open: an unrecognised key is
 * carried through rather than dropped, which is what lets a third party define
 * its own without a GoWay release.
 */
export const WELL_KNOWN_CAPABILITIES = [
  'payments.faircoin.accepted',
  'commerce.mercaria.store',
  'mobility.moovo.pickup',
  'housing.homiio.listings',
  'social.mention.location',
] as const;
export type WellKnownCapability = (typeof WELL_KNOWN_CAPABILITIES)[number];

/** A capability key. Well-known keys autocomplete; any namespaced key is valid. */
export type CapabilityKey = WellKnownCapability | (string & {});

/**
 * One asserted capability of a place, with the provenance needed to decide how
 * much to trust it and how loudly to present it.
 */
export interface PlaceCapability {
  /** e.g. `payments.faircoin` */
  namespace: string;
  /** e.g. `accepted` */
  capability: string;
  /** The full `<namespace>.<capability>` key, for filtering. */
  key: CapabilityKey;
  /** `true`/`false` for a flag; a string or number for a valued capability. */
  value: boolean | string | number;
  verification: CapabilityVerification;
  /**
   * ISO 8601 instant this claim was last observed. Freshness is part of the
   * contract: a two-year-old community report is not a current fact.
   */
  observedAt: string;
  /** The source that asserted it, when it came from outside GoWay. */
  source?: PlaceSourceRef;
}

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

/** A claimed relationship between an Oxy account/organization and a place. */
export interface PlaceClaim {
  id: string;
  role: PlaceClaimRole;
  state: PlaceClaimState;
  /** The claiming Oxy account or organization. Oxy owns identity; GoWay stores the reference only. */
  oxyAccountId: string;
  /** Groups the locations of one multi-location business. */
  brandId?: string;
  /** ISO 8601. */
  claimedAt: string;
}

/**
 * One of a place's names, in one language, from one source.
 *
 * A row rather than a key in a map, for the same reason {@link PlaceSourceRef}
 * is a row: a name has provenance. OpenStreetMap's `name:es` and a GoWay-owned
 * correction to the Spanish name are two statements about the same language,
 * and a `Record<string, string>` can hold only one of them — so the next import
 * would have to overwrite the correction to say anything at all.
 */
export interface PlaceName {
  /**
   * Canonical BCP 47 tag — `es`, `ca`, `en-GB`, `zh-Hant`.
   *
   * This is the `xx` of OpenStreetMap's `name:xx`, normalized. It is never the
   * bare `name` key: that one is the place's DEFAULT name, it is published as
   * {@link Place.name}, and its language is frequently not recorded anywhere.
   */
  language: string;
  name: string;
  /** Which source supplies this spelling. `goway` is GoWay's own correction. */
  source: PlaceSourceRef['source'];
}

/** A place as GoWay publishes it. */
export interface Place {
  id: PlaceId;
  /**
   * The place's DEFAULT name — what is written on the shopfront.
   *
   * The LOCAL-language name, which is not the same thing as the English one:
   * OpenStreetMap's bare `name` on Museu Picasso is Catalan, and nothing in
   * this field is ever translated, transliterated or resolved against a
   * locale. It is always present and never empty.
   *
   * A request that names a `locale` additionally gets {@link localizedName};
   * this field does not change with it, so a cached `Place` means the same
   * thing whoever fetched it.
   */
  name: string;
  /**
   * Every language GoWay holds a name for this place in, strongest provenance
   * first within a language.
   *
   * Published on a single-place read and on search results; ABSENT — not
   * empty — from a viewport or nearby list, where every language of every pin
   * is a payload nothing renders. Absent means "not published here", exactly
   * as it does for {@link Place.claims}; `[]` means GoWay holds no translation.
   */
  names?: PlaceName[];
  /**
   * The name for the locale the request asked for, resolved by GoWay.
   *
   * Present only when the request named a `locale` AND a name in that language
   * (or in a variety of it) exists. When it is absent, {@link Place.name} is
   * the answer — which is what {@link placeDisplayName} does, so no consumer
   * has to restate the fallback.
   *
   * The resolution order is GoWay's, in one place, so two call sites cannot
   * disagree about what `es-MX` should show.
   */
  localizedName?: PlaceName;
  /** Representative point — what a marker sits on. */
  location: GeoCoordinate;
  /** Footprint or service area, when GoWay has one. */
  geometry?: GeoGeometry;
  /** Normalized category keys, most specific first. */
  categories: string[];
  address?: StructuredAddress;
  contact?: PlaceContact;
  openingHours?: OpeningHours;
  status: PlaceStatus;
  verification: PlaceVerification;
  /** Every source this record reconciles against. Never empty for an imported place. */
  sources: PlaceSourceRef[];
  capabilities: PlaceCapability[];
  /** Present only where the caller is entitled to see claim details. */
  claims?: PlaceClaim[];
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. */
  updatedAt: string;
}

/** A place plus its distance from the query point, for nearby results. */
export interface PlaceWithDistance extends Place {
  /** Great-circle distance from the query coordinate, in metres. */
  distanceMeters: number;
}

/** Query for {@link Place} records inside a radius. */
export interface NearbyPlacesQuery {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  /** Only return places asserting every listed capability. */
  capabilities?: CapabilityKey[];
  categories?: string[];
  limit?: number;
  /**
   * BCP 47 tag to resolve {@link Place.localizedName} against.
   *
   * A hint, never a filter: a place with no name in that language is still
   * returned, carrying its default name.
   */
  locale?: string;
}

/** Query for {@link Place} records inside a bounding box. */
export interface PlacesInBoundsQuery {
  west: number;
  south: number;
  east: number;
  north: number;
  capabilities?: CapabilityKey[];
  categories?: string[];
  limit?: number;
  /** BCP 47 tag to resolve {@link Place.localizedName} against. */
  locale?: string;
}

/** What a single-place read may ask for beyond the place itself. */
export interface PlaceReadOptions {
  /** BCP 47 tag to resolve {@link Place.localizedName} against. */
  locale?: string;
}

/**
 * The name to put on screen: the resolved one if GoWay resolved one, and the
 * default otherwise.
 *
 * A function in a contracts package, deliberately. The alternative is every
 * consumer writing `place.localizedName?.name ?? place.name` — and the one
 * that writes `place.name` instead, because it is shorter and works, is a
 * client that silently ignores the locale it asked for. One expression,
 * published once.
 */
export function placeDisplayName(place: Pick<Place, 'name' | 'localizedName'>): string {
  return place.localizedName?.name ?? place.name;
}

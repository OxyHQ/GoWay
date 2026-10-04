/**
 * The wall between the database and the published contract.
 *
 * Every row that leaves the Places repository passes through here and becomes a
 * `@goway/contracts` `Place`. Nothing spreads a row into a response: the
 * mapper READS the columns the contract names and WRITES a fresh object holding
 * exactly those, so a column added to `places` tomorrow — a moderation note, a
 * reviewer id, a contributor's Oxy user id — cannot reach an API consumer by
 * accident. `AGENTS.md` says a Drizzle/PostGIS row shape is never an SDK
 * contract; this module is what makes that true rather than aspirational.
 *
 * Its output is held to the contract's own `placeSchema` — the schema
 * `@goway.to/sdk` parses every response with — so a mapper that drifted from
 * the contract fails a test here rather than a consumer's parse.
 *
 * ## Absent is not empty
 *
 * An optional field the database has no value for is OMITTED, never emitted as
 * `null` and never invented. `claims` in particular is absent when the caller
 * is not entitled to see claim details, which is a different fact from "this
 * place has no claims" — and the SDK reads it that way.
 */

import type {
  CapabilityVerification,
  OpeningHours,
  Place,
  PlaceCapability,
  PlaceName,
  PlaceClaim,
  PlaceClaimRole,
  PlaceClaimState,
  PlaceContact,
  PlaceDescription,
  PlaceHoursException,
  PlaceRating,
  PlaceSourceRef,
  PlaceVerificationState,
  PlaceWithDistance,
  StructuredAddress,
} from '@goway/contracts';
import { CAPABILITY_VERIFICATIONS } from '@goway/contracts';
import type { SelectedRow } from '@oxy.so/db';
import { comparePublishedNames, resolveLocalizedName } from '../../places/placeNames';
import {
  placeHoursExceptions,
  places,
  placesCapabilities,
  placesClaims,
  placesDescriptions,
  placesNames,
  placesSources,
} from '../schema';

/**
 * The columns a place read actually selects.
 *
 * `geo` is deliberately NOT here. It is a 100-plus-byte PostGIS hex blob that no
 * consumer can use, it is derivable from the two ordinates that ARE selected,
 * and selecting it on a 200-row viewport query would cost more bytes than every
 * other column combined. `nameNormalized` is likewise absent: it is
 * reconciliation's private, lower-cased view of the name, and publishing it
 * would make a matching implementation detail into something a client could
 * come to depend on.
 */
export const PLACE_COLUMNS = {
  id: places.id,
  name: places.name,
  latitude: places.latitude,
  longitude: places.longitude,
  geometry: places.geometry,
  categories: places.categories,
  addressHouseNumber: places.addressHouseNumber,
  addressStreet: places.addressStreet,
  addressLocality: places.addressLocality,
  addressCity: places.addressCity,
  addressRegion: places.addressRegion,
  addressPostalCode: places.addressPostalCode,
  addressCountryCode: places.addressCountryCode,
  addressCountry: places.addressCountry,
  addressFormatted: places.addressFormatted,
  contactPhone: places.contactPhone,
  contactEmail: places.contactEmail,
  contactWebsite: places.contactWebsite,
  openingHours: places.openingHours,
  timezone: places.timezone,
  description: places.description,
  logoMediaId: places.logoMediaId,
  coverMediaId: places.coverMediaId,
  status: places.status,
  verificationState: places.verificationState,
  verifiedAt: places.verifiedAt,
  createdAt: places.createdAt,
  updatedAt: places.updatedAt,
} as const;

export type PlaceRow = SelectedRow<typeof PLACE_COLUMNS>;

/**
 * The columns a name read selects.
 *
 * `nameNormalized` is absent — reconciliation's private view, exactly as on
 * `places` — and so is `id`, because a name row has no identity a consumer can
 * act on: it is addressed by its `(place, language, source)` triple, which is
 * also the only thing a writer can upsert against.
 */
export const NAME_COLUMNS = {
  placeId: placesNames.placeId,
  language: placesNames.language,
  name: placesNames.name,
  source: placesNames.source,
  observedAt: placesNames.observedAt,
} as const;

export type NameRow = SelectedRow<typeof NAME_COLUMNS>;

/** The columns a description read selects — the shape of {@link NAME_COLUMNS}, for its reason. */
export const DESCRIPTION_COLUMNS = {
  placeId: placesDescriptions.placeId,
  language: placesDescriptions.language,
  description: placesDescriptions.description,
  source: placesDescriptions.source,
  observedAt: placesDescriptions.observedAt,
} as const;

export type DescriptionRow = SelectedRow<typeof DESCRIPTION_COLUMNS>;

export const SOURCE_COLUMNS = {
  id: placesSources.id,
  placeId: placesSources.placeId,
  source: placesSources.source,
  sourceId: placesSources.sourceId,
  observedAt: placesSources.observedAt,
} as const;

export type SourceRow = SelectedRow<typeof SOURCE_COLUMNS>;

export const CAPABILITY_COLUMNS = {
  id: placesCapabilities.id,
  placeId: placesCapabilities.placeId,
  namespace: placesCapabilities.namespace,
  capability: placesCapabilities.capability,
  key: placesCapabilities.key,
  value: placesCapabilities.value,
  verification: placesCapabilities.verification,
  observedAt: placesCapabilities.observedAt,
  placeSourceId: placesCapabilities.placeSourceId,
} as const;

export type CapabilityRow = SelectedRow<typeof CAPABILITY_COLUMNS>;

export const CLAIM_COLUMNS = {
  id: placesClaims.id,
  placeId: placesClaims.placeId,
  oxyAccountId: placesClaims.oxyAccountId,
  role: placesClaims.role,
  state: placesClaims.state,
  claimedAt: placesClaims.claimedAt,
  decidedAt: placesClaims.decidedAt,
} as const;

export type ClaimRow = SelectedRow<typeof CLAIM_COLUMNS>;

export const HOURS_EXCEPTION_COLUMNS = {
  id: placeHoursExceptions.id,
  placeId: placeHoursExceptions.placeId,
  startsOn: placeHoursExceptions.startsOn,
  endsOn: placeHoursExceptions.endsOn,
  closed: placeHoursExceptions.closed,
  intervals: placeHoursExceptions.intervals,
  note: placeHoursExceptions.note,
  source: placeHoursExceptions.source,
  verification: placeHoursExceptions.verification,
  observedAt: placeHoursExceptions.observedAt,
} as const;

export type HoursExceptionRow = SelectedRow<typeof HOURS_EXCEPTION_COLUMNS>;

/**
 * How a read publishes a place's names.
 *
 * Two independent questions, because the answers differ by endpoint. A
 * single-place read publishes the whole set — a detail view genuinely wants
 * "also known as". A viewport read resolves ONE name and publishes no set: 200
 * pins carrying every language each is a payload nothing on screen renders,
 * and shipping it would also hand the fallback decision back to the client
 * this module exists to keep it away from.
 */
export interface PlaceNameView {
  /** Publish the full `names` array. */
  publishAll: boolean;
  /** Resolve `localizedName` against this BCP 47 tag, when the request named one. */
  locale?: string | undefined;
}

/** Publish neither — what a read that was not asked about names does. */
export const NO_NAME_VIEW: PlaceNameView = { publishAll: false };

/** The children a place read hydrates before mapping. */
export interface PlaceChildren {
  sources: readonly SourceRow[];
  capabilities: readonly CapabilityRow[];
  /**
   * The name rows that were LOADED, which is not the same question as what is
   * published — see {@link PlaceNameView}. Absent means the read did not ask
   * for names at all, which reads identically to a place that has none.
   */
  names?: readonly NameRow[];
  /**
   * The exceptions that have not ended. Absent for a list read, which publishes
   * no `hoursExceptions` — absent, as for `names`.
   */
  hoursExceptions?: readonly HoursExceptionRow[];
  /**
   * `undefined` means "this caller may not see claims" and is published as an
   * absent field. An empty array means "there are none", which is a different
   * statement and is published as an empty array.
   */
  claims?: readonly ClaimRow[];
  /**
   * The description rows. Present only for a single-place read, which is the
   * only read that publishes `description`, `descriptions` and
   * `localizedDescription` — absent, as for `names` on a list.
   */
  descriptions?: readonly DescriptionRow[];
  /**
   * The Oxy file of each VISIBLE gallery item the place's logo or cover names,
   * by item id. An item that left the gallery is not here, so its pointer is
   * not published even for the instant before the write that cleared it.
   */
  mediaFiles?: ReadonlyMap<string, string>;
  /** The published reviews, summarised. Absent: none. */
  rating?: PlaceRating;
}

/** Assigns `value` under `key` only when present, so no contract key is ever `undefined`. */
function put<T, K extends keyof T>(target: T, key: K, value: T[K] | undefined): void {
  if (value !== undefined) target[key] = value;
}

/** A nullable column as an optional contract field. */
function optionalText(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

function toStructuredAddress(row: PlaceRow): StructuredAddress | undefined {
  const address: StructuredAddress = {};
  put(address, 'houseNumber', optionalText(row.addressHouseNumber));
  put(address, 'street', optionalText(row.addressStreet));
  put(address, 'locality', optionalText(row.addressLocality));
  put(address, 'city', optionalText(row.addressCity));
  put(address, 'region', optionalText(row.addressRegion));
  put(address, 'postalCode', optionalText(row.addressPostalCode));
  put(address, 'countryCode', optionalText(row.addressCountryCode));
  put(address, 'country', optionalText(row.addressCountry));
  put(address, 'formatted', optionalText(row.addressFormatted));
  // An address with no parts is no address. Emitting `{}` would make every
  // place in the database look like it has an address object worth rendering.
  return Object.keys(address).length === 0 ? undefined : address;
}

function toContact(row: PlaceRow): PlaceContact | undefined {
  const contact: PlaceContact = {};
  put(contact, 'phone', optionalText(row.contactPhone));
  put(contact, 'email', optionalText(row.contactEmail));
  put(contact, 'website', optionalText(row.contactWebsite));
  return Object.keys(contact).length === 0 ? undefined : contact;
}

/**
 * The schedule, rebuilt from its two contract fields rather than passed
 * through: a jsonb blob is a row shape too, and one written before the timezone
 * moved to its own column still carries a `timezone` key.
 */
function toOpeningHours(value: OpeningHours): OpeningHours {
  const hours: OpeningHours = {
    intervals: value.intervals.map(({ day, opens, closes }) => ({ day, opens, closes })),
  };
  put(hours, 'raw', value.raw);
  return hours;
}

export function toHoursException(row: HoursExceptionRow): PlaceHoursException {
  const exception: PlaceHoursException = {
    id: row.id,
    placeId: row.placeId,
    startsOn: row.startsOn,
    endsOn: row.endsOn,
    closed: row.closed,
    intervals: row.intervals.map(({ opens, closes }) => ({ opens, closes })),
    source: row.source,
    verification: row.verification as CapabilityVerification,
    observedAt: row.observedAt.toISOString(),
  };
  put(exception, 'note', optionalText(row.note));
  return exception;
}

export function toPlaceDescription(row: DescriptionRow): PlaceDescription {
  return { language: row.language, description: row.description, source: row.source };
}

export function toPlaceName(row: NameRow): PlaceName {
  return { language: row.language, name: row.name, source: row.source };
}

export function toSourceRef(row: SourceRow): PlaceSourceRef {
  return {
    source: row.source,
    sourceId: row.sourceId,
    observedAt: row.observedAt.toISOString(),
  };
}

/**
 * How strongly a capability assertion is believed, as a sortable rank.
 *
 * Read from the SAME tuple that types the column and builds the CHECK, in the
 * order the contract documents (weakest first), so a tier added to the contract
 * cannot be silently ranked last here — it is ranked wherever the contract puts
 * it.
 */
function verificationRank(verification: string): number {
  const rank = (CAPABILITY_VERIFICATIONS as readonly string[]).indexOf(verification);
  // A value outside the tuple cannot exist: the column's CHECK is built from
  // it. Ranking an impossible value lowest is a belt-and-braces default, not a
  // case any write path can produce.
  return rank === -1 ? -1 : rank;
}

export function toCapability(row: CapabilityRow, source?: SourceRow): PlaceCapability {
  const capability: PlaceCapability = {
    namespace: row.namespace,
    capability: row.capability,
    // `key` is a GENERATED column, so it cannot disagree with its two parts —
    // which is exactly the invariant the contract's `placeCapabilitySchema`
    // refuses a response over.
    // The fallback keeps TypeScript honest about a generated column's
    // nullability without ever being reached.
    key: row.key ?? `${row.namespace}.${row.capability}`,
    value: row.value,
    verification: row.verification as CapabilityVerification,
    observedAt: row.observedAt.toISOString(),
  };
  if (source) capability.source = toSourceRef(source);
  return capability;
}

export function toClaim(row: ClaimRow): PlaceClaim {
  const claim: PlaceClaim = {
    id: row.id,
    placeId: row.placeId,
    role: row.role as PlaceClaimRole,
    state: row.state as PlaceClaimState,
    oxyAccountId: row.oxyAccountId,
    claimedAt: row.claimedAt.toISOString(),
  };
  if (row.decidedAt !== null) claim.decidedAt = row.decidedAt.toISOString();
  return claim;
}

/**
 * One place, as GoWay publishes it.
 *
 * Capabilities come out ordered by key, then strongest verification first, then
 * freshest first. The order is part of what a client renders: a place whose
 * FairCoin acceptance is both `oxy_verified` (last month) and
 * `community_reported` (two years ago) publishes both — nothing is destroyed —
 * and a consumer that takes the first row per key gets the strongest current
 * answer without having to know the ranking.
 */
export function toPlace(
  row: PlaceRow,
  children: PlaceChildren,
  nameView: PlaceNameView = NO_NAME_VIEW,
): Place {
  const sourcesById = new Map(children.sources.map((source) => [source.id, source]));

  const place: Place = {
    id: row.id,
    // The DEFAULT name, always, whatever locale was asked for. A field whose
    // meaning changed with a query parameter would make a cached `Place` mean
    // different things to different holders of it; the resolved answer is a
    // second field, below.
    name: row.name,
    location: { latitude: row.latitude, longitude: row.longitude },
    categories: row.categories,
    // Every read that maps a row selects only the published statuses in SQL,
    // so the status is one of the three a place can be published in.
    status: row.status as Place['status'],
    verification: { state: row.verificationState as PlaceVerificationState },
    sources: [...children.sources]
      .sort((a, b) => b.observedAt.getTime() - a.observedAt.getTime())
      .map(toSourceRef),
    capabilities: [...children.capabilities]
      .sort(
        (a, b) =>
          (a.key ?? '').localeCompare(b.key ?? '') ||
          verificationRank(b.verification) - verificationRank(a.verification) ||
          b.observedAt.getTime() - a.observedAt.getTime(),
      )
      .map((capability) =>
        toCapability(
          capability,
          capability.placeSourceId === null
            ? undefined
            : sourcesById.get(capability.placeSourceId),
        ),
      ),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };

  if (row.verifiedAt !== null) place.verification.verifiedAt = row.verifiedAt.toISOString();
  if (row.geometry !== null) place.geometry = row.geometry;
  put(place, 'address', toStructuredAddress(row));
  put(place, 'contact', toContact(row));
  if (row.openingHours !== null) place.openingHours = toOpeningHours(row.openingHours);
  put(place, 'timezone', optionalText(row.timezone));
  if (children.hoursExceptions !== undefined) {
    place.hoursExceptions = children.hoursExceptions.map(toHoursException);
  }
  if (children.claims !== undefined) place.claims = children.claims.map(toClaim);
  if (children.descriptions !== undefined) {
    put(place, 'description', optionalText(row.description));
    place.descriptions = [...children.descriptions].sort(comparePublishedNames).map(toPlaceDescription);
    const localizedDescription = resolveLocalizedName(children.descriptions, nameView.locale);
    if (localizedDescription) place.localizedDescription = toPlaceDescription(localizedDescription);
  }
  if (row.logoMediaId !== null) put(place, 'logoFileId', children.mediaFiles?.get(row.logoMediaId));
  if (row.coverMediaId !== null) put(place, 'coverFileId', children.mediaFiles?.get(row.coverMediaId));
  put(place, 'rating', children.rating);

  const names = children.names ?? [];
  if (nameView.publishAll) {
    place.names = [...names].sort(comparePublishedNames).map(toPlaceName);
  }
  const localized = resolveLocalizedName(names, nameView.locale);
  if (localized) place.localizedName = toPlaceName(localized);

  return place;
}

/** A place plus the distance a nearby query measured, in metres. */
export function toPlaceWithDistance(
  row: PlaceRow,
  children: PlaceChildren,
  distanceMeters: number,
  nameView: PlaceNameView = NO_NAME_VIEW,
): PlaceWithDistance {
  return { ...toPlace(row, children, nameView), distanceMeters };
}

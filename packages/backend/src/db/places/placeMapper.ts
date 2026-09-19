/**
 * The wall between the database and the published contract.
 *
 * Every row that leaves the Places repository passes through here and becomes a
 * `@goway/shared-types` `Place`. Nothing spreads a row into a response: the
 * mapper READS the columns the contract names and WRITES a fresh object holding
 * exactly those, so a column added to `places` tomorrow — a moderation note, a
 * reviewer id, a contributor's Oxy user id — cannot reach an API consumer by
 * accident. `AGENTS.md` says a Drizzle/PostGIS row shape is never an SDK
 * contract; this module is what makes that true rather than aspirational.
 *
 * It is the mirror of `packages/sdk/src/parse.ts`, which rebuilds the same
 * objects field by field on the way in. Two independent projections of one
 * contract, meeting in the middle.
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
  Place,
  PlaceCapability,
  PlaceClaim,
  PlaceClaimRole,
  PlaceClaimState,
  PlaceContact,
  PlaceSourceRef,
  PlaceStatus,
  PlaceVerificationState,
  PlaceWithDistance,
  StructuredAddress,
} from '@goway/shared-types';
import { CAPABILITY_VERIFICATIONS } from '@goway/shared-types';
import type { SelectedRow } from '@oxy.so/db';
import { places, placesCapabilities, placesClaims, placesSources } from '../schema';

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
  status: places.status,
  verificationState: places.verificationState,
  verifiedAt: places.verifiedAt,
  createdAt: places.createdAt,
  updatedAt: places.updatedAt,
} as const;

export type PlaceRow = SelectedRow<typeof PLACE_COLUMNS>;

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
  brandId: placesClaims.brandId,
  role: placesClaims.role,
  state: placesClaims.state,
  claimedAt: placesClaims.claimedAt,
} as const;

export type ClaimRow = SelectedRow<typeof CLAIM_COLUMNS>;

/** The children a place read hydrates before mapping. */
export interface PlaceChildren {
  sources: readonly SourceRow[];
  capabilities: readonly CapabilityRow[];
  /**
   * `undefined` means "this caller may not see claims" and is published as an
   * absent field. An empty array means "there are none", which is a different
   * statement and is published as an empty array.
   */
  claims?: readonly ClaimRow[];
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
    // which is exactly the invariant the SDK's parser refuses a response over.
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
    role: row.role as PlaceClaimRole,
    state: row.state as PlaceClaimState,
    oxyAccountId: row.oxyAccountId,
    claimedAt: row.claimedAt.toISOString(),
  };
  put(claim, 'brandId', optionalText(row.brandId));
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
export function toPlace(row: PlaceRow, children: PlaceChildren): Place {
  const sourcesById = new Map(children.sources.map((source) => [source.id, source]));

  const place: Place = {
    id: row.id,
    name: row.name,
    location: { latitude: row.latitude, longitude: row.longitude },
    categories: row.categories,
    status: row.status as PlaceStatus,
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
  if (row.openingHours !== null) place.openingHours = row.openingHours;
  if (children.claims !== undefined) place.claims = children.claims.map(toClaim);

  return place;
}

/** A place plus the distance a nearby query measured, in metres. */
export function toPlaceWithDistance(
  row: PlaceRow,
  children: PlaceChildren,
  distanceMeters: number,
): PlaceWithDistance {
  return { ...toPlace(row, children), distanceMeters };
}

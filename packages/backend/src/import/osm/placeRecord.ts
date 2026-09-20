/**
 * One OpenStreetMap element, turned into the facts GoWay stores about a place.
 *
 * Pure, and deliberately so: everything here is a function of an element's
 * tags and position, which is what lets the whole mapping be tested without a
 * database, without a network and without an extract.
 *
 * ## The source id is `<type>/<id>`, and getting it right is the point
 *
 * Issue #58 exists because `places_sources` recorded `way/34633854` as Museu
 * Picasso's provenance, and `way/34633854` is the Empire State Building. An
 * identifier that resolves to SOMETHING looks exactly like one that resolves to
 * the right thing, so the only way to know is to dereference it — which is why
 * `verifyProvenance.ts` fetches a sample from the OpenStreetMap API and
 * compares names, and why {@link osmSourceId} takes the element's type as a
 * separate argument that cannot be defaulted.
 *
 * Reading the `.osm.pbf` directly is itself part of the answer: a node, a way
 * and a relation live in different message types in the file, so the type is
 * never inferred and never encoded into the id. The tile pipeline's
 * `osmId * 10 + sourceId` packing, which is where #58's wrong id came from, has
 * no analogue here.
 *
 * ## Every name, and the bare one is not English
 *
 * OpenStreetMap's `name` is the name in the LOCAL language — `Museu Picasso` in
 * Barcelona, not `Picasso Museum`. It becomes `places.name`, which is where the
 * schema says the default name lives. Every `name:xx` becomes a row in
 * `places_names` under its normalized tag. `int_name`, `alt_name`, `old_name`
 * and `loc_name` are NOT names in a language — they are a different kind of
 * claim with no tag to be keyed by — and this importer skips them rather than
 * inventing a language for them.
 */

import { normalizeLanguageTag } from '@goway/shared-types';
import { classifyPoi, poiCategories } from './poiTags';

/** Which OSM element a place came from. Part of the source id; never inferred. */
export type OsmElementType = 'node' | 'way' | 'relation';

/** A translated name, ready for `places_names`. */
export interface ImportedName {
  /** Canonical BCP 47, as `normalizeLanguageTag` produces it. */
  language: string;
  name: string;
}

/**
 * Everything one element contributes, in the shape the write path consumes.
 *
 * `sourceData` is the SAME object, minus the fields that are redundant with it
 * — it is what `places_sources.source_data` stores, and what the next run
 * compares against to tell a GoWay correction from an unchanged source fact.
 * Keeping it derived from this record rather than assembled separately is what
 * stops the two from disagreeing.
 */
export interface ImportedPlace {
  osmType: OsmElementType;
  osmId: number;
  /** `node/26947722`, `way/188938001`, `relation/6288735`. */
  sourceId: string;
  name: string;
  names: ImportedName[];
  latitude: number;
  longitude: number;
  /** Most specific first — see `poiCategories`. */
  categories: string[];
  addressHouseNumber: string | null;
  addressStreet: string | null;
  addressLocality: string | null;
  addressCity: string | null;
  addressRegion: string | null;
  addressPostalCode: string | null;
  addressCountryCode: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
  contactWebsite: string | null;
}

/** `<type>/<id>` — the identifier `places_sources.source_id` carries for `openstreetmap`. */
export function osmSourceId(type: OsmElementType, id: number): string {
  return `${type}/${id}`;
}

/**
 * OpenStreetMap stores coordinates as integers in units of 100 nanodegrees, so
 * seven decimal places is its full precision and rounding there is lossless.
 *
 * It is not cosmetic. The next run compares the stored ordinate against the one
 * recorded in `source_data` to decide whether anybody has moved the place since
 * — and two doubles that came from the same integer must compare EQUAL for that
 * to work. Rounding both through the same function is what guarantees it.
 */
export function roundCoordinate(value: number): number {
  return Math.round(value * 1e7) / 1e7;
}

/** The longest value this importer will store in a text column it does not control. */
const MAX_TEXT_LENGTH = 500;

/** Trim, collapse runs of whitespace, and refuse anything empty or absurd. */
function cleanText(value: string | undefined): string | null {
  if (value === undefined) return null;
  const collapsed = value.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0 || collapsed.length > MAX_TEXT_LENGTH) return null;
  return collapsed;
}

/** The first of several tags that carries a usable value. */
function firstOf(tags: ReadonlyMap<string, string>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = cleanText(tags.get(key));
    if (value !== null) return value;
  }
  return null;
}

/** ISO 3166-1 alpha-2, uppercase, or nothing — the shape `places_country_code_check` demands. */
function countryCode(tags: ReadonlyMap<string, string>): string | null {
  const raw = firstOf(tags, 'addr:country');
  if (raw === null) return null;
  const upper = raw.toUpperCase();
  return /^[A-Z]{2}$/.test(upper) ? upper : null;
}

/**
 * The language-tagged names on an element.
 *
 * A `name:*` key whose suffix is not a language tag is SKIPPED, not failed:
 * `name:etymology`, `name:left` and `name:signed` are all well-formed keys that
 * are not translations, and the right response to one is to lose that key
 * rather than the element. `normalizeLanguageTag` is the judge, and it refuses
 * four-letter primary subtags for exactly this reason.
 *
 * A translation identical to the default name is dropped: OpenStreetMap
 * frequently repeats `name` as `name:es` in Spain, and storing it would put
 * several million rows in `places_names` that say nothing the `places` row does
 * not already say.
 */
export function importedNames(tags: ReadonlyMap<string, string>, defaultName: string): ImportedName[] {
  const byLanguage = new Map<string, string>();
  for (const [key, value] of tags) {
    if (!key.startsWith('name:')) continue;
    const language = normalizeLanguageTag(key.slice('name:'.length));
    if (language === undefined) continue;
    const name = cleanText(value);
    if (name === null || name === defaultName) continue;
    byLanguage.set(language, name);
  }
  return [...byLanguage].map(([language, name]) => ({ language, name }));
}

/**
 * The place an element describes, or `null` if it does not describe one.
 *
 * `null` covers three cases a caller never needs to tell apart: no qualifying
 * tag, a class the basemap draws nowhere (see `poiTags`), and no name. The
 * last is not a judgement about importance — `places.name` is NOT NULL, every
 * `poi-*` layer filter in the map style carries `['has', 'name']`, and an
 * unnamed bench is not a place.
 */
export function toImportedPlace(
  type: OsmElementType,
  id: number,
  latitude: number,
  longitude: number,
  tags: ReadonlyMap<string, string>,
): ImportedPlace | null {
  const name = cleanText(tags.get('name'));
  if (name === null) return null;

  const kind = classifyPoi(tags);
  if (kind === null) return null;

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  return {
    osmType: type,
    osmId: id,
    sourceId: osmSourceId(type, id),
    name,
    names: importedNames(tags, name),
    latitude: roundCoordinate(latitude),
    longitude: roundCoordinate(longitude),
    categories: poiCategories(kind),
    addressHouseNumber: firstOf(tags, 'addr:housenumber'),
    addressStreet: firstOf(tags, 'addr:street'),
    addressLocality: firstOf(tags, 'addr:suburb', 'addr:neighbourhood', 'addr:district'),
    addressCity: firstOf(tags, 'addr:city', 'addr:town', 'addr:village'),
    addressRegion: firstOf(tags, 'addr:province', 'addr:state'),
    addressPostalCode: firstOf(tags, 'addr:postcode'),
    addressCountryCode: countryCode(tags),
    contactPhone: firstOf(tags, 'contact:phone', 'phone'),
    contactEmail: firstOf(tags, 'contact:email', 'email'),
    contactWebsite: firstOf(tags, 'contact:website', 'website', 'url'),
  };
}

/**
 * What `places_sources.source_data` records: the facts this source stated, in
 * the normalized form GoWay derived them in.
 *
 * Not the raw tags. The column's job is to let the NEXT run tell "nobody has
 * touched this since we wrote it" from "somebody corrected it", and that
 * question is asked about the normalized value that actually went into the
 * column — so this is that value, and `mergePlaceColumns` compares against it
 * directly. Storing the raw tags instead would leave every comparison to
 * re-derive the normalization and to drift the moment the derivation changes.
 */
export function sourceDataOf(place: ImportedPlace): Record<string, unknown> {
  return {
    name: place.name,
    latitude: place.latitude,
    longitude: place.longitude,
    categories: place.categories,
    addressHouseNumber: place.addressHouseNumber,
    addressStreet: place.addressStreet,
    addressLocality: place.addressLocality,
    addressCity: place.addressCity,
    addressRegion: place.addressRegion,
    addressPostalCode: place.addressPostalCode,
    addressCountryCode: place.addressCountryCode,
    contactPhone: place.contactPhone,
    contactEmail: place.contactEmail,
    contactWebsite: place.contactWebsite,
  };
}

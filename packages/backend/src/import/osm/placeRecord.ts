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

import { normalizeLanguageTag } from '@goway/contracts';
import type { OsmCategoryMapping } from '../../categories/catalog';
import type { PlaceSourceData } from '../../db/schema';
import { osmCapabilities, type ImportedCapability } from './capabilityTags';
import { cleanText, readColumns, type ImportedColumns } from './fields';
import { classifyPoi } from './poiTags';

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
 * `columns` is every `places` column the import owns, read by the one field
 * table in `fields.ts`; `tags` is everything the element said, raw. Both go
 * into `places_sources.source_data` ({@link sourceDataOf}), which is what the
 * next run compares against to tell a GoWay correction from an unchanged
 * source fact.
 */
export interface ImportedPlace {
  osmType: OsmElementType;
  osmId: number;
  /** `node/26947722`, `way/188938001`, `relation/6288735`. */
  sourceId: string;
  /** Every tag on the element, verbatim. */
  tags: Record<string, string>;
  columns: ImportedColumns;
  names: ImportedName[];
  /** Written as `external_source` assertions tied to this element's source row. */
  capabilities: ImportedCapability[];
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
export function importedNames(
  tags: ReadonlyMap<string, string>,
  defaultName: string,
): ImportedName[] {
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
 * Whether these tags describe a place at all: a name, and a qualifying tag the
 * basemap draws. The cheap test the extract runs on a way or relation before
 * it pays to position one.
 */
export function isImportablePoi(tags: ReadonlyMap<string, string>): boolean {
  return cleanText(tags.get('name')) !== null && classifyPoi(tags) !== null;
}

/**
 * The place an element describes, or `null` if it does not describe one.
 *
 * `null` covers four cases a caller never needs to tell apart: no qualifying
 * tag, a class the basemap draws nowhere (see `poiTags`), no name, and a
 * position outside the ordinate ranges. The name rule is not a judgement about
 * importance — `places.name` is NOT NULL, every `poi-*` layer filter in the
 * map style carries `['has', 'name']`, and an unnamed bench is not a place.
 *
 * A way or relation is built only once its position is known, because the
 * timezone is read from the position like every other derived column.
 * `categories` is the taxonomy's OpenStreetMap mapping, from the database.
 */
export function toImportedPlace(
  type: OsmElementType,
  id: number,
  latitude: number,
  longitude: number,
  tags: ReadonlyMap<string, string>,
  categories: OsmCategoryMapping,
): ImportedPlace | null {
  if (!isImportablePoi(tags)) return null;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) return null;

  const columns = readColumns(
    { tags, latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) },
    categories,
  );
  return {
    osmType: type,
    osmId: id,
    sourceId: osmSourceId(type, id),
    tags: Object.fromEntries(tags),
    columns,
    names: importedNames(tags, columns.name),
    capabilities: osmCapabilities(tags),
  };
}

/**
 * What `places_sources.source_data` records — version 2.
 *
 * `tags` is the whole element, so a mapping added later can be applied to what
 * is stored. `normalized` is the value each owned column was given, in the form
 * it went in: `mergePlaceColumns` compares the column against it directly, and
 * re-deriving it from the raw tags on the next run would drift the moment the
 * derivation changed. The capabilities the element asserted ride along, keyed,
 * for the same reconciliation.
 */
export function sourceDataOf(place: ImportedPlace): PlaceSourceData {
  return {
    v: 2,
    tags: place.tags,
    normalized: {
      ...place.columns,
      capabilities: Object.fromEntries(
        place.capabilities.map((capability) => [capability.key, capability.value]),
      ),
    },
  };
}

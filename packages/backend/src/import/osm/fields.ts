/**
 * The `places` columns the OpenStreetMap import owns — declared ONCE.
 *
 * Every importable column is one entry in {@link IMPORTED_FIELDS}, and that
 * entry is the only place the column is named. Everything else is derived from
 * the table:
 *
 *  - the record type an element becomes ({@link ImportedColumns});
 *  - what `places_sources.source_data.normalized` records (`placeRecord`);
 *  - the three-way merge, column by column (`merge`);
 *  - the columns the write path reads back, inserts, and sizes its statements
 *    by (`writePlaces`).
 *
 * Before this table the same fourteen names were written out by hand in seven
 * places, and adding opening hours would have meant finding all seven. Now a
 * new importable column is one entry here — and a column that is in the table
 * but missing from one of those places cannot exist, because none of them
 * lists columns any more.
 *
 * Each entry also says what EMPTY and SAME mean for its value, because the
 * merge needs both and they differ by type: an empty category list is a gap,
 * and two schedules are the same when they say the same thing whatever order
 * jsonb gave their keys back in.
 */

import { z } from 'zod';
import { openingHoursSchema, type OpeningHours } from '@goway/contracts';
import type { places } from '../../db/schema';
import type { OsmCategoryMapping } from '../../categories/catalog';
import { timezoneAt } from '../../places/timezone';
import { osmOpeningHoursParser } from './openingHours';
import { osmCategories } from './poiTags';

/** One element, positioned: what every field reads from. */
export interface OsmElement {
  tags: ReadonlyMap<string, string>;
  /** Already rounded to OpenStreetMap's own precision. */
  latitude: number;
  longitude: number;
}

/** One importable column. Methods, so a field of a narrower type still fits. */
export interface ImportedField<T> {
  /**
   * What the column holds for this element; `null` when the source says
   * nothing. `categories` is the taxonomy's OpenStreetMap mapping, which is
   * data in the database rather than code, read once per run.
   */
  read(element: OsmElement, categories: OsmCategoryMapping): T;
  /** The value's shape, for reading it back out of `source_data` defensively. */
  readonly schema: z.ZodType<T>;
  /** Whether the column holds nothing, so filling it destroys nothing. */
  empty(value: T): boolean;
  /** Whether two values are the same statement. */
  same(left: T, right: T): boolean;
}

/** The longest value this importer will store in a text column it does not control. */
const MAX_TEXT_LENGTH = 500;

/** Trim, collapse runs of whitespace, and refuse anything empty or absurd. */
export function cleanText(value: string | undefined): string | null {
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

/** A value with every object's keys sorted, so jsonb's key order cannot make two equal values differ. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

/** A nullable text column read from the first tag that has a value. */
function text(...keys: string[]): ImportedField<string | null> {
  return {
    read: (element) => firstOf(element.tags, ...keys),
    schema: z.string().nullable(),
    empty: (value) => value === null || value === '',
    same: (left, right) => left === right,
  };
}

function ordinate(read: (element: OsmElement) => number): ImportedField<number> {
  return { read, schema: z.number(), empty: () => false, same: (left, right) => left === right };
}

/**
 * The table. Keys are `places` columns, spelled as the schema spells them —
 * `satisfies` refuses a key that is not one, or a value the column cannot hold.
 */
export const IMPORTED_FIELDS = {
  name: {
    // `toImportedPlace` refuses an element without one before any field is read.
    read: (element) => cleanText(element.tags.get('name')) ?? '',
    schema: z.string(),
    empty: (value) => value === '',
    same: (left, right) => left === right,
  } satisfies ImportedField<string>,
  latitude: ordinate((element) => element.latitude),
  longitude: ordinate((element) => element.longitude),
  categories: {
    read: (element, categories): string[] => osmCategories(element.tags, categories),
    schema: z.array(z.string()),
    empty: (value) => value.length === 0,
    // The same members in the same order: "most specific first" is part of
    // what the list says.
    same: (left, right) => left.length === right.length && left.every((value, index) => value === right[index]),
  } satisfies ImportedField<string[]>,
  addressHouseNumber: text('addr:housenumber'),
  addressStreet: text('addr:street'),
  addressLocality: text('addr:suburb', 'addr:neighbourhood', 'addr:district'),
  addressCity: text('addr:city', 'addr:town', 'addr:village'),
  addressRegion: text('addr:province', 'addr:state'),
  addressPostalCode: text('addr:postcode'),
  addressCountryCode: {
    read: (element) => countryCode(element.tags),
    schema: z.string().nullable(),
    empty: (value) => value === null,
    same: (left, right) => left === right,
  } satisfies ImportedField<string | null>,
  contactPhone: text('contact:phone', 'phone'),
  contactEmail: text('contact:email', 'email'),
  contactWebsite: text('contact:website', 'website', 'url'),
  openingHours: {
    read: (element) => {
      const raw = cleanText(element.tags.get('opening_hours'));
      return raw === null ? null : osmOpeningHoursParser.parse(raw);
    },
    schema: openingHoursSchema.nullable(),
    empty: (value) => value === null,
    same: sameJson,
  } satisfies ImportedField<OpeningHours | null>,
  /** Derived from the position, never from a tag — see `places/timezone`. */
  timezone: {
    read: (element) => timezoneAt(element.latitude, element.longitude),
    schema: z.string().nullable(),
    empty: (value) => value === null,
    same: (left, right) => left === right,
  } satisfies ImportedField<string | null>,
} satisfies { [K in keyof typeof places.$inferInsert]?: ImportedField<(typeof places.$inferInsert)[K]> };

export type ImportedColumn = keyof typeof IMPORTED_FIELDS;

/** Every importable column, in table order. */
export const IMPORTED_COLUMNS = Object.keys(IMPORTED_FIELDS) as ImportedColumn[];

/** The value each importable column holds. */
export type ImportedColumns = {
  [K in ImportedColumn]: ReturnType<(typeof IMPORTED_FIELDS)[K]['read']>;
};

/** The field for a column, widened so one loop can walk them all. */
export function importedField(column: ImportedColumn): ImportedField<unknown> {
  return IMPORTED_FIELDS[column] as ImportedField<unknown>;
}

/** Every column read from one element. */
export function readColumns(element: OsmElement, categories: OsmCategoryMapping): ImportedColumns {
  return Object.fromEntries(
    IMPORTED_COLUMNS.map((column) => [column, importedField(column).read(element, categories)]),
  ) as ImportedColumns;
}

/**
 * What a previous run recorded, column by column, read defensively: a column
 * missing from the record, or recorded in a shape this release no longer
 * reads, is ABSENT — which the merge treats as "never stated", the safe
 * direction.
 */
export function previousColumns(normalized: Record<string, unknown>): Partial<ImportedColumns> {
  const previous: Partial<Record<ImportedColumn, unknown>> = {};
  for (const column of IMPORTED_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(normalized, column)) continue;
    const parsed = importedField(column).schema.safeParse(normalized[column]);
    if (parsed.success) previous[column] = parsed.data;
  }
  return previous as Partial<ImportedColumns>;
}

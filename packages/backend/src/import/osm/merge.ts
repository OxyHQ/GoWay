/**
 * What a re-import is allowed to change about a place it imported before.
 *
 * ## The problem `places_names` solved by its key, and `places` cannot
 *
 * `places_names` is keyed `(place, language, source)`, so an `openstreetmap`
 * refresh literally CANNOT address a `goway` row: the correction survives
 * because the importer has no way to name it. That is a property of the schema
 * and it costs the importer nothing.
 *
 * `places` has no such key. `name`, `categories` and the address columns are
 * single-valued and GoWay-owned, and the same UPDATE that refreshes a shop's
 * new phone number from OpenStreetMap would flatten a moderator's correction to
 * its name. `AGENTS.md` forbids exactly that — *"never destructively overwrite
 * a source fact"* — and there is no conflict target to hide behind.
 *
 * So this module reconstructs the same guarantee from the one thing that makes
 * it decidable: `places_sources.source_data` holds what THIS source said last
 * time, in the same normalized form that was written to the column. Three
 * values are therefore in hand for every column — what the column holds now,
 * what the source said last time, and what it says today — and that is a
 * three-way merge, the same shape as a version-control merge:
 *
 *  - the column is EMPTY → take the source's value; filling a gap destroys
 *    nothing;
 *  - the column still equals what the source said last time → nobody has
 *    touched it, so take the new value;
 *  - the column differs from what the source said last time → somebody
 *    changed it deliberately. Keep it. The source's own version is not lost:
 *    it is in `source_data`, which is what that column is for.
 *
 * With no `source_data` — a place linked by some earlier path, or the very
 * first run after this importer ships — the middle branch cannot be evaluated,
 * and the answer is the conservative one: fill gaps, change nothing else.
 *
 * ## Returning only what changed is not an optimization
 *
 * It is what makes a second run cheap AND what keeps `updated_at` honest. An
 * unconditional UPDATE over three million rows every night moves every
 * `updated_at`, and a client caching on it re-fetches the entire country
 * because the importer ran, not because anything changed.
 */

import type { ImportedPlace } from './placeRecord';

/** The `places` columns this importer owns. Named exactly as the schema names them. */
export interface MergeablePlaceColumns {
  name: string;
  latitude: number;
  longitude: number;
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

/** The scalar columns, merged one way; `categories` is an array and is merged the other. */
const SCALAR_COLUMNS = [
  'name',
  'latitude',
  'longitude',
  'addressHouseNumber',
  'addressStreet',
  'addressLocality',
  'addressCity',
  'addressRegion',
  'addressPostalCode',
  'addressCountryCode',
  'contactPhone',
  'contactEmail',
  'contactWebsite',
] as const satisfies readonly (keyof MergeablePlaceColumns)[];

/** The columns an imported place supplies, taken straight off the record. */
export function incomingColumns(place: ImportedPlace): MergeablePlaceColumns {
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

/** Two category lists are the same list when they have the same members in the same order. */
function sameCategories(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * The subset of columns to write, or `null` when the merge changes nothing.
 *
 * `previous` is `places_sources.source_data` as the last run wrote it — see
 * {@link sourceDataOf}. It is read defensively (`unknown` per field, compared
 * by value) because it is data from a previous release of this importer and may
 * predate any field added since.
 */
export function mergePlaceColumns(
  current: MergeablePlaceColumns,
  previous: Record<string, unknown> | null,
  incoming: MergeablePlaceColumns,
): Partial<MergeablePlaceColumns> | null {
  const changes: Record<string, unknown> = {};

  for (const column of SCALAR_COLUMNS) {
    const held = current[column];
    const offered = incoming[column];
    const stated = previous === null ? undefined : previous[column];

    const gap = held === null || held === undefined || held === '';
    const untouched = previous !== null && held === stated;
    if (!gap && !untouched) continue;
    if (held === offered) continue;
    changes[column] = offered;
  }

  const heldCategories = current.categories ?? [];
  const statedCategories = Array.isArray(previous?.categories)
    ? (previous.categories as unknown[]).filter((value): value is string => typeof value === 'string')
    : null;
  const categoriesGap = heldCategories.length === 0;
  const categoriesUntouched = statedCategories !== null && sameCategories(heldCategories, statedCategories);
  if (
    (categoriesGap || categoriesUntouched) &&
    !sameCategories(heldCategories, incoming.categories)
  ) {
    changes.categories = incoming.categories;
  }

  return Object.keys(changes).length === 0 ? null : (changes as Partial<MergeablePlaceColumns>);
}

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
 * `places` has no such key. `name`, `categories`, the address columns and the
 * opening hours are single-valued and GoWay-owned, and the same UPDATE that refreshes a shop's
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

import { IMPORTED_COLUMNS, importedField, type ImportedColumns } from './fields';

/**
 * The subset of columns to write, or `null` when the merge changes nothing.
 *
 * `previous` is what the last run recorded in `places_sources.source_data`,
 * read by `previousColumns`: a column it never stated is absent, and the merge
 * then fills a gap and changes nothing else. Every column goes through the same
 * rule, with its own field's idea of EMPTY and SAME — `fields.ts` — so a
 * schedule, a category list and a phone number are merged by one loop rather
 * than one branch each.
 */
export function mergePlaceColumns(
  current: ImportedColumns,
  previous: Partial<ImportedColumns> | null,
  incoming: ImportedColumns,
): Partial<ImportedColumns> | null {
  const changes: Partial<Record<keyof ImportedColumns, unknown>> = {};

  for (const column of IMPORTED_COLUMNS) {
    const field = importedField(column);
    const held = current[column];
    const offered = incoming[column];

    const gap = field.empty(held);
    const untouched = previous !== null && column in previous && field.same(held, previous[column]);
    if (!gap && !untouched) continue;
    if (field.same(held, offered)) continue;
    changes[column] = offered;
  }

  return Object.keys(changes).length === 0 ? null : (changes as Partial<ImportedColumns>);
}

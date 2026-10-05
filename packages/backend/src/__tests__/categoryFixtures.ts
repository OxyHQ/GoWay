/**
 * The category taxonomy as `0016` seeded it, for the suites that need one
 * without a database.
 *
 * `fixtures/categoryTaxonomy-0.3.0.json` is the 0.3.0 contract registry —
 * keys, glyphs, OpenStreetMap tags — with the labels of
 * `contracts/src/i18n/category-labels.json` in twelve languages, frozen to JSON
 * before both were deleted: the same data `0016`'s seed was generated from. It is a TEST fixture and nothing else: production reads
 * the taxonomy from `place_categories`, and `categoryTables.realdb.test.ts`
 * holds the migrated database to this file entry for entry, so the importer's
 * unit suites below classify exactly as a freshly migrated database does.
 *
 * It is NOT kept in step with the live taxonomy. A moderator's edit changes
 * the database; this file stays what 0.3.0 shipped.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { LocalizedLabels, ModerationCategory } from '@goway/contracts';
import { catalogOf, type CategoryCatalog } from '../categories/catalog';

export interface SeededCategory {
  key: string;
  icon: string;
  /** Twelve languages, `en` first: the registry's English and Spanish and the translations of `feat/label-i18n`. */
  labels: LocalizedLabels;
  osmTags: string[];
}

/** The 148 seeded categories, in seed order. */
export const SEEDED_CATEGORIES: readonly SeededCategory[] = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'categoryTaxonomy-0.3.0.json'), 'utf8'),
) as SeededCategory[];

/** The seed as the catalog reads it: parents from keys, positions in tens among siblings. */
export function seededCategories(): ModerationCategory[] {
  const ordinal = new Map<string | null, number>();
  return SEEDED_CATEGORIES.map((entry) => {
    const separator = entry.key.lastIndexOf('.');
    const parent = separator < 0 ? null : entry.key.slice(0, separator);
    const position = ordinal.get(parent) ?? 0;
    ordinal.set(parent, position + 1);
    return {
      key: entry.key,
      parent,
      icon: entry.icon,
      status: 'active',
      label: entry.labels.en,
      labels: entry.labels,
      position: position * 10,
      osmTags: [...entry.osmTags].sort(),
      createdAt: '2026-10-05T00:00:00.000Z',
      updatedAt: '2026-10-05T00:00:00.000Z',
    };
  });
}

/** A catalog over the seed — what the importer reads from a freshly migrated database. */
export const SEEDED_CATALOG: CategoryCatalog = catalogOf(seededCategories());

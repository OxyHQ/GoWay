/**
 * Moving every place from one category key to another, in batches — the second
 * half of a rename.
 *
 * A key is immutable (`docs/PLACE_DATA.md`), so renaming `shop.newsagent` to
 * `shop.kiosk` is three steps: a moderator creates `shop.kiosk` (moving the
 * OpenStreetMap tags across in the same breath), deprecates `shop.newsagent`,
 * and an operator runs `bun run categories:move` to rewrite the places that
 * still carry the old key. Nothing is lost if the third step never runs — a
 * deprecated key is still read, labelled and filtered by — so it is a tidy-up,
 * not a deadline.
 *
 * ## What it rewrites, and why both sides
 *
 *  - `places.categories`: the old key replaced by the new one, repeats
 *    collapsed, an ancestor of another key dropped, order kept.
 *  - the OpenStreetMap import's record of what it last said
 *    (`places_sources.source_data.normalized.categories`), by the SAME rule.
 *    The import changes a column only while it still equals what OSM last
 *    said; moving the column alone would read as a GoWay correction and stop
 *    the column refreshing for good — `0011` converts both sides for the same
 *    reason.
 *
 * Each batch is one id range and one transaction, through the converter's own
 * machinery (`places/legacyConversion`): idempotent, resumable with `--from`,
 * retried on a lock timeout. A data move, not an edit: it records no
 * `place_revisions`, as `0011` records none. It moves `updated_at`, because a
 * client caching a place on it must refetch the new key.
 *
 * It refuses unless `from` is DEPRECATED and `to` is ACTIVE: an active `from`
 * would keep being written while the move runs, and the database's trigger
 * would refuse the move's own writes into an inactive `to`.
 */

import { getTableName } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { sqlColumnName } from '@oxy.so/db';
import type postgres from 'postgres';
import { placeCategories, places, placesSources } from '../db/schema';
import { OSM_SOURCE } from '../import/osm/writePlaces';
import {
  rangedCount,
  runIdBatches,
  type ConversionSummary,
  type IdBatchOptions,
} from '../places/legacyConversion';

/** The two sides of a move, in the order they run. */
export const MOVE_STEPS = ['places', 'sources'] as const;
export type MoveStepName = (typeof MOVE_STEPS)[number];

export interface MoveCategoryOptions extends IdBatchOptions {
  /** The deprecated key places are moved off. */
  readonly fromCategory: string;
  /** The active key they are moved to. */
  readonly toCategory: string;
  readonly steps: readonly MoveStepName[];
  /** Count the rows each step would change; write nothing. */
  readonly dryRun?: boolean;
}

const column = (target: PgColumn) => `"${sqlColumnName(target)}"`;

/**
 * A `text[]` expression with `$3` replaced by `$4`, repeats collapsed to their
 * first place, and any key that is an ancestor of another dropped.
 */
function moved(keys: string): string {
  const replaced = `array_replace(${keys}, $3::text, $4::text)`;
  return (
    `ARRAY(SELECT "item"."key" FROM (` +
    `SELECT "key", min("ordinality") AS "first" FROM unnest(${replaced}) WITH ORDINALITY AS "entry"("key", "ordinality") GROUP BY "key"` +
    `) AS "item" WHERE NOT EXISTS (` +
    `SELECT 1 FROM unnest(${replaced}) AS "other"("key") WHERE starts_with("other"."key", "item"."key" || '.')` +
    `) ORDER BY "item"."first")`
  );
}

/** The table, the rows that carry `$3`, and the rewrite, for each step. */
function stepOf(name: MoveStepName): { table: 'places' | 'places_sources'; predicate: string; update: string } {
  if (name === 'places') {
    const categories = column(places.categories);
    return {
      table: 'places',
      predicate: `${categories} @> ARRAY[$3::text]`,
      update:
        `UPDATE "${getTableName(places)}" SET ${categories} = ${moved(categories)}, ` +
        `${column(places.updatedAt)} = date_trunc('milliseconds', now())`,
    };
  }
  const data = column(placesSources.sourceData);
  const recorded = `${data} -> 'normalized' -> 'categories'`;
  return {
    table: 'places_sources',
    predicate: `${column(placesSources.source)} = '${OSM_SOURCE}' AND jsonb_typeof(${recorded}) = 'array' AND ${recorded} ? $3::text`,
    update:
      `UPDATE "${getTableName(placesSources)}" SET ${data} = jsonb_set(${data}, '{normalized,categories}', ` +
      `to_jsonb(${moved(`ARRAY(SELECT jsonb_array_elements_text(${recorded}))`)}))`,
  };
}

/** Refuse a move the database would not finish, before any batch runs. */
export async function assertMovable(session: postgres.Sql, from: string, to: string): Promise<void> {
  if (from === to) throw new Error('--from-category and --to-category name the same category.');
  const rows = await session.unsafe<{ key: string; status: string }[]>(
    `SELECT ${column(placeCategories.key)} AS "key", ${column(placeCategories.status)} AS "status" ` +
      `FROM "${getTableName(placeCategories)}" WHERE ${column(placeCategories.key)} IN ($1, $2)`,
    [from, to],
  );
  const status = new Map(rows.map((row) => [row.key, row.status]));
  if (status.get(from) !== 'deprecated') {
    throw new Error(`${from} must be a deprecated category: deprecate it first, so nothing writes it during the move.`);
  }
  if (status.get(to) !== 'active') throw new Error(`${to} must be an active category.`);
}

/** Move (or, with `dryRun`, count) each requested step. */
export async function moveCategoryPlaces(
  session: postgres.Sql,
  options: MoveCategoryOptions,
): Promise<ConversionSummary[]> {
  if (options.from && options.steps.length !== 1) {
    throw new Error('--from resumes ONE step; pass exactly one --step with it.');
  }
  await assertMovable(session, options.fromCategory, options.toCategory);
  const summaries: ConversionSummary[] = [];
  for (const name of MOVE_STEPS) {
    if (!options.steps.includes(name)) continue;
    const step = stepOf(name);
    const statement = options.dryRun
      ? rangedCount(step.table, step.predicate)
      : `${step.update}\nWHERE (${step.predicate}) AND "id" > $1 AND "id" <= $2`;
    summaries.push(
      await runIdBatches(
        session,
        {
          name,
          table: step.table,
          statement,
          counts: options.dryRun === true,
          // A count names only `$3`; an unreferenced `$4` would be a parameter
          // Postgres cannot type.
          parameters: options.dryRun ? [options.fromCategory] : [options.fromCategory, options.toCategory],
        },
        options,
      ),
    );
  }
  return summaries;
}

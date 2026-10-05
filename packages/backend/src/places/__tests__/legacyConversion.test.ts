/**
 * The converter reads `0011_goway_place_data_conversion` and `0013`'s CHECK
 * instead of restating them. These pin the shape it relies on, so an edit to
 * either migration that the converter would misread fails here, not halfway
 * through a production run.
 */

import { describe, expect, it } from 'bun:test';
import {
  CONVERSION_STEPS,
  loadLegacyConversion,
  parseConversionMigration,
  parseTaxonomyCheck,
  rangedCount,
  rangedUpdate,
} from '../legacyConversion';

describe('the conversion plan read from the migrations', () => {
  const plan = loadLegacyConversion();

  it('finds the three conversions, each on its own table', () => {
    expect(CONVERSION_STEPS.map((name) => [name, plan.steps[name].table])).toEqual([
      ['categories', 'places'],
      ['sources', 'places_sources'],
      ['timezone', 'places'],
    ]);
  });

  it('runs everything that is not an UPDATE once per session: the mapping and its functions', () => {
    expect(plan.setup.map((statement) => statement.split(/\s+/).slice(0, 3).join(' '))).toEqual([
      'CREATE TEMP TABLE',
      'INSERT INTO pg_temp."goway_category_mapping"',
      'ANALYZE pg_temp."goway_category_mapping";',
      'CREATE FUNCTION pg_temp.goway_category_keys(legacy',
      'CREATE FUNCTION pg_temp.goway_source_data_v2(legacy_data',
    ]);
  });

  it('narrows the WHOLE predicate to an id range, not just its last disjunct', () => {
    const sources = rangedUpdate(plan.steps.sources);
    expect(sources).toEndWith(
      `WHERE ("source_data" IS NOT NULL AND "source_data" -> 'v' IS NULL) AND "id" > $1 AND "id" <= $2`,
    );
    expect(rangedUpdate(plan.steps.categories)).toMatch(/\nWHERE \(CASE[\s\S]*END\) AND "id" > \$1 AND "id" <= \$2$/);
    expect(rangedCount('places', 'x OR y')).toBe(
      `SELECT count(*)::int AS "rows" FROM "places" WHERE (x OR y) AND "id" > $1 AND "id" <= $2`,
    );
  });

  it("reads 0013's CHECK whole, up to its balanced parenthesis", () => {
    expect(plan.taxonomyCheck).toStartWith(`"places"."categories" <@ ARRAY['food', `);
    expect(plan.taxonomyCheck).toEndWith(`]::text[]`);
  });

  it('refuses a migration shape it would misread', () => {
    const update = (table: string, body: string) => `UPDATE "${table}"\n${body};`;
    const valid = [
      update('places', 'SET "categories" = x\nWHERE true'),
      update('places_sources', 'SET "source_data" = y\nWHERE true'),
      update('places', 'SET "timezone" = z\nWHERE true'),
    ];
    expect(() => parseConversionMigration(valid.join('\n--> statement-breakpoint\n'))).not.toThrow();
    expect(() => parseConversionMigration(valid.slice(0, 2).join('\n--> statement-breakpoint\n'))).toThrow(/no "timezone"/);
    expect(() =>
      parseConversionMigration([...valid, update('places', 'SET "categories" = w\nWHERE false')].join('\n--> statement-breakpoint\n')),
    ).toThrow(/two "categories"/);
    expect(() => parseConversionMigration(update('places', 'SET "categories" = x WHERE true'))).toThrow(/line-initial WHERE/);
    expect(() => parseConversionMigration(update('places_names', 'SET "name" = x\nWHERE true'))).toThrow(/does not batch/);
    expect(() => parseTaxonomyCheck('ALTER TABLE "places" ADD CONSTRAINT "other" CHECK (true);')).toThrow(/does not add/);
  });
});

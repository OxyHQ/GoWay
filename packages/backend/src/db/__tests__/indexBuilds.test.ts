/**
 * Which statements of a migration the migrator builds concurrently first, and
 * the exact statement it runs for each. The database side is
 * `indexBuilds.realdb.test.ts`.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readIndexBuilds } from '../indexBuilds';
import { MIGRATIONS_FOLDER } from '../migrationsFolder';

describe('readIndexBuilds', () => {
  it('reads both of 0026 and changes nothing but CONCURRENTLY', () => {
    const contents = readFileSync(
      join(MIGRATIONS_FOLDER, '0026_goway_place_name_search.sql'),
      'utf8',
    );
    const builds = readIndexBuilds('0026_goway_place_name_search', contents);
    expect(builds.map((build) => [build.index, build.table])).toEqual([
      ['places_name_fold_trgm_idx', 'places'],
      ['places_names_name_fold_trgm_idx', 'places_names'],
    ]);
    const statements = contents
      .split('--> statement-breakpoint')
      .map((chunk) => chunk.replace('-- oxy:deploy-phase=pre', '').trim().replace(/;$/, ''));
    builds.forEach((build, index) => {
      expect(build.concurrentStatement).toBe(
        statements[index].replace(
          'CREATE INDEX IF NOT EXISTS',
          'CREATE INDEX CONCURRENTLY IF NOT EXISTS',
        ),
      );
    });
  });

  it('keeps UNIQUE and a schema-qualified table', () => {
    const [build] = readIndexBuilds(
      't',
      'CREATE UNIQUE INDEX IF NOT EXISTS "a_key" ON "public"."a" USING btree ("x") WHERE "x" IS NOT NULL;',
    );
    expect(build).toEqual({
      tag: 't',
      index: 'a_key',
      schema: 'public',
      table: 'a',
      concurrentStatement:
        'CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "a_key" ON "public"."a" USING btree ("x") WHERE "x" IS NOT NULL',
    });
  });

  it('leaves a plain CREATE INDEX, ON ONLY and every other statement to the migration', () => {
    expect(
      readIndexBuilds(
        't',
        [
          '-- oxy:deploy-phase=pre',
          'CREATE INDEX "plain_idx" ON "a" USING btree ("x");',
          'CREATE INDEX IF NOT EXISTS "parent_idx" ON ONLY "p" USING btree ("x");',
          'ALTER TABLE "a" ADD COLUMN "y" text;',
          'CREATE TABLE "b" ("id" text);',
        ].join('--> statement-breakpoint\n'),
      ),
    ).toEqual([]);
  });
});

/**
 * `0011_goway_place_data_conversion` and `places:convert-legacy`, against a
 * real server.
 *
 * Three claims:
 *
 *  1. The conversion itself: what the previous release wrote becomes taxonomy
 *     keys, a version-2 statement and a timezone column.
 *  2. The cheap "already converted" test the migration's category UPDATE
 *     answers first agrees with calling the function, on every shape.
 *  3. The converter and the migration are ONE conversion: two databases at the
 *     pre-deploy schema, seeded identically with legacy rows — one converted by
 *     the batched command and then migrated, the other only migrated — end
 *     byte-identical, and the migration rewrites no row of the first. That last
 *     part is what makes the post-deploy phase a scan instead of a rewrite.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { CATEGORY_KEYS } from '@goway/contracts';
import postgres from 'postgres';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  migrateSuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import {
  TAXONOMY_CONSTRAINT,
  convertLegacyPlaceData,
  loadLegacyConversion,
  prepareConversionSession,
  validateTaxonomyConstraint,
} from '../legacyConversion';

/**
 * The release this deploy test reproduces: its pre/post window is the state the
 * conversion runs in. A later release's migrations do not exist for it.
 */
const PLACES_PLATFORM_RELEASE = '0013_goway_category_taxonomy';
const plan = loadLegacyConversion();

/** One connection: the mapping and the functions live in its `pg_temp`. */
function sessionFor(suite: SuiteDatabase): postgres.Sql {
  return postgres(suite.databaseUrl, { max: 1, onnotice: () => undefined });
}

describe('the conversion', () => {
  let suite: SuiteDatabase | null = null;
  let session: postgres.Sql;

  beforeAll(async () => {
    suite = await createSuiteDatabase();
    session = sessionFor(suite);
    await prepareConversionSession(session, plan);
  }, SUITE_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await session?.end({ timeout: 5 });
    await destroySuiteDatabase(suite);
    suite = null;
  });

  async function convert(legacy: string[]): Promise<string[]> {
    const [row] = await session<{ keys: string[] }[]>`SELECT pg_temp.goway_category_keys(${legacy}::text[]) AS keys`;
    return row?.keys ?? [];
  }

  it('turns what the old importer wrote into one taxonomy key', async () => {
    expect(await convert(['cafe', 'food_drink'])).toEqual(['food.cafe']);
    expect(await convert(['supermarket', 'grocery', 'shopping'])).toEqual(['shop.supermarket']);
    expect(await convert(['museum', 'culture'])).toEqual(['culture.museum']);
    expect(await convert(['station', 'railway', 'transit'])).toEqual(['transport.rail_station']);
  });

  it("keeps the app's own keys, drops what it cannot map, and never leaves an ancestor beside its child", async () => {
    expect(await convert(['transit_station', 'bicycle_rental'])).toEqual([
      'transport.rail_station',
      'transport.bicycle_rental',
    ]);
    expect(await convert(['coworking'])).toEqual(['office.coworking']);
    expect(await convert(['zz_unheard_of'])).toEqual([]);
    expect(await convert(['food_drink'])).toEqual(['food']);
    expect(await convert([])).toEqual([]);
  });

  it('is the identity on every taxonomy key, so running it twice changes nothing', async () => {
    const moved = await session<{ key: string }[]>`
      SELECT key FROM unnest(${[...CATEGORY_KEYS]}::text[]) AS key
      WHERE pg_temp.goway_category_keys(ARRAY[key]) IS DISTINCT FROM ARRAY[key]
    `;
    expect([...moved]).toEqual([]);
    expect(await convert(['food.cafe', 'culture.attraction'])).toEqual(['food.cafe', 'culture.attraction']);
  });

  it('answers "already converted" exactly as the function would, on every shape', async () => {
    // Every key the mapping knows (legacy and taxonomy) and one it does not,
    // in lists of one to four with repeats, ancestors and descendants.
    const disagreements = await session.unsafe<{ categories: string[] }[]>(`
      WITH "keys" AS (
        SELECT array_agg(k ORDER BY k) AS "all" FROM (
          SELECT "legacy_key" AS k FROM pg_temp."goway_category_mapping"
          UNION SELECT 'zz_unheard_of'
        ) AS "known"
      ),
      "lists" AS (
        SELECT ARRAY(
          SELECT "keys"."all"[1 + (hashint4(n * 7 + slot) & 2147483647) % cardinality("keys"."all")]
          FROM generate_series(1, 1 + n % 4) AS slot
        ) AS "categories"
        FROM generate_series(1, 20000) AS n, "keys"
        UNION ALL SELECT ARRAY['food', 'food.cafe']
        UNION ALL SELECT ARRAY['food.cafe', 'food.cafe']
        UNION ALL SELECT ARRAY['food.cafe', 'shop.bakery']
        UNION ALL SELECT ARRAY['civic', 'food.cafe']
        UNION ALL SELECT ARRAY['food.cafe']
        UNION ALL SELECT '{}'::text[]
      )
      SELECT "categories" FROM "lists"
      WHERE (${plan.steps.categories.predicate})
        IS DISTINCT FROM ("categories" IS DISTINCT FROM pg_temp.goway_category_keys("categories"))
    `);
    expect([...disagreements]).toEqual([]);
  });

  it('wraps a version-1 statement as version 2, its categories converted the same way', async () => {
    const [row] = await session.unsafe<{ data: unknown }[]>(`SELECT pg_temp.goway_source_data_v2($1::text::jsonb) AS data`, [
      JSON.stringify({ name: 'Bar Pepe', categories: ['bar', 'food_drink'] }),
    ]);
    expect(row?.data).toEqual({ v: 2, tags: {}, normalized: { name: 'Bar Pepe', categories: ['food.bar'] } });
  });
});

describe('the batched converter and the migration', () => {
  let converted: SuiteDatabase | null = null;
  let migratedOnly: SuiteDatabase | null = null;

  /** The rows the previous release wrote, in every shape the conversion meets. */
  async function seed(sql: postgres.Sql): Promise<void> {
    await sql.unsafe(`
      INSERT INTO places (id, name, latitude, longitude, categories, opening_hours)
      SELECT
        'place-' || lpad(n::text, 4, '0'),
        'Place ' || n,
        41 + n / 10000.0,
        2 + n / 10000.0,
        CASE n % 10
          WHEN 0 THEN ARRAY['cafe', 'food_drink']
          WHEN 1 THEN ARRAY['supermarket', 'grocery', 'shopping']
          WHEN 2 THEN ARRAY['post_office', 'post', 'civic']
          WHEN 3 THEN ARRAY['restaurant', 'restaurant']
          WHEN 4 THEN ARRAY['zz_unheard_of']
          WHEN 5 THEN ARRAY['food', 'food.cafe']
          WHEN 6 THEN ARRAY['food.cafe']
          WHEN 7 THEN ARRAY['station', 'railway', 'transit']
          WHEN 8 THEN ARRAY['museum', 'culture', 'zz_unheard_of']
          ELSE ARRAY['atm', 'civic', 'bank']
        END,
        CASE n % 7
          WHEN 0 THEN '{"intervals": [], "timezone": "Europe/Madrid"}'::jsonb
          WHEN 1 THEN '{"intervals": [], "timezone": "Madrid; drop"}'::jsonb
          WHEN 2 THEN '{"intervals": []}'::jsonb
        END
      FROM generate_series(1, 240) AS n;
      UPDATE places SET categories = '{}' WHERE id = 'place-0003';
      INSERT INTO places_sources (id, place_id, source, source_id, source_data)
      SELECT
        'source-' || substr(id, 7),
        id,
        'openstreetmap',
        'node/' || substr(id, 7),
        CASE substr(id, 7)::int % 5
          WHEN 0 THEN jsonb_build_object('name', name, 'categories', to_jsonb(categories))
          WHEN 1 THEN jsonb_build_object('name', name)
          WHEN 2 THEN jsonb_build_object('name', name, 'categories', 'cafe')
          WHEN 3 THEN NULL
          ELSE jsonb_build_object('v', 2, 'tags', '{}'::jsonb, 'normalized', jsonb_build_object('name', name))
        END
      FROM places;
    `);
  }

  async function rows(suite: SuiteDatabase) {
    const sql = sessionFor(suite);
    try {
      const places = await sql`SELECT id, categories, timezone, opening_hours FROM places ORDER BY id`;
      const sources = await sql`SELECT id, source_data FROM places_sources ORDER BY id`;
      return { places: [...places], sources: [...sources] };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  async function versions(suite: SuiteDatabase) {
    const sql = sessionFor(suite);
    try {
      const places = await sql`SELECT id, xmin::text AS version FROM places ORDER BY id`;
      const sources = await sql`SELECT id, xmin::text AS version FROM places_sources ORDER BY id`;
      return { places: [...places], sources: [...sources] };
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  beforeAll(async () => {
    converted = await createSuiteDatabase({ run: 'pre', throughTag: PLACES_PLATFORM_RELEASE });
    migratedOnly = await createSuiteDatabase({ run: 'pre', throughTag: PLACES_PLATFORM_RELEASE });
    for (const suite of [converted, migratedOnly]) {
      const sql = sessionFor(suite);
      try {
        await seed(sql);
      } finally {
        await sql.end({ timeout: 5 });
      }
    }
  }, SUITE_SETUP_TIMEOUT_MS * 2);

  afterAll(async () => {
    await destroySuiteDatabase(converted);
    await destroySuiteDatabase(migratedOnly);
    converted = null;
    migratedOnly = null;
  });

  it('counts, converts in batches, and then finds nothing left to do', async () => {
    const sql = sessionFor(converted!);
    try {
      await prepareConversionSession(sql, plan);
      const steps = ['categories', 'sources', 'timezone'] as const;
      const options = { steps, batchSize: 7 };

      const counted = await convertLegacyPlaceData(sql, plan, { ...options, dryRun: true });
      const done = await convertLegacyPlaceData(sql, plan, options);
      const again = await convertLegacyPlaceData(sql, plan, { ...options, dryRun: true });
      const rerun = await convertLegacyPlaceData(sql, plan, options);

      const matched = (summaries: typeof done) => Object.fromEntries(summaries.map((s) => [s.step, s.matched]));
      expect(matched(done)).toEqual({ categories: expect.any(Number), sources: expect.any(Number), timezone: 69 });
      expect(matched(counted)).toEqual({ ...matched(done), 'taxonomy-check': expect.any(Number) });
      expect(matched(counted)['taxonomy-check']).toBeGreaterThan(0);
      expect(matched(again)).toEqual({ categories: 0, 'taxonomy-check': 0, sources: 0, timezone: 0 });
      expect(matched(rerun)).toEqual({ categories: 0, sources: 0, timezone: 0 });
      expect(done.every((s) => s.examined === 240 && s.batches === Math.ceil(240 / 7))).toBe(true);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('resumes after an id, covering only what follows it', async () => {
    const sql = sessionFor(converted!);
    try {
      await prepareConversionSession(sql, plan, { dryRun: true });
      const [summary] = await convertLegacyPlaceData(sql, plan, {
        steps: ['sources'],
        batchSize: 50,
        from: 'source-0200',
        dryRun: true,
      });
      expect(summary?.examined).toBe(40);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  it('leaves exactly what the migration alone leaves, and the migration then rewrites no row', async () => {
    const before = await versions(converted!);
    await migrateSuiteDatabase(converted!.databaseUrl, 'post', PLACES_PLATFORM_RELEASE);
    await migrateSuiteDatabase(migratedOnly!.databaseUrl, 'post', PLACES_PLATFORM_RELEASE);

    expect(await versions(converted!)).toEqual(before);
    expect(await rows(converted!)).toEqual(await rows(migratedOnly!));
    // Spot-check the result is the conversion, not two identical no-ops.
    const { places } = await rows(converted!);
    expect(places.find((p) => p.id === 'place-0007')).toMatchObject({ categories: ['transport.rail_station'], timezone: 'Europe/Madrid' });
  });

  it('validates the CHECK the post phase added NOT VALID, without rewriting anything', async () => {
    const sql = sessionFor(converted!);
    try {
      const [before] = await sql`SELECT convalidated FROM pg_constraint WHERE conname = ${TAXONOMY_CONSTRAINT}`;
      expect(before?.convalidated).toBe(false);
      expect((await validateTaxonomyConstraint(sql)).alreadyValid).toBe(false);
      expect((await validateTaxonomyConstraint(sql)).alreadyValid).toBe(true);
      // NOT VALID never meant unchecked: a new legacy key is refused at once.
      const refused = await sql`UPDATE places SET categories = ARRAY['cafe'] WHERE id = 'place-0001'`.then(
        () => null,
        (error: unknown) => error,
      );
      expect(String(refused)).toContain(TAXONOMY_CONSTRAINT);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

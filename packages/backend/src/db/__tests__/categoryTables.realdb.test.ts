/**
 * The category tables against a real server: what `0015`–`0017` leave, and
 * the triggers that are the only thing holding `places.categories` to them.
 *
 * Four claims:
 *
 *  1. The seed IS the 0.3.0 taxonomy — every key, parent, glyph, position,
 *     label in all twelve languages and OpenStreetMap tag — compared entry for
 *     entry with the frozen fixture it was generated from.
 *  2. A write can only ADD an active category: an unknown key, a deprecated
 *     key and a NULL are refused; a row already carrying a deprecated key is
 *     still read, still edited, and may keep it.
 *  3. English is required, a key is immutable, and a key a place carries is
 *     never deleted.
 *  4. The release deploys onto the places-platform release's ledger as its pre
 *     phase, with the rows that release left readable and the CHECK gone.
 *
 * This suite does not skip. See `testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import postgres from 'postgres';
import { SEEDED_CATEGORIES } from '../../__tests__/categoryFixtures';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  migrateSuiteDatabase,
  type SuiteDatabase,
} from './testDatabase';

/** The label languages the seed carries for every category, `en` first. */
const SEEDED_LANGUAGES = ['en', 'ar', 'bn', 'ca', 'de', 'es', 'fr', 'hi', 'ja', 'pt-BR', 'ru', 'zh-Hans'];

let suite: SuiteDatabase | null = null;
let sql: postgres.Sql;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  sql = postgres(suite.databaseUrl, { max: 2, onnotice: () => undefined });
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await sql?.end({ timeout: 5 });
  await destroySuiteDatabase(suite);
  suite = null;
});

/** The error a statement raised, or `null` when it succeeded. */
async function refusal(statement: Promise<unknown>): Promise<{ constraint?: string; code?: string } | null> {
  return statement.then(
    () => null,
    (error: { constraint_name?: string; code?: string }) => ({ constraint: error.constraint_name, code: error.code }),
  );
}

let placeCounter = 0;

/** A place inserted straight into the table, as a script or an importer would. */
function insertPlace(categories: (string | null)[]) {
  placeCounter += 1;
  return sql`
    INSERT INTO places (id, name, latitude, longitude, categories)
    VALUES (${`category-place-${placeCounter}`}, 'Sitio', 41.39, 2.17, ${categories}::text[])
    RETURNING id
  `;
}

describe('the seed', () => {
  it('is the 0.3.0 taxonomy, entry for entry, in all twelve label languages', async () => {
    const categories = await sql<{ key: string; parent_key: string | null; icon: string; position: number; status: string }[]>`
      SELECT key, parent_key, icon, position, status FROM place_categories
    `;
    const labels = await sql<{ category_key: string; language: string; label: string }[]>`
      SELECT category_key, language, label FROM place_category_labels
    `;
    const tags = await sql<{ category_key: string; tag: string }[]>`SELECT category_key, tag FROM place_category_osm_tags`;

    const ordinal = new Map<string | null, number>();
    const expected = SEEDED_CATEGORIES.map((entry) => {
      const parent = entry.key.includes('.') ? entry.key.slice(0, entry.key.lastIndexOf('.')) : null;
      const position = ordinal.get(parent) ?? 0;
      ordinal.set(parent, position + 1);
      return {
        key: entry.key,
        parent,
        icon: entry.icon,
        position: position * 10,
        status: 'active',
        labels: entry.labels,
        osmTags: [...entry.osmTags].sort(),
      };
    });
    const actual = new Map(
      categories.map((row) => [
        row.key,
        {
          key: row.key,
          parent: row.parent_key,
          icon: row.icon,
          position: row.position,
          status: row.status,
          labels: Object.fromEntries(labels.filter((label) => label.category_key === row.key).map((label) => [label.language, label.label])),
          osmTags: tags.filter((tag) => tag.category_key === row.key).map((tag) => tag.tag).sort(),
        },
      ]),
    );

    expect(categories.length).toBe(148);
    expect(labels.length).toBe(148 * SEEDED_LANGUAGES.length);
    expect(tags.length).toBe(SEEDED_CATEGORIES.reduce((total, entry) => total + entry.osmTags.length, 0));
    for (const entry of expected) expect(actual.get(entry.key)).toEqual(entry);
  });

  it('holds every label to one spelling: twelve languages, trimmed, NFC, no bidirectional controls', () => {
    for (const { key, labels } of SEEDED_CATEGORIES) {
      expect(Object.keys(labels)).toEqual(SEEDED_LANGUAGES);
      for (const [language, label] of Object.entries(labels)) {
        const where = `${key} ${language}`;
        expect({ where, label }).toEqual({ where, label: label.normalize('NFC').trim() });
        expect({ where, bidi: /[‎‏‪-‮⁦-⁩]/.test(label) }).toEqual({ where, bidi: false });
      }
    }
  });
});

describe('places.categories', () => {
  beforeAll(async () => {
    // One transaction: the English label is checked at commit.
    await sql.begin(async (tx) => {
      await tx`INSERT INTO place_categories (key, parent_key, icon, status) VALUES ('food.automat', 'food', 'cafe', 'deprecated')`;
      await tx`INSERT INTO place_category_labels (category_key, language, label) VALUES ('food.automat', 'en', 'Automat')`;
    });
  });

  it('admits active categories and no category at all', async () => {
    expect(await refusal(insertPlace(['food.cafe', 'culture.attraction']))).toBeNull();
    expect(await refusal(insertPlace([]))).toBeNull();
  });

  it('refuses a key that is not a category, a deprecated one and a NULL, naming the trigger', async () => {
    for (const categories of [['cafe'], ['food.cafe', 'food.automat'], [null]]) {
      expect({ categories, refused: await refusal(insertPlace(categories)) }).toEqual({
        categories,
        refused: { constraint: 'places_categories_taxonomy_guard', code: '23514' },
      });
    }
  });

  it('lets a place keep a key that was deprecated after it was written, and refuses adding it anywhere else', async () => {
    const [carrier] = await insertPlace(['food.cafe']);
    const [other] = await insertPlace(['food.cafe']);
    // As a moderator deprecating an existing category leaves things: the row
    // was valid when written, and nothing re-checks it.
    await sql`UPDATE place_categories SET status = 'active' WHERE key = 'food.automat'`;
    await sql`UPDATE places SET categories = ARRAY['food.automat', 'food.cafe'] WHERE id = ${carrier!.id}`;
    await sql`UPDATE place_categories SET status = 'deprecated' WHERE key = 'food.automat'`;

    const [read] = await sql<{ categories: string[] }[]>`SELECT categories FROM places WHERE id = ${carrier!.id}`;
    expect(read?.categories).toEqual(['food.automat', 'food.cafe']);
    expect(await refusal(sql`UPDATE places SET name = 'Renamed' WHERE id = ${carrier!.id}`)).toBeNull();
    expect(
      await refusal(sql`UPDATE places SET categories = ARRAY['food.automat', 'food.bakery'] WHERE id = ${carrier!.id}`),
    ).toBeNull();
    expect(await refusal(sql`UPDATE places SET categories = ARRAY['food.automat'] WHERE id = ${other!.id}`)).toEqual({
      constraint: 'places_categories_taxonomy_guard',
      code: '23514',
    });
  });

  it('is enforced by the trigger alone: the static CHECK is gone', async () => {
    const [check] = await sql`SELECT 1 FROM pg_constraint WHERE conname = 'places_categories_taxonomy_check'`;
    expect(check).toBeUndefined();
  });
});

describe('the taxonomy tables', () => {
  it('refuses a category without an English label, at commit', async () => {
    const created = sql.begin(async (tx) => {
      await tx`INSERT INTO place_categories (key, parent_key, icon) VALUES ('shop.kites', 'shop', 'shop')`;
      await tx`INSERT INTO place_category_labels (category_key, language, label) VALUES ('shop.kites', 'es', 'Cometas')`;
    });
    expect(await refusal(created)).toEqual({ constraint: 'place_categories_english_label', code: '23514' });
  });

  it('refuses removing or moving an English label', async () => {
    expect(await refusal(sql`DELETE FROM place_category_labels WHERE category_key = 'food.cafe' AND language = 'en'`)).toEqual({
      constraint: 'place_categories_english_label',
      code: '23514',
    });
    expect(
      await refusal(sql`UPDATE place_category_labels SET language = 'en-GB' WHERE category_key = 'food.cafe' AND language = 'en'`),
    ).toEqual({ constraint: 'place_categories_english_label', code: '23514' });
  });

  it('refuses a parent that is not the key minus its last segment, and a malformed key', async () => {
    expect(await refusal(sql`INSERT INTO place_categories (key, parent_key, icon) VALUES ('shop.kites', 'food', 'shop')`)).toEqual({
      constraint: 'place_categories_parent_check',
      code: '23514',
    });
    expect(await refusal(sql`INSERT INTO place_categories (key, icon) VALUES ('Shop', 'shop')`)).toMatchObject({
      code: '23514',
    });
    expect(await refusal(sql`INSERT INTO place_categories (key, parent_key, icon) VALUES ('kites.box', 'kites', 'shop')`)).toMatchObject({
      code: '23503',
    });
  });

  it('never renames a key, and never deletes one a place carries', async () => {
    await insertPlace(['food.cafe']);
    expect(await refusal(sql`UPDATE place_categories SET key = 'food.coffee' WHERE key = 'food.cafe'`)).toEqual({
      constraint: 'place_categories_key_immutable',
      code: '23001',
    });
    expect(await refusal(sql`DELETE FROM place_categories WHERE key = 'food.cafe'`)).toEqual({
      constraint: 'place_categories_in_use',
      code: '23001',
    });
    // One nothing carries can go, with its labels and tags.
    await sql.begin(async (tx) => {
      await tx`INSERT INTO place_categories (key, parent_key, icon) VALUES ('shop.kites', 'shop', 'shop')`;
      await tx`INSERT INTO place_category_labels (category_key, language, label) VALUES ('shop.kites', 'en', 'Kites')`;
    });
    expect(await refusal(sql`DELETE FROM place_categories WHERE key = 'shop.kites'`)).toBeNull();
  });

  it('files one OpenStreetMap tag under one category', async () => {
    expect(
      await refusal(sql`INSERT INTO place_category_osm_tags (tag, category_key) VALUES ('amenity=cafe', 'food.bar')`),
    ).toMatchObject({ code: '23505' });
  });
});

describe('the deploy onto the places-platform release', () => {
  let previous: SuiteDatabase | null = null;

  afterAll(async () => {
    await destroySuiteDatabase(previous);
    previous = null;
  });

  it('applies as one pre phase, and every row that release wrote still reads', async () => {
    // The ledger as the places-platform release leaves production: 0013 applied.
    previous = await createSuiteDatabase({ throughTag: '0013_goway_category_taxonomy' });
    const old = postgres(previous.databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await old`
        INSERT INTO places (id, name, latitude, longitude, categories)
        SELECT 'before-' || n, 'Sitio ' || n, 41.39, 2.17, ARRAY['food.cafe', 'shop.books']
        FROM generate_series(1, 50) AS n
      `;
      await migrateSuiteDatabase(previous.databaseUrl, 'pre');

      const [counts] = await old<{ places: number; categories: number; check: number }[]>`
        SELECT (SELECT count(*)::int FROM places WHERE categories = ARRAY['food.cafe', 'shop.books']) AS places,
               (SELECT count(*)::int FROM place_categories) AS categories,
               (SELECT count(*)::int FROM pg_constraint WHERE conname = 'places_categories_taxonomy_check') AS check
      `;
      expect(counts).toEqual({ places: 50, categories: 148, check: 0 });
      const [pending] = await old<{ applied: number }[]>`SELECT count(*)::int AS applied FROM drizzle.__drizzle_migrations`;
      expect(pending?.applied).toBe(18);
    } finally {
      await old.end({ timeout: 5 });
    }
  });
});

/**
 * Name search over GoWay's own places, against a real PostGIS + pg_trgm.
 *
 * What an in-memory test cannot see: that the folded `translate(...)` expression
 * the query spells is the one the trigram indexes are built on (a mismatch is a
 * correct answer from a sequential scan), that `word_similarity` really finds a
 * typo, and that LIKE wildcards in typed text are text. This suite does not
 * skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { findPlacesByText } from '../places/placesRepository';
import { FOLD_TABLE } from '../places/textFold';
import {
  requireSuite,
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from './testDatabase';

const BARCELONA = { latitude: 41.4036, longitude: 2.1744 };
const MADRID = { latitude: 40.4168, longitude: -3.7038 };
const FAR = { latitude: 52.52, longitude: 13.405 };

let suite: SuiteDatabase | null = null;

async function seed(
  id: string,
  name: string,
  at: { latitude: number; longitude: number },
  categories: string[] = [],
): Promise<void> {
  await requireSuite(suite).client`
    INSERT INTO places (id, name, latitude, longitude, categories)
    VALUES (${id}, ${name}, ${at.latitude}, ${at.longitude}, ${categories})
  `;
}

async function search(
  text: string,
  extra: Partial<Parameters<typeof findPlacesByText>[1]> = {},
): Promise<string[]> {
  const found = await findPlacesByText(requireSuite(suite).db, { text, limit: 10, ...extra });
  return found.map((place) => place.id);
}

beforeAll(async () => {
  suite = await createSuiteDatabase();
  await seed('exact', 'Central', BARCELONA);
  await seed('prefix', 'Central Station', BARCELONA);
  await seed('word', 'Bar Central Norte', BARCELONA);
  await seed('inside', 'Descentralizado', BARCELONA);
  await seed('cafe-accent', 'Café Sagrada', BARCELONA);
  await seed('cafe-plain', 'Cafe Luna', MADRID);
  await seed('pharmacy', 'Farmacia López', BARCELONA);
  await seed('munich', 'München', FAR);
  await seed('bakery', 'Nothing Relevant', BARCELONA, ['food.bakery']);
  await seed('bakery-far', 'Also Irrelevant', FAR, ['food.bakery']);
  await seed('percent', '100% Natural', BARCELONA);
  await seed('plain', 'Hundred Natural', BARCELONA);
  await requireSuite(suite).client`
    INSERT INTO places_names (id, place_id, language, source, name)
    VALUES ('munich-en', 'munich', 'en', 'test', 'Munich')
  `;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('findPlacesByText', () => {
  it('ranks exact, then prefix, then word-start, then substring', async () => {
    expect(await search('central')).toEqual(['exact', 'prefix', 'word', 'inside']);
  });

  it('folds accents in both directions', async () => {
    expect(await search('cafe')).toEqual(expect.arrayContaining(['cafe-accent', 'cafe-plain']));
    expect(await search('CAFÉ')).toEqual(expect.arrayContaining(['cafe-accent', 'cafe-plain']));
  });

  it('finds a place despite a typo', async () => {
    expect(await search('farmcia')).toContain('pharmacy');
    expect(await search('farmacia lopez')).toContain('pharmacy');
  });

  it('finds a place by a name it holds in another language', async () => {
    expect(await search('munich')).toContain('munich');
  });

  it('works with no position, and orders ties by distance when there is one', async () => {
    expect((await search('cafe')).length).toBe(2);
    expect(await search('cafe', { center: MADRID, radiusMeters: 100_000 })).toEqual(['cafe-plain']);
    expect(await search('cafe', { center: BARCELONA, radiusMeters: 1_000_000 })).toEqual([
      'cafe-accent',
      'cafe-plain',
    ]);
  });

  it('puts a category the text names after every name match', async () => {
    const found = await search('bakery', {
      center: BARCELONA,
      radiusMeters: 100_000,
      categoryIntent: ['food.bakery'],
    });
    expect(found).toEqual(['bakery']);
  });

  it('treats LIKE wildcards in the typed text as text', async () => {
    expect(await search('100%')).toEqual(['percent']);
    expect(await search('_____')).toEqual([]);
  });

  it('answers a one-letter query only when anchored', async () => {
    expect(await search('c')).toEqual([]);
    expect((await search('c', { center: BARCELONA, radiusMeters: 10_000 })).length).toBeGreaterThan(
      0,
    );
  });
});

describe('the name indexes', () => {
  it('serve the folded expression the query spells', async () => {
    const { client } = requireSuite(suite);
    const from = FOLD_TABLE.from.replace(/'/g, "''");
    const to = FOLD_TABLE.to.replace(/'/g, "''");
    const plan = await client.begin(async (transaction) => {
      await transaction`SET LOCAL enable_seqscan = off`;
      return transaction.unsafe(
        `EXPLAIN SELECT id FROM places WHERE translate(name_normalized, '${from}', '${to}') LIKE '%central%'`,
      );
    });
    expect(JSON.stringify(plan)).toContain('places_name_fold_trgm_idx');
  });
});

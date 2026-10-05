/**
 * `categories:move` against a real server: a rename's last step rewrites both
 * the places and the import's record of them by one rule, once.
 *
 * This suite does not skip. See `db/__tests__/testDatabase.ts`.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import postgres from 'postgres';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  type SuiteDatabase,
} from '../../db/__tests__/testDatabase';
import { placeCategories, placeCategoryLabels, places, placesSources } from '../../db/schema';
import { prepareBatchSession } from '../../places/legacyConversion';
import { moveCategoryPlaces } from '../moveCategory';

let suite: SuiteDatabase | null = null;
let session: postgres.Sql;

/** Each place's categories before the move, and after it. */
const CASES: Record<string, [string[], string[]]> = {
  'move-1': [['shop.newsagent'], ['shop.kiosk']],
  'move-2': [['shop.newsagent', 'culture.attraction'], ['shop.kiosk', 'culture.attraction']],
  // Already carried: the repeat collapses to its first place.
  'move-3': [['shop.kiosk', 'shop.newsagent'], ['shop.kiosk']],
  // An ancestor of the new key is dropped, as the importer drops one.
  'move-4': [['shop', 'shop.newsagent'], ['shop.kiosk']],
  'move-5': [['food.cafe'], ['food.cafe']],
};

const options = { fromCategory: 'shop.newsagent', toCategory: 'shop.kiosk', batchSize: 2 } as const;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  session = postgres(suite.databaseUrl, { max: 1, onnotice: () => undefined });
  await prepareBatchSession(session, 'goway-categories-move-test');
  const db = suite.db;
  await db.transaction(async (tx) => {
    await tx.insert(placeCategories).values({ key: 'shop.kiosk', parentKey: 'shop', icon: 'book', position: 1000 });
    await tx.insert(placeCategoryLabels).values({ categoryKey: 'shop.kiosk', language: 'en', label: 'Kiosk' });
  });
  for (const [id, [categories]] of Object.entries(CASES)) {
    await db.insert(places).values({ id, name: id, latitude: 40.4, longitude: -3.7, categories });
    await db.insert(placesSources).values({
      placeId: id,
      source: 'openstreetmap',
      sourceId: `node/${id.slice(-1)}`,
      sourceData: { v: 2, tags: {}, normalized: { categories } },
    });
  }
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await session?.end({ timeout: 5 });
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('categories:move', () => {
  it('refuses to move off a category that is still active', async () => {
    await expect(moveCategoryPlaces(session, { ...options, steps: ['places'] })).rejects.toThrow('must be a deprecated category');
  });

  it('counts, moves both sides by one rule, and then finds nothing left', async () => {
    await suite!.db.update(placeCategories).set({ status: 'deprecated' }).where(eq(placeCategories.key, 'shop.newsagent'));
    const steps = ['places', 'sources'] as const;
    const matched = (summaries: Awaited<ReturnType<typeof moveCategoryPlaces>>) =>
      Object.fromEntries(summaries.map((summary) => [summary.step, summary.matched]));

    expect(matched(await moveCategoryPlaces(session, { ...options, steps, dryRun: true }))).toEqual({ places: 4, sources: 4 });
    expect(matched(await moveCategoryPlaces(session, { ...options, steps }))).toEqual({ places: 4, sources: 4 });
    expect(matched(await moveCategoryPlaces(session, { ...options, steps, dryRun: true }))).toEqual({ places: 0, sources: 0 });

    const ids = Object.keys(CASES);
    const rows = await suite!.db.select({ id: places.id, categories: places.categories }).from(places).where(inArray(places.id, ids));
    const sources = await suite!.db
      .select({ id: placesSources.placeId, data: placesSources.sourceData })
      .from(placesSources)
      .where(inArray(placesSources.placeId, ids));
    for (const [id, [, after]] of Object.entries(CASES)) {
      expect({ id, categories: rows.find((row) => row.id === id)?.categories }).toEqual({ id, categories: after });
      const recorded = sources.find((row) => row.id === id)?.data as { normalized: { categories: string[] } } | undefined;
      expect({ id, recorded: recorded?.normalized.categories }).toEqual({ id, recorded: after });
    }
  });
});

/**
 * `0011_goway_place_data_conversion` — the data the previous image wrote,
 * converted, run against a real server.
 *
 * The migration has already been applied to the suite's database (empty, so it
 * converted nothing). Here its statements are run AGAIN, on one reserved
 * connection — its category function lives in that session's `pg_temp` —
 * against rows written the way the previous release wrote them. Re-running is
 * itself part of the claim: every statement must be a no-op on data it has
 * already converted.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';
import { MIGRATIONS_FOLDER } from '../migrationsFolder';
import { SUITE_SETUP_TIMEOUT_MS, createSuiteDatabase, destroySuiteDatabase, type SuiteDatabase } from './testDatabase';

const STATEMENTS = readFileSync(join(MIGRATIONS_FOLDER, '0011_goway_place_data_conversion.sql'), 'utf8')
  .split('--> statement-breakpoint')
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

let suite: SuiteDatabase | null = null;
let session: postgres.ReservedSql;

beforeAll(async () => {
  suite = await createSuiteDatabase();
  session = await suite.client.reserve();
  // The function, and only the function: the updates run per test.
  await session.unsafe(STATEMENTS[0] as string);
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  session?.release();
  await destroySuiteDatabase(suite);
  suite = null;
});

async function convert(legacy: string[]): Promise<string[]> {
  const [row] = await session<{ keys: string[] }[]>`SELECT pg_temp.goway_category_keys(${legacy}::text[]) AS keys`;
  return row?.keys ?? [];
}

describe('the category conversion', () => {
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
  });

  it('is the identity on the taxonomy, so running it twice changes nothing', async () => {
    expect(await convert(['food.cafe', 'culture.attraction'])).toEqual(['food.cafe', 'culture.attraction']);
    await session`INSERT INTO places (id, name, latitude, longitude, categories) VALUES ('conv-1', 'Ja convertit', 41.4, 2.1, ARRAY['food.cafe'])`;
    await session.unsafe(STATEMENTS[1] as string);
    const [row] = await session<{ categories: string[] }[]>`SELECT categories FROM places WHERE id = 'conv-1'`;
    expect(row?.categories).toEqual(['food.cafe']);
  });
});

describe('the source statement and the timezone', () => {
  it('wraps a version-1 statement as version 2, its categories converted the same way', async () => {
    await session`INSERT INTO places (id, name, latitude, longitude) VALUES ('conv-2', 'Bar Pepe', 41.4, 2.1)`;
    await session`
      INSERT INTO places_sources (id, place_id, source, source_id, source_data)
      VALUES ('src-2', 'conv-2', 'openstreetmap', 'node/2', ${JSON.stringify({ name: 'Bar Pepe', categories: ['bar', 'food_drink'] })}::jsonb)
    `;
    await session.unsafe(STATEMENTS[2] as string);
    await session.unsafe(STATEMENTS[2] as string);
    const [row] = await session<{ data: unknown }[]>`SELECT source_data AS data FROM places_sources WHERE id = 'src-2'`;
    expect(row?.data).toEqual({ v: 2, tags: {}, normalized: { name: 'Bar Pepe', categories: ['food.bar'] } });
  });

  it('moves a timezone out of the schedule, and refuses to copy one that is not a zone name', async () => {
    await session`
      INSERT INTO places (id, name, latitude, longitude, opening_hours) VALUES
        ('conv-3', 'Amb zona', 41.4, 2.1, ${JSON.stringify({ intervals: [], timezone: 'Europe/Madrid' })}::jsonb),
        ('conv-4', 'Zona dolenta', 41.4, 2.1, ${JSON.stringify({ intervals: [], timezone: "Madrid'; drop" })}::jsonb)
    `;
    await session.unsafe(STATEMENTS[3] as string);
    const rows = await session<{ id: string; timezone: string | null; hours: unknown }[]>`
      SELECT id, timezone, opening_hours AS hours FROM places WHERE id IN ('conv-3', 'conv-4') ORDER BY id
    `;
    expect([...rows]).toEqual([
      { id: 'conv-3', timezone: 'Europe/Madrid', hours: { intervals: [] } },
      { id: 'conv-4', timezone: null, hours: { intervals: [] } },
    ]);
  });
});

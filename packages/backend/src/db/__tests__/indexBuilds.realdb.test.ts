/**
 * The migrator builds a pending migration's indexes on existing tables
 * CONCURRENTLY before the migration runs, against a real Postgres: a database
 * at 0025 with rows in `places` and `places_names` — the state production was
 * in when 0026's in-transaction build hit the statement timeout on 2026-10-21.
 *
 * What only a real server shows: that the concurrent statement is the one the
 * migration then finds built (its IF NOT EXISTS no-ops), that an INVALID index
 * an interrupted build left is replaced rather than accepted by name, and that
 * a build which fails leaves nothing behind. This suite does not skip.
 */

import '../../__tests__/testEnv';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { readAppliedMillis, readJournal } from '@oxy.so/db/migrate';
import postgres from 'postgres';
import { applyMigrations } from '../applyMigrations';
import { buildPendingIndexesConcurrently } from '../indexBuilds';
import { MIGRATIONS_FOLDER } from '../migrationsFolder';
import { statementFailure } from './statementFailure';
import {
  SUITE_SETUP_TIMEOUT_MS,
  createSuiteDatabase,
  destroySuiteDatabase,
  requireSuite,
  type SuiteDatabase,
} from './testDatabase';

const BEFORE_NAME_SEARCH = '0025_public_quasimodo';
const NAME_SEARCH = '0026_goway_place_name_search';
const INDEXES = ['places_name_fold_trgm_idx', 'places_names_name_fold_trgm_idx'];
const silent = { info: () => undefined, warn: () => undefined, debug: () => undefined };

let suite: SuiteDatabase | null = null;

async function indexStates(client: postgres.Sql): Promise<Record<string, boolean>> {
  const rows = await client<{ relname: string; indisvalid: boolean }[]>`
    select c.relname, i.indisvalid
      from pg_class c join pg_index i on i.indexrelid = c.oid
     where c.relname in ${client(INDEXES)}
  `;
  return Object.fromEntries(rows.map((row) => [row.relname, row.indisvalid]));
}

beforeAll(async () => {
  suite = await createSuiteDatabase({ run: 'all', throughTag: BEFORE_NAME_SEARCH });
  const { client } = suite;
  await client`
    INSERT INTO places (id, name, latitude, longitude)
    SELECT 'p' || g, 'Café ' || g, 41.4, 2.17 FROM generate_series(1, 200) g
  `;
  await client`
    INSERT INTO places_names (id, place_id, language, name, source)
    SELECT 'n' || g, 'p' || g, 'es', 'Cafetería ' || g, 'openstreetmap'
      FROM generate_series(1, 200) g
  `;
}, SUITE_SETUP_TIMEOUT_MS);

afterAll(async () => {
  await destroySuiteDatabase(suite);
  suite = null;
});

describe('building 0026 concurrently before it runs', () => {
  it('drops what a failed build leaves, and keeps nothing of it', async () => {
    const { client, databaseUrl } = requireSuite(suite);
    // An open transaction that has written to `places` holds ROW EXCLUSIVE. A
    // concurrent build commits its catalogue entry and then WAITS for every
    // such writer, so with a 1.5 s budget it is cancelled mid-build — the
    // exact point at which Postgres leaves an INVALID index behind. The writer
    // finishes at 4 s, which lets the DROP … CONCURRENTLY that follows through.
    const writer = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    const session = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    try {
      await writer`begin`;
      await writer`UPDATE places SET name = name WHERE id = 'p1'`;
      const release = setTimeout(() => {
        writer`rollback`.then(
          () => undefined,
          () => undefined,
        );
      }, 4_000);
      const message = await statementFailure(() =>
        buildPendingIndexesConcurrently({
          client: session,
          migrationsFolder: MIGRATIONS_FOLDER,
          run: 'pre',
          dryRun: false,
          budgetMs: 1_500,
          logger: silent,
        }),
      );
      expect(message).toContain('places_name_fold_trgm_idx');
      clearTimeout(release);
      expect(message).toContain('nothing of it was kept');
      expect(await indexStates(client)).toEqual({});
    } finally {
      await writer`rollback`.catch(() => undefined);
      await writer.end({ timeout: 5 });
      await session.end({ timeout: 5 });
    }
  });

  it('replaces an INVALID index of the same name, then the migration finds both built', async () => {
    const { client, databaseUrl } = requireSuite(suite);
    // An INVALID index under 0026's name, as an interrupted concurrent build
    // leaves one: a UNIQUE build over duplicate values fails after creating it.
    await statementFailure(
      () =>
        client`CREATE UNIQUE INDEX CONCURRENTLY "places_names_name_fold_trgm_idx" ON places_names (language)`,
    );
    expect(await indexStates(client)).toEqual({ places_names_name_fold_trgm_idx: false });

    await applyMigrations({
      databaseUrl,
      migrationsFolder: MIGRATIONS_FOLDER,
      run: 'pre',
      dryRun: false,
      logger: silent,
    });

    expect(await indexStates(client)).toEqual({
      places_name_fold_trgm_idx: true,
      places_names_name_fold_trgm_idx: true,
    });
    const [definition] = await client<{ indexdef: string }[]>`
      select indexdef from pg_indexes where indexname = 'places_names_name_fold_trgm_idx'
    `;
    expect(definition?.indexdef).toContain('USING gin (translate(name_normalized');
    expect(definition?.indexdef).toContain('gin_trgm_ops');

    const journal = readJournal(MIGRATIONS_FOLDER);
    const nameSearch = journal.find((entry) => entry.tag === NAME_SEARCH);
    expect(await readAppliedMillis(client)).toContain(nameSearch?.when ?? -1);
  });

  it('finds nothing left to build once the migration is applied', async () => {
    const { client } = requireSuite(suite);
    const session = postgres(requireSuite(suite).databaseUrl, {
      max: 1,
      onnotice: () => undefined,
    });
    try {
      const report = await buildPendingIndexesConcurrently({
        client: session,
        migrationsFolder: MIGRATIONS_FOLDER,
        run: 'all',
        dryRun: false,
        logger: silent,
      });
      expect(report).toEqual({ built: [], alreadyBuilt: [], leftToMigration: [] });
    } finally {
      await session.end({ timeout: 5 });
    }
    expect(Object.keys(await indexStates(client)).sort()).toEqual(INDEXES);
  });
});

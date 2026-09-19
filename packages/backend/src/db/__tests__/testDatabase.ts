/**
 * A throwaway, fully migrated database for ONE test file.
 *
 * ## The suite REFUSES to run without a database. It never skips.
 *
 * Skipping is the failure this file exists to prevent. A skipped suite and a
 * passing suite are the same colour, so a container that failed to start, a
 * renamed variable or a dropped service block would leave the build green while
 * nothing at all was tested against PostGIS — and PostGIS is where every
 * expensive Places bug lives, because a transposed coordinate and a
 * non-indexed radius filter both return plausible rows rather than errors.
 *
 * So `createSuiteDatabase()` throws when it cannot reach a server, with the
 * command that starts one. There is no `describe.skip` in any real-database
 * file in this package, and adding one would silently disarm the only tests
 * that can see a spatial regression.
 *
 * ## It lives under `__tests__/` so it cannot reach the image
 *
 * The emitting build excludes every `__tests__` directory, and the runtime
 * image copies `dist/`. A harness compiled into it would ship `@oxy.so/db/testing` —
 * code whose whole job is to CREATE and DROP databases — into the production
 * bundle, reachable by anything that could get a `require` past the entrypoint.
 * `tsconfig.tools.json` type-checks it in a non-emitting program instead, so it
 * is still held to `strict` without being built.
 *
 * ## Per file, not per run
 *
 * A database shared across files makes every suite's rows visible to every
 * other suite, and the contention that produces — rows one file deleted while
 * another was counting them — reads exactly like a regression in the code under
 * test. That misattribution is the expensive failure, not the few hundred
 * milliseconds a fresh database costs.
 */

import { createDatabase } from '@oxy.so/db';
import { runMigrations } from '@oxy.so/db/migrate';
import { createTestDatabase, dropTestDatabase } from '@oxy.so/db/testing';
import postgres from 'postgres';
import { REQUIRED_EXTENSIONS } from '../extensions';
import { MIGRATIONS_FOLDER } from '../migrationsFolder';
import { setDatabaseForTesting, type Database } from '../postgres';
import * as schema from '../schema';

/**
 * The server throwaway databases are created ON.
 *
 * `TEST_DATABASE_URL` first, so a developer can point the suite at a PostGIS
 * server that is not the one their `.env` names. `DATABASE_URL` otherwise,
 * which is what CI sets — the `postgis/postgis:17-3.5` service container's
 * `POSTGRES_USER` owns the server, so it can create and drop databases, and
 * `createTestDatabase` reaches the maintenance database through the same
 * credentials.
 *
 * The database NAMED in either URL is never touched: only its server is used.
 */
const ADMIN_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;

/**
 * How long a suite's `beforeAll` gets.
 *
 * bun's default hook timeout is 5 s, and setup here is `CREATE DATABASE` plus
 * `CREATE EXTENSION postgis` plus the migrations. That is well under a second
 * on a warm local server and comfortably over five on a cold CI runner, where
 * building the PostGIS extension into a brand-new database is the slow part.
 * A setup that times out reports "a beforeEach/afterEach hook timed out",
 * which names neither the database nor the real cause.
 */
export const SUITE_SETUP_TIMEOUT_MS = 60_000;

/** Seconds the reachability probe waits before declaring the server absent. */
const PROBE_CONNECT_TIMEOUT_SECONDS = 5;

/**
 * Fail FAST and legibly when there is no server, instead of letting the hook
 * time out.
 *
 * Without this the suite reports `a beforeEach/afterEach hook timed out` after
 * five seconds — a message that names neither PostgreSQL nor the variable that
 * was supposed to point at it, on the one failure a developer with no container
 * running is most likely to hit.
 */
async function assertServerReachable(adminUrl: string): Promise<void> {
  const maintenance = new URL(adminUrl);
  maintenance.pathname = '/postgres';
  const probe = postgres(maintenance.toString(), {
    max: 1,
    connect_timeout: PROBE_CONNECT_TIMEOUT_SECONDS,
    onnotice: () => undefined,
  });
  try {
    await probe`select 1`;
  } catch (error) {
    throw new Error(
      `GoWay's real-database suites could not reach ${maintenance.host}. They do ` +
        'not skip: a skipped spatial suite is the same colour as a passing one.\n' +
        'Start one with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
        'then export TEST_DATABASE_URL=postgres://goway:goway@127.0.0.1:5440/goway_dev\n' +
        `(${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  } finally {
    await probe.end({ timeout: PROBE_CONNECT_TIMEOUT_SECONDS });
  }
}

export interface SuiteDatabase {
  readonly db: Database;
  readonly client: postgres.Sql;
  readonly databaseUrl: string;
}

/**
 * Create and migrate a throwaway database, and publish it to `getDb()` so a
 * route exercised over a socket reads the rows this suite writes.
 *
 * The migrations are applied with the SAME folder and the SAME extension
 * registry the production migrator uses (`MIGRATIONS_FOLDER`,
 * `REQUIRED_EXTENSIONS`), so the schema under test is the schema a deploy gets.
 * `src/db/migrate.ts` cannot be called instead: it runs its `main()` at module
 * load and reads `DATABASE_URL` through the one configuration parse, so
 * importing it would migrate the developer's own database as a side effect of
 * loading the harness.
 *
 * `--phase=all` is correct for a database created a moment ago: `pre` and
 * `post` describe the two sides of a rolling deploy, and there is no previous
 * image here to stay compatible with.
 */
export async function createSuiteDatabase(): Promise<SuiteDatabase> {
  if (!ADMIN_URL) {
    throw new Error(
      'No database URL for the real-database suites. These tests do not skip: a ' +
        'skipped spatial suite is the same colour as a passing one.\n' +
        'Start one with:\n' +
        '  docker compose -f docker-compose.postgres.yml up -d --wait postgres\n' +
        'then export TEST_DATABASE_URL=postgres://goway:goway@127.0.0.1:5440/goway_dev',
    );
  }

  await assertServerReachable(ADMIN_URL);

  const databaseUrl = await createTestDatabase({
    adminUrl: ADMIN_URL,
    migrate: async (url) => {
      await runMigrations({
        databaseUrl: url,
        migrationsFolder: MIGRATIONS_FOLDER,
        extensions: REQUIRED_EXTENSIONS,
        run: 'all',
        dryRun: false,
        // Silent: a migration log line per test file drowns the assertions,
        // and a failure throws rather than being reported through this.
        logger: { info: () => undefined, debug: () => undefined },
      });
    },
  });

  const { db, client } = createDatabase({
    databaseUrl,
    schema,
    // Postgres NOTICEs are informative and are not failures — PostGIS emits one
    // whenever it coerces an out-of-range ordinate, which several constraint
    // tests provoke on purpose. Left on the default they print a JSON blob into
    // the middle of the assertions.
    client: { onnotice: () => undefined },
  });
  setDatabaseForTesting({ db, client });
  return { db, client, databaseUrl };
}

/** Close the handle and drop the database. Safe to call after a failed setup. */
export async function destroySuiteDatabase(suite: SuiteDatabase | null): Promise<void> {
  if (!suite) return;
  setDatabaseForTesting(null);
  await suite.client.end({ timeout: 5 });
  await dropTestDatabase(suite.databaseUrl);
}

/**
 * GoWay's one way to apply its migrations: build the pending migrations'
 * indexes on existing tables concurrently (`./indexBuilds`), then hand the run
 * to `@oxy.so/db`'s `runMigrations`. `migrate.ts` (the deploy's one-shot task
 * and `bun run db:migrate`) and the real-database test harness both call this,
 * so the suites migrate exactly as production does.
 */

import { assertMigrationTarget, type MigrationRun, runMigrations } from '@oxy.so/db/migrate';
import postgres from 'postgres';
import { REQUIRED_EXTENSIONS } from './extensions';
import { buildPendingIndexesConcurrently } from './indexBuilds';

/** Seconds to wait for in-flight queries before forcing the socket shut. */
const CLOSE_TIMEOUT_SECONDS = 5;

export interface ApplyMigrationsOptions {
  readonly databaseUrl: string;
  readonly migrationsFolder: string;
  readonly run: MigrationRun;
  readonly expectedDatabase?: string;
  readonly dryRun: boolean;
  /** Override for tests; see `INDEX_BUILD_BUDGET_MS`. */
  readonly indexBuildBudgetMs?: number;
  readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
  };
}

export async function applyMigrations(options: ApplyMigrationsOptions): Promise<void> {
  // `max: 1`: the builds' session settings (statement_timeout, lock_timeout,
  // maintenance_work_mem) must reach the connection that runs them.
  const client = postgres(options.databaseUrl, {
    max: 1,
    onnotice: (notice) => options.logger.debug(`Postgres notice: ${notice.message}`),
  });
  try {
    // First, before anything is read or built: the wrong database is the one
    // mistake every later step would make look like success.
    if (options.expectedDatabase !== undefined) {
      await assertMigrationTarget(client, options.expectedDatabase);
    }
    await buildPendingIndexesConcurrently({
      client,
      migrationsFolder: options.migrationsFolder,
      run: options.run,
      dryRun: options.dryRun,
      budgetMs: options.indexBuildBudgetMs,
      logger: options.logger,
    });
  } finally {
    await client.end({ timeout: CLOSE_TIMEOUT_SECONDS });
  }

  await runMigrations({
    databaseUrl: options.databaseUrl,
    migrationsFolder: options.migrationsFolder,
    extensions: REQUIRED_EXTENSIONS,
    run: options.run,
    expectedDatabase: options.expectedDatabase,
    dryRun: options.dryRun,
    logger: options.logger,
  });
}

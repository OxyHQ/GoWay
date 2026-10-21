/**
 * Build a pending migration's indexes on EXISTING tables `CONCURRENTLY`, before
 * the migration itself runs, so that inside its transaction the migration's own
 * `CREATE INDEX IF NOT EXISTS` finds the index already there and does nothing.
 *
 * ## The outage this exists for
 *
 * `0026_goway_place_name_search` (#249) added two trigram indexes to `places`
 * and `places_names` (~13M rows each in production) as plain `CREATE INDEX`.
 * `@oxy.so/db` applies every migration in a transaction under a 120 s
 * `statement_timeout` (`locks.ts` there; the marker raises it per file), and a
 * GIN build over 13M rows takes many minutes, so every deploy's `pre` task
 * failed with `canceling statement due to statement timeout` on 2026-10-21 and
 * the rollout stopped. Raising the timeout would not have fixed it: a
 * non-concurrent build holds SHARE on the table for its whole duration, so every
 * import, edit and claim on `places` would have queued behind it.
 *
 * `CREATE INDEX CONCURRENTLY` takes SHARE UPDATE EXCLUSIVE instead, which
 * conflicts with neither reads nor writes, but it cannot run inside a
 * transaction — and drizzle runs every migration inside one. So the migration
 * spells the index `CREATE INDEX IF NOT EXISTS` (`~/Oxy/docs/postgres-and-drizzle.md`:
 * "indexes on existing large/hot tables built CONCURRENTLY out of band first,
 * migration = CREATE INDEX IF NOT EXISTS"), and this module is the "out of band
 * first", run by the migrator itself on every run rather than by an operator
 * from a runbook: the SAME statement, from the migration's own file, with
 * `CONCURRENTLY` inserted.
 *
 * ## What is built, and what is left to the migration
 *
 * Only `CREATE [UNIQUE] INDEX IF NOT EXISTS "name" ON "table" …` in a migration
 * this run is about to apply (pending, and in the requested phase — the same
 * plan `runMigrations` computes), and only when `table` already exists: an index
 * on a table a pending migration creates is built on an empty table, inside the
 * migration, instantly. A plain `CREATE INDEX` is never touched — the migration
 * would fail on the index this built — and the lock gate in `check:migrations`
 * refuses one on a large table.
 *
 * ## An INVALID index is never left behind, and never mistaken for a built one
 *
 * A concurrent build that fails (a timeout, a duplicate under a UNIQUE index, a
 * killed task) leaves an INVALID index of that name. `IF NOT EXISTS` checks the
 * NAME only, so the migration would then "succeed" over an index the planner
 * never uses and every write still maintains. So: an INVALID index found before
 * a build is dropped (`DROP INDEX CONCURRENTLY`) and rebuilt, and one a failed
 * build leaves is dropped before the error is rethrown.
 *
 * ## An index on something an earlier pending migration adds
 *
 * Every build happens before ANY of this run's migrations, so an index on a
 * column (or function, or type) that an earlier migration of the same run adds
 * cannot be built yet. Postgres refuses it while parsing, before it creates
 * anything, and it is left to the migration: built inside its transaction,
 * which is instant on a small table and, on a large one, fails the `pre` task
 * at the statement timeout with nothing applied of THAT migration — the earlier
 * ones have committed, so the next run builds it here.
 */

import {
  type MigrationRun,
  planLedgerRun,
  planMigrationRun,
  readAppliedMillis,
  readJournal,
  readMigrationPhases,
} from '@oxy.so/db/migrate';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type postgres from 'postgres';

/**
 * How long ALL of one run's concurrent builds may take together. Each build's
 * `statement_timeout` is what is left of it, so a run cannot outlive the deploy
 * task that waits for it (`.github/scripts/deploy-backend.py`, which allows more).
 * A concurrent trigram GIN build measured 30-75 s per million rows on a
 * developer machine; production holds ~13M places on a smaller, shared instance.
 */
export const INDEX_BUILD_BUDGET_MS = 3 * 60 * 60 * 1000;

/**
 * Working memory for one build. A GIN build accumulates its entries here and
 * flushes them to the index each time it fills, so more means fewer, larger
 * merges. Session-local, one build at a time, on a database other apps share.
 */
export const INDEX_BUILD_MAINTENANCE_WORK_MEM = '256MB';

/** How long dropping what a failed build left may take before the next run does it. */
const INVALID_INDEX_DROP_TIMEOUT_MS = 60_000;

/**
 * SQLSTATEs Postgres raises while PARSING an index definition whose column,
 * function, type or table does not exist yet — before it has created anything.
 */
const NOT_YET_DEFINED = new Set([
  '42703', // undefined_column
  '42883', // undefined_function
  '42704', // undefined_object
  '42P01', // undefined_table
]);

/**
 * A drizzle-kit index statement with `IF NOT EXISTS`. `ON ONLY` (a partitioned
 * parent, which CONCURRENTLY cannot build) does not match: `ONLY` is unquoted.
 */
const IF_NOT_EXISTS_INDEX =
  /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"\s+ON\s+(?:"([^"]+)"\.)?"([^"]+)"/i;
const STATEMENT_HEAD = /^CREATE\s+(UNIQUE\s+)?INDEX\s+IF\s+NOT\s+EXISTS/i;

/** One index a migration builds with `IF NOT EXISTS`, and its concurrent form. */
export interface IndexBuild {
  readonly tag: string;
  readonly index: string;
  readonly schema: string | null;
  readonly table: string;
  /** The migration's statement with `CONCURRENTLY` inserted, and nothing else changed. */
  readonly concurrentStatement: string;
}

/**
 * The `IF NOT EXISTS` index statements in one migration's SQL, in file order.
 * Statements are split exactly as drizzle splits them; comment lines (the phase
 * marker among them) are not part of a statement's head.
 */
export function readIndexBuilds(tag: string, contents: string): IndexBuild[] {
  const builds: IndexBuild[] = [];
  for (const chunk of contents.split('--> statement-breakpoint')) {
    const statement = chunk
      .split('\n')
      .filter((line) => !line.trim().startsWith('--'))
      .join('\n')
      .trim()
      .replace(/;\s*$/, '');
    const match = IF_NOT_EXISTS_INDEX.exec(statement);
    if (!match) continue;
    const [, unique, index, schema, table] = match;
    builds.push({
      tag,
      index,
      schema: schema ?? null,
      table,
      concurrentStatement: statement.replace(
        STATEMENT_HEAD,
        `CREATE ${unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS`,
      ),
    });
  }
  return builds;
}

export interface BuildPendingIndexesOptions {
  /** One connection, `max: 1`: the session settings below must reach every statement. */
  readonly client: postgres.Sql;
  readonly migrationsFolder: string;
  readonly run: MigrationRun;
  readonly dryRun: boolean;
  /** Override for tests; production uses {@link INDEX_BUILD_BUDGET_MS}. */
  readonly budgetMs?: number;
  readonly logger: { info(message: string): void; warn(message: string): void };
}

/** What a run built, found already built, and left to its migration. */
export interface IndexBuildReport {
  readonly built: string[];
  readonly alreadyBuilt: string[];
  readonly leftToMigration: string[];
}

function quoted(identifier: string): string {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function sqlStateOf(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

/**
 * The index named `index` beside `build.table`, with its validity, or null.
 * Looked up in the table's own schema, which is where Postgres puts it.
 */
async function existingIndex(
  client: postgres.Sql,
  build: IndexBuild,
): Promise<{ valid: boolean; schema: string } | null | 'no-table'> {
  const table = build.schema
    ? `${quoted(build.schema)}.${quoted(build.table)}`
    : quoted(build.table);
  const [found] = await client<{ table_oid: string | null }[]>`
    select to_regclass(${table})::oid::text as table_oid
  `;
  if (!found?.table_oid) return 'no-table';
  const [row] = await client<{ indisvalid: boolean; nspname: string }[]>`
    select i.indisvalid, n.nspname
      from pg_class t
      join pg_namespace n on n.oid = t.relnamespace
      join pg_class c on c.relnamespace = t.relnamespace and c.relname = ${build.index}
      join pg_index i on i.indexrelid = c.oid
     where t.oid = ${found.table_oid}::oid
  `;
  return row ? { valid: row.indisvalid, schema: row.nspname } : null;
}

async function dropInvalid(client: postgres.Sql, schema: string, index: string): Promise<void> {
  await client.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS ${quoted(schema)}.${quoted(index)}`);
}

/**
 * Build every `IF NOT EXISTS` index the pending migrations of `run` declare on
 * an existing table, concurrently, one at a time. Throws on any failure other
 * than a not-yet-defined dependency, after dropping what the failure left.
 */
export async function buildPendingIndexesConcurrently(
  options: BuildPendingIndexesOptions,
): Promise<IndexBuildReport> {
  const { client, migrationsFolder, logger } = options;
  const report: IndexBuildReport = { built: [], alreadyBuilt: [], leftToMigration: [] };

  const entries = readJournal(migrationsFolder);
  const { phases, problems } = readMigrationPhases(
    entries.map((entry) => entry.tag),
    migrationsFolder,
  );
  // `runMigrations` reports these, with the same reader, before any DDL.
  if (problems.length > 0) return report;
  const plan = planMigrationRun(
    planLedgerRun(entries, await readAppliedMillis(client)),
    phases,
    options.run,
  );
  if (plan.blocked) return report;

  const builds = plan.apply.flatMap((entry) =>
    readIndexBuilds(entry.tag, readFileSync(join(migrationsFolder, `${entry.tag}.sql`), 'utf8')),
  );
  if (builds.length === 0) return report;

  const deadline = Date.now() + (options.budgetMs ?? INDEX_BUILD_BUDGET_MS);
  // A concurrent build's lock (SHARE UPDATE EXCLUSIVE) conflicts with no read
  // or write, and a request WAITING for it holds none of them up either, so
  // the wait needs no lock_timeout: the statement timeout bounds it.
  await client.unsafe(`set lock_timeout = 0`);
  await client.unsafe(`set maintenance_work_mem = '${INDEX_BUILD_MAINTENANCE_WORK_MEM}'`);

  for (const build of builds) {
    const label = `${build.tag}: ${build.index} on ${build.table}`;
    const existing = await existingIndex(client, build);
    if (existing === 'no-table') continue; // A pending migration creates it; built there.
    if (existing?.valid) {
      report.alreadyBuilt.push(build.index);
      logger.info(`${label} is already built`);
      continue;
    }
    if (options.dryRun) {
      logger.info(
        `DRY RUN — would build ${label} concurrently${existing ? ' (replacing an INVALID one)' : ''}`,
      );
      continue;
    }
    if (existing) {
      logger.warn(`${label} exists but is INVALID (an interrupted build); dropping it to rebuild`);
      await dropInvalid(client, existing.schema, build.index);
    }

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(
        `${label} was not built: this run's concurrent index builds used their whole ` +
          `${options.budgetMs ?? INDEX_BUILD_BUDGET_MS}ms budget. The ones before it are built and ` +
          'valid, so running the migrator again continues from here.',
      );
    }

    const startedAt = Date.now();
    logger.info(`Building ${label} concurrently (budget ${remainingMs}ms)`);
    try {
      await client.unsafe(`set statement_timeout = ${remainingMs}`);
      await client.unsafe(build.concurrentStatement);
    } catch (error) {
      if (NOT_YET_DEFINED.has(sqlStateOf(error) ?? '')) {
        report.leftToMigration.push(build.index);
        logger.warn(
          `${label} depends on something an earlier migration of this run adds ` +
            `(${error instanceof Error ? error.message : String(error)}); its migration builds it`,
        );
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const failedAfter = `${label}: the concurrent build failed after ${Date.now() - startedAt}ms`;
      const left = await existingIndex(client, build).catch(() => null);
      if (left && left !== 'no-table' && !left.valid) {
        try {
          // DROP … CONCURRENTLY waits for the same transactions the build did.
          await client.unsafe(`set statement_timeout = ${INVALID_INDEX_DROP_TIMEOUT_MS}`);
          await dropInvalid(client, left.schema, build.index);
        } catch {
          throw new Error(
            `${failedAfter} (${reason}). It left an INVALID index that could not be dropped ` +
              'yet; the next run drops and rebuilds it.',
            { cause: error },
          );
        }
      }
      throw new Error(`${failedAfter} and nothing of it was kept (${reason})`, { cause: error });
    } finally {
      await client.unsafe(`set statement_timeout = 0`).catch(() => undefined);
    }

    const after = await existingIndex(client, build);
    if (after === 'no-table' || !after?.valid) {
      throw new Error(`${label}: the concurrent build returned but the index is not valid.`);
    }
    report.built.push(build.index);
    logger.info(`Built ${label} in ${Date.now() - startedAt}ms`);
  }
  return report;
}

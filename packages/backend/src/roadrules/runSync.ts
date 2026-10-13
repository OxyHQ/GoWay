/**
 * `bun run roadrules:sync -- --target-database=<name> [--only=<id>] [--dry-run]`
 *
 * Reads each road-rule source and writes what changed (`./sync`). Meant to run
 * on a schedule — rules change a few times a year, so weekly is plenty — as an
 * operator one-shot, the way `import:osm` runs: `oxy-postgres` is not publicly
 * reachable, so the task runs inside the VPC.
 *
 *   --target-database=<name>  Required unless --dry-run; asserted first, by the
 *                             migrator's own guard.
 *   --only=<id>               Run one sync (`natural-earth-countries`,
 *                             `osm-country-rules`, `osm-low-emission-zones`).
 *   --dry-run                 Read and report; write nothing. Needs no database.
 *
 * Exits non-zero if any sync failed or any unit it reads failed, after
 * running all of them: a failed country must not hide the others' updates, and
 * must not pass as a success.
 */

import { parseArgs } from 'node:util';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { logger } from '../utils/logger';
import { ROAD_RULE_SYNCS } from './index';
import { createOverpass } from './overpass';
import { applySync } from './sync';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { values } = parseArgs({
    args: argv,
    options: {
      'target-database': { type: 'string' },
      only: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
    },
    strict: false,
  });
  const dryRun = values['dry-run'] === true;
  const expectedDatabase = dryRun ? null : readTargetDatabase(argv);
  const syncs = ROAD_RULE_SYNCS.filter((sync) => !values.only || sync.id === values.only);
  if (syncs.length === 0)
    throw new Error(`--only names no sync. Use ${ROAD_RULE_SYNCS.map((s) => s.id).join(', ')}.`);

  const { connectPostgres, closePostgres, getDb } = await import('../db/postgres');
  let failed = false;
  if (expectedDatabase !== null) {
    const { assertMigrationTarget } = await import('@oxy.so/db/migrate');
    const handle = await connectPostgres();
    await assertMigrationTarget(handle.$client, expectedDatabase);
  }
  try {
    const context = { overpass: createOverpass(), fetch, now: () => new Date() };
    for (const sync of syncs) {
      try {
        const report = await applySync(dryRun ? (null as never) : getDb(), sync, context, {
          dryRun,
        });
        if (report.failures.length > 0) failed = true;
        logger.info({ report, dryRun }, `Sync ${sync.id} finished`);
      } catch (error) {
        failed = true;
        logger.error({ err: error }, `Sync ${sync.id} failed`);
      }
    }
  } finally {
    if (expectedDatabase !== null) await closePostgres();
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Road-rule sync failed');
  process.exitCode = 1;
});

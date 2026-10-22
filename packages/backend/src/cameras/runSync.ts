/**
 * `bun run cameras:sync -- --target-database=<name> [--only=<id>] [--dry-run]`
 *
 * Reads each camera provider's catalogue and writes what changed
 * (`./sync`), then prunes observations past their retention. Meant to run on a
 * schedule as an operator one-shot, the way `roadrules:sync` and `import:osm`
 * do: `oxy-postgres` is not publicly reachable, so the task runs inside the VPC.
 *
 *   --target-database=<name>  Required unless --dry-run; asserted first, by the
 *                             migrator's own guard.
 *   --only=<id>               Run one provider.
 *   --dry-run                 Read and report; write nothing. Needs no database.
 *
 * Exits non-zero if any provider failed or any unit it reads failed, after
 * running all of them: one provider's outage must not hide the others'
 * updates, and must not pass as a success.
 */

import { parseArgs } from 'node:util';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { pruneObservations } from '../db/cameras/camerasRepository';
import { logger } from '../utils/logger';
import { OBSERVATION_RETENTION_DAYS } from './config';
import { CAMERA_PROVIDERS } from './providers';
import { applyCameraSync } from './sync';

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
  const providers = CAMERA_PROVIDERS.filter((p) => !values.only || p.id === values.only);
  if (providers.length === 0)
    throw new Error(
      `--only names no provider. Use ${CAMERA_PROVIDERS.map((p) => p.id).join(', ')}.`,
    );

  const { connectPostgres, closePostgres, getDb } = await import('../db/postgres');
  let failed = false;
  if (expectedDatabase !== null) {
    const { assertMigrationTarget } = await import('@oxy.so/db/migrate');
    const handle = await connectPostgres();
    await assertMigrationTarget(handle.$client, expectedDatabase);
  }
  try {
    const db = dryRun ? null : getDb();
    const context = {
      fetch,
      now: () => new Date(),
      settings: (provider: (typeof providers)[number]) => ({
        url: provider.defaultUrl,
        userAgent: 'GoWay-cameras/1.0 (+https://goway.to)',
      }),
    };
    for (const provider of providers) {
      try {
        const report = await applyCameraSync(db, provider, context);
        if (report.failures.length > 0) failed = true;
        logger.info({ report, dryRun }, `Camera sync ${provider.id} finished`);
      } catch (error) {
        failed = true;
        logger.error({ err: error }, `Camera sync ${provider.id} failed`);
      }
    }
    if (db !== null && !values.only) {
      const before = new Date(Date.now() - OBSERVATION_RETENTION_DAYS * 86_400_000);
      logger.info({ pruned: await pruneObservations(db, before) }, 'Camera observations pruned');
    }
  } finally {
    if (expectedDatabase !== null) await closePostgres();
  }
  if (failed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Camera sync failed');
  process.exitCode = 1;
});

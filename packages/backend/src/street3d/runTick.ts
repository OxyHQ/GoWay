/**
 * `bun run street3d:tick --target-database=<name>` — one scheduler tick.
 *
 * For operators and for a deployment that prefers a scheduled task to the
 * in-process loop. Asserts the database and the migration ledger first, exactly
 * as the cleanup command does, so a tick pointed at the wrong database reads
 * nothing. Prints the aggregate summary as JSON; exits 1 when a phase failed.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { assertMigrationTarget } from '@oxy.so/db/migrate';
import { street3dConfig } from '../config/street3d';
import { assertMigrationsCurrent, closePostgres, connectPostgres, getDb } from '../db/postgres';
import { createConfiguredStreet3dServices } from './services';
import { tick } from './scheduler';

async function main() {
  const { values } = parseArgs({ options: { 'target-database': { type: 'string' } } });
  const target = values['target-database'];
  if (!target?.trim()) throw new Error('--target-database is required.');
  await connectPostgres();
  try {
    await assertMigrationTarget(getDb().$client, target);
    await assertMigrationsCurrent();
    const services = createConfiguredStreet3dServices();
    if (!services) {
      console.log(JSON.stringify({ skipped: 'street3d_pipeline_not_configured' }));
      process.exitCode = 1;
      return;
    }
    const summary = await tick({ db: getDb(), services, config: street3dConfig });
    console.log(JSON.stringify(summary));
    if (summary.failedPhases.length > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

main().catch(() => {
  // Configuration, SQL and network errors may carry credentials or keys.
  console.error('Street 3D tick failed. Check its arguments, database and AWS configuration.');
  process.exitCode = 1;
});

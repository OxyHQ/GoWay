import 'dotenv/config';
import { parseArgs } from 'node:util';
import { assertMigrationTarget } from '@oxy.so/db/migrate';
import { assertMigrationsCurrent, closePostgres, connectPostgres, getDb } from '../db/postgres';
import { createConfiguredObjectStore } from '../storage';
import { sweepExpiredCaptures } from './cleanup';

async function main() {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      limit: { type: 'string', default: '100' },
      'retry-after-seconds': { type: 'string', default: '300' },
    },
  });
  const target = values['target-database'];
  if (!target?.trim()) throw new Error('--target-database is required, including for dry runs.');
  await connectPostgres();
  try {
    await assertMigrationTarget(getDb().$client, target);
    await assertMigrationsCurrent();
    const summary = await sweepExpiredCaptures(getDb(), createConfiguredObjectStore(), {
      dryRun: values['dry-run'],
      limit: Number(values.limit),
      retryAfterSeconds: Number(values['retry-after-seconds']),
    });
    console.log(JSON.stringify(summary));
    if (summary.failed > 0) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

main().catch(() => {
  // Configuration, SQL and network errors may carry credentials. The scheduler
  // gets a failed run without exposing connection strings or signed URLs.
  console.error('Capture cleanup failed. Check its arguments, database and object-store configuration.');
  process.exitCode = 1;
});

/**
 * `bun run oxy-references:admin <command> --target-database=<name> [options]`
 *
 *     status                    the outbox (pending, dead, oldest) and recent reconciliations
 *     dead                      the dead-lettered changes, oldest first
 *     retry-dead <changeId>     requeue one dead change with fresh attempts
 *     retry-dead --all          requeue every dead change
 *     drain                     deliver what is due now, as the loop would
 *     reconcile [--apply]       reconcile `place` references now: a dry run, or a real one
 *
 * The operator surface of `oxy/fileReferences`. Asserts the database and
 * migration ledger first, like every GoWay operator command. Prints JSON:
 * ids, counts and failure classes — never a file's metadata. Exits 1 on a
 * refusal or a failed reconciliation.
 */

import { parseArgs } from 'node:util';
import { assertMigrationTarget } from '@oxy.so/db/migrate';
import { config } from '../config';
import { assertMigrationsCurrent, closePostgres, connectPostgres, getDb } from '../db/postgres';
import {
  fileReferenceOutboxStatus,
  listDeadFileReferenceChanges,
  retryDeadFileReferenceChanges,
} from '../db/oxyFiles/referenceChanges';
import { recentReconciliations } from '../db/oxyFiles/reconciliations';
import { createLogger } from '../utils/logger';
import { createFileReferenceWorker, createOxyFileReferences } from './fileReferences';

const USAGE =
  'Usage: oxy-references:admin <status|dead|retry-dead|drain|reconcile> [changeId] ' +
  '--target-database=<name> [--all] [--apply]';

async function run(
  command: string,
  id: string | undefined,
  values: { all?: boolean; apply?: boolean },
): Promise<Record<string, unknown>> {
  const db = getDb();
  const now = new Date();
  const worker = () =>
    createFileReferenceWorker({
      getDb,
      references: createOxyFileReferences({ baseURL: config.oxyApiUrl }),
      logger: createLogger('oxy-references'),
    });
  switch (command) {
    case 'status':
      return {
        outbox: await fileReferenceOutboxStatus(db, now),
        reconciliations: await recentReconciliations(db, 5),
      };
    case 'dead':
      return { dead: await listDeadFileReferenceChanges(db, 100) };
    case 'retry-dead': {
      if (!id && !values.all) throw new Error('retry-dead needs a change id, or --all.');
      const requeued = await retryDeadFileReferenceChanges(db, now, id ? [id] : undefined);
      return { requeued };
    }
    case 'drain':
      return { ...(await worker().drain()) };
    case 'reconcile': {
      const outcome = await worker().reconcile({ dryRun: values.apply !== true, onlyIfDue: false });
      return { ...outcome };
    }
    default:
      throw new Error(USAGE);
  }
}

function refused(
  command: string,
  id: string | undefined,
  result: Record<string, unknown>,
): boolean {
  if (command === 'retry-dead' && id !== undefined) return result.requeued === 0;
  if (command === 'reconcile') return result.status !== 'committed';
  return false;
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      'target-database': { type: 'string' },
      all: { type: 'boolean', default: false },
      apply: { type: 'boolean', default: false },
    },
  });
  const [command, id] = positionals;
  if (!command) throw new Error(USAGE);
  const target = values['target-database'];
  if (!target?.trim()) throw new Error('--target-database is required.');
  await connectPostgres();
  try {
    await assertMigrationTarget(getDb().$client, target);
    await assertMigrationsCurrent();
    const result = await run(command, id, values);
    console.log(JSON.stringify(result));
    if (refused(command, id, result)) process.exitCode = 1;
  } finally {
    await closePostgres();
  }
}

main().catch((error: unknown) => {
  // Usage errors are ours and safe to print; anything else may carry secrets.
  const message =
    error instanceof Error && /needs|Usage|required/.test(error.message)
      ? error.message
      : 'Oxy references admin command failed. Check its arguments, database and Oxy configuration.';
  console.error(message);
  process.exitCode = 1;
});

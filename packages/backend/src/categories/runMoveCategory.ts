/**
 * `bun run categories:move -- --target-database=<name> --from-category=<old> --to-category=<new> [options]`
 *
 * Moves every place off a DEPRECATED category key onto an active one, in
 * batches — the last step of renaming a category (`docs/PLACE_DATA.md`). See
 * `moveCategory.ts` for what it rewrites and why.
 *
 *   --target-database=<name>  Required, dry runs included. Asserted first.
 *   --from-category=<key>     The deprecated key. Required.
 *   --to-category=<key>       The active key. Required.
 *   --step=<a,b>              places, sources. Default both, in that order.
 *   --batch-size=<n>          Rows per batch and per transaction. Default 5000.
 *   --from=<id>               Resume ONE step after this id (from a log line).
 *   --pause-ms=<n>            Sleep between batches. Default 0.
 *   --dry-run                 Count what would change; write nothing.
 *
 * Do not dispatch the OpenStreetMap import while it runs: between the two
 * steps a moved place's column and its recorded statement disagree.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { assertMigrationTarget } from '@oxy.so/db/migrate';
import postgres from 'postgres';
import { config } from '../config';
import { prepareBatchSession, type ConversionProgress } from '../places/legacyConversion';
import { logger } from '../utils/logger';
import { MOVE_STEPS, moveCategoryPlaces, type MoveStepName } from './moveCategory';

/** One progress line at most this often, per step. */
const PROGRESS_INTERVAL_MS = 10_000;

function parseSteps(value: string | undefined): MoveStepName[] {
  if (value === undefined) return [...MOVE_STEPS];
  const steps = value
    .split(',')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  for (const step of steps) {
    if (!(MOVE_STEPS as readonly string[]).includes(step)) {
      throw new Error(`Unknown --step ${JSON.stringify(step)}. Use ${MOVE_STEPS.join(', ')}.`);
    }
  }
  if (steps.length === 0) throw new Error('--step names no step.');
  return steps as MoveStepName[];
}

function integer(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum)
    throw new Error(`${flag} must be an integer >= ${minimum}.`);
  return parsed;
}

function required(value: string | undefined, flag: string): string {
  if (!value?.trim()) throw new Error(`${flag} is required.`);
  return value.trim();
}

function progressReporter(): (progress: ConversionProgress) => void {
  let last = 0;
  return (progress) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    logger.info(
      { ...progress, resume: `--step=${progress.step} --from=${progress.lastId}` },
      'Moving places',
    );
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      'from-category': { type: 'string' },
      'to-category': { type: 'string' },
      step: { type: 'string' },
      'batch-size': { type: 'string', default: '5000' },
      from: { type: 'string' },
      'pause-ms': { type: 'string', default: '0' },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const target = required(values['target-database'], '--target-database');
  const options = {
    fromCategory: required(values['from-category'], '--from-category'),
    toCategory: required(values['to-category'], '--to-category'),
    steps: parseSteps(values.step),
    batchSize: integer(values['batch-size'], '--batch-size', 1),
    from: values.from ?? null,
    pauseMs: integer(values['pause-ms'], '--pause-ms', 0),
    dryRun: values['dry-run'],
  };

  const session = postgres(config.databaseUrl, {
    max: 1,
    connect_timeout: config.databaseConnectTimeoutSeconds,
    onnotice: () => undefined,
  });
  try {
    await assertMigrationTarget(session, target);
    await prepareBatchSession(session, 'goway-categories-move', options);
    logger.info(options, 'Starting the category move');
    const summaries = await moveCategoryPlaces(session, {
      ...options,
      onProgress: progressReporter(),
    });
    for (const summary of summaries) logger.info(summary, options.dryRun ? 'Would move' : 'Moved');
    console.log(JSON.stringify({ dryRun: options.dryRun, summaries }));
  } finally {
    await session.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'Category move failed');
  process.exitCode = 1;
});

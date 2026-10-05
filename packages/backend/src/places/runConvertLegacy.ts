/**
 * `bun run places:convert-legacy -- --target-database=<name> [options]`
 *
 * Converts the place data the previous release wrote, in batches, BEFORE the
 * release that needs it is deployed — so the post-deploy migration
 * (`0011_goway_place_data_conversion`) finds only the stragglers. The runbook
 * is `docs/PLACE_DATA_CONVERSION.md`.
 *
 *   --target-database=<name>  Required, dry runs included. Asserted before
 *                             anything else, by the migrator's own guard.
 *   --step=<a,b>              categories, sources, timezone. Default
 *                             `categories,sources`: the two that are safe while
 *                             the previous image serves. `timezone` needs the
 *                             pre-deploy column and is left to the migration.
 *   --batch-size=<n>          Rows per batch and per transaction. Default 5000.
 *   --from=<id>               Resume ONE step after this id (from a log line).
 *   --pause-ms=<n>            Sleep between batches. Default 0.
 *   --dry-run                 Count what would change, and the places 0013's
 *                             CHECK would refuse; write nothing. After a full
 *                             run every count is 0.
 *   --validate-constraint     After the deploy: VALIDATE the CHECK 0013 added
 *                             NOT VALID (SHARE UPDATE EXCLUSIVE; no outage).
 *
 * It deliberately does NOT assert that the migration ledger is current: it is
 * built to run against a database the release has not migrated yet.
 *
 * One connection, `max: 1`: the migration's mapping table and functions live
 * in that session's `pg_temp`.
 */

import 'dotenv/config';
import { parseArgs } from 'node:util';
import { assertMigrationTarget } from '@oxy.so/db/migrate';
import postgres from 'postgres';
import { config } from '../config';
import { logger } from '../utils/logger';
import {
  CONVERSION_STEPS,
  DEFAULT_CONVERSION_STEPS,
  convertLegacyPlaceData,
  loadLegacyConversion,
  prepareConversionSession,
  validateTaxonomyConstraint,
  type ConversionProgress,
  type ConversionStepName,
} from './legacyConversion';

/** One progress line at most this often, per step. */
const PROGRESS_INTERVAL_MS = 10_000;

function parseSteps(value: string | undefined): ConversionStepName[] {
  if (value === undefined) return [...DEFAULT_CONVERSION_STEPS];
  const steps = value
    .split(',')
    .map((step) => step.trim())
    .filter((step) => step.length > 0);
  for (const step of steps) {
    if (!(CONVERSION_STEPS as readonly string[]).includes(step)) {
      throw new Error(`Unknown --step ${JSON.stringify(step)}. Use ${CONVERSION_STEPS.join(', ')}.`);
    }
  }
  if (steps.length === 0) throw new Error('--step names no step.');
  return steps as ConversionStepName[];
}

function positiveInteger(value: string, flag: string, minimum: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) throw new Error(`${flag} must be an integer >= ${minimum}.`);
  return parsed;
}

function progressReporter(): (progress: ConversionProgress) => void {
  let last = 0;
  return (progress) => {
    const now = Date.now();
    if (now - last < PROGRESS_INTERVAL_MS) return;
    last = now;
    const rate = progress.elapsedSeconds > 0 ? progress.examined / progress.elapsedSeconds : 0;
    const remaining = Math.max(0, progress.estimatedRows - progress.examined);
    logger.info(
      {
        ...progress,
        rowsPerSecond: Math.round(rate),
        percent: progress.estimatedRows > 0 ? Math.min(100, Math.round((progress.examined / progress.estimatedRows) * 1000) / 10) : null,
        etaSeconds: rate > 0 ? Math.round(remaining / rate) : null,
        resume: `--step=${progress.step} --from=${progress.lastId}`,
      },
      'Converting legacy place data',
    );
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      'target-database': { type: 'string' },
      step: { type: 'string' },
      'batch-size': { type: 'string', default: '5000' },
      from: { type: 'string' },
      'pause-ms': { type: 'string', default: '0' },
      'dry-run': { type: 'boolean', default: false },
      'validate-constraint': { type: 'boolean', default: false },
    },
  });
  const target = values['target-database'];
  if (!target?.trim()) throw new Error('--target-database is required, including for dry runs.');
  const steps = parseSteps(values.step);
  const batchSize = positiveInteger(values['batch-size'], '--batch-size', 1);
  const pauseMs = positiveInteger(values['pause-ms'], '--pause-ms', 0);
  const dryRun = values['dry-run'];
  const plan = loadLegacyConversion();

  const session = postgres(config.databaseUrl, {
    max: 1,
    connect_timeout: config.databaseConnectTimeoutSeconds,
    onnotice: () => undefined,
  });
  try {
    await assertMigrationTarget(session, target);

    if (values['validate-constraint']) {
      const result = await validateTaxonomyConstraint(session);
      logger.info(result, result.alreadyValid ? 'The taxonomy CHECK was already valid' : 'Validated the taxonomy CHECK');
      return;
    }

    await prepareConversionSession(session, plan, { dryRun });
    logger.info({ steps, batchSize, pauseMs, dryRun, from: values.from ?? null }, 'Starting the legacy place-data conversion');
    const summaries = await convertLegacyPlaceData(session, plan, {
      steps,
      batchSize,
      from: values.from ?? null,
      pauseMs,
      dryRun,
      onProgress: progressReporter(),
    });
    for (const summary of summaries) {
      logger.info(summary, dryRun ? 'Would convert' : 'Converted');
    }
    console.log(JSON.stringify({ dryRun, summaries }));
  } finally {
    await session.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  // pino's redaction keeps a connection string out of the line; the message
  // names the step and the id to resume from when a batch failed.
  logger.error({ err: error }, 'Legacy place-data conversion failed');
  process.exitCode = 1;
});

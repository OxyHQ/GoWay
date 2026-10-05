/**
 * The legacy place-data conversion, in batches.
 *
 * `drizzle/0011_goway_place_data_conversion.sql` converts what the previous
 * image wrote: category lists become taxonomy keys, a source's statement
 * becomes `{v: 2, tags, normalized}`, and the timezone leaves the schedule. As
 * a migration it is three full-table UPDATEs inside the ONE transaction the
 * migrator gives a whole phase. Production holds ~13M places and ~13M source
 * rows on a burstable instance; that transaction would hold row locks on every
 * place for hours, while the new image serves, and outlast the deploy's
 * one-shot migration task.
 *
 * So the same statements are run here first, by an operator, in id-ordered
 * batches of a few thousand rows, each its own transaction — and the migration
 * then finds only the stragglers written since.
 *
 * ## One source, not two copies
 *
 * This module does not restate the conversion. It READS the migration file:
 * every statement that is not an UPDATE (the mapping table, its functions) runs
 * once on this session, and each UPDATE runs as written with its WHERE clause
 * wrapped in parentheses and narrowed to a range of `"id"`. A change to the
 * migration is a change to this command. The realdb suite proves the two agree
 * row for row, and that the migration rewrites nothing after a full run.
 *
 * ## Safe to stop, safe to repeat
 *
 * Every UPDATE matches only a row it would change, so a batch that already ran
 * is a no-op and a run can be killed at any point and started again — from the
 * beginning (each batch then costs a read and no write) or from the last id it
 * logged (`--from`).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { sqlStateOf } from '@oxy.so/db';
import type postgres from 'postgres';
import { MIGRATIONS_FOLDER } from '../db/migrationsFolder';

/** The migration this command runs in batches. */
export const CONVERSION_MIGRATION_TAG = '0011_goway_place_data_conversion';
/** The migration that adds the CHECK the conversion makes true. */
export const TAXONOMY_MIGRATION_TAG = '0013_goway_category_taxonomy';
/** The CHECK `0013` adds `NOT VALID`, and `--validate-constraint` validates. */
export const TAXONOMY_CONSTRAINT = 'places_categories_taxonomy_check';

/** The three conversions, in the order the migration runs them. */
export const CONVERSION_STEPS = ['categories', 'sources', 'timezone'] as const;
export type ConversionStepName = (typeof CONVERSION_STEPS)[number];

/** What runs by default: the two conversions that are safe while the previous image serves. */
export const DEFAULT_CONVERSION_STEPS: readonly ConversionStepName[] = ['categories', 'sources'];

export interface ConversionStep {
  readonly name: ConversionStepName;
  readonly table: 'places' | 'places_sources';
  /** The statement up to, not including, its WHERE. */
  readonly head: string;
  /** The WHERE clause's condition, exactly as the migration spells it. */
  readonly predicate: string;
}

export interface LegacyConversionPlan {
  /** Session setup: the mapping table and the functions, in file order. */
  readonly setup: readonly string[];
  readonly steps: Readonly<Record<ConversionStepName, ConversionStep>>;
  /** The CHECK expression `0013` adds, for counting the rows it would refuse. */
  readonly taxonomyCheck: string;
}

/** Strip whole-line SQL comments and surrounding blank space from one statement. */
function withoutComments(statement: string): string {
  return statement
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
    .trim();
}

function statementsOf(sqlText: string): string[] {
  return sqlText
    .split('--> statement-breakpoint')
    .map(withoutComments)
    .filter((statement) => statement.length > 0);
}

function classify(table: string, head: string): ConversionStepName {
  if (table === 'places_sources' && /SET\s+"source_data"/.test(head)) return 'sources';
  if (table === 'places' && /SET\s+"categories"/.test(head)) return 'categories';
  if (table === 'places' && /"timezone"\s*=/.test(head)) return 'timezone';
  throw new Error(`An UPDATE of "${table}" in ${CONVERSION_MIGRATION_TAG} is not one of the known conversions.`);
}

/**
 * Split the conversion migration into session setup and the three UPDATEs.
 *
 * Fails loudly on any shape it does not recognise — a fourth UPDATE, one
 * without a line-initial WHERE, a missing step — rather than converting part of
 * the data and reporting success.
 */
export function parseConversionMigration(sqlText: string): Omit<LegacyConversionPlan, 'taxonomyCheck'> {
  const setup: string[] = [];
  const steps: Partial<Record<ConversionStepName, ConversionStep>> = {};

  for (const statement of statementsOf(sqlText)) {
    const update = /^UPDATE\s+"([a-z_]+)"\s/.exec(statement);
    if (!update) {
      setup.push(statement);
      continue;
    }
    const table = update[1] as string;
    if (table !== 'places' && table !== 'places_sources') {
      throw new Error(`${CONVERSION_MIGRATION_TAG} updates "${table}", which this command does not batch.`);
    }
    const where = statement.lastIndexOf('\nWHERE ');
    if (where < 0) throw new Error(`An UPDATE of "${table}" in ${CONVERSION_MIGRATION_TAG} has no line-initial WHERE.`);
    const head = statement.slice(0, where);
    const predicate = statement
      .slice(where + '\nWHERE '.length)
      .replace(/;\s*$/, '')
      .trim();
    const name = classify(table, head);
    if (steps[name]) throw new Error(`${CONVERSION_MIGRATION_TAG} has two "${name}" conversions.`);
    steps[name] = { name, table, head, predicate };
  }

  for (const name of CONVERSION_STEPS) {
    if (!steps[name]) throw new Error(`${CONVERSION_MIGRATION_TAG} has no "${name}" conversion.`);
  }
  return { setup, steps: steps as Record<ConversionStepName, ConversionStep> };
}

/** The CHECK expression of `0013`, balanced-parenthesis exact. */
export function parseTaxonomyCheck(sqlText: string): string {
  const marker = `ADD CONSTRAINT "${TAXONOMY_CONSTRAINT}" CHECK (`;
  const start = sqlText.indexOf(marker);
  if (start < 0) throw new Error(`${TAXONOMY_MIGRATION_TAG} does not add "${TAXONOMY_CONSTRAINT}".`);
  let depth = 1;
  let quoted = false;
  const from = start + marker.length;
  for (let index = from; index < sqlText.length; index += 1) {
    const char = sqlText[index];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (depth === 0) return sqlText.slice(from, index);
  }
  throw new Error(`The CHECK in ${TAXONOMY_MIGRATION_TAG} is not balanced.`);
}

/** Read both migrations from the folder the migrator itself uses. */
export function loadLegacyConversion(folder: string = MIGRATIONS_FOLDER): LegacyConversionPlan {
  const conversion = readFileSync(join(folder, `${CONVERSION_MIGRATION_TAG}.sql`), 'utf8');
  const taxonomy = readFileSync(join(folder, `${TAXONOMY_MIGRATION_TAG}.sql`), 'utf8');
  return { ...parseConversionMigration(conversion), taxonomyCheck: parseTaxonomyCheck(taxonomy) };
}

/** The step's UPDATE, narrowed to `"id" > $1 AND "id" <= $2`. */
export function rangedUpdate(step: ConversionStep): string {
  return `${step.head}\nWHERE (${step.predicate}) AND "id" > $1 AND "id" <= $2`;
}

/** How many rows in `"id" > $1 AND "id" <= $2` satisfy `condition`. */
export function rangedCount(table: string, condition: string): string {
  return `SELECT count(*)::int AS "rows" FROM "${table}" WHERE (${condition}) AND "id" > $1 AND "id" <= $2`;
}

/** The next batch after `$1`: how many ids it holds and the last one. */
function nextBatch(table: string): string {
  return (
    `SELECT count(*)::int AS "rows", max("id") AS "upper" FROM ` +
    `(SELECT "id" FROM "${table}" WHERE "id" > $1 ORDER BY "id" LIMIT $2) AS "batch"`
  );
}

/** Errors a batch is retried on: it lost a lock race or ran out of time, and changed nothing. */
const RETRYABLE_STATES = new Set([
  '55P03', // lock_not_available — lock_timeout
  '57014', // query_canceled — statement_timeout
  '40P01', // deadlock_detected
  '40001', // serialization_failure
]);

export interface ConversionProgress {
  readonly step: string;
  readonly batches: number;
  /** Rows the batches covered so far. */
  readonly examined: number;
  /** Rows converted (or, in a dry run, that would be). */
  readonly matched: number;
  /** The last id covered: `--from=<this>` resumes after it. */
  readonly lastId: string;
  /** The planner's row estimate for the table, for an ETA. */
  readonly estimatedRows: number;
  readonly elapsedSeconds: number;
}

export interface ConversionSummary {
  readonly step: string;
  readonly table: string;
  readonly batches: number;
  readonly examined: number;
  readonly matched: number;
  readonly lastId: string | null;
  readonly seconds: number;
}

/** How a batched run paces itself, resumes and reports. */
export interface IdBatchOptions {
  /** Rows per batch, and so per transaction. */
  readonly batchSize: number;
  /** Resume after this id (exclusive). Only meaningful for a single step. */
  readonly from?: string | null;
  /** Sleep between batches, to leave CPU credits and autovacuum room. */
  readonly pauseMs?: number;
  /** Attempts per batch on a lock or statement timeout. */
  readonly maxAttempts?: number;
  readonly onProgress?: (progress: ConversionProgress) => void;
}

export interface ConvertLegacyOptions extends IdBatchOptions {
  readonly steps: readonly ConversionStepName[];
  /** Count what would be converted; write nothing. */
  readonly dryRun?: boolean;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetries<T>(attempts: number, run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const state = sqlStateOf(error);
      if (attempt >= attempts || state === undefined || !RETRYABLE_STATES.has(state)) throw error;
      await sleep(Math.min(30_000, 1_000 * 2 ** (attempt - 1)));
    }
  }
}

async function estimatedRows(session: postgres.Sql, table: string): Promise<number> {
  const [row] = await session.unsafe<{ estimate: number | null }[]>(
    `SELECT greatest(reltuples, 0)::bigint::float8 AS "estimate" FROM pg_class WHERE oid = to_regclass($1)`,
    [table],
  );
  return Number(row?.estimate ?? 0);
}

async function hasColumn(session: postgres.Sql, table: string, column: string): Promise<boolean> {
  const rows = await session.unsafe(
    `SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return rows.length > 0;
}

/** A failure that says where to resume. */
export class ConversionInterruptedError extends Error {
  constructor(
    readonly step: string,
    readonly lastId: string,
    cause: unknown,
  ) {
    super(
      `The "${step}" conversion stopped after id ${JSON.stringify(lastId)}; resume with --step=${step} --from=${lastId}`,
      { cause },
    );
  }
}

/**
 * Prepare ONE session: settings, then the migration's mapping table and
 * functions, which live in that session's `pg_temp`.
 *
 * `session` must be a single connection (`postgres(url, { max: 1 })` or a
 * reserved one): a pool would run the setup on one connection and the batches
 * on another, where `pg_temp.goway_category_keys` does not exist.
 */
export async function prepareConversionSession(
  session: postgres.Sql,
  plan: LegacyConversionPlan,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  await prepareBatchSession(session, 'goway-places-convert-legacy', options);
  for (const statement of plan.setup) await session.unsafe(statement);
}

/** The settings every batched operator command runs its one session with. */
export async function prepareBatchSession(
  session: postgres.Sql,
  applicationName: string,
  options: { dryRun?: boolean } = {},
): Promise<void> {
  await session.unsafe(`SET application_name = '${applicationName}'`);
  // A batch that waits on a row lock gives up and is retried, rather than
  // queueing the API behind it.
  await session.unsafe(`SET lock_timeout = '5s'`);
  await session.unsafe(`SET statement_timeout = '5min'`);
  // A crash loses at most the last few committed batches, which the next run
  // redoes: every batch is idempotent. Not waiting on the WAL flush per batch is
  // a large share of the run time on gp3.
  if (!options.dryRun) await session.unsafe(`SET synchronous_commit = off`);
}

/** Run one step over its whole table, batch by batch. */
async function runStep(
  session: postgres.Sql,
  plan: LegacyConversionPlan,
  name: ConversionStepName | 'taxonomy-check',
  options: ConvertLegacyOptions,
): Promise<ConversionSummary> {
  const step = name === 'taxonomy-check' ? null : plan.steps[name];
  const statement =
    step === null
      ? rangedCount('places', `NOT (${plan.taxonomyCheck})`)
      : options.dryRun
        ? rangedCount(step.table, step.predicate)
        : rangedUpdate(step);
  return runIdBatches(
    session,
    { name, table: step?.table ?? 'places', statement, counts: step === null || options.dryRun === true },
    options,
  );
}

/**
 * One statement over a whole table, in id-ordered batches, each its own
 * transaction — the machinery of this command, shared with every other
 * operator command that rewrites `places` (`categories:move`).
 *
 * `statement` reads its id range as `$1` (exclusive) and `$2` (inclusive), and
 * any further parameters from `job.parameters` as `$3` onward. With `counts`
 * it is a `SELECT count(*) AS "rows"`; otherwise its row count is what it
 * changed.
 */
export async function runIdBatches(
  session: postgres.Sql,
  job: {
    readonly name: string;
    readonly table: 'places' | 'places_sources';
    readonly statement: string;
    readonly counts: boolean;
    readonly parameters?: readonly (string | number)[];
  },
  options: IdBatchOptions,
): Promise<ConversionSummary> {
  const attempts = options.maxAttempts ?? 5;
  const started = Date.now();
  const estimate = await estimatedRows(session, job.table);

  let after = options.from ?? '';
  let batches = 0;
  let examined = 0;
  let matched = 0;

  for (;;) {
    const [batch] = await withRetries(attempts, () =>
      session.unsafe<{ rows: number; upper: string | null }[]>(nextBatch(job.table), [after, options.batchSize]),
    );
    if (!batch || batch.rows === 0 || batch.upper === null) break;
    const upper = batch.upper;
    try {
      const result = await withRetries(attempts, () =>
        session.unsafe(job.statement, [after, upper, ...(job.parameters ?? [])]),
      );
      matched += job.counts ? Number((result[0] as { rows?: number })?.rows ?? 0) : result.count;
    } catch (error) {
      throw new ConversionInterruptedError(job.name, after, error);
    }
    batches += 1;
    examined += batch.rows;
    after = upper;
    options.onProgress?.({
      step: job.name,
      batches,
      examined,
      matched,
      lastId: after,
      estimatedRows: estimate,
      elapsedSeconds: (Date.now() - started) / 1000,
    });
    if (batch.rows < options.batchSize) break;
    if (options.pauseMs) await sleep(options.pauseMs);
  }

  return {
    step: job.name,
    table: job.table,
    batches,
    examined,
    matched,
    lastId: after === '' ? null : after,
    seconds: (Date.now() - started) / 1000,
  };
}

/**
 * Convert (or, with `dryRun`, count) the legacy rows of each requested step.
 *
 * A dry run of `categories` also counts the places `0013`'s CHECK would refuse
 * — the number that must be zero before `--validate-constraint`.
 */
export async function convertLegacyPlaceData(
  session: postgres.Sql,
  plan: LegacyConversionPlan,
  options: ConvertLegacyOptions,
): Promise<ConversionSummary[]> {
  if (options.from && options.steps.length !== 1) {
    throw new Error('--from resumes ONE step; pass exactly one --step with it.');
  }
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1) {
    throw new Error('The batch size must be a positive integer.');
  }
  if (options.steps.includes('timezone') && !(await hasColumn(session, 'places', 'timezone'))) {
    throw new Error(
      'The timezone conversion needs places.timezone, which the pre-deploy migrations add. ' +
        'It is not run before the merge: the previous image reads the zone from opening_hours.',
    );
  }

  const summaries: ConversionSummary[] = [];
  for (const name of CONVERSION_STEPS) {
    if (!options.steps.includes(name)) continue;
    summaries.push(await runStep(session, plan, name, options));
    if (name === 'categories' && options.dryRun) {
      summaries.push(await runStep(session, plan, 'taxonomy-check', { ...options, from: null }));
    }
  }
  return summaries;
}

/**
 * `ALTER TABLE places VALIDATE CONSTRAINT …`, after the deploy.
 *
 * `0013` adds the CHECK `NOT VALID`: new and updated rows are checked at once,
 * and the scan of every existing row happens here, under SHARE UPDATE
 * EXCLUSIVE, which blocks neither reads nor writes — instead of under the
 * ACCESS EXCLUSIVE lock an ordinary ADD CONSTRAINT holds for the whole scan,
 * inside the migrator's single transaction.
 */
export async function validateTaxonomyConstraint(session: postgres.Sql): Promise<{ alreadyValid: boolean; seconds: number }> {
  const [constraint] = await session.unsafe<{ valid: boolean }[]>(
    `SELECT convalidated AS "valid" FROM pg_constraint WHERE conrelid = to_regclass('places') AND conname = $1`,
    [TAXONOMY_CONSTRAINT],
  );
  if (!constraint) {
    throw new Error(
      `"${TAXONOMY_CONSTRAINT}" does not exist: the places-platform release's post phase adds it, and ` +
        '`0017` later drops it for the `places_categories_taxonomy_guard` trigger, which needs no validation.',
    );
  }
  if (constraint.valid) return { alreadyValid: true, seconds: 0 };
  const started = Date.now();
  await session.unsafe(`SET statement_timeout = 0`);
  await session.unsafe(`ALTER TABLE "places" VALIDATE CONSTRAINT "${TAXONOMY_CONSTRAINT}"`);
  return { alreadyValid: false, seconds: (Date.now() - started) / 1000 };
}

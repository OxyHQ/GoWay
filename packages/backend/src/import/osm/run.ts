/**
 * The OpenStreetMap POI import, as a one-shot task.
 *
 * ## How it is run
 *
 *     bun packages/backend/dist/src/import/osm/run.js \
 *       --target-database=goway --region=europe/spain
 *
 * which is the same shape as the migration one-shot — the compiled entry point
 * of the SHIPPED image, invoked as an ECS `command` override — for the same
 * reason: `oxy-postgres` is not publicly reachable, so anything that writes to
 * it runs inside the VPC. `packages/backend/README.md` has the full
 * `aws ecs run-task` invocation and the sizing it needs.
 *
 * `--target-database` is REQUIRED and is checked before a single row is read,
 * by the same `@oxy.so/db` guard the migrator uses. Pointed at the wrong
 * database this task would not fail — it would import a country into it and
 * report success, which is the failure mode that guard exists for.
 *
 * ## Flags
 *
 *   --target-database=<name>  Required unless --dry-run. Asserted first.
 *   --region=europe/spain     Geofabrik path. Default: europe/spain.
 *   --extract=<path>          Use a local .osm.pbf instead of downloading.
 *   --dry-run                 Read and measure; open no connection and write
 *                             nothing. Reproduces the numbers in
 *                             packages/backend/README.md on any machine.
 *   --limit=<n>               Stop after n places. For a smoke run.
 *   --bbox=w,s,e,n            Keep only places inside this rectangle. A first
 *                             run over central Barcelona is
 *                             --bbox=2.15,41.37,2.19,41.40.
 *   --batch-size=<n>          Places per write batch. Default 1000.
 *   --skip-duplicates         Do not run duplicate-candidate detection.
 *   --verify-sample=<n>       Elements to dereference against the live
 *                             OpenStreetMap API. Default 25; 0 disables.
 *   --work-dir=<path>         Where the extract is kept. Default /tmp/osm-data,
 *                             or GOWAY_OSM_DIR.
 *
 * A `--dry-run` still needs a syntactically valid `DATABASE_URL`: this package
 * parses its whole configuration at module load, deliberately, so that nothing
 * can be half-configured while already running. Any well-formed URL will do —
 * nothing connects.
 *
 * ## What it prints
 *
 * One `pino` line per phase and a final summary, which is what CloudWatch shows
 * for `/oxy/ecs`, stream `goway/goway/<task-id>`. The summary carries the
 * numbers the design was sized against: places by category and by language,
 * bytes per record, peak memory, and how long each pass took.
 */

import { join } from 'node:path';
import { readTargetDatabase } from '@oxy.so/db/migrate';
import { logger } from '../../utils/logger';
import { detectDuplicates } from './duplicates';
import { downloadExtract, geofabrikUrl } from './download';
import { extractPois } from './extract';
import type { ImportedPlace } from './placeRecord';
import { sourceDataOf } from './placeRecord';
import {
  provenanceHolds,
  sampleEvenly,
  verifyProvenance,
  type ProvenanceReport,
} from './verifyProvenance';
import { emptyWriteStats, writePlaceBatch, type WriteStats } from './writePlaces';

/** Every `SAMPLE_STRIDE`-th place is kept as a provenance sample candidate. */
const SAMPLE_STRIDE = 997;

/** How many candidates are kept before the sample is thinned to the requested size. */
const SAMPLE_RESERVOIR = 500;

/** `--flag=value`, or `undefined`. */
function value(argv: readonly string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const found = argv.find((arg) => arg.startsWith(prefix));
  return found?.slice(prefix.length).trim();
}

/** Whether a bare `--flag` is present. */
function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/** A positive integer flag, or its default. */
function number(argv: readonly string[], name: string, fallback: number): number {
  const raw = value(argv, name);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`--${name} must be a non-negative integer, got ${JSON.stringify(raw)}.`);
  }
  return parsed;
}

/** `--bbox=west,south,east,north`, or nothing. */
function readBounds(raw: string | undefined) {
  if (raw === undefined || raw === '') return undefined;
  const parts = raw.split(',').map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error(`--bbox must be west,south,east,north, got ${JSON.stringify(raw)}.`);
  }
  const [west, south, east, north] = parts as [number, number, number, number];
  // `south <= north` and deliberately NOT `west <= east`: the HTTP layer makes
  // the same asymmetry a contract, because west > east is an antimeridian
  // viewport. This filter is a plain comparison and cannot express that, so the
  // one it cannot serve is refused rather than silently inverted.
  if (south > north) throw new Error('--bbox south must not be north of north.');
  if (west > east) throw new Error('--bbox does not support a rectangle crossing the antimeridian.');
  return { west, south, east, north };
}

/** The mean serialized size of a record, as a stand-in for the row it becomes. */
function meanRecordBytes(sample: readonly ImportedPlace[]): number {
  if (sample.length === 0) return 0;
  const total = sample.reduce(
    (bytes, place) =>
      bytes +
      Buffer.byteLength(JSON.stringify(place)) +
      Buffer.byteLength(JSON.stringify(sourceDataOf(place))),
    0,
  );
  return Math.round(total / sample.length);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dryRun = flag(argv, 'dry-run');

  // Before anything opens a socket or moves a byte: an operator who forgot the
  // flag should learn it instantly. Exactly where `db/migrate.ts` puts it.
  const expectedDatabase = dryRun ? null : readTargetDatabase(argv);

  const workDir = value(argv, 'work-dir') ?? process.env.GOWAY_OSM_DIR ?? '/tmp/osm-data';
  const region = value(argv, 'region') ?? 'europe/spain';
  const local = value(argv, 'extract');
  const batchSize = number(argv, 'batch-size', 1000);
  const limit = number(argv, 'limit', 0);
  const verifySample = number(argv, 'verify-sample', 25);
  const bounds = readBounds(value(argv, 'bbox'));

  let db: Awaited<ReturnType<typeof openDatabase>> | null = null;
  if (expectedDatabase !== null) {
    db = await openDatabase(expectedDatabase);
  }

  try {
    let path = local;
    if (path === undefined) {
      const url = geofabrikUrl(region);
      const result = await downloadExtract(
        url,
        join(workDir, `${region.replace(/\//g, '-')}-latest.osm.pbf`),
        (message, detail) => logger.info(detail ?? {}, message),
      );
      logger.info(
        {
          url,
          bytes: result.bytes,
          megabytes: Math.round(result.bytes / 1e6),
          reused: result.reused,
          seconds: Math.round(result.milliseconds / 1000),
        },
        'Extract ready',
      );
      path = result.path;
    }

    const observedAt = new Date();
    const writes: WriteStats = emptyWriteStats();
    const sample: ImportedPlace[] = [];
    let seen = 0;

    const started = Date.now();
    const stats = await extractPois({
      path,
      batchSize,
      bounds,
      limit: limit > 0 ? limit : undefined,
      onProgress: (emitted) =>
        logger.info({ emitted, seconds: Math.round((Date.now() - started) / 1000) }, 'Importing'),
      onPlaces: async (batch) => {
        for (const place of batch) {
          seen += 1;
          if (seen % SAMPLE_STRIDE === 0 && sample.length < SAMPLE_RESERVOIR) sample.push(place);
        }
        if (db) await writePlaceBatch(db.handle, batch, observedAt, writes);
      },
    });

    const places = stats.nodePlaces + stats.wayPlaces + stats.relationPlaces;
    logger.info(
      {
        places,
        nodes: stats.nodePlaces,
        ways: stats.wayPlaces,
        relations: stats.relationPlaces,
        unpositioned: stats.unpositioned,
        names: stats.names,
        placesWithTranslations: stats.placesWithTranslations,
        blobsInflated: stats.blobsInflated,
        passSeconds: stats.passMilliseconds.map((milliseconds) => Math.round(milliseconds / 1000)),
        totalSeconds: Math.round((Date.now() - started) / 1000),
        meanRecordBytes: meanRecordBytes(sample),
        peakResidentMegabytes: Math.round(process.memoryUsage().rss / 1e6),
        byCategory: Object.fromEntries(
          [...stats.byCategory].sort((left, right) => right[1] - left[1]).slice(0, 40),
        ),
        byLanguage: Object.fromEntries(
          [...stats.byLanguage].sort((left, right) => right[1] - left[1]).slice(0, 20),
        ),
        writes: db ? writes : undefined,
        dryRun,
      },
      'Extract pass complete',
    );

    let provenance: ProvenanceReport | null = null;
    if (verifySample > 0 && sample.length > 0) {
      provenance = await verifyProvenance(sampleEvenly(sample, verifySample));
      logger.info(
        {
          checked: provenance.checked.length,
          matched: provenance.matched,
          nameDiffers: provenance.nameDiffers,
          missing: provenance.missing,
          mismatches: provenance.checked.filter((check) => check.status !== 'match'),
        },
        'Provenance dereferenced against OpenStreetMap',
      );
    }

    if (db && !flag(argv, 'skip-duplicates')) {
      const duplicates = await detectDuplicates(db.handle);
      logger.info({ ...duplicates }, 'Duplicate candidates filed');
    }

    // Last, so a provenance failure is reported with everything else already in
    // the log rather than instead of it. A wrong identifier is the #58 defect
    // and it must fail the task, not be a line somebody has to notice.
    if (provenance && !provenanceHolds(provenance)) {
      throw new Error(
        `Provenance check failed: ${provenance.missing} of ${provenance.checked.length} source ids ` +
          `resolve to nothing and ${provenance.nameDiffers} name the wrong element.`,
      );
    }
  } finally {
    if (db) await db.close();
  }
}

/**
 * Open the pool and prove it is the database the operator named.
 *
 * Dynamically imported so `--dry-run` never loads the connection module at all:
 * a measurement pass on a build runner has no database, and requiring one to
 * count POIs would make the measurement impossible to reproduce.
 */
async function openDatabase(expectedDatabase: string) {
  const { assertMigrationTarget } = await import('@oxy.so/db/migrate');
  const { connectPostgres, closePostgres } = await import('../../db/postgres');
  const handle = await connectPostgres();
  await assertMigrationTarget(handle.$client, expectedDatabase);
  return { handle, close: closePostgres };
}

main().catch((error: unknown) => {
  logger.error({ err: error }, 'OpenStreetMap POI import failed');
  process.exitCode = 1;
});

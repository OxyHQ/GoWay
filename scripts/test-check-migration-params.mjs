#!/usr/bin/env bun
/**
 * Fixture tests for check-migration-params.mjs.
 *
 * The gate's real run scans ZERO migrations today, so on this tree it cannot
 * distinguish "clean" from "broken traversal". These fixtures are the positive
 * control that it can fail at all, and the negative control that it does not
 * fail on SQL where `$1` is legitimate.
 *
 * Each case is a throwaway `packages/backend/drizzle/` handed to the real script
 * through MIGRATION_GATE_ROOT, so the code under test is the code CI runs — not
 * a re-implementation of its regex.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkScript = resolve(dirname(fileURLToPath(import.meta.url)), 'check-migration-params.mjs');
const fixturePrefix = join(tmpdir(), 'goway-migration-params-');
const decoder = new TextDecoder();
const created = [];
const failures = [];

async function fixture(files) {
  const root = await mkdtemp(fixturePrefix);
  created.push(root);
  const drizzle = join(root, 'packages', 'backend', 'drizzle');
  await mkdir(drizzle, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(drizzle, name), contents);
  }
  return root;
}

function run(root) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, checkScript],
    cwd: root,
    env: { ...process.env, MIGRATION_GATE_ROOT: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

async function expectVerdict(name, files, expectedExit, expectedFragment) {
  const { exitCode, output } = run(await fixture(files));
  if (exitCode !== expectedExit) {
    failures.push(`${name}: expected exit ${expectedExit}, got ${exitCode}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${name}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
  }
}

// ── Must FAIL ──────────────────────────────────────────────────────────────

// The exact shape ~/Oxy/docs/postgres-and-drizzle.md describes: a value
// interpolated into a `check()` renders as a bound parameter.
await expectVerdict(
  'check-constraint-placeholder',
  {
    '0000_places.sql': [
      '-- oxy:deploy-phase=pre',
      'CREATE TABLE "places" (',
      '\t"id" text PRIMARY KEY NOT NULL,',
      '\t"rating" integer,',
      '\tCONSTRAINT "places_rating_range" CHECK ("rating" between 0 and $1)',
      ');',
      '',
    ].join('\n'),
  },
  1,
  '0000_places.sql:5:65 contains the bound-parameter placeholder $1.',
);

// A placeholder in a LATER file, so the scan cannot pass by stopping at the
// first file.
await expectVerdict(
  'placeholder-in-second-file',
  {
    '0000_clean.sql': '-- oxy:deploy-phase=pre\nCREATE TABLE "a" ("id" text PRIMARY KEY NOT NULL);\n',
    '0001_dirty.sql': '-- oxy:deploy-phase=pre\nALTER TABLE "a" ADD CONSTRAINT "c" CHECK ("id" <> $2);\n',
  },
  1,
  '0001_dirty.sql',
);

// A `$1` after a dollar-quoted body. If the masker mis-parses the `$$` pair it
// blanks the rest of the file and this placeholder disappears — a failure mode
// that reads as a clean run.
await expectVerdict(
  'placeholder-after-dollar-quoted-body',
  {
    '0000_mixed.sql': [
      '-- oxy:deploy-phase=pre',
      'CREATE FUNCTION touch() RETURNS trigger AS $$',
      'BEGIN',
      '  RETURN NEW;',
      'END;',
      '$$ LANGUAGE plpgsql;',
      '--> statement-breakpoint',
      'ALTER TABLE "a" ADD CONSTRAINT "c" CHECK ("n" > $1);',
      '',
    ].join('\n'),
  },
  1,
  '0000_mixed.sql:8:',
);

// An UNTERMINATED dollar quote must not become a licence to hide everything
// after it.
await expectVerdict(
  'unterminated-dollar-quote-does-not-mask',
  {
    '0000_broken.sql': '-- oxy:deploy-phase=pre\nSELECT $$ unterminated;\nCHECK ("n" > $1);\n',
  },
  1,
  '0000_broken.sql:3:',
);

// The directory not existing at all. Zero files is a legitimate state; a
// drizzle/ that cannot be listed is not, and must not read as zero.
const missingRoot = await mkdtemp(fixturePrefix);
created.push(missingRoot);
const missing = run(missingRoot);
if (missing.exitCode !== 1 || !missing.output.includes('cannot be listed')) {
  failures.push(`missing-drizzle-folder: expected a refusal, got exit ${missing.exitCode}.\n${missing.output}`);
}

// ── Must PASS ──────────────────────────────────────────────────────────────

// `sql.raw` on the constant side — the fix the failure message prescribes. If
// this failed, the prescribed fix would not satisfy the gate.
await expectVerdict(
  'raw-constant-passes',
  {
    '0000_places.sql': [
      '-- oxy:deploy-phase=pre',
      'CREATE TABLE "places" (',
      '\t"id" text PRIMARY KEY NOT NULL,',
      '\t"rating" integer,',
      '\tCONSTRAINT "places_rating_range" CHECK ("rating" between 0 and 5)',
      ');',
      '',
    ].join('\n'),
  },
  0,
  'scanned 1 migration file(s)',
);

// `$1` inside a PL/pgSQL body is a function-argument reference and is correct.
// Failing it would push authors to switch the gate off.
await expectVerdict(
  'dollar-quoted-argument-reference-passes',
  {
    '0000_function.sql': [
      '-- oxy:deploy-phase=pre',
      'CREATE FUNCTION place_distance(geography, geography) RETURNS double precision AS $body$',
      '  SELECT ST_Distance($1, $2);',
      '$body$ LANGUAGE sql IMMUTABLE;',
      '',
    ].join('\n'),
  },
  0,
  'scanned 1 migration file(s)',
);

// `$1` in prose. Both comment forms, because the masker handles them separately.
await expectVerdict(
  'placeholders-in-comments-pass',
  {
    '0000_commented.sql': [
      '-- oxy:deploy-phase=pre',
      '-- NOTE: an interpolated value would render as $1 here; see check-migration-params.mjs.',
      '/* and $2 inside a block comment,',
      '   over several lines */',
      'CREATE TABLE "a" ("id" text PRIMARY KEY NOT NULL);',
      '',
    ].join('\n'),
  },
  0,
  'scanned 1 migration file(s)',
);

// An EMPTY drizzle/ — GoWay's real state today. It must pass, and it must say
// zero out loud so a traversal that stopped finding files is visible in the log.
await expectVerdict('empty-folder-passes', {}, 0, 'scanned 0 migration file(s)');

for (const root of created) {
  if (root.startsWith(fixturePrefix)) await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Migration parameter check tests failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Migration parameter check discriminated ${created.length} fixture case(s).`);

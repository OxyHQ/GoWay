#!/usr/bin/env bun
/**
 * Fixture tests for check-migration-phases.mjs.
 *
 * GoWay's journal is EMPTY today, so the real run reports "0 migrations" and
 * cannot tell a clean tree from a traversal that stopped working. These fixtures
 * are the positive control: each one must fail for its own named reason, and the
 * clean ones must pass, so the gate is known to discriminate before it is
 * trusted over a tree with real migrations in it.
 *
 * Each case is a throwaway `packages/backend/drizzle/` handed to the real script
 * through MIGRATION_GATE_ROOT — the code under test is the code CI runs.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkScript = resolve(dirname(fileURLToPath(import.meta.url)), 'check-migration-phases.mjs');
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturePrefix = join(tmpdir(), 'goway-migration-phases-');
const decoder = new TextDecoder();
const created = [];
const failures = [];

function journal(tags) {
  return JSON.stringify(
    {
      version: '7',
      dialect: 'postgresql',
      entries: tags.map((tag, idx) => ({ idx, version: '7', when: 1 + idx, tag, breakpoints: true })),
    },
    null,
    2,
  );
}

/**
 * @param files  `<tag>.sql` contents, keyed by file name.
 * @param meta   `_journal.json` contents, or `null` to omit the file entirely.
 */
async function fixture(files, meta) {
  const root = await mkdtemp(fixturePrefix);
  created.push(root);
  const drizzle = join(root, 'packages', 'backend', 'drizzle');
  await mkdir(join(drizzle, 'meta'), { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(drizzle, name), contents);
  }
  if (meta !== null) await writeFile(join(drizzle, 'meta', '_journal.json'), meta);
  return root;
}

function run(root) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, checkScript],
    // cwd is the REPOSITORY, so `@oxy.so/db/migrate` resolves from its
    // node_modules; the fixture is addressed by MIGRATION_GATE_ROOT. The gate
    // therefore uses the same phase reader the migrator does, rather than a
    // copy of its regex.
    cwd: repositoryRoot,
    env: { ...process.env, MIGRATION_GATE_ROOT: root },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    exitCode: result.exitCode,
    output: `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`,
  };
}

async function expectVerdict(name, files, meta, expectedExit, expectedFragment) {
  const { exitCode, output } = run(await fixture(files, meta));
  if (exitCode !== expectedExit) {
    failures.push(`${name}: expected exit ${expectedExit}, got ${exitCode}.\n${output}`);
    return;
  }
  if (!output.includes(expectedFragment)) {
    failures.push(`${name}: output does not contain ${JSON.stringify(expectedFragment)}.\n${output}`);
  }
}

const PRE = '-- oxy:deploy-phase=pre\nCREATE TABLE "a" ("id" text PRIMARY KEY NOT NULL);\n';
const POST = '-- oxy:deploy-phase=post\nALTER TABLE "a" DROP COLUMN "b";\n';

// ── Must PASS ──────────────────────────────────────────────────────────────

// GoWay's real state: a present, parseable, EMPTY journal and no orphan .sql.
await expectVerdict('empty-journal', {}, journal([]), 0, 'is present, parses, and is EMPTY');

await expectVerdict(
  'marked-migrations',
  { '0000_a.sql': PRE, '0001_b.sql': POST },
  journal(['0000_a', '0001_b']),
  0,
  'all 2 migration(s) declare a phase (1 pre, 1 post)',
);

// ── Must FAIL ──────────────────────────────────────────────────────────────

// A migration with no marker. This is the case the whole gate exists for.
await expectVerdict(
  'unmarked-migration',
  { '0000_a.sql': 'CREATE TABLE "a" ("id" text PRIMARY KEY NOT NULL);\n' },
  journal(['0000_a']),
  1,
  '0000_a',
);

// Two markers is as bad as none: nothing decides which one wins.
await expectVerdict(
  'two-markers',
  { '0000_a.sql': `-- oxy:deploy-phase=pre\n${POST}` },
  journal(['0000_a']),
  1,
  '0000_a',
);

// A value the migrator does not recognise.
await expectVerdict(
  'unrecognised-phase',
  { '0000_a.sql': '-- oxy:deploy-phase=predeploy\nCREATE TABLE "a" ("id" text);\n' },
  journal(['0000_a']),
  1,
  '0000_a',
);

// A hand-written .sql nobody added to the journal. NOTHING applies it — not
// db:migrate, not the deploy — and without the reconciliation the gate reports
// "all 0 migrations declare a phase" over it.
await expectVerdict(
  'orphan-sql-file',
  { '0000_a.sql': PRE },
  journal([]),
  1,
  'is not in the journal, so NOTHING applies it',
);

// The mirror image: a journal entry whose file was deleted. The image cannot
// migrate and readiness asserts against a migration that does not exist.
await expectVerdict(
  'journal-entry-without-file',
  {},
  journal(['0000_a']),
  1,
  'there is no 0000_a.sql in drizzle/',
);

// A MISSING journal must not read as an empty one.
await expectVerdict('missing-journal', { '0000_a.sql': PRE }, null, 1, 'cannot be read');

// A journal that is not JSON.
await expectVerdict('unparseable-journal', {}, '{ not json', 1, 'is not readable JSON');

// A journal with no `entries` array.
await expectVerdict('journal-without-entries', {}, '{"version":"7"}', 1, 'has no `entries` array');

for (const root of created) {
  if (root.startsWith(fixturePrefix)) await rm(root, { recursive: true, force: true });
}

if (failures.length > 0) {
  console.error('Migration phase check tests failed:\n');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Migration phase check discriminated ${created.length} fixture case(s).`);

#!/usr/bin/env bun
/**
 * Fail the build when a schema change could reach production out of order.
 *
 * THE OUTAGE THIS EXISTS FOR (measured on OxyHQ/oxy, 2026-08-02)
 *
 * A migration added `users.account_categories`, and the same pull request added
 * code selecting that column by name. The image reached production; the column
 * did not. Every read of it returned 500 ecosystem-wide until the migration was
 * dispatched by hand. The migration was additive, defaulted, dropped nothing and
 * documented the ordering it needed — none of which helped, because the ordering
 * depended on a human performing two dispatches in the right order while a
 * deploy raced them.
 *
 * So a migration DECLARES its side, in its own file, on one line:
 *
 *     -- oxy:deploy-phase=pre      applied BEFORE the new image rolls out
 *     -- oxy:deploy-phase=post     applied AFTER the new image is live
 *
 * There is no default. A migration with no marker, with two, or with an
 * unrecognised value is a hard failure here AND at migration time.
 *
 * WHAT IS CHECKED
 *
 *   1. The journal exists and parses. A MISSING journal is a failure, not an
 *      empty one: an image shipped without its migrations must never read as
 *      "nothing declared, nothing to do" — and `GET /ready` reads this same file
 *      to decide whether a task may serve traffic.
 *   2. The journal and the `.sql` files on disk describe the SAME set. This is
 *      what makes the check meaningful while GoWay has zero migrations: an
 *      orphan `.sql` nothing applies, or a journal entry with no file beside it,
 *      both fail — so "zero migrations" is a verified statement rather than the
 *      absence of one.
 *   3. Every journal entry declares exactly one legible phase, read with the
 *      SAME reader the migrator uses at runtime (`readMigrationPhases` from
 *      `@oxy.so/db/migrate`) rather than a second copy of the regex. A gate and
 *      a migrator that own separate copies eventually disagree, and the
 *      disagreement surfaces as a migration that passes CI and refuses to apply.
 *
 * WHAT IS NOT CHECKED, DELIBERATELY
 *
 * Whether anything is PENDING. That needs the ledger, and the database is on a
 * private address a pull-request check must never hold credentials for. The
 * pending question is answered at migration time by the migrator itself, which
 * names every migration it applies, defers or refuses.
 *
 * Paths resolve from the working directory, so `test-check-migration-phases.mjs`
 * can run this against mutated copies of the real files via MIGRATION_GATE_ROOT.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readMigrationPhases } from '@oxy.so/db/migrate';

const root = resolve(process.env.MIGRATION_GATE_ROOT || process.cwd());
const DRIZZLE_FOLDER = join(root, 'packages', 'backend', 'drizzle');
const JOURNAL_PATH = join(DRIZZLE_FOLDER, 'meta', '_journal.json');

const problems = [];
const fail = (message) => problems.push(message);

/** Journal tags, in journal order. `null` means the journal could not be read. */
function parseJournalTags() {
  let raw;
  try {
    raw = readFileSync(JOURNAL_PATH, 'utf8');
  } catch (error) {
    fail(
      `${JOURNAL_PATH} cannot be read (${error.message}). A missing journal is not an empty one: ` +
        'an image shipped without its migrations must never read as "nothing to do", and GET /ready ' +
        'parses this same file to decide whether a task may serve traffic.',
    );
    return null;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    fail(`${JOURNAL_PATH} is not readable JSON (${error.message}); the gate cannot see any migration.`);
    return null;
  }

  const entries = parsed?.entries;
  if (!Array.isArray(entries)) {
    fail(`${JOURNAL_PATH} has no \`entries\` array; the gate cannot see any migration.`);
    return null;
  }

  const tags = [];
  for (const [index, entry] of entries.entries()) {
    if (typeof entry?.tag !== 'string' || entry.tag.length === 0) {
      fail(`${JOURNAL_PATH} entry ${index} has no string \`tag\`, so its migration cannot be located.`);
      continue;
    }
    tags.push(entry.tag);
  }
  return tags;
}

/** The `.sql` files actually sitting in `drizzle/`. */
function migrationFilesOnDisk() {
  try {
    return readdirSync(DRIZZLE_FOLDER)
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.slice(0, -'.sql'.length))
      .sort();
  } catch (error) {
    fail(`${DRIZZLE_FOLDER} cannot be listed (${error.message}), so the journal cannot be reconciled with it.`);
    return null;
  }
}

const tags = parseJournalTags();
const filesOnDisk = migrationFilesOnDisk();

// ── The journal and the directory must describe the same set ───────────────
//
// This is the VACUITY FLOOR, and it is the reason a zero-migration journal is
// still a measurement. An orphan `.sql` is a migration nothing will ever apply;
// a journal entry with no file is an image that cannot migrate. Without this the
// gate would report "all 0 migrations declare a phase" over any amount of
// broken state.
if (tags !== null && filesOnDisk !== null) {
  for (const tag of tags) {
    if (!filesOnDisk.includes(tag)) {
      fail(
        `The journal lists ${tag} but there is no ${tag}.sql in drizzle/. The migrator cannot apply it ` +
          'and readiness asserts against a migration that does not exist.',
      );
    }
  }
  for (const file of filesOnDisk) {
    if (!tags.includes(file)) {
      fail(
        `drizzle/${file}.sql is not in the journal, so NOTHING applies it — not \`db:migrate\`, not the ` +
          'deploy. Regenerate with `bun run db:generate` instead of hand-writing a migration.',
      );
    }
  }
}

// ── Every migration declares its side of the deploy ────────────────────────
let phases = new Map();
if (tags !== null && tags.length > 0) {
  const result = readMigrationPhases(tags, DRIZZLE_FOLDER);
  phases = result.phases;
  for (const problem of result.problems) fail(problem);
}

if (problems.length > 0) {
  console.error('Migration deploy phases are BROKEN:\n');
  for (const problem of problems) console.error(`- ${problem}`);
  console.error(
    '\nA migration that does not declare its side of the deploy ships an image against a schema that' +
      '\ndoes not match it. Nothing errors at deploy time; the API just starts returning 500 on every' +
      '\nread of the new column.',
  );
  process.exit(1);
}

const postCount = [...phases.values()].filter((phase) => phase === 'post').length;
if (tags.length === 0) {
  console.log(
    'Migration deploy phases are sound: the journal is present, parses, and is EMPTY — and no orphan ' +
      '.sql sits in drizzle/ waiting for nothing to apply it. GoWay\'s first migration arrives with the ' +
      'Places schema.',
  );
} else {
  console.log(
    `Migration deploy phases are sound: all ${tags.length} migration(s) declare a phase ` +
      `(${tags.length - postCount} pre, ${postCount} post) and the journal matches the .sql files on disk.`,
  );
}

#!/usr/bin/env bun
/**
 * Fail the build on a `$1`-style placeholder inside a GENERATED migration.
 *
 * THE BUG THIS EXISTS FOR
 *
 * drizzle's `check()` — and `sql` fragments generally — parameterise every
 * interpolated JavaScript value. That is exactly right for a QUERY, where the
 * driver sends the value alongside the statement. It is exactly wrong for DDL,
 * because `db:generate` renders the fragment to a `.sql` FILE and the values
 * never travel with it:
 *
 *     check('rating_range', sql`${places.rating} between 0 and ${MAX_RATING}`)
 *
 * generates `CHECK ("rating" between 0 and $1)`. There is no bound parameter at
 * apply time, so Postgres raises `there is no parameter $1` — and it raises it
 * when the migration APPLIES, not when it is generated. On a developer's warm
 * database with the migration already applied, nothing complains; it fails in
 * CI, or on the deploy, or on a new database. The fix is `sql.raw(String(value))`
 * for the constant side, and this gate is what makes forgetting it visible in
 * the diff that introduces it.
 *
 * `~/Oxy/docs/postgres-and-drizzle.md` mandates exactly this check.
 *
 * WHY THIS IS NOT A ONE-LINE `grep`
 *
 * `$1` is not unconditionally wrong in SQL, and a naive grep produces false
 * failures that get the gate switched off:
 *
 *   - `$$ … $$` and `$tag$ … $tag$` dollar-quoted bodies (a PL/pgSQL function,
 *     a trigger) legitimately contain `$1` as a function argument reference.
 *     Those are scanned for their own delimiters and skipped.
 *   - `--` line comments and `/* … *\/` block comments are prose.
 *
 * Everything else is a hard failure with a line number. A `$1` in executable DDL
 * has no legitimate meaning: nothing binds a parameter to a migration.
 *
 * Paths resolve from MIGRATION_GATE_ROOT or the working directory, so
 * `test-check-migration-params.mjs` can run this against fixture folders.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(process.env.MIGRATION_GATE_ROOT || process.cwd());
const DRIZZLE_FOLDER = join(root, 'packages', 'backend', 'drizzle');

/** `$` followed by at least one digit — the shape a bound parameter renders as. */
const PLACEHOLDER = /\$\d+/g;

/**
 * Blank out every region of `sql` where a `$<digit>` is legitimate, preserving
 * newlines so reported line numbers stay the source's.
 *
 * Returns the masked text. Deliberately a single left-to-right scan rather than
 * a stack of regexes: dollar quoting, line comments and block comments can each
 * contain the others' opening delimiter, so replacing them one pattern at a time
 * mis-parses in both directions (a `--` inside a dollar-quoted body, a `$$`
 * inside a comment).
 */
export function maskNonExecutableRegions(sql) {
  const out = [];
  let index = 0;

  const blank = (text) => text.replace(/[^\n]/g, ' ');

  while (index < sql.length) {
    const rest = sql.slice(index);

    // `-- …` to end of line.
    if (rest.startsWith('--')) {
      const end = sql.indexOf('\n', index);
      const stop = end === -1 ? sql.length : end;
      out.push(blank(sql.slice(index, stop)));
      index = stop;
      continue;
    }

    // `/* … */`, which nests in Postgres.
    if (rest.startsWith('/*')) {
      let depth = 0;
      let cursor = index;
      while (cursor < sql.length) {
        if (sql.startsWith('/*', cursor)) {
          depth += 1;
          cursor += 2;
        } else if (sql.startsWith('*/', cursor)) {
          depth -= 1;
          cursor += 2;
          if (depth === 0) break;
        } else {
          cursor += 1;
        }
      }
      out.push(blank(sql.slice(index, cursor)));
      index = cursor;
      continue;
    }

    // `$$ … $$` or `$tag$ … $tag$`. The tag is an identifier, so `$1` can never
    // open one — which is what keeps a bare placeholder from masking itself and
    // everything after it.
    const openTag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(rest);
    if (openTag) {
      const delimiter = openTag[0];
      const close = sql.indexOf(delimiter, index + delimiter.length);
      // An UNTERMINATED dollar quote masks the rest of the file, which would
      // hide every later placeholder. Stop masking here and let the caller see
      // the raw remainder rather than a silently blanked one.
      const stop = close === -1 ? index + delimiter.length : close + delimiter.length;
      out.push(blank(sql.slice(index, stop)));
      index = stop;
      continue;
    }

    out.push(sql[index]);
    index += 1;
  }

  return out.join('');
}

/** Every `$<digit>` left in executable DDL, as `{ line, column, text }`. */
export function findPlaceholders(sql) {
  const masked = maskNonExecutableRegions(sql);
  const found = [];
  for (const match of masked.matchAll(PLACEHOLDER)) {
    const before = masked.slice(0, match.index);
    const line = before.split('\n').length;
    const column = match.index - (before.lastIndexOf('\n') + 1) + 1;
    found.push({ line, column, text: match[0] });
  }
  return found;
}

function main() {
  let files;
  try {
    files = readdirSync(DRIZZLE_FOLDER)
      .filter((name) => name.endsWith('.sql'))
      .sort();
  } catch (error) {
    console.error(`::error::${DRIZZLE_FOLDER} cannot be listed (${error.message}), so no migration was scanned.`);
    process.exit(1);
  }

  const problems = [];
  let scannedLines = 0;

  for (const file of files) {
    const path = join(DRIZZLE_FOLDER, file);
    const sql = readFileSync(path, 'utf8');
    scannedLines += sql.split('\n').length;
    for (const { line, column, text } of findPlaceholders(sql)) {
      problems.push(
        `packages/backend/drizzle/${file}:${line}:${column} contains the bound-parameter placeholder ` +
          `${text}.`,
      );
    }
  }

  if (problems.length > 0) {
    console.error('Generated migrations contain bound-parameter placeholders:\n');
    for (const problem of problems) console.error(`- ${problem}`);
    console.error(
      '\nA JavaScript value interpolated into a drizzle `sql` fragment — a `check()` constraint is the' +
        '\nusual one — is PARAMETERISED, and `db:generate` renders it to a file where nothing binds the' +
        '\nparameter. Postgres answers `there is no parameter $1` at APPLY time, which means CI or the' +
        '\ndeploy, not the machine that generated it.' +
        '\n\nFix: `sql.raw(String(value))` for the constant side, then re-run `bun run db:generate`.',
    );
    process.exit(1);
  }

  // Vacuity report. Zero migrations is GoWay's real state today (the Places
  // schema lands in issue #4), so this cannot be a hard floor — but it is stated
  // out loud on every run, so a traversal that silently stops finding files
  // reads as "0 scanned" in the log instead of as a clean result. The gate's
  // ability to fail at all is proved by test-check-migration-params.mjs, which
  // runs the same code over fixtures that must fail.
  console.log(
    `No bound-parameter placeholders: scanned ${files.length} migration file(s), ${scannedLines} line(s).` +
      (files.length === 0
        ? ' The journal is empty — GoWay\'s first migration arrives with the Places schema.'
        : ''),
  );
}

// Importable for the fixture tests, executable for CI.
if (import.meta.main) main();

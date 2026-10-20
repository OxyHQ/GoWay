/**
 * Accent- and case-insensitive text, spelled once for JavaScript and for SQL.
 *
 * ## Why a `translate` table and not `unaccent`
 *
 * `unaccent()` is STABLE, so Postgres refuses it in an index expression, and the
 * usual fix is a hand-written IMMUTABLE wrapper function in a hand-written
 * migration. `translate()` is IMMUTABLE and built in: the same fold, as an
 * expression index, with no extension and no function to own.
 *
 * ## One table drives both sides
 *
 * The index is only used when the query spells the SAME expression, and a
 * stored name is only found when both sides fold identically. So the table
 * below is the single definition: {@link foldText} applies it in JavaScript and
 * {@link foldedSql} emits it as `translate(...)`. `textFold.test.ts` pins the
 * generated strings, because changing the table changes the index expression
 * and silently orphans the deployed index.
 */

import { sql, type SQL } from 'drizzle-orm';

/** Scripts whose precomposed letters decompose to a base letter plus marks. */
const FOLDED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00c0, 0x024f], // Latin-1 Supplement, Latin Extended-A and -B
  [0x0370, 0x03ff], // Greek
  [0x0400, 0x04ff], // Cyrillic
  [0x1e00, 0x1fff], // Latin Extended Additional, Greek Extended
];

const BASE_LETTER = /^\p{L}$/u;
const ONLY_MARKS = /^\p{M}+$/u;

function buildTable(): { from: string; to: string } {
  let from = '';
  let to = '';
  for (const [start, end] of FOLDED_RANGES) {
    for (let code = start; code <= end; code += 1) {
      const character = String.fromCodePoint(code);
      const lower = character.toLowerCase();
      // Only lower-case letters get an entry: both sides lower-case first.
      if (lower !== character) continue;
      const decomposed = lower.normalize('NFD');
      const [base, ...marks] = [...decomposed];
      if (base === undefined || marks.length === 0) continue;
      if (!BASE_LETTER.test(base) || !ONLY_MARKS.test(marks.join(''))) continue;
      from += lower;
      to += base;
    }
  }
  return { from, to };
}

const TABLE = buildTable();
const BY_CHARACTER = new Map(
  [...TABLE.from].map((character, index) => [character, [...TABLE.to][index]]),
);

/**
 * `value` lower-cased, trimmed and stripped of the accents in the table.
 *
 * What a search compares typed text with: "Café" and "cafe" are the same word
 * to anyone typing on a phone keyboard.
 */
export function foldText(value: string): string {
  let folded = '';
  for (const character of value.normalize('NFC').trim().toLowerCase()) {
    folded += BY_CHARACTER.get(character) ?? character;
  }
  return folded;
}

const literal = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/** The fold as a SQL expression over `column`, which must already be lower-case. */
export function foldedSql(column: SQL): SQL {
  return sql`translate(${column}, ${sql.raw(literal(TABLE.from))}, ${sql.raw(literal(TABLE.to))})`;
}

/** The table, exposed so a test can pin the index expression. */
export const FOLD_TABLE: Readonly<{ from: string; to: string }> = TABLE;

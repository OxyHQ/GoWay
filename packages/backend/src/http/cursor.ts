/**
 * Page cursors — `~/Oxy/docs/api-conventions.md` § Lists.
 *
 * The contract says a cursor is OPAQUE (`Page.nextCursor`): a consumer passes
 * it back verbatim and its contents are not a promise. What it carries today is
 * a small versioned JSON payload, base64url-encoded:
 *
 * ```
 * { "v": 1, "k": <list kind>, "f": <fingerprint>, "p": <position> }
 * ```
 *
 * ## Keyset where the list has an order, an offset only where it cannot
 *
 * A nearby list resumes at `(distance, id)`, a viewport at `id` (uuidv7, so
 * creation order), claims and captures at `(timestamp, id)`. A keyset position
 * is immune to rows arriving or leaving between pages: no duplicate and no gap,
 * and no cost that grows with depth. Search is the exception — its order is a
 * fused score over several providers' rankings, recomputed per request, so it
 * pages by OFFSET and stops at `SEARCH_MAX_DEPTH`.
 *
 * ## Why a foreign cursor is a 400 rather than a first page
 *
 * The fingerprint is a digest of the list KIND and its normalized filters. A
 * cursor minted by another list, or by the same list under different filters,
 * names a position that means nothing there — so it is refused as
 * `bad_request`. The page SIZE is deliberately NOT in the fingerprint: a keyset
 * or an offset is independent of how many rows the previous page held, so a
 * caller may change `limit` between pages.
 *
 * A fingerprint is a truncated SHA-256, so a nearby list's coordinate is in it
 * only as a digest — and the same request already carries that coordinate in
 * the clear, so the cursor exposes nothing the URL does not.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './apiError';

/** The lists a cursor can belong to. */
export const CURSOR_KINDS = [
  'places-nearby',
  'places-bounds',
  'place-claims',
  'my-claims',
  'search',
  'geocode',
  'reverse-geocode',
  'structured-geocode',
  'capture-sessions',
  'capture-assets',
] as const;
export type CursorKind = (typeof CURSOR_KINDS)[number];

const CURSOR_VERSION = 1;

/** A scalar or a list of scalars a list was filtered by. `undefined` is dropped. */
type FilterValue = string | number | boolean | readonly string[] | undefined;

export type CursorFilters = Readonly<Record<string, FilterValue>>;

/**
 * A stable digest of a list kind plus its filters.
 *
 * Key order does not matter and neither does the order of a set-valued filter
 * (`capabilities=a,b` and `b,a` ask the same question), so both are sorted
 * before hashing; an absent filter and an unsent one digest identically.
 */
export function cursorFingerprint(kind: CursorKind, filters: CursorFilters): string {
  const entries = Object.entries(filters)
    .filter((entry): entry is [string, Exclude<FilterValue, undefined>] => entry[1] !== undefined)
    .map(([name, value]) => [name, Array.isArray(value) ? [...value].sort() : value] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha256').update(JSON.stringify([kind, entries])).digest('base64url').slice(0, 22);
}

const payloadSchema = z
  .object({
    v: z.literal(CURSOR_VERSION),
    k: z.enum(CURSOR_KINDS),
    f: z.string().min(1).max(64),
    p: z.unknown(),
  })
  .strict();

/** A list's binding: what kind it is and the fingerprint of its filters. */
export interface CursorBinding {
  kind: CursorKind;
  fingerprint: string;
}

export function cursorBinding(kind: CursorKind, filters: CursorFilters): CursorBinding {
  return { kind, fingerprint: cursorFingerprint(kind, filters) };
}

/** Encode the cursor that resumes at `position`. Deterministic for equal inputs. */
export function encodeCursor(binding: CursorBinding, position: unknown): string {
  // Fixed key order, so equal inputs always produce the identical string.
  return Buffer.from(
    JSON.stringify({ v: CURSOR_VERSION, k: binding.kind, f: binding.fingerprint, p: position }),
    'utf8',
  ).toString('base64url');
}

/**
 * The position a request's cursor resumes at — `undefined` with no cursor.
 *
 * @throws `bad_request` for a cursor that is not base64url JSON of the current
 * version, belongs to another list kind, was minted under different filters,
 * or carries a position this list cannot resume from.
 */
export function decodeCursor<P>(
  raw: string | undefined,
  binding: CursorBinding,
  position: z.ZodType<P>,
): P | undefined {
  if (raw === undefined) return undefined;
  const refused = new ApiError('bad_request', 'The cursor is not one this list issued for these filters.', {
    field: 'cursor',
    issue: 'foreign_cursor',
  });
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw refused;
  }
  const payload = payloadSchema.safeParse(decoded);
  if (!payload.success || payload.data.k !== binding.kind || payload.data.f !== binding.fingerprint) {
    throw refused;
  }
  const parsed = position.safeParse(payload.data.p);
  if (!parsed.success) throw refused;
  return parsed.data;
}

/**
 * One page from `limit + 1` rows: the first `limit` as items, and the cursor
 * for the next page made from the last item served — or `null` when the extra
 * row did not arrive, which is the only honest "there is no more".
 */
export function pageOf<Row, Item>(
  rows: readonly Row[],
  limit: number,
  binding: CursorBinding,
  positionOf: (row: Row) => unknown,
  toItem: (row: Row) => Item,
): { items: Item[]; nextCursor: string | null } {
  const served = rows.slice(0, limit);
  const last = served[served.length - 1];
  return {
    items: served.map(toItem),
    nextCursor: rows.length > limit && last !== undefined ? encodeCursor(binding, positionOf(last)) : null,
  };
}

/**
 * A `(timestamp, id)` keyset position.
 *
 * The timestamp is Postgres's own TEXT rendering, microseconds intact: a
 * `timestamptz` has microsecond precision and a JavaScript `Date` does not, so
 * a position rebuilt from `toISOString()` sorts on the wrong side of the row it
 * came from and the next page would repeat or skip it.
 */
export const timeKeysetSchema = z.tuple([
  // The shape Postgres renders a `timestamptz` as. Checked, not trusted: a
  // cursor is only base64, so a caller can edit it, and a value Postgres then
  // failed to cast would be a 500 instead of the `bad_request` it is.
  z.string().regex(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?[+-]\d{2}(?::\d{2})?$/),
  z.string().min(1).max(128),
]);
export type TimeKeyset = z.infer<typeof timeKeysetSchema>;

/** A window over a time-ordered list: how many rows, and where to resume. */
export interface TimeWindow {
  limit: number;
  after?: TimeKeyset | undefined;
}

/** A listed row plus the position a page that ends on it resumes after. */
export interface Paged<T> {
  item: T;
  position: TimeKeyset;
}

/** `limit + 1` rows from a request's limit and cursor, so the page can tell whether the list continues. */
export function timeWindowOf(query: { limit: number; cursor?: string | undefined }, binding: CursorBinding): TimeWindow {
  return { limit: query.limit + 1, after: decodeCursor(query.cursor, binding, timeKeysetSchema) };
}

/** The page of {@link Paged} rows. */
export function timePageOf<T>(rows: readonly Paged<T>[], limit: number, binding: CursorBinding): { items: T[]; nextCursor: string | null } {
  return pageOf(rows, limit, binding, (row) => row.position, (row) => row.item);
}

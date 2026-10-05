/**
 * Lists, pages and cursors — `~/Oxy/docs/api-conventions.md` § Lists.
 *
 * Every GoWay list answers `{ items, nextCursor }`, and that is all a client
 * may rely on: there is no total and no `count(*)` behind it, because a count
 * over a viewport or a radius is a second scan of the same rows that nothing
 * renders.
 *
 * A cursor is OPAQUE. What it carries today is the server's business (a keyset
 * position or an offset, bound to its list and filters by a fingerprint), and
 * a client passes it back verbatim with the SAME filters. Replaying it on
 * another list, or with other filters, is `bad_request` rather than a page of
 * something else.
 */

import { z } from 'zod';

/** The longest cursor GoWay mints, with room to spare. */
export const MAX_CURSOR_LENGTH = 512;

/** An opaque page cursor: base64url, as the server minted it. */
export const cursorSchema = z
  .string()
  .min(1)
  .max(MAX_CURSOR_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'must be a cursor this list issued');

/** One page of a list. `nextCursor` is `null` on the last page. */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** The schema of a page of `item`. */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    /** Pass back as `cursor`, with the same filters, for the next page. `null` on the last one. */
    nextCursor: cursorSchema.nullable(),
  });
}

/**
 * A `limit` parameter: an integer from 1 to `maximum`, `fallback` when absent.
 *
 * Outside the range is `validation_failed`, never a silent clamp — a caller
 * who asked for 500 and got 200 would conclude the list has 200 entries.
 */
export function limitSchema(maximum: number, fallback: number) {
  return z.number().int().min(1).max(maximum).default(fallback);
}

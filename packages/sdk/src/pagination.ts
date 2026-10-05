import { GoWayResponseError } from './errors';

/** One page as {@link iterateGoWayPages} reads it: every GoWay list has this shape. */
export interface GoWayPageLike<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

/**
 * Every item of a GoWay list, page after page.
 *
 * `fetchPage` is called with `undefined` for the first page and then with each
 * `nextCursor` the server returned, until one is `null`. Pass the SAME filters
 * on every call — a cursor is bound to the list and filters that issued it, and
 * replaying it with others is refused as `bad_request`:
 *
 * ```ts
 * for await (const place of iterateGoWayPages((cursor) => goway.places.nearby({ ...query, cursor }))) {
 *   render(place);
 * }
 * ```
 *
 * A cursor the server has already issued for this walk is a
 * {@link GoWayResponseError}, thrown after that page's items are yielded:
 * following it would loop forever, re-serving the same rows, and a consumer
 * that `for await`s a list is entitled to assume the loop ends. Break out of
 * the loop to stop early; nothing further is requested.
 */
export async function* iterateGoWayPages<T>(
  fetchPage: (cursor: string | undefined) => Promise<GoWayPageLike<T>>,
): AsyncGenerator<T, void, undefined> {
  if (typeof fetchPage !== 'function') throw new TypeError('iterateGoWayPages needs a function that fetches one page');
  const issued = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const page = await fetchPage(cursor);
    yield* page.items;
    const next: unknown = page.nextCursor;
    if (next === null) return;
    if (typeof next !== 'string' || next === '') {
      throw new GoWayResponseError('GoWay returned a page whose nextCursor is neither a cursor nor null');
    }
    if (issued.has(next)) {
      throw new GoWayResponseError('GoWay repeated a page cursor; following it would never end');
    }
    issued.add(next);
    cursor = next;
  }
}

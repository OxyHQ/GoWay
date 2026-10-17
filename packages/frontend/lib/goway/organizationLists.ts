/** Pure scheduling for an open organization list; the hooks live in `queries.ts`. */

/** How often an open list re-reads itself: every minute, and just after its next active entry ends. */
export const LIST_REFRESH_MS = 60_000;
/**
 * The delay before the next re-read. Expiry is decided by the server, so an
 * idle `active` view asks again 10 ms after its earliest entry ends.
 */
export function nextListRefreshMs(
  entries: readonly { endsAt: string }[],
  state: 'active' | 'all',
  now: number,
): number {
  if (state === 'all' || entries.length === 0) return LIST_REFRESH_MS;
  const end = Math.min(...entries.map((entry) => Date.parse(entry.endsAt)));
  return Math.min(LIST_REFRESH_MS, Math.max(1, end - now + 10));
}

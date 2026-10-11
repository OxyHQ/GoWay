/**
 * Whether this page asked for the route flyover and Camera Studio.
 *
 * The same two unequal ways in as the city-3D prototype (`city3dFlag.ts`):
 *
 *  - `EXPO_PUBLIC_MAP_FLYOVER=1` (`MAP_FLYOVER_ENABLED` in `lib/config.ts`): a
 *    BUILD decision. No production deployment sets it.
 *  - `?flyover=1` on the URL: a per-tab switch honoured ONLY in a development
 *    build (`__DEV__`), so a goway.to link cannot switch an experimental
 *    feature on for somebody else.
 *
 * Pure, with its inputs passed in, so "production ignores the query string" is
 * a test (`__tests__/flyoverFlag.test.ts`), not a comment.
 */
export function isFlyoverRequested(input: {
  /** `MAP_FLYOVER_ENABLED`. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('flyover');
  return value === '1' || value === 'true';
}

/**
 * Whether this page asked for the route flyover and Camera Studio.
 *
 * The same two unequal ways in as the city-3D prototype (`city3dFlag.ts`):
 *
 *  - `enabled`: the map-feature registry's answer (`mapFeatures.ts`) — the
 *    build's `EXPO_PUBLIC_MAP_FLYOVER`, then the person's own choice in the
 *    settings dialog's Labs section. No production deployment sets the variable.
 *  - `?flyover=1` on the URL: a per-tab switch honoured ONLY in a development
 *    build (`__DEV__`), so a goway.to link cannot switch an experimental
 *    feature on for somebody else.
 *
 * Pure, with its inputs passed in, so "production ignores the query string" is
 * a test (`__tests__/flyoverFlag.test.ts`), not a comment.
 */
export function isFlyoverRequested(input: {
  /** The registry's answer for `flyover` (`mapFeatures.ts`): build, then the person's choice. */
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

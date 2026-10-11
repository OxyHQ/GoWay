/**
 * Whether this page asked for the city-3D prototype.
 *
 * Two ways in, deliberately unequal:
 *
 *  - `EXPO_PUBLIC_MAP_CITY3D=1` (`MAP_CITY3D_ENABLED` in `lib/config.ts`): a
 *    BUILD decision. Every page of that build gets it. No production deployment
 *    sets it.
 *  - `?city3d=1` on the URL: a per-tab switch for looking at the prototype
 *    beside the shipped map without rebuilding — honoured ONLY in a
 *    development build (`__DEV__`), so a link cannot turn an experimental
 *    renderer on for somebody using goway.to.
 *
 * Pure, with its inputs passed in, so the "production ignores the query
 * string" rule is a test rather than a comment (`__tests__/city3dFlag.test.ts`).
 */
export function isCity3dRequested(input: {
  /** `MAP_CITY3D_ENABLED`. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('city3d');
  return value === '1' || value === 'true';
}

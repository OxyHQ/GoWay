/**
 * Whether this page asked for the 3D landmarks and their tour
 * (`docs/MAP_LANDMARKS.md`).
 *
 * The same two unequal ways in as the city-3D prototype (`city3dFlag.ts`):
 *
 *  - `EXPO_PUBLIC_MAP_LANDMARKS=1` (`MAP_LANDMARKS_ENABLED` in
 *    `lib/config.ts`): a BUILD decision. No production deployment sets it.
 *  - `?landmarks=1` on the URL: a per-tab switch honoured ONLY in a
 *    development build (`__DEV__`), so a goway.to link cannot switch an
 *    experimental renderer on for somebody else.
 *
 * Landmarks draw only inside the city-3D engine over GoWay city tiles; the
 * map adapter checks those two flags as well, so this alone draws nothing.
 * Pure, with its inputs passed in, so "production ignores the query string"
 * is a test (`__tests__/landmarksFlag.test.ts`), not a comment.
 */
export function isLandmarksRequested(input: {
  /** `MAP_LANDMARKS_ENABLED`. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('landmarks');
  return value === '1' || value === 'true';
}

/**
 * Whether this page asked for the 3D landmarks and their tour
 * (`docs/MAP_LANDMARKS.md`).
 *
 * The same two unequal ways in as the city-3D prototype (`city3dFlag.ts`):
 *
 *  - `enabled`: the map-feature registry's answer (`mapFeatures.ts`,
 *    `docs/MAP_FEATURES.md`) — the build's `EXPO_PUBLIC_MAP_LANDMARKS` (no
 *    production deployment sets it), then the person's choice in Labs.
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
  /** The registry's answer for `landmarks`. */
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

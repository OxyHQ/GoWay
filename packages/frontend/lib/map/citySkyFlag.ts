/**
 * Whether this page asked for the city layer's sky, atmosphere, sun shadows
 * and time-of-day scrubber.
 *
 * The same two ways in as `city3dFlag.ts`, deliberately unequal, plus one
 * precondition:
 *
 *  - `EXPO_PUBLIC_MAP_CITY_SKY=1` (`MAP_CITY_SKY_ENABLED` in `lib/config.ts`):
 *    a BUILD decision. No production deployment sets it.
 *  - `?citysky=1` on the URL: a per-tab switch, honoured ONLY in a development
 *    build (`__DEV__`), so a link cannot switch it on for somebody on goway.to.
 *  - **Both need the city-3D layer** (`isCity3dRequested`): the sky, the haze
 *    and the shadows are drawn by that layer, so without it there is nothing
 *    to switch on — and the answer is `false`, not a half-feature.
 *
 * Pure, with its inputs passed in, so these rules are a test
 * (`__tests__/citySkyFlag.test.ts`), not a comment.
 */
export function isCitySkyRequested(input: {
  /** `isCity3dRequested(…)` for this page. */
  city3d: boolean;
  /** `MAP_CITY_SKY_ENABLED`. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (!input.city3d) return false;
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('citysky');
  return value === '1' || value === 'true';
}

/**
 * The steepest tilt while the sky is on. The shipped map stops at 60°, where a
 * zoom-16 view never reaches the horizon (its top edge looks 78° from straight
 * down); at 80° the top tenth of the screen is sky.
 */
export const CITY_SKY_MAX_PITCH = 80;

/** The shipped ceiling: MapLibre's own and MapLibre Native's, which keeps the forks in step. */
export const DEFAULT_MAX_PITCH = 60;

/**
 * The map's pitch ceiling. ONE function, read by `MapCanvas.web.tsx`'s
 * interaction effect — the single owner of `setMaxPitch` — so a change to the
 * `interaction` prop can no longer drop a sky-lit map back to 60° while the
 * sky is still drawn (review of #125), and detaching the sky brings it back
 * to 60°. A map whose interaction forbids tilting stays at 0 either way.
 */
export function maxPitchFor(input: { pitchAllowed: boolean; skyActive: boolean }): number {
  if (!input.pitchAllowed) return 0;
  return input.skyActive ? CITY_SKY_MAX_PITCH : DEFAULT_MAX_PITCH;
}

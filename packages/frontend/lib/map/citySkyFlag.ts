/*
 * The city sky's pitch ceiling. Whether the sky draws is the map-feature
 * registry's `citySky` (`mapFeatures.ts`), which needs the 3D city.
 */

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

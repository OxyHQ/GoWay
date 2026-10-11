/**
 * Whether the city-3D layer also draws the city-life SIMULATION — cars and
 * people moving on the real street network (`docs/MAP_CITY_LIFE.md`).
 *
 * A refinement of the city-3D flag, never a way around it: the simulation is
 * drawn by the city-3D engine, so it requires that answer explicitly. It does
 * NOT need the city tiles: it drives on the compiled road archive where one
 * exists and on the basemap's own roads, healed, everywhere else
 * (`docs/MAP_CITY_LIFE.md` → "Worldwide").
 * Consulted only by the map-feature registry. Two ways
 * in, unequal exactly as `city3dFlag.ts`'s are:
 *
 *  - `EXPO_PUBLIC_MAP_CITY_LIFE=1`: a BUILD decision. No production deployment
 *    sets it.
 *  - `?cityLife=1`: per tab, honoured ONLY in a development build.
 *
 * Since the map-feature registry (`mapFeatures.ts`, `docs/MAP_FEATURES.md`)
 * the build switch is read there and `enabled` is the registry's answer (the
 * kill switch, then the person's choice in the settings modal's Labs — offered
 * only in a development build while nothing serves the road tiles); the
 * adapter is handed the result.
 */

export function isCityLifeRequested(input: {
  /** Whether the city-3D layer is on (`isCity3dRequested`). */
  city3d: boolean;
  /** The registry's answer for `cityLife` (`mapFeatures.ts`). */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (!input.city3d) return false;
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('cityLife');
  return value === '1' || value === 'true';
}

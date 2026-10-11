/**
 * Whether the city-3D layer also draws the city-life SIMULATION — cars and
 * people moving on the real street network (`docs/MAP_CITY_LIFE.md`).
 *
 * A refinement of the city-3D and city-tiles flags, never a way around them:
 * the simulation is drawn by the city-3D engine and drives on the road tiles
 * the city-tile compiler builds, so it requires both answers explicitly.
 * Consulted only by the lazily loaded adapter (`city3dLayer.web.ts`). Two ways
 * in, unequal exactly as `city3dFlag.ts`'s are:
 *
 *  - `EXPO_PUBLIC_MAP_CITY_LIFE=1`: a BUILD decision. No production deployment
 *    sets it.
 *  - `?cityLife=1`: per tab, honoured ONLY in a development build.
 *
 * The env read lives here, not in `lib/config.ts`, for the reason
 * `cityTilesFlag.ts` gives: this module is outside the first-paint bundle.
 */

/** `EXPO_PUBLIC_MAP_CITY_LIFE`, as a build switch. */
export const MAP_CITY_LIFE_ENABLED = /^(1|true)$/i.test(
  process.env.EXPO_PUBLIC_MAP_CITY_LIFE ?? '',
);

export function isCityLifeRequested(input: {
  /** Whether the city-3D layer is on (`isCity3dRequested`). */
  city3d: boolean;
  /** Whether it reads GoWay's city tiles (`isCityTilesRequested`). */
  cityTiles: boolean;
  /** {@link MAP_CITY_LIFE_ENABLED}. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (!input.city3d || !input.cityTiles) return false;
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('cityLife');
  return value === '1' || value === 'true';
}

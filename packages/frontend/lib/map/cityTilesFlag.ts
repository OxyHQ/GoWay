/**
 * Whether the city-3D layer reads GoWay's own per-building city tiles
 * (`docs/MAP_3D_CITY.md` → Phase 2) instead of OpenMapTiles' `building` layer.
 *
 * A refinement of the city-3D flag, never a way around it: the city tiles are
 * a SOURCE for the city layer, so this is only consulted by that layer's
 * adapter (`components/map/city3dLayer.web.ts`) — which only loads when
 * `?city3d=1` / `EXPO_PUBLIC_MAP_CITY3D` asked for it — and it also requires
 * the city-3D answer explicitly, so a caller cannot ask for one without the
 * other. Two ways in, unequal exactly as `city3dFlag.ts`'s are:
 *
 *  - `EXPO_PUBLIC_MAP_CITY_TILES=1`: a BUILD decision. No production
 *    deployment sets it, and none should until the Worker serves the tiles
 *    (the doc's "Hosting" lists what that takes).
 *  - `?cityTiles=1`: per tab, honoured ONLY in a development build.
 *
 * ## Why the env read is here and not in `lib/config.ts`
 *
 * `lib/config.ts` is in the first-paint bundle; this module is imported only
 * by the lazily loaded adapter. Reading the variable here keeps the flag-off
 * entry chunk byte-identical (measured; see the doc), at the cost of one
 * `EXPO_PUBLIC_*` read outside `config.ts`. It is a literal member read, which
 * is what Metro inlines and what `expo/no-dynamic-env-var` checks.
 */

/** `EXPO_PUBLIC_MAP_CITY_TILES`, as a build switch. */
export const MAP_CITY_TILES_ENABLED = /^(1|true)$/i.test(
  process.env.EXPO_PUBLIC_MAP_CITY_TILES ?? '',
);

export function isCityTilesRequested(input: {
  /** Whether the city-3D layer itself is on (`isCity3dRequested`). */
  city3d: boolean;
  /** {@link MAP_CITY_TILES_ENABLED}. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (!input.city3d) return false;
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('cityTiles');
  return value === '1' || value === 'true';
}

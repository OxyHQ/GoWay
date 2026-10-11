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
 *  - `EXPO_PUBLIC_MAP_CITY_TILES=1`: a BUILD decision (now the registry's
 *    `enabled`, which the layers panel can also turn on). No production
 *    deployment sets it, and none should until the Worker serves the tiles
 *    (the doc's "Hosting" lists what that takes).
 *  - `?cityTiles=1`: per tab, honoured ONLY in a development build.
 *
 * Since the map-feature registry (`mapFeatures.ts`, `docs/MAP_FEATURES.md`)
 * the build switch is read THERE, and `enabled` is the registry's answer —
 * the build's kill switch, then the person's choice in the layers panel, then
 * the build's default — in the place the build boolean used to be.
 */

export function isCityTilesRequested(input: {
  /** Whether the city-3D layer itself is on (`isCity3dRequested`). */
  city3d: boolean;
  /** The registry's answer for `cityTiles` (`mapFeatures.ts`). */
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

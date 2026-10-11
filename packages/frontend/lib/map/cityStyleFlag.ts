/**
 * Which LOOK the city-3D layer draws: `classic` (today's — MapLibre's
 * extrusion light on the 2D palette) or `detailed` (the art direction in
 * `lib/map/style/palette3d.ts`: clay buildings, a 3D-mode ground, a night
 * look). `docs/MAP_3D_CITY.md` → Art direction.
 *
 * A refinement of the city-3D flag, exactly as `cityTilesFlag.ts` is: only
 * the lazily loaded adapter (`components/map/city3dLayer.web.ts`) reads it,
 * and it requires the city-3D answer explicitly. Two ways in, unequal:
 *
 *  - `EXPO_PUBLIC_MAP_CITY_STYLE=detailed`: a BUILD decision. No production
 *    deployment sets it.
 *  - `?cityStyle=detailed` (or `classic`): per tab, honoured ONLY in a
 *    development build, so the two looks can be compared side by side.
 *
 * How much of NIGHT the look draws is not decided here: the engine's one
 * night seam (`lib/map/landmarks/night.ts`; the city sky's time of day).
 *
 * The env read is here, not in `lib/config.ts`, for the reason
 * `cityTilesFlag.ts` gives: `config.ts` is in the first-paint bundle.
 */

export type CityStyle = 'classic' | 'detailed';

/** `EXPO_PUBLIC_MAP_CITY_STYLE`, as a build switch. */
export const MAP_CITY_STYLE_BUILD: CityStyle = /^detailed$/i.test(
  process.env.EXPO_PUBLIC_MAP_CITY_STYLE ?? '',
)
  ? 'detailed'
  : 'classic';

export function cityStyleRequested(input: {
  /** Whether the city-3D layer itself is on (`isCity3dRequested`). */
  city3d: boolean;
  /** {@link MAP_CITY_STYLE_BUILD}. */
  build: CityStyle;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): CityStyle {
  if (!input.city3d) return 'classic';
  if (input.development) {
    const value = new URLSearchParams(input.search).get('cityStyle');
    if (value === 'detailed' || value === 'classic') return value;
  }
  return input.build;
}

/**
 * Whether the city-3D layer stands its stylised trees in the woods and parks
 * the tiles map (`components/map/engine/city3d/trees.ts`). Asked only once the
 * prototype itself is on (`city3dFlag.ts`).
 *
 * Its own module, imported only by the MapLibre adapter
 * (`components/map/city3dLayer.web.ts`), so it is part of the lazy city-3D
 * chunk and adds nothing to the first-paint bundle while the prototype is off
 * (measured with `expo export`; `components/__tests__/engine3dChunk.test.ts`
 * pins the import).
 *
 *  - `EXPO_PUBLIC_MAP_CITY3D_TREES=0` (or `false`): a BUILD without trees.
 *    Anything else, or unset, keeps them — they come with the prototype.
 *  - `?city3dTrees=0` on the URL: a per-tab switch for comparing the city
 *    with and without them, honoured ONLY in a development build, as
 *    `?city3d=1` is.
 *
 * The trees are styling, not mapped trees — see `docs/MAP_3D_CITY.md` →
 * "Trees". Pure, with its inputs passed in, so the rules are tests
 * (`__tests__/city3dTreesFlag.test.ts`).
 */

/** `EXPO_PUBLIC_MAP_CITY3D_TREES` is not `0`/`false`. */
export const MAP_CITY3D_TREES_ENABLED = !/^(0|false)$/i.test(
  process.env.EXPO_PUBLIC_MAP_CITY3D_TREES ?? '',
);

export function isCity3dTreesRequested(input: {
  /** `MAP_CITY3D_TREES_ENABLED`. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (!input.enabled) return false;
  if (!input.development) return true;
  const value = new URLSearchParams(input.search).get('city3dTrees');
  return value !== '0' && value !== 'false';
}

/** `EXPO_PUBLIC_MAP_CITY3D_TREE_FILL` is `1`/`true`. */
export const MAP_CITY3D_TREE_FILL_ENABLED = /^(1|true)$/i.test(
  process.env.EXPO_PUBLIC_MAP_CITY3D_TREE_FILL ?? '',
);

/**
 * Whether the trees include the STYLING fill of mapped woods
 * (`components/map/engine/city3d/trees.ts`) — off unless a build says
 * `EXPO_PUBLIC_MAP_CITY3D_TREE_FILL=1` or a DEVELOPMENT tab `?city3dTreeFill=1`.
 * By default the layer draws only the trees OpenStreetMap records (owner
 * decision: no trees where none are mapped).
 */
export function isCity3dTreeFillRequested(input: {
  enabled: boolean;
  development: boolean;
  search: string;
}): boolean {
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('city3dTreeFill');
  return value === '1' || value === 'true';
}

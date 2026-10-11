/**
 * Whether the city-3D layer stands its stylised trees in the woods and parks
 * the tiles map (`components/map/engine/city3d/trees.ts`). Asked only once the
 * prototype itself is on (`city3dFlag.ts`).
 *
 * Pure, and reached only from the map-feature registry (`mapFeatures.ts`,
 * `docs/MAP_FEATURES.md`), which reads the build variables and hands these
 * functions its answer as `enabled` — the build's kill switch, then the
 * person's choice in the settings modal's Labs, then the default. The adapter
 * (`components/map/city3dLayer.web.ts`) is given the result; it no longer
 * reads a flag (`components/__tests__/engine3dChunk.test.ts` pins both).
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

export function isCity3dTreesRequested(input: {
  /** The registry's answer for `city3dTrees` (on unless killed or switched off). */
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

/**
 * Whether the trees include the STYLING fill of mapped woods
 * (`components/map/engine/city3d/trees.ts`) — off unless a build says
 * `EXPO_PUBLIC_MAP_CITY3D_TREE_FILL=1`, the person turns it on in Labs, or a
 * DEVELOPMENT tab says `?city3dTreeFill=1`. `enabled` is the registry's answer.
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

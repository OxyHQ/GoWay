/**
 * Whether this page asked for the GoWay Live layer (`docs/MAP_LIVE.md`).
 *
 * The same two ways in as the city-3D prototype (`city3dFlag.ts`), and as
 * unequal:
 *
 *  - `EXPO_PUBLIC_MAP_LIVE=1`: a BUILD decision. No production deployment
 *    sets it.
 *  - `?live=1` on the URL: a per-tab switch, honoured ONLY in a development
 *    build (`__DEV__`), so a link cannot turn a third party's real-time feed on
 *    for somebody using goway.to.
 *
 * The env read lives HERE rather than in `lib/config.ts` so the whole gate is
 * one small module; everything the layer needs beyond it is loaded with
 * `import()` only once this answers `true`.
 */

/** `EXPO_PUBLIC_MAP_LIVE`, read statically so Metro inlines it. */
export const MAP_LIVE_ENABLED = /^(1|true)$/i.test(process.env.EXPO_PUBLIC_MAP_LIVE ?? '');

export function isLiveRequested(input: {
  /** {@link MAP_LIVE_ENABLED}. */
  enabled: boolean;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window. */
  search: string;
}): boolean {
  if (input.enabled) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get('live');
  return value === '1' || value === 'true';
}

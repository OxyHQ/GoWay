/**
 * Whether this page asked for the GoWay Live layer (`docs/MAP_LIVE.md`), given
 * the map-feature registry's answer (`mapFeatures.ts` → `live`: the
 * `EXPO_PUBLIC_MAP_LIVE` build switch and the person's choice).
 *
 * `?live=1` on the URL is a per-tab switch honoured ONLY in a development build
 * (`__DEV__`), so a link cannot turn a third party's real-time feed on for
 * somebody using goway.to.
 */
export function isLiveRequested(input: {
  /** The registry's answer for `live`. */
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

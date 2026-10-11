/**
 * Whether this page asked for the globe, or for terrain — the same two-door
 * rule as `city3dFlag.ts`, for the relief features of `docs/MAP_TERRAIN_GLOBE.md`.
 *
 *  - `EXPO_PUBLIC_MAP_GLOBE=1` / `EXPO_PUBLIC_MAP_TERRAIN=1` (`lib/config.ts`):
 *    a BUILD decision. Every page of that build gets it. No production
 *    deployment sets either.
 *  - `?globe=1` / `?terrain=1` on the URL: a per-tab switch for looking at the
 *    prototype beside the shipped map without rebuilding — honoured ONLY in a
 *    development build (`__DEV__`), so a link cannot turn an experimental
 *    renderer on for somebody using goway.to.
 *
 * Pure, with its inputs passed in, so "production ignores the query string" is
 * a test rather than a comment (`__tests__/reliefFlag.test.ts`).
 */

/**
 * Every source and layer the relief prototype adds starts with this, so the
 * map adapter can recognise one of its errors without importing the relief
 * module (which is a lazy chunk; see `lib/map/style/relief.ts`).
 */
export const RELIEF_ID_PREFIX = 'goway:relief:';

/** Is this a source or layer the relief prototype added? */
export function isReliefId(id: string | undefined): boolean {
  return typeof id === 'string' && id.startsWith(RELIEF_ID_PREFIX);
}

/** The relief features a page can ask for. */
export type ReliefFeature = 'globe' | 'terrain';

export interface ReliefFlagInput {
  /** `MAP_GLOBE_ENABLED` / `MAP_TERRAIN_ENABLED` from `lib/config.ts`. */
  enabled: Readonly<Record<ReliefFeature, boolean>>;
  /** `__DEV__`. */
  development: boolean;
  /** `window.location.search`, or `''` where there is no window (native). */
  search: string;
}

/** What this page draws: each feature on or off, decided once per load. */
export type ReliefFlags = Readonly<Record<ReliefFeature, boolean>>;

function requested(input: ReliefFlagInput, feature: ReliefFeature): boolean {
  if (input.enabled[feature]) return true;
  if (!input.development) return false;
  const value = new URLSearchParams(input.search).get(feature);
  return value === '1' || value === 'true';
}

export function resolveReliefFlags(input: ReliefFlagInput): ReliefFlags {
  return { globe: requested(input, 'globe'), terrain: requested(input, 'terrain') };
}

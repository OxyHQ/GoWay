/**
 * The relief features this page draws — globe and terrain — decided ONCE per
 * page load from the build flags and, in a development build, the URL
 * (`lib/map/reliefFlag.ts`). Read by both `MapCanvas` forks and by
 * `MapAttribution`, so the map and its credit can never disagree about whether
 * elevation data is on screen.
 *
 * Native has no URL, so only the build flags reach it there.
 */
import { MAP_GLOBE_ENABLED, MAP_TERRAIN_ENABLED } from '@/lib/config';
import { type ReliefFlags, resolveReliefFlags } from '@/lib/map/reliefFlag';

export const MAP_RELIEF: ReliefFlags = resolveReliefFlags({
  enabled: { globe: MAP_GLOBE_ENABLED, terrain: MAP_TERRAIN_ENABLED },
  development: __DEV__,
  search: typeof window !== 'undefined' && window.location ? window.location.search : '',
});

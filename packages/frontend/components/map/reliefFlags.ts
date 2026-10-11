/**
 * The relief features this page draws — globe and terrain — as the map-feature
 * registry decides them (`lib/map/mapFeatures.ts`: the build's kill switch,
 * the person's choice in the settings dialog, the default, and in a development
 * build the URL, `lib/map/reliefFlag.ts`). Read by both `MapCanvas` forks and
 * by `MapAttribution`, so the map and its credit can never disagree about
 * whether elevation data is on screen — and both follow a toggle live.
 *
 * Native has no URL, so only the build and the person's choice reach it there.
 */
import { useMemo } from 'react';

import type { ReliefFlags } from '@/lib/map/reliefFlag';
import { mapFeatureOn, useMapFeatures } from '@/lib/map/useMapFeatures';

/** The relief this page draws, live. */
export function useMapRelief(): ReliefFlags {
  const { features } = useMapFeatures();
  const globe = features.on('globe');
  const terrain = features.on('terrain');
  return useMemo(() => ({ globe, terrain }), [globe, terrain]);
}

/** The same, read once — for preloading the relief chunk before the first frame. */
export function initialMapRelief(): ReliefFlags {
  return { globe: mapFeatureOn('globe'), terrain: mapFeatureOn('terrain') };
}

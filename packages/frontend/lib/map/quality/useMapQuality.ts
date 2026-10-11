/**
 * The map's live quality profile (`profile.ts`), for the map and its chrome:
 * the person's Settings → Performance choice and what this device's GPU
 * measured (both kept by the map-feature store, `lib/map/mapFeatureStore.ts`),
 * resolved for this device class.
 *
 * In a development build `?quality=low|medium|high` forces a preset — the
 * benchmark's switch (`scripts/bench-map.ts`); a production build ignores it,
 * as it ignores every map query flag.
 */
import { useMemo } from 'react';

import { mapFeatureStore, useMapFeatures } from '../useMapFeatures';
import { currentDeviceClass } from './deviceClass';
import {
  type QualityProfile,
  type QualityTier,
  QUALITY_PRESETS,
  qualityFromSearch,
  resolveQuality,
} from './profile';

const FORCED = qualityFromSearch(
  typeof window !== 'undefined' && window.location ? window.location.search : '',
  typeof __DEV__ !== 'undefined' && __DEV__,
);

function resolve(
  performance: Parameters<typeof resolveQuality>[0]['mode'],
  gpu: QualityTier | null,
) {
  if (FORCED) return { ...QUALITY_PRESETS[FORCED], reason: `forced by ?quality=${FORCED}` };
  return resolveQuality({ mode: performance, device: currentDeviceClass(), gpuTier: gpu });
}

/** The profile now, outside React (the map's construction options). */
export function mapQualityNow(): QualityProfile {
  const { performance, gpu } = mapFeatureStore.getSnapshot();
  return resolve(performance, gpu?.tier ?? null);
}

/** The profile, live: a Settings change or a finished GPU benchmark re-renders. */
export function useMapQuality(): QualityProfile {
  const { performance, gpu } = useMapFeatures();
  const tier = gpu?.tier ?? null;
  return useMemo(() => resolve(performance, tier), [performance, tier]);
}

/**
 * The app's ONE map-feature store, and the hooks the map and its chrome read
 * it through (`docs/MAP_FEATURES.md`).
 *
 * Read `useMapFeature('<id>')` in a component — it re-renders when the answer
 * changes, which is how a toggle in the layers panel reaches the map without
 * a reload. `mapFeatureOn('<id>')` is the same answer read once, for the rare
 * module-level decision (preloading a chunk before the first frame).
 */
import { useSyncExternalStore } from 'react';

import { MAP_PLATFORM, mapFeatureStorage } from './mapFeatureStorage';
import { createMapFeatureStore, type MapFeatureSnapshot } from './mapFeatureStore';
import { MAP_FEATURES, type MapFeatureId } from './mapFeatures';

export const mapFeatureStore = createMapFeatureStore({
  features: MAP_FEATURES,
  storage: mapFeatureStorage,
  platform: MAP_PLATFORM,
  development: __DEV__,
  // Native has a `window` without a `location`.
  search: typeof window !== 'undefined' && window.location ? window.location.search : '',
});

/** Everything: every feature's state, whether Labs shows, whether choices are loaded. */
export function useMapFeatures(): MapFeatureSnapshot {
  return useSyncExternalStore(
    mapFeatureStore.subscribe,
    mapFeatureStore.getSnapshot,
    mapFeatureStore.getSnapshot,
  );
}

/** Whether one feature draws on this page, live. */
export function useMapFeature(id: MapFeatureId): boolean {
  return useMapFeatures().features.on(id);
}

/** The same answer, read once, outside React. */
export function mapFeatureOn(id: MapFeatureId): boolean {
  return mapFeatureStore.getSnapshot().features.on(id);
}

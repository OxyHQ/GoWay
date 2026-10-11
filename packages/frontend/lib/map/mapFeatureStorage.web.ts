/**
 * Web: the map-feature document in `localStorage`, read SYNCHRONOUSLY so the
 * first frame already honours a stored choice. Every access is guarded — a
 * private window, blocked site data or a missing `window` (static rendering)
 * throws or has nothing, and the store then keeps the defaults.
 */
import { MAP_FEATURES_STORAGE_KEY, type MapFeatureStorage } from './mapFeatureStore';
import type { MapPlatform } from './mapFeatures';

export const MAP_PLATFORM: MapPlatform = 'web';

export const mapFeatureStorage: MapFeatureStorage = {
  load() {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(MAP_FEATURES_STORAGE_KEY);
  },
  save(value) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(MAP_FEATURES_STORAGE_KEY, value);
  },
};

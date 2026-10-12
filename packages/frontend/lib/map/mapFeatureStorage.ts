/**
 * Native: the map-feature document in AsyncStorage, the device's own app
 * storage. Asynchronous, so the map draws the registry's defaults for the moment
 * before it answers (`mapFeatureStore.ts`). The web fork is
 * `mapFeatureStorage.web.ts`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

import { MAP_FEATURES_STORAGE_KEY, type MapFeatureStorage } from './mapFeatureStore';
import type { MapPlatform } from './mapFeatures';

export const MAP_PLATFORM: MapPlatform = Platform.OS === 'android' ? 'android' : 'ios';

export const mapFeatureStorage: MapFeatureStorage = {
  load: () => AsyncStorage.getItem(MAP_FEATURES_STORAGE_KEY),
  save: (value) => AsyncStorage.setItem(MAP_FEATURES_STORAGE_KEY, value),
};

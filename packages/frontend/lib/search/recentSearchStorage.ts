/** Native: the recent searches in AsyncStorage. The web fork is `recentSearchStorage.web.ts`. */
import AsyncStorage from '@react-native-async-storage/async-storage';

import { RECENT_SEARCHES_STORAGE_KEY, type RecentSearchStorage } from './recentSearches';

export const recentSearchStorage: RecentSearchStorage = {
  load: () => AsyncStorage.getItem(RECENT_SEARCHES_STORAGE_KEY),
  save: (value) => AsyncStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, value),
};

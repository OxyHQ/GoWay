import { useSyncExternalStore } from 'react';

import { createRecentSearchStore } from './recentSearches';
import { recentSearchStorage } from './recentSearchStorage';

/** The app's one store. Created on first import; hydrates from the device. */
export const recentSearches = createRecentSearchStore(recentSearchStorage);

/** The recent searches, newest first, and how to add to or clear them. */
export function useRecentSearches() {
  const list = useSyncExternalStore(
    recentSearches.subscribe,
    recentSearches.getSnapshot,
    recentSearches.getSnapshot,
  );
  return { recent: list, add: recentSearches.add, clear: recentSearches.clear };
}

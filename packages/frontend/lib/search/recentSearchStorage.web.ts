/**
 * Web: the recent searches in `localStorage`, read synchronously so the first
 * frame already has them. A private window, blocked site data or a missing
 * `window` (static rendering) throws or has nothing; the store then starts empty.
 */
import { RECENT_SEARCHES_STORAGE_KEY, type RecentSearchStorage } from './recentSearches';

export const recentSearchStorage: RecentSearchStorage = {
  load() {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(RECENT_SEARCHES_STORAGE_KEY);
  },
  save(value) {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(RECENT_SEARCHES_STORAGE_KEY, value);
  },
};

/**
 * The searches a person ran lately, kept on THIS DEVICE only.
 *
 * Text and nothing else: no coordinate, no result, no account. Nothing is sent
 * anywhere and no server learns it, the same stance as the map settings
 * (`lib/map/mapFeatureStore.ts`). Storage is a convenience, never a
 * dependency: a store that throws or holds garbage leaves the list empty, and a
 * search that cannot be saved still ran.
 *
 * The factory takes its storage so hydration order and failure are tests
 * (`__tests__/recentSearches.test.ts`); the app's one instance is
 * `useRecentSearches.ts`.
 */

export const RECENT_SEARCHES_STORAGE_KEY = 'goway.recentSearches';
export const MAX_RECENT_SEARCHES = 8;
/** Shorter than this is not a search (the API refuses it as well). */
const MIN_RECENT_LENGTH = 2;
const MAX_RECENT_LENGTH = 80;

/** Where the list is kept. Either method may throw or reject. */
export interface RecentSearchStorage {
  load(): string | null | Promise<string | null>;
  save(value: string): void | Promise<void>;
}

const keyOf = (query: string): string => query.normalize('NFC').toLocaleLowerCase();

const tidy = (query: string): string =>
  query.trim().replace(/\s+/g, ' ').slice(0, MAX_RECENT_LENGTH);

/** The stored document as a list, or `[]` for anything that is not one. */
export function parseRecentSearches(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const list: string[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'string') continue;
      const search = tidy(entry);
      if (search.length < MIN_RECENT_LENGTH) continue;
      if (list.some((known) => keyOf(known) === keyOf(search))) continue;
      list.push(search);
      if (list.length === MAX_RECENT_SEARCHES) break;
    }
    return list;
  } catch {
    return [];
  }
}

/** `list` with `query` first, once, and the list capped. Unchanged if `query` is unusable. */
export function withRecentSearch(list: readonly string[], query: string): string[] {
  const search = tidy(query);
  if (search.length < MIN_RECENT_LENGTH) return [...list];
  const key = keyOf(search);
  return [search, ...list.filter((entry) => keyOf(entry) !== key)].slice(0, MAX_RECENT_SEARCHES);
}

export interface RecentSearchStore {
  getSnapshot(): readonly string[];
  subscribe(listener: () => void): () => void;
  add(query: string): void;
  clear(): void;
}

const NONE: readonly string[] = [];

export function createRecentSearchStore(storage: RecentSearchStorage): RecentSearchStore {
  let current: readonly string[] = NONE;
  /** Set once the user changed the list, so a late hydration cannot overwrite it. */
  let touched = false;
  const listeners = new Set<() => void>();

  const publish = (next: readonly string[]) => {
    current = next;
    for (const listener of listeners) listener();
  };

  const persist = () => {
    try {
      void Promise.resolve(storage.save(JSON.stringify(current))).catch(() => undefined);
    } catch {
      // Not saved; it still applies to this session.
    }
  };

  const hydrate = (raw: string | null) => {
    if (touched) return;
    const list = parseRecentSearches(raw);
    if (list.length > 0) publish(list);
  };

  try {
    const loaded = storage.load();
    if (loaded instanceof Promise) loaded.then(hydrate, () => undefined);
    else hydrate(loaded);
  } catch {
    // Nothing stored that we can read: start empty.
  }

  return {
    getSnapshot: () => current,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    add(query) {
      const next = withRecentSearch(current, query);
      touched = true;
      if (
        next.length === current.length &&
        next.every((entry, index) => entry === current[index])
      ) {
        return;
      }
      publish(next);
      persist();
    },
    clear() {
      touched = true;
      if (current.length === 0) return;
      publish(NONE);
      persist();
    },
  };
}

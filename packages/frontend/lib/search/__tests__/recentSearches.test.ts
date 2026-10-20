import { describe, expect, test } from 'bun:test';

import {
  createRecentSearchStore,
  MAX_RECENT_SEARCHES,
  parseRecentSearches,
  type RecentSearchStorage,
  withRecentSearch,
} from '../recentSearches';

function memoryStorage(initial: string | null = null) {
  const saved: string[] = [];
  const storage: RecentSearchStorage = {
    load: () => initial,
    save: (value) => {
      saved.push(value);
    },
  };
  return { storage, saved };
}

describe('withRecentSearch', () => {
  test('puts the newest first and keeps each search once, ignoring case', () => {
    expect(withRecentSearch(['pizza', 'Café'], 'CAFÉ')).toEqual(['CAFÉ', 'pizza']);
  });

  test('ignores a search too short to run, and trims', () => {
    expect(withRecentSearch(['a b'], 'x')).toEqual(['a b']);
    expect(withRecentSearch([], '  farmacia   lopez ')).toEqual(['farmacia lopez']);
  });

  test('caps the list', () => {
    let list: string[] = [];
    for (let index = 0; index < MAX_RECENT_SEARCHES + 3; index += 1) {
      list = withRecentSearch(list, `search ${index}`);
    }
    expect(list).toHaveLength(MAX_RECENT_SEARCHES);
    expect(list[0]).toBe(`search ${MAX_RECENT_SEARCHES + 2}`);
  });
});

describe('parseRecentSearches', () => {
  test('keeps the stored order and drops anything that is not a search', () => {
    expect(parseRecentSearches(JSON.stringify(['b b', 'a a', 1, null, 'b b']))).toEqual([
      'b b',
      'a a',
    ]);
  });

  test('reads garbage as empty', () => {
    expect(parseRecentSearches('{nope')).toEqual([]);
    expect(parseRecentSearches('{"a":1}')).toEqual([]);
    expect(parseRecentSearches(null)).toEqual([]);
  });
});

describe('createRecentSearchStore', () => {
  test('hydrates from storage and saves changes', () => {
    const { storage, saved } = memoryStorage(JSON.stringify(['old one']));
    const store = createRecentSearchStore(storage);
    expect(store.getSnapshot()).toEqual(['old one']);

    store.add('new one');
    expect(store.getSnapshot()).toEqual(['new one', 'old one']);
    expect(JSON.parse(saved.at(-1) ?? '[]')).toEqual(['new one', 'old one']);

    store.clear();
    expect(store.getSnapshot()).toEqual([]);
  });

  test('notifies subscribers only on a real change', () => {
    const { storage } = memoryStorage();
    const store = createRecentSearchStore(storage);
    let calls = 0;
    const unsubscribe = store.subscribe(() => {
      calls += 1;
    });
    store.add('pizza');
    store.add('pizza');
    expect(calls).toBe(1);
    unsubscribe();
    store.add('sushi');
    expect(calls).toBe(1);
  });

  test('a late native hydration cannot overwrite what was typed meanwhile', async () => {
    let resolve: (value: string | null) => void = () => undefined;
    const storage: RecentSearchStorage = {
      load: () => new Promise((done) => (resolve = done)),
      save: () => undefined,
    };
    const store = createRecentSearchStore(storage);
    store.add('typed first');
    resolve(JSON.stringify(['stale']));
    await Promise.resolve();
    expect(store.getSnapshot()).toEqual(['typed first']);
  });

  test('survives a storage that throws', () => {
    const store = createRecentSearchStore({
      load: () => {
        throw new Error('blocked');
      },
      save: () => {
        throw new Error('blocked');
      },
    });
    store.add('still works');
    expect(store.getSnapshot()).toEqual(['still works']);
  });
});

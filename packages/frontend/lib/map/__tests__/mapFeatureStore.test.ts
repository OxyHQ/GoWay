/**
 * The map-feature store: choices persist on the device, storage is a
 * convenience and never a dependency (a store that throws, rejects or holds
 * garbage leaves the defaults), `?labs=` reveals and hides Labs in any build,
 * and a choice made before native storage answers is not overwritten by it.
 */
import { describe, expect, test } from 'bun:test';

import {
  createMapFeatureStore,
  labsFromSearch,
  type MapFeatureStorage,
  NO_PREFERENCES,
  parsePreferences,
  serializePreferences,
} from '@/lib/map/mapFeatureStore';
import { MAP_FEATURES, type MapFeatureDefinition } from '@/lib/map/mapFeatures';

const FEATURES: MapFeatureDefinition[] = MAP_FEATURES.map((feature) => ({
  ...feature,
  build: undefined,
}));
const IDS = new Set(FEATURES.map((feature) => feature.id));

function memoryStorage(initial: string | null = null) {
  const saved: string[] = [];
  const storage: MapFeatureStorage = {
    load: () => initial,
    save: (value) => {
      saved.push(value);
    },
  };
  return { storage, saved };
}

function store(
  storage: MapFeatureStorage,
  overrides: Partial<{ search: string; features: MapFeatureDefinition[] }> = {},
) {
  const errors: string[] = [];
  const instance = createMapFeatureStore({
    features: overrides.features ?? FEATURES,
    storage,
    platform: 'web',
    development: false,
    search: overrides.search ?? '',
    onStorageError: (operation) => errors.push(operation),
  });
  return { instance, errors };
}

/** Let pending promise callbacks run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('persistence', () => {
  test('a choice is saved, and read back by the next page', () => {
    const first = memoryStorage();
    const { instance } = store(first.storage);
    instance.setChoice('city3d', true);
    expect(instance.getSnapshot().features.on('city3d')).toBe(true);
    expect(first.saved).toHaveLength(1);

    const second = memoryStorage(first.saved[0]);
    const { instance: next } = store(second.storage);
    expect(next.getSnapshot().features.on('city3d')).toBe(true);
    // A plain read writes nothing back.
    expect(second.saved).toHaveLength(0);
  });

  test('choosing what the build decides anyway forgets the choice', () => {
    const { storage, saved } = memoryStorage();
    const { instance } = store(storage);
    instance.setChoice('globe', false);
    expect(instance.getSnapshot().features.get('globe').choice).toBe(false);
    instance.setChoice('globe', true);
    expect(instance.getSnapshot().features.get('globe').choice).toBeNull();
    expect(JSON.parse(saved.at(-1) ?? '{}').choices).toEqual({});
  });

  test('a killed feature cannot be chosen', () => {
    const { storage, saved } = memoryStorage();
    const features = FEATURES.map((feature) =>
      feature.id === 'city3d' ? { ...feature, build: '0' } : feature,
    );
    const { instance } = store(storage, { features });
    instance.setChoice('city3d', true);
    expect(instance.getSnapshot().features.on('city3d')).toBe(false);
    expect(saved).toHaveLength(0);
  });

  test('an unknown id is ignored', () => {
    const { storage, saved } = memoryStorage();
    const { instance } = store(storage);
    instance.setChoice('teleport', true);
    expect(saved).toHaveLength(0);
  });

  test('listeners hear every change, and stop when unsubscribed', () => {
    const { instance } = store(memoryStorage().storage);
    let heard = 0;
    const unsubscribe = instance.subscribe(() => heard++);
    const before = instance.getSnapshot();
    instance.setChoice('flyover', true);
    expect(heard).toBe(1);
    expect(instance.getSnapshot()).not.toBe(before);
    unsubscribe();
    instance.setChoice('flyover', false);
    expect(heard).toBe(1);
  });
});

describe('storage failures keep the defaults', () => {
  test('load throws', () => {
    const { instance, errors } = store({
      load: () => {
        throw new Error('SecurityError: localStorage is disabled');
      },
      save: () => {},
    });
    const snapshot = instance.getSnapshot();
    expect(snapshot.hydrated).toBe(true);
    expect(snapshot.features.on('globe')).toBe(true);
    expect(snapshot.features.on('city3d')).toBe(false);
    expect(errors).toEqual(['load']);
  });

  test('save throws: the choice still applies to this session', () => {
    const { instance, errors } = store({
      load: () => null,
      save: () => {
        throw new Error('QuotaExceededError');
      },
    });
    instance.setChoice('city3d', true);
    expect(instance.getSnapshot().features.on('city3d')).toBe(true);
    expect(errors).toEqual(['save']);
  });

  test('async load rejects, async save rejects', async () => {
    const { instance, errors } = store({
      load: () => Promise.reject(new Error('AsyncStorage unavailable')),
      save: () => Promise.reject(new Error('disk full')),
    });
    expect(instance.getSnapshot().hydrated).toBe(false);
    await settle();
    expect(instance.getSnapshot().hydrated).toBe(true);
    instance.setChoice('flyover', true);
    expect(instance.getSnapshot().features.on('flyover')).toBe(true);
    await settle();
    expect(errors).toEqual(['load', 'save']);
  });

  test('garbage in storage', () => {
    for (const raw of ['not json', '[]', 'null', '42', '{"v":2,"choices":{"city3d":true}}']) {
      const { instance } = store(memoryStorage(raw).storage);
      expect(instance.getSnapshot().features.on('city3d')).toBe(false);
    }
  });
});

describe('native: storage answers later', () => {
  test('defaults until it answers, then the stored choices', async () => {
    let answer: (value: string | null) => void = () => {};
    const { instance } = store({
      load: () => new Promise((resolve) => (answer = resolve)),
      save: () => {},
    });
    expect(instance.getSnapshot().hydrated).toBe(false);
    expect(instance.getSnapshot().features.on('terrain')).toBe(true);
    let heard = 0;
    instance.subscribe(() => heard++);
    answer(serializePreferences({ choices: { terrain: false }, labs: true }));
    await settle();
    expect(instance.getSnapshot().hydrated).toBe(true);
    expect(instance.getSnapshot().features.on('terrain')).toBe(false);
    expect(instance.getSnapshot().labs).toBe(true);
    expect(heard).toBe(1);
  });

  test('a choice made before it answers wins over the older stored one', async () => {
    let answer: (value: string | null) => void = () => {};
    const saved: string[] = [];
    const { instance } = store({
      load: () => new Promise((resolve) => (answer = resolve)),
      save: (value) => {
        saved.push(value);
      },
    });
    instance.setChoice('city3d', true);
    expect(saved).toHaveLength(0);
    answer(serializePreferences({ choices: { city3d: false, flyover: true }, labs: false }));
    await settle();
    const { features } = instance.getSnapshot();
    expect(features.on('city3d')).toBe(true);
    expect(features.on('flyover')).toBe(true);
    expect(JSON.parse(saved.at(-1) ?? '{}').choices).toEqual({ city3d: true, flyover: true });
  });
});

describe('Labs', () => {
  test('hidden until asked for', () => {
    expect(store(memoryStorage().storage).instance.getSnapshot().labs).toBe(false);
  });

  test('`?labs=1` reveals it, in any build, and is remembered', () => {
    const first = memoryStorage();
    const { instance } = store(first.storage, { search: '?labs=1' });
    expect(instance.getSnapshot().labs).toBe(true);
    // Revealing Labs switches nothing on.
    for (const state of instance.getSnapshot().features.list) {
      if (state.tier === 'labs') expect(state.on).toBe(false);
    }
    const { instance: later } = store(memoryStorage(first.saved[0]).storage);
    expect(later.getSnapshot().labs).toBe(true);
  });

  test('`?labs=0` hides it again', () => {
    const stored = serializePreferences({ choices: {}, labs: true });
    const { instance } = store(memoryStorage(stored).storage, { search: '?labs=0' });
    expect(instance.getSnapshot().labs).toBe(false);
  });

  test('setLabs', () => {
    const { storage, saved } = memoryStorage();
    const { instance } = store(storage);
    instance.setLabs(true);
    expect(instance.getSnapshot().labs).toBe(true);
    expect(JSON.parse(saved.at(-1) ?? '{}').labs).toBe(true);
  });

  test('labsFromSearch', () => {
    expect(labsFromSearch('')).toBeNull();
    expect(labsFromSearch('?labs=true')).toBe(true);
    expect(labsFromSearch('?a=b&labs=false')).toBe(false);
    expect(labsFromSearch('?labs=yes')).toBeNull();
  });
});

describe('parsePreferences', () => {
  test('keeps only known ids with boolean values', () => {
    const raw = JSON.stringify({
      v: 1,
      choices: { city3d: true, globe: 'no', teleport: true },
      labs: 'yes',
    });
    expect(parsePreferences(raw, IDS)).toEqual({ choices: { city3d: true }, labs: false });
    expect(parsePreferences(null, IDS)).toBe(NO_PREFERENCES);
  });
});

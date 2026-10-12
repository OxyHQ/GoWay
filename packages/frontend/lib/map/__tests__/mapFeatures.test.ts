/**
 * The map-feature registry: a person decides (their choice, else the
 * registry's default), a development page's address may override for one tab,
 * a dependency that is off switches its dependants off, and what the panel
 * offers depends on the platform and on whether production can serve it. No
 * build variable takes part in any of it.
 */
import { describe, expect, test } from 'bun:test';

import {
  MAP_FEATURES,
  type MapFeatureDefinition,
  type MapPlatform,
  pageOverride,
  resolveMapFeatures,
} from '@/lib/map/mapFeatures';

function resolve(
  options: {
    choices?: Record<string, boolean>;
    platform?: MapPlatform;
    development?: boolean;
    search?: string;
  } = {},
) {
  return resolveMapFeatures({
    features: MAP_FEATURES,
    choices: options.choices ?? {},
    platform: options.platform ?? 'web',
    development: options.development ?? false,
    search: options.search ?? '',
  });
}

const FEATURES = MAP_FEATURES as readonly MapFeatureDefinition[];

describe('the registry', () => {
  test('ids are unique, and every dependency comes earlier', () => {
    const seen = new Set<string>();
    for (const feature of FEATURES) {
      expect(seen.has(feature.id)).toBe(false);
      for (const dependency of feature.requires) expect(seen.has(dependency)).toBe(true);
      seen.add(feature.id);
    }
  });

  test('query parameters are unique', () => {
    const queries = FEATURES.flatMap((feature) => (feature.query ? [feature.query] : []));
    expect(new Set(queries).size).toBe(queries.length);
  });

  test('defaults: globe, terrain and Street 3D on, everything else off', () => {
    const features = resolve();
    expect(features.list.map((state) => [state.id, state.on])).toEqual([
      ['globe', true],
      ['terrain', true],
      ['street3d', true],
      ['city3d', false],
      ['citySky', false],
      ['detailedCity', false],
      ['cityTiles', false],
      ['city3dTrees', false],
      ['city3dTreeFill', false],
      ['cityLife', false],
      ['cityStreets', false],
      ['landmarks', false],
      ['live', false],
      ['flyover', false],
    ]);
    // Nothing new is on by default: every Labs feature starts off. (The trees
    // default on, but only with the 3D city, which is off.)
    for (const state of features.list) if (state.tier === 'labs') expect(state.on).toBe(false);
    for (const state of features.list) expect(state.source).toBe('default');
  });

  test('a production build answers the same with any address: defaults, then choices', () => {
    const searches = ['', '?city3d=1', '?globe=0&terrain=0', '?live=1', '?citysky=1&city3d=1'];
    for (const search of searches) {
      expect(resolve({ search }).list.map((state) => state.on)).toEqual(
        resolve().list.map((state) => state.on),
      );
    }
  });

  test('a dependency that is not earlier in the registry is a loud error', () => {
    expect(() =>
      resolveMapFeatures({
        features: [
          {
            id: 'a',
            section: 'layers',
            tier: 'labs',
            defaultOn: true,
            requires: ['b'],
            platforms: ['web'],
          },
        ],
        choices: {},
        platform: 'web',
        development: false,
        search: '',
      }),
    ).toThrow(/"b"/);
  });
});

describe('the person decides', () => {
  test('a choice beats the default, either way', () => {
    const chosen = resolve({ choices: { city3d: true, globe: false } });
    expect(chosen.on('city3d')).toBe(true);
    expect(chosen.get('city3d').source).toBe('choice');
    expect(chosen.on('globe')).toBe(false);
    expect(chosen.get('globe').baseline).toBe(true);
  });

  test('a stored value that is not a boolean is no choice', () => {
    const choices = { city3d: 'yes' } as unknown as Record<string, boolean>;
    expect(resolve({ choices }).get('city3d').choice).toBeNull();
    expect(resolve({ choices }).on('city3d')).toBe(false);
  });

  test('a choice also reaches a feature the panel does not offer in this build', () => {
    // How the benchmark switches production-unserved features on: it stores
    // the choices the panel would (`scripts/bench-map.ts`).
    const features = resolve({ choices: { city3d: true, cityTiles: true } });
    expect(features.get('cityTiles').available).toBe(false);
    expect(features.on('cityTiles')).toBe(true);
  });
});

describe('a development page’s address', () => {
  test('`1`/`true` turns a feature on, `0`/`false` off, over the choice', () => {
    const on = resolve({ development: true, search: '?city3d=1', choices: { city3d: false } });
    expect(on.on('city3d')).toBe(true);
    expect(on.get('city3d').source).toBe('page');

    const off = resolve({ development: true, search: '?globe=false&terrain=0' });
    expect(off.on('globe')).toBe(false);
    expect(off.on('terrain')).toBe(false);
    expect(off.get('globe').source).toBe('page');

    const trees = resolve({ development: true, search: '?city3d=1&city3dTrees=0' });
    expect(trees.on('city3d')).toBe(true);
    expect(trees.on('city3dTrees')).toBe(false);
  });

  test('an address that agrees with the answer is not the reason for it', () => {
    const features = resolve({ development: true, search: '?globe=1' });
    expect(features.get('globe').source).toBe('default');
  });

  test('every feature with a query parameter answers to it', () => {
    for (const feature of FEATURES) {
      if (!feature.query) continue;
      const search = `?${feature.query}=${feature.defaultOn ? '0' : '1'}`;
      const state = resolve({
        development: true,
        // Anything it needs (the city, at the root of every chain) is on, so
        // only the parameter decides.
        choices: Object.fromEntries(
          [...feature.requires, 'city3d'].filter((id) => id !== feature.id).map((id) => [id, true]),
        ),
        search,
      }).get(feature.id);
      expect([feature.id, state.on]).toEqual([feature.id, !feature.defaultOn]);
    }
  });

  test('anything but 1/true/0/false says nothing', () => {
    for (const value of ['', 'yes', 'on', '2', 'TRUE']) {
      expect(pageOverride('city3d', { development: true, search: `?city3d=${value}` })).toBeNull();
    }
    expect(pageOverride('city3d', { development: true, search: '?xcity3d=1' })).toBeNull();
    expect(pageOverride(undefined, { development: true, search: '?street3d=0' })).toBeNull();
    expect(pageOverride('city3d', { development: false, search: '?city3d=1' })).toBeNull();
  });

  test('the sky keeps its lower-case parameter', () => {
    const features = resolve({ development: true, search: '?city3d=1&citysky=1' });
    expect(features.on('citySky')).toBe(true);
  });
});

describe('dependencies', () => {
  test('city tiles need the 3D city', () => {
    const blocked = resolve({ development: true, choices: { cityTiles: true } });
    expect(blocked.on('cityTiles')).toBe(false);
    expect(blocked.get('cityTiles').blockedBy).toEqual(['city3d']);

    const both = resolve({ development: true, choices: { city3d: true, cityTiles: true } });
    expect(both.on('cityTiles')).toBe(true);
    expect(both.get('cityTiles').blockedBy).toEqual([]);
  });

  test('the trees come with the city, and the woods fill needs the trees', () => {
    const city = resolve({ choices: { city3d: true } });
    expect(city.on('city3dTrees')).toBe(true);
    expect(city.on('city3dTreeFill')).toBe(false);
    const fill = resolve({ choices: { city3d: true, city3dTreeFill: true, city3dTrees: false } });
    expect(fill.get('city3dTreeFill').blockedBy).toEqual(['city3dTrees']);
  });

  test('street detail needs the 3D city; `?cityStreets=1` works in a development build only', () => {
    const page = { search: '?cityStreets=1' };
    expect(resolve({ ...page, development: true }).get('cityStreets').blockedBy).toEqual([
      'city3d',
    ]);
    expect(
      resolve({ ...page, development: true, choices: { city3d: true } }).get('cityStreets').on,
    ).toBe(true);
    expect(resolve({ ...page, choices: { city3d: true } }).get('cityStreets').on).toBe(false);
  });

  test('a generic dependency switches its dependant off with it', () => {
    const features: MapFeatureDefinition[] = [
      {
        id: 'base',
        section: 'layers',
        tier: 'labs',
        defaultOn: false,
        requires: [],
        platforms: ['web'],
      },
      {
        id: 'leaf',
        section: 'layers',
        tier: 'labs',
        defaultOn: true,
        requires: ['base'],
        platforms: ['web'],
      },
    ];
    const input = { features, platform: 'web' as const, development: false, search: '' };
    expect(resolveMapFeatures({ ...input, choices: {} }).on('leaf')).toBe(false);
    expect(resolveMapFeatures({ ...input, choices: { base: true } }).on('leaf')).toBe(true);
  });
});

describe('what the panel offers', () => {
  test('per platform', () => {
    const ios = resolve({ platform: 'ios' });
    expect(ios.get('globe').available).toBe(false);
    expect(ios.get('terrain').available).toBe(true);
    expect(ios.get('street3d').available).toBe(true);
    expect(ios.get('city3d').available).toBe(false);
    expect(ios.get('flyover').available).toBe(true);
    expect(resolve().get('city3d').available).toBe(true);
  });

  test('what production cannot serve yet only in a development build', () => {
    for (const id of ['cityTiles', 'cityLife', 'cityStreets', 'landmarks', 'live']) {
      expect(resolve().get(id).available).toBe(false);
      expect(resolve({ development: true }).get(id).available).toBe(true);
    }
  });
});

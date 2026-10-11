/**
 * The map-feature registry: the precedence (kill switch, then the person's
 * choice, then the build's default, then the registry's), the dependencies,
 * what the panel offers where — and, the rule the registry was allowed in
 * under, that with no stored choice every flag answers exactly what its
 * module answered before the registry existed.
 */
import { describe, expect, test } from 'bun:test';

import { isCity3dRequested } from '@/lib/map/city3dFlag';
import { isCity3dTreeFillRequested, isCity3dTreesRequested } from '@/lib/map/city3dTreesFlag';
import { isCitySkyRequested } from '@/lib/map/citySkyFlag';
import { isCityLifeRequested } from '@/lib/map/cityLifeFlag';
import { isCityTilesRequested } from '@/lib/map/cityTilesFlag';
import { isLandmarksRequested } from '@/lib/map/landmarksFlag';
import { isLiveRequested } from '@/lib/map/liveFlag';
import { isFlyoverRequested } from '@/lib/map/flyoverFlag';
import {
  MAP_FEATURES,
  type MapFeatureDefinition,
  type MapPlatform,
  parseBuildSwitch,
  resolveMapFeatures,
} from '@/lib/map/mapFeatures';
import { enabledUnlessKilled, resolveReliefFlags } from '@/lib/map/reliefFlag';

type Builds = Partial<Record<string, string | undefined>>;

/** The REAL definitions (their `request` functions included), with the build variables swapped. */
function withBuilds(builds: Builds): MapFeatureDefinition[] {
  return MAP_FEATURES.map((feature) => ({ ...feature, build: builds[feature.id] }));
}

function resolve(
  options: {
    builds?: Builds;
    choices?: Record<string, boolean>;
    platform?: MapPlatform;
    development?: boolean;
    search?: string;
  } = {},
) {
  return resolveMapFeatures({
    features: withBuilds(options.builds ?? {}),
    choices: options.choices ?? {},
    platform: options.platform ?? 'web',
    development: options.development ?? false,
    search: options.search ?? '',
  });
}

/** What `lib/config.ts` + each flag module answered before the registry. */
function legacy(builds: Builds, development: boolean, search: string) {
  const onBuild = (value: string | undefined) => /^(1|true)$/i.test(value ?? '');
  const relief = resolveReliefFlags({
    enabled: {
      globe: enabledUnlessKilled(builds.globe),
      terrain: enabledUnlessKilled(builds.terrain),
    },
    development,
    search,
  });
  const city3d = isCity3dRequested({ enabled: onBuild(builds.city3d), development, search });
  // As `city3dTreesFlag.ts` read it, except that padding around a `0` now
  // kills too, as it always did for the globe and terrain (the one spelling
  // the shared parser unified; see `parseBuildSwitch`).
  const treesBuild = !/^\s*(0|false)\s*$/i.test(builds.city3dTrees ?? '');
  // The trees were only ever ASKED for by the city layer, so they were only
  // ever drawn with it; the registry states that as a dependency.
  const city3dTrees =
    city3d && isCity3dTreesRequested({ enabled: treesBuild, development, search });
  return {
    globe: relief.globe,
    terrain: relief.terrain,
    city3d,
    cityTiles: isCityTilesRequested({
      city3d,
      enabled: onBuild(builds.cityTiles),
      development,
      search,
    }),
    citySky: isCitySkyRequested({
      city3d,
      enabled: onBuild(builds.citySky),
      development,
      search,
    }),
    cityLife: isCityLifeRequested({
      city3d,
      enabled: onBuild(builds.cityLife),
      development,
      search,
    }),
    city3dTrees,
    city3dTreeFill:
      city3dTrees &&
      isCity3dTreeFillRequested({ enabled: onBuild(builds.city3dTreeFill), development, search }),
    // As `ExploreScreen` decided it: the landmarks flag AND the 3D city.
    landmarks:
      city3d && isLandmarksRequested({ enabled: onBuild(builds.landmarks), development, search }),
    live: isLiveRequested({ enabled: onBuild(builds.live), development, search }),
    flyover: isFlyoverRequested({ enabled: onBuild(builds.flyover), development, search }),
  };
}

describe('the registry', () => {
  test('ids are unique, and every dependency comes earlier', () => {
    const seen = new Set<string>();
    for (const feature of MAP_FEATURES as readonly MapFeatureDefinition[]) {
      expect(seen.has(feature.id)).toBe(false);
      for (const dependency of feature.requires) expect(seen.has(dependency)).toBe(true);
      seen.add(feature.id);
    }
  });

  test('defaults: globe and terrain on, everything else off', () => {
    const features = resolve();
    expect(features.list.map((state) => [state.id, state.on])).toEqual([
      ['globe', true],
      ['terrain', true],
      ['city3d', false],
      ['citySky', false],
      ['cityTiles', false],
      ['city3dTrees', false],
      ['city3dTreeFill', false],
      ['cityLife', false],
      ['landmarks', false],
      ['live', false],
      ['flyover', false],
    ]);
    // Nothing new is on by default: every Labs feature starts off. (The trees
    // default on, but only with the 3D city, which is off.)
    for (const state of features.list) if (state.tier === 'labs') expect(state.on).toBe(false);
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
            build: undefined,
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

describe('with no stored choice, every flag answers what it did before', () => {
  const values = [undefined, '', '0', 'false', 'FALSE', ' 0 ', '1', 'true', 'True', 'yes', ' 1'];
  const searches = [
    '',
    '?city3d=1',
    '?city3d=0',
    '?globe=0',
    '?globe=1&terrain=0',
    '?terrain=1',
    '?flyover=true',
    '?city3d=1&cityTiles=1',
    '?cityTiles=1',
    '?labs=1',
    '?city3d=1&city3dTrees=0',
    '?city3d=1&city3dTreeFill=1',
    '?city3dTreeFill=true',
    '?city3d=1&cityTiles=1&cityLife=1',
    '?cityLife=1',
    '?landmarks=1',
    '?city3d=1&landmarks=true',
    '?live=1',
    '?city3d=1&citysky=1',
    '?citysky=true',
  ];
  for (const development of [false, true]) {
    test(`${development ? 'development' : 'production'} build`, () => {
      for (const value of values) {
        for (const id of MAP_FEATURES.map((feature) => feature.id)) {
          // A feature that needs the city is checked with the city built in.
          const builds = {
            ...(id === 'city3d' ? {} : { city3d: '1' }),
            [id]: value,
          };
          for (const search of searches) {
            const now = resolve({ builds, development, search });
            const before = legacy(builds, development, search);
            for (const [feature, on] of Object.entries(before)) {
              expect([feature, value, search, now.on(feature)]).toEqual([
                feature,
                value,
                search,
                on,
              ]);
            }
          }
        }
      }
    });
  }
});

describe('precedence', () => {
  test('the kill switch beats the person’s choice', () => {
    const features = resolve({ builds: { city3d: '0' }, choices: { city3d: true } });
    expect(features.on('city3d')).toBe(false);
    expect(features.get('city3d').source).toBe('killed');
    expect(features.get('city3d').available).toBe(false);

    const globe = resolve({ builds: { globe: 'false' }, choices: { globe: true } });
    expect(globe.on('globe')).toBe(false);
  });

  test('the person’s choice beats the build’s default and the registry’s', () => {
    expect(resolve({ choices: { city3d: true } }).on('city3d')).toBe(true);
    expect(resolve({ choices: { globe: false } }).on('globe')).toBe(false);
    const built = resolve({ builds: { flyover: '1' }, choices: { flyover: false } });
    expect(built.on('flyover')).toBe(false);
    expect(built.get('flyover').source).toBe('choice');
    expect(built.get('flyover').baseline).toBe(true);
  });

  test('a build `1` is the build’s default', () => {
    const features = resolve({ builds: { city3d: 'true' } });
    expect(features.on('city3d')).toBe(true);
    expect(features.get('city3d').source).toBe('build');
  });

  test('a development query parameter still overrides, and says so', () => {
    const features = resolve({
      choices: { city3d: false },
      development: true,
      search: '?city3d=1',
    });
    expect(features.on('city3d')).toBe(true);
    expect(features.get('city3d').source).toBe('page');
    // ...and a production build ignores it, choice or none.
    expect(resolve({ search: '?city3d=1' }).on('city3d')).toBe(false);
  });

  test('a stored value that is not a boolean is no choice', () => {
    const choices = { city3d: 'yes' } as unknown as Record<string, boolean>;
    expect(resolve({ choices }).get('city3d').choice).toBeNull();
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

  test('a generic dependency switches its dependant off with it', () => {
    const features: MapFeatureDefinition[] = [
      {
        id: 'base',
        section: 'layers',
        tier: 'labs',
        defaultOn: false,
        build: undefined,
        requires: [],
        platforms: ['web'],
      },
      {
        id: 'leaf',
        section: 'layers',
        tier: 'labs',
        defaultOn: true,
        build: undefined,
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
  test('live is offered in development builds only, where a live backend can serve it', () => {
    expect(resolve({ development: false }).get('live').available).toBe(false);
    expect(resolve({ development: true }).get('live').available).toBe(true);
  });

  test('per platform', () => {
    const ios = resolve({ platform: 'ios' });
    expect(ios.get('globe').available).toBe(false);
    expect(ios.get('terrain').available).toBe(true);
    expect(ios.get('city3d').available).toBe(false);
    expect(ios.get('flyover').available).toBe(true);
    expect(resolve().get('city3d').available).toBe(true);
  });

  test('city tiles, city life and landmarks only in a development build (no tiles served yet)', () => {
    for (const id of ['cityTiles', 'cityLife', 'landmarks']) {
      expect(resolve().get(id).available).toBe(false);
      expect(resolve({ development: true }).get(id).available).toBe(true);
    }
  });
});

describe('parseBuildSwitch', () => {
  test('the spellings the old flags accepted', () => {
    expect(parseBuildSwitch(undefined)).toBeNull();
    expect(parseBuildSwitch('')).toBeNull();
    expect(parseBuildSwitch('yes')).toBeNull();
    expect(parseBuildSwitch('0')).toBe('killed');
    expect(parseBuildSwitch(' False ')).toBe('killed');
    expect(parseBuildSwitch('1')).toBe('on');
    expect(parseBuildSwitch('TRUE')).toBe('on');
  });
});

/**
 * Globe and terrain are ON unless a build kills them — and only a DEVELOPMENT
 * tab may override either way: a production build ignores `?globe=0` /
 * `?terrain=0`, so no goway.to link can change somebody else's renderer.
 */
import { describe, expect, test } from 'bun:test';

import {
  enabledUnlessKilled,
  GLOBE_PROJECTION,
  isReliefId,
  mapStyleLoading,
  RELIEF_ID_PREFIX,
  resolveReliefFlags,
} from '@/lib/map/reliefFlag';

const ON = { globe: true, terrain: true };
const OFF = { globe: false, terrain: false };

describe('enabledUnlessKilled (the build flags)', () => {
  test('unset, empty, 1, true and typos all leave it on — production gets relief with no env', () => {
    for (const value of [undefined, '', '1', 'true', 'TRUE', 'yes', 'flase']) {
      expect(enabledUnlessKilled(value)).toBe(true);
    }
  });

  test('only an explicit 0 or false kills it', () => {
    for (const value of ['0', 'false', 'FALSE', ' 0 ', 'False']) {
      expect(enabledUnlessKilled(value)).toBe(false);
    }
  });
});

describe('resolveReliefFlags', () => {
  test('the build flags decide, in production and in development without a parameter', () => {
    expect(resolveReliefFlags({ enabled: ON, development: false, search: '' })).toEqual(ON);
    expect(resolveReliefFlags({ enabled: ON, development: true, search: '' })).toEqual(ON);
    expect(resolveReliefFlags({ enabled: OFF, development: false, search: '' })).toEqual(OFF);
    expect(
      resolveReliefFlags({
        enabled: { globe: true, terrain: false },
        development: false,
        search: '',
      }),
    ).toEqual({ globe: true, terrain: false });
  });

  test('a development tab can turn either off, or a killed one back on', () => {
    expect(
      resolveReliefFlags({ enabled: ON, development: true, search: '?globe=0&terrain=false' }),
    ).toEqual(OFF);
    expect(
      resolveReliefFlags({ enabled: ON, development: true, search: '?lat=1&terrain=0' }),
    ).toEqual({ globe: true, terrain: false });
    expect(
      resolveReliefFlags({ enabled: OFF, development: true, search: '?globe=1&terrain=true' }),
    ).toEqual(ON);
  });

  test('a production build ignores the query string both ways', () => {
    expect(
      resolveReliefFlags({ enabled: ON, development: false, search: '?globe=0&terrain=0' }),
    ).toEqual(ON);
    expect(
      resolveReliefFlags({ enabled: OFF, development: false, search: '?globe=1&terrain=1' }),
    ).toEqual(OFF);
  });

  test('an unrecognised value leaves the build flag in charge', () => {
    expect(
      resolveReliefFlags({ enabled: ON, development: true, search: '?globe=no&terrain=' }),
    ).toEqual(ON);
  });
});

describe('isReliefId', () => {
  test('recognises the prefix and nothing else', () => {
    expect(isReliefId(`${RELIEF_ID_PREFIX}dem-terrain`)).toBe(true);
    expect(isReliefId('openmaptiles')).toBe(false);
    expect(isReliefId('goway:src:route')).toBe(false);
    expect(isReliefId(undefined)).toBe(false);
  });
});

describe('mapStyleLoading', () => {
  const URL = 'https://goway.to/map/goway-light.json';

  test('globe off: the URL goes into the constructor, as it always did', () => {
    expect(mapStyleLoading(URL, false)).toEqual({
      construct: { style: URL },
      deferred: null,
      background: null,
    });
  });

  test('globe on: the projection is IN the document from its first load (PR #124 review)', () => {
    const { construct, deferred, background } = mapStyleLoading(URL, true);
    // Space, not a white page, around the globe before the relief chunk lands.
    expect(background).toContain('radial-gradient');
    // Absent, not present-and-undefined (see engineOptions.test.ts).
    expect('style' in construct).toBe(false);
    if (!deferred) throw new Error('expected a deferred style');
    expect(deferred.url).toBe(URL);
    const fetched = {
      version: 8 as const,
      sources: {},
      layers: [{ id: 'background', type: 'background' as const }],
    };
    const loaded: unknown = deferred.transformStyle(undefined, fetched);
    expect(loaded).toEqual({ ...fetched, projection: GLOBE_PROJECTION });
    expect(fetched).not.toHaveProperty('projection');
  });
});

/**
 * Globe and terrain are off unless a build or a DEVELOPMENT tab asks — and a
 * production build ignores `?globe=1` / `?terrain=1`, so no goway.to link can
 * switch an experimental renderer on for somebody else.
 */
import { describe, expect, test } from 'bun:test';

import {
  GLOBE_PROJECTION,
  isReliefId,
  mapStyleLoading,
  RELIEF_ID_PREFIX,
  resolveReliefFlags,
} from '@/lib/map/reliefFlag';

const OFF = { globe: false, terrain: false };

describe('resolveReliefFlags', () => {
  test('off by default, in development and production alike', () => {
    expect(resolveReliefFlags({ enabled: OFF, development: false, search: '' })).toEqual(OFF);
    expect(resolveReliefFlags({ enabled: OFF, development: true, search: '' })).toEqual(OFF);
  });

  test('each build flag turns on its own feature, everywhere', () => {
    expect(
      resolveReliefFlags({
        enabled: { globe: true, terrain: false },
        development: false,
        search: '',
      }),
    ).toEqual({ globe: true, terrain: false });
    expect(
      resolveReliefFlags({
        enabled: { globe: false, terrain: true },
        development: false,
        search: '',
      }),
    ).toEqual({ globe: false, terrain: true });
  });

  test('the query parameters work in development only', () => {
    expect(
      resolveReliefFlags({ enabled: OFF, development: true, search: '?globe=1&terrain=true' }),
    ).toEqual({ globe: true, terrain: true });
    expect(
      resolveReliefFlags({ enabled: OFF, development: true, search: '?lat=1&terrain=1' }),
    ).toEqual({ globe: false, terrain: true });
    expect(
      resolveReliefFlags({ enabled: OFF, development: false, search: '?globe=1&terrain=1' }),
    ).toEqual(OFF);
  });

  test('anything but 1 or true is off', () => {
    expect(
      resolveReliefFlags({ enabled: OFF, development: true, search: '?globe=yes&terrain=0' }),
    ).toEqual(OFF);
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

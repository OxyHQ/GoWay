/**
 * Globe and terrain are off unless a build or a DEVELOPMENT tab asks — and a
 * production build ignores `?globe=1` / `?terrain=1`, so no goway.to link can
 * switch an experimental renderer on for somebody else.
 */
import { describe, expect, test } from 'bun:test';

import { isReliefId, RELIEF_ID_PREFIX, resolveReliefFlags } from '@/lib/map/reliefFlag';

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

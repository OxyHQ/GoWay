/**
 * The globe and terrain's shared pieces: their ids, and how the style is
 * handed over with the globe on. Whether either draws is the registry's
 * (`mapFeatures.test.ts`).
 */
import { describe, expect, test } from 'bun:test';

import {
  GLOBE_PROJECTION,
  isReliefId,
  mapStyleLoading,
  RELIEF_ID_PREFIX,
} from '@/lib/map/reliefFlag';

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

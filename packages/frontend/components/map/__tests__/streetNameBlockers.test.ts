/**
 * The street-name blockers (`components/map/streetNameBlockers.web.ts`): where
 * they go in the style — directly above the road labels — and what they are.
 */
import { describe, expect, test } from 'bun:test';

import { blockerAnchor, blockerFeatures } from '@/components/map/streetNameBlockers.web';

describe('street-name blockers', () => {
  test('directly above the last road-name layer, below everything after it', () => {
    const layers = [
      { id: 'road-primary', type: 'line', 'source-layer': 'transportation' },
      { id: 'label-road-local', type: 'symbol', 'source-layer': 'transportation_name' },
      { id: 'label-road-arterial', type: 'symbol', 'source-layer': 'transportation_name' },
      { id: 'label-poi', type: 'symbol', 'source-layer': 'poi' },
    ];
    expect(blockerAnchor(layers)).toEqual({ before: 'label-poi' });
    // Road labels last in the style: on top.
    expect(blockerAnchor(layers.slice(0, 3))).toEqual({ before: undefined });
  });

  test('a style with no road labels gets no blockers', () => {
    expect(blockerAnchor([{ id: 'x', type: 'symbol', 'source-layer': 'poi' }])).toBeNull();
    expect(blockerAnchor([])).toBeNull();
  });

  test('one invisible point per reported position', () => {
    const fc = blockerFeatures([
      [2.16, 41.39],
      [2.17, 41.4],
    ]);
    expect(fc.features.map((f) => f.geometry.coordinates)).toEqual([
      [2.16, 41.39],
      [2.17, 41.4],
    ]);
  });
});

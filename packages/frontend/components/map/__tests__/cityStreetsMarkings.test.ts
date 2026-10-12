/**
 * Which marking a tag combination draws (`engine/cityStreets/markings.ts`),
 * junk included: a crossing only where one is mapped, in the pattern
 * recorded; an arrow only from recorded turns.
 */
import { describe, expect, test } from 'bun:test';

import { arrowKey, arrowParts, crossingStyle } from '@/components/map/engine/cityStreets/markings';
import {
  rasterArrow,
  SDF_EDGE,
  StreetAtlas,
  ARROW_CELL,
} from '@/components/map/engine/cityStreets/streetAtlas';

describe('crossing style', () => {
  test('the owner rule: zebra, marked and uncontrolled are zebras', () => {
    for (const crossing of ['zebra', 'marked', 'uncontrolled']) {
      expect(crossingStyle({ crossing }, null)).toBe('zebra');
    }
    expect(crossingStyle({ crossingRef: 'zebra' }, null)).toBe('zebra');
  });

  test('crossing:markings wins, on the node or on the crossing way', () => {
    expect(crossingStyle({ crossing: 'marked', crossingMarkings: 'dots' }, null)).toBe('dots');
    expect(crossingStyle({ crossing: 'traffic_signals' }, { crossingMarkings: 'zebra' })).toBe(
      'zebra',
    );
    expect(
      crossingStyle(null, { crossing: 'traffic_signals', crossingMarkings: 'ladder:skewed' }),
    ).toBe('ladder');
    expect(crossingStyle({ crossingMarkings: 'surface' }, null)).toBe('surface');
    expect(crossingStyle({ crossingMarkings: 'dashes' }, null)).toBe('dashes');
    expect(crossingStyle({ crossingMarkings: 'zebra:double' }, null)).toBe('zebra');
  });

  test('a signalled crossing with no pattern: the two lines only', () => {
    expect(crossingStyle({ crossing: 'traffic_signals' }, null)).toBe('lines');
    expect(crossingStyle({ crossingRef: 'pelican' }, null)).toBe('lines');
    expect(crossingStyle({ crossingMarkings: 'yes' }, null)).toBe('lines');
  });

  test('unmarked, informal, no and junk draw nothing', () => {
    expect(crossingStyle({ crossing: 'unmarked' }, null)).toBe('none');
    expect(crossingStyle({ crossing: 'informal' }, null)).toBe('none');
    expect(crossingStyle({ crossing: 'marked', crossingMarkings: 'no' }, null)).toBe('none');
    expect(crossingStyle({ crossing: 'zebrra' }, null)).toBe('none');
    expect(crossingStyle({}, null)).toBe('none');
    expect(crossingStyle(null, null)).toBe('none');
    // An unknown markings value falls through to what else is recorded.
    expect(crossingStyle({ crossing: 'marked', crossingMarkings: 'stripey' }, null)).toBe('zebra');
  });
});

describe('arrows', () => {
  test('from recorded turns only', () => {
    expect(arrowParts(null)).toBeNull();
    expect(arrowParts([])).toBeNull();
    expect(arrowParts(['none'])).toBeNull();
    expect(arrowParts(['through'])).toEqual(['through']);
    expect(arrowParts(['right', 'through'])).toEqual(['through', 'right']);
    expect(arrowParts(['sharp_left'])).toEqual(['left']);
    expect(arrowParts(['merge_to_left'])).toEqual(['merge_to_left']);
  });

  test('a U-turn bends to the side traffic crosses', () => {
    expect(arrowKey(['reverse'], 'right')).toBe('reverse');
    expect(arrowKey(['reverse'], 'left')).toBe('reverse@lht');
    expect(arrowKey(['through', 'right'], 'left')).toBe('through+right');
  });

  test('the SDF is MapLibre’s encoding: inside above the edge value, outside below', () => {
    const cell = rasterArrow(['through']);
    const { width, height, pad } = ARROW_CELL;
    const at = (x: number, y: number) =>
      cell[Math.round(height - pad - y) * width + Math.round(x + width / 2)] / 255;
    expect(at(0, 20)).toBeGreaterThan(SDF_EDGE); // on the shaft
    expect(at(0, 75)).toBeGreaterThan(SDF_EDGE); // in the head
    expect(at(14, 20)).toBeLessThan(SDF_EDGE); // beside the shaft
    // A left turn's head is on the left, a right turn's on the right.
    const left = rasterArrow(['left']);
    const right = rasterArrow(['right']);
    const row = Math.round(height - pad - 53);
    expect(left[row * width + 12]).toBeGreaterThan(right[row * width + 12]);
  });

  test('the atlas places each shape once and hands the bytes over once', () => {
    const atlas = new StreetAtlas();
    const a = atlas.arrow('through', ['through']);
    const b = atlas.arrow('through', ['through']);
    expect(a).toEqual(b);
    expect(atlas.takePatches()).toHaveLength(1);
    expect(atlas.takePatches()).toHaveLength(0);
  });
});

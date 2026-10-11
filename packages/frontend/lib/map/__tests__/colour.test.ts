/** The one hex-colour parser every map module uses (`lib/map/colour.ts`). */
import { describe, expect, test } from 'bun:test';

import { hexToPacked, hexToRgb, parseHexColour } from '@/lib/map/colour';

describe('hex colours', () => {
  test('long and short forms, any case', () => {
    expect(parseHexColour('#ff8000')).toEqual([255, 128, 0]);
    expect(parseHexColour('#FF8000')).toEqual([255, 128, 0]);
    expect(parseHexColour('#f80')).toEqual([255, 136, 0]);
  });

  test('anything else is refused, never guessed', () => {
    for (const value of ['ff8000', '#ff800', '#ff80000', 'red', 'rgb(1,2,3)', 7, null, undefined]) {
      expect(parseHexColour(value)).toBeNull();
    }
  });

  test('unit channels, with MapLibre’s white as the fallback', () => {
    expect(hexToRgb('#ffffff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('nonsense')).toEqual([1, 1, 1]);
    expect(hexToRgb('nonsense', [0, 0, 0])).toEqual([0, 0, 0]);
  });

  test('a tile property packs only the long form', () => {
    expect(hexToPacked('#123456')).toBe(0x123456);
    expect(hexToPacked('#123')).toBeUndefined();
    expect(hexToPacked('blue')).toBeUndefined();
  });
});

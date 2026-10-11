/**
 * The shape cache fetches an operator's line only when asked to load it, a
 * few at a time, newest request first.
 */
import { describe, expect, test } from 'bun:test';
import type { LiveShape } from '@goway.to/sdk';

import { ShapeCache } from '../shapeCache';

function shape(id: string): LiveShape {
  return {
    sourceId: 'mta-bus',
    id,
    coordinates: [
      [-73.99, 40.75],
      [-73.98, 40.76],
    ],
    alongMeters: [0, 1400],
    lengthMeters: 1400,
  };
}

describe('ShapeCache', () => {
  test('does not fetch when told not to load, and serves a loaded shape either way', async () => {
    const asked: string[] = [];
    let loaded = 0;
    const cache = new ShapeCache(
      () => {
        loaded++;
      },
      async (_source, id) => {
        asked.push(id);
        return shape(id);
      },
    );
    expect(cache.get('mta-bus', 'a', false)).toBeUndefined();
    expect(asked).toEqual([]);
    expect(cache.get('mta-bus', 'a')).toBeUndefined();
    await Bun.sleep(0);
    expect(asked).toEqual(['a']);
    expect(loaded).toBe(1);
    expect(cache.get('mta-bus', 'a', false)?.lengthMeters).toBe(1400);
  });

  test('keeps at most four requests in flight, newest first', async () => {
    const asked: string[] = [];
    const resolvers: (() => void)[] = [];
    const cache = new ShapeCache(
      () => {},
      (_source, id) =>
        new Promise<LiveShape>((resolve) => {
          asked.push(id);
          resolvers.push(() => resolve(shape(id)));
        }),
    );
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) cache.get('mta-bus', id);
    expect(asked).toEqual(['a', 'b', 'c', 'd']);
    resolvers[0]?.();
    await Bun.sleep(0);
    await Bun.sleep(0);
    expect(asked).toEqual(['a', 'b', 'c', 'd', 'f']);
  });
});

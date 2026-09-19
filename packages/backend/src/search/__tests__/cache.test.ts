/**
 * The bounded cache.
 *
 * Both bounds are load-bearing: an unbounded cache in front of a free-text API
 * is a memory leak whose key is user-controlled — every distinct typo is an
 * entry nothing ever removes.
 */

import { describe, expect, it } from 'bun:test';
import { BoundedCache } from '../cache';

function clock(): { now: () => number; advance: (ms: number) => void } {
  let current = 1_000;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe('BoundedCache', () => {
  it('returns a stored value until it expires', () => {
    const time = clock();
    const cache = new BoundedCache<string>({ maxEntries: 10, ttlMs: 500, now: time.now });

    cache.set('a', 'value');
    expect(cache.get('a')).toBe('value');

    time.advance(500);
    expect(cache.get('a')).toBeUndefined();
    // The expired entry is dropped on read rather than lingering.
    expect(cache.size).toBe(0);
  });

  it('evicts the least recently used entry when full', () => {
    const cache = new BoundedCache<string>({ maxEntries: 2, ttlMs: 60_000 });
    cache.set('a', '1');
    cache.set('b', '2');
    // Touching `a` makes `b` the least recently used.
    expect(cache.get('a')).toBe('1');
    cache.set('c', '3');

    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('a')).toBe('1');
    expect(cache.get('c')).toBe('3');
  });

  it('is off when either bound is zero', () => {
    for (const options of [{ maxEntries: 0, ttlMs: 60_000 }, { maxEntries: 10, ttlMs: 0 }]) {
      const cache = new BoundedCache<string>(options);
      cache.set('a', '1');
      expect(cache.enabled).toBe(false);
      expect(cache.get('a')).toBeUndefined();
      expect(cache.size).toBe(0);
    }
  });
});

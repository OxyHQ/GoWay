/**
 * The city-3D engine's request and cache bookkeeping (PR #119 review).
 *
 *  1. A failed tile is retried while the view stands STILL — the first
 *     version only scheduled when the wanted set changed, so a failure left a
 *     hole in the city (with `building-3d` hidden) until the user panned —
 *     and the retries are bounded, so a tile that never loads is no hot loop.
 *  2. An EMPTY tile is cached, so a revisit does not fetch it again, and the
 *     cache stays bounded although an empty tile weighs zero bytes.
 *
 * The engine itself needs WebGL; everything it decides is here.
 */
import { describe, expect, test } from 'bun:test';

import { type TileId, tileKey } from '@/components/map/engine/city3d/tileMath';
import {
  pickEvictions,
  RETRY,
  retryDelayMs,
  TileCache,
  TileScheduler,
} from '@/components/map/engine/city3d/tileScheduler';

const A: TileId = { z: 14, x: 1, y: 1 };
const B: TileId = { z: 14, x: 2, y: 1 };
const nothingCached = () => false;

/** Drive a scheduler like the engine does: one `plan` per frame, ids from 1. */
function driver(scheduler = new TileScheduler()) {
  let nextId = 1;
  const inFlight = new Map<string, number>();
  return {
    scheduler,
    frame(tiles: TileId[], now: number, isCached: (key: string) => boolean = nothingCached) {
      const plan = scheduler.plan(tiles, now, isCached);
      for (const tile of plan.request) {
        const id = nextId++;
        scheduler.started(tile, id);
        inFlight.set(tileKey(tile), id);
      }
      return plan;
    },
    fail(tile: TileId, now: number) {
      return scheduler.failed(tile, inFlight.get(tileKey(tile)) ?? -1, now);
    },
    succeed(tile: TileId) {
      return scheduler.succeeded(tile, inFlight.get(tileKey(tile)) ?? -1);
    },
  };
}

describe('retries with the view standing still', () => {
  test('a failed tile is requested again once its backoff has passed', () => {
    const d = driver();
    expect(d.frame([A], 0).request).toEqual([A]);
    const delay = d.fail(A, 10);
    expect(delay).toBe(RETRY.baseMs);
    // Same wanted set, before the backoff: nothing.
    expect(d.frame([A], 10 + RETRY.baseMs - 1).request).toEqual([]);
    // Same wanted set, after it: requested again.
    expect(d.frame([A], 10 + RETRY.baseMs).request).toEqual([A]);
  });

  test('backoff doubles to the cap, then cools down', () => {
    expect([1, 2, 3, 4].map(retryDelayMs)).toEqual([1_000, 2_000, 4_000, 8_000]);
    expect(retryDelayMs(RETRY.maxAttempts)).toBe(RETRY.cooldownMs);
  });

  test('a tile that never loads costs a bounded number of requests', () => {
    const d = driver();
    let requests = 0;
    const tenMinutes = 10 * 60_000;
    // One frame every 16 ms for ten minutes, and every request fails.
    for (let now = 0; now <= tenMinutes; now += 16) {
      for (const tile of d.frame([A], now).request) {
        requests++;
        d.fail(tile, now);
      }
    }
    const rounds = Math.ceil(tenMinutes / RETRY.cooldownMs) + 1;
    expect(requests).toBeGreaterThan(1);
    expect(requests).toBeLessThanOrEqual(RETRY.maxAttempts * rounds);
  });

  test('success forgets the failures', () => {
    const d = driver();
    d.frame([A], 0);
    d.fail(A, 0);
    d.frame([A], RETRY.baseMs);
    expect(d.succeed(A)).toBe(true);
    // Cached now; and were it evicted, it would be requested at once.
    expect(d.frame([A], RETRY.baseMs + 1).request).toEqual([A]);
  });

  test('a tile that leaves the view is cancelled, and its late answer ignored', () => {
    const d = driver();
    d.frame([A, B], 0);
    const plan = d.frame([B], 1);
    expect(plan.cancel).toHaveLength(1);
    expect(d.succeed(A)).toBe(false);
    expect(d.fail(A, 2)).toBeNull();
  });
});

describe('empty tiles are cached', () => {
  test('an empty tile, once answered, is not requested again on a revisit', () => {
    const released: string[] = [];
    const cache = new TileCache<string>(100, 10, (value) => released.push(value));
    const d = driver();
    d.frame([A], 0, (key) => cache.has(key));
    expect(d.succeed(A)).toBe(true);
    cache.put(tileKey(A), null, 0, 0, new Set([tileKey(A)]));
    // Leave and come back.
    d.frame([B], 1, (key) => cache.has(key));
    expect(d.frame([A], 2, (key) => cache.has(key)).request).toEqual([]);
    expect(cache.get(tileKey(A))).toBeNull();
    expect(released).toEqual([]);
  });

  test('zero-byte entries are still bounded, least recently used first', () => {
    const cache = new TileCache<string>(1_000, 3, () => {});
    for (let i = 0; i < 5; i++) cache.put(`k${i}`, null, 0, i, new Set());
    expect(cache.size).toBe(3);
    expect(cache.has('k0')).toBe(false);
    expect(cache.has('k4')).toBe(true);
  });

  test('evicted meshes are released, wanted ones never evicted', () => {
    const released: string[] = [];
    const cache = new TileCache<string>(10, 100, (value) => released.push(value));
    cache.put('old', 'mesh-old', 6, 0, new Set());
    cache.put('kept', 'mesh-kept', 6, 1, new Set(['kept', 'old']));
    // Over budget, but both wanted: nothing goes.
    expect(released).toEqual([]);
    cache.put('new', 'mesh-new', 6, 2, new Set(['new']));
    expect(released).toEqual(['mesh-old', 'mesh-kept']);
    expect(cache.bytes).toBe(6);
  });

  test('pickEvictions honours both budgets', () => {
    const entries = [
      { key: 'a', bytes: 0, lastUsed: 0 },
      { key: 'b', bytes: 5, lastUsed: 1 },
      { key: 'c', bytes: 5, lastUsed: 2 },
    ];
    expect(pickEvictions(entries, new Set(), 100, 2)).toEqual(['a']);
    expect(pickEvictions(entries, new Set(), 5, 100)).toEqual(['a', 'b']);
    expect(pickEvictions(entries, new Set(['b']), 5, 100)).toEqual(['a', 'c']);
  });
});

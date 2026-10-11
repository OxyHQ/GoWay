/**
 * The spatial index and the hub, driven by a fake clock and a fake feed.
 *
 * What is pinned: rooms (tile × kind) as the index, moves between rooms,
 * deltas only to watched rooms, demand-driven polling (no viewer → no
 * request), full-snapshot vs partial-poll removal, ageing out by the feed's own
 * timestamps, backoff with Retry-After, idle release, statuses — and that
 * nothing the hub logs names a viewport.
 */

import { describe, expect, it } from 'bun:test';
import {
  LIVE_MAX_ROOM_TILES,
  type LiveDelta,
  type LiveEntity,
  liveTileBounds,
  liveTileOf,
  liveTilesFor,
} from '@goway/contracts';
import { LiveHub, MAX_BACKOFF_MS } from '../hub';
import { contains, LiveTileIndex } from '../tileIndex';
import type { LiveFetchContext, LivePollResult, LiveSourceDefinition } from '../types';
import { LiveUpstreamError } from '../types';

const T0 = Date.parse('2026-10-11T12:00:00Z');

function bus(id: string, latitude: number, longitude: number, observedAt: number): LiveEntity {
  return {
    kind: 'transit',
    id: `test-bus:${id}`,
    sourceId: 'test-bus',
    position: { latitude, longitude },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt: new Date(observedAt).toISOString(),
    mode: 'bus',
    operator: 'Test',
    line: 'M1',
    headsign: null,
    vehicleLabel: null,
  };
}

const BARCELONA = { latitude: 41.39, longitude: 2.17 };
const BARCELONA_TILE = liveTileOf(BARCELONA);
const NEW_YORK_TILE = liveTileOf({ latitude: 40.75, longitude: -73.98 });

// ---------------------------------------------------------------------------
// Room tiles (contracts) and the index
// ---------------------------------------------------------------------------

describe('room tiles', () => {
  it('puts a city in one or two z7 rooms', () => {
    expect(BARCELONA_TILE).toBe('7/64/47');
    const city = liveTilesFor({ west: 2.05, south: 41.32, east: 2.25, north: 41.47 });
    expect(city).toEqual(['7/64/47']);
  });

  it('refuses a box wider than the room budget, and crosses the antimeridian', () => {
    expect(liveTilesFor({ west: -30, south: 20, east: 30, north: 60 })).toBeNull();
    const pacific = liveTilesFor({ west: 179, south: -1, east: -179, north: 1 });
    expect(pacific).toEqual(['7/127/63', '7/127/64', '7/0/63', '7/0/64']);
    expect((pacific ?? []).length).toBeLessThanOrEqual(LIVE_MAX_ROOM_TILES);
  });

  it('bounds a tile so that its own centre falls back in it', () => {
    const box = liveTileBounds(BARCELONA_TILE);
    expect(contains(box, BARCELONA)).toBe(true);
    const centre = { latitude: (box.north + box.south) / 2, longitude: (box.east + box.west) / 2 };
    expect(liveTileOf(centre)).toBe(BARCELONA_TILE);
  });
});

describe('the tile index', () => {
  it('reports changes, ignores repeats, and moves between rooms', () => {
    const index = new LiveTileIndex();
    const first = bus('1', 41.39, 2.17, T0);
    expect(index.upsert(first)).toEqual([
      { type: 'upsert', room: `${BARCELONA_TILE}|transit`, entity: first },
    ]);
    expect(index.upsert({ ...first })).toEqual([]);
    const moved = bus('1', 40.75, -73.98, T0 + 1000);
    expect(index.upsert(moved)).toEqual([
      { type: 'remove', room: `${BARCELONA_TILE}|transit`, id: 'test-bus:1' },
      { type: 'upsert', room: `${NEW_YORK_TILE}|transit`, entity: moved },
    ]);
    expect(index.inRoom(BARCELONA_TILE, 'transit')).toEqual([]);
    expect(index.inRoom(NEW_YORK_TILE, 'transit')).toEqual([moved]);
    expect(index.inRoom(NEW_YORK_TILE, 'aircraft')).toEqual([]);
    expect(index.countOfSource('test-bus')).toBe(1);
    expect(index.remove('test-bus:1')).toHaveLength(1);
    expect(index.size).toBe(0);
    expect(index.countOfSource('test-bus')).toBe(0);
  });

  it('answers a box query exactly, by kind', () => {
    const index = new LiveTileIndex();
    index.upsert(bus('in', 41.39, 2.17, T0));
    index.upsert(bus('out', 41.6, 2.6, T0));
    const box = { west: 2.1, south: 41.3, east: 2.2, north: 41.45 };
    expect(index.query(box, ['transit'])?.map((entity) => entity.id)).toEqual(['test-bus:in']);
    expect(index.query(box, ['aircraft'])).toEqual([]);
    expect(index.query({ west: -100, south: -60, east: 100, north: 60 }, ['transit'])).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The hub
// ---------------------------------------------------------------------------

interface Harness {
  hub: LiveHub;
  deltas: LiveDelta[];
  polls: LiveFetchContext[];
  logs: Record<string, unknown>[];
  clock: { now: number };
  /** What the next poll answers. */
  answer: { next: () => Promise<LivePollResult> };
}

function harness(overrides: Partial<LiveSourceDefinition> = {}): Harness {
  const clock = { now: T0 };
  const deltas: LiveDelta[] = [];
  const polls: LiveFetchContext[] = [];
  const logs: Record<string, unknown>[] = [];
  const answer = { next: async (): Promise<LivePollResult> => ({ entities: [], rejected: 0 }) };
  const definition: LiveSourceDefinition = {
    id: 'test-bus',
    kind: 'transit',
    name: 'Test buses',
    attribution: { label: 'Test', href: 'https://example.org' },
    licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
    coverage: { west: 1.9, south: 41.2, east: 2.4, north: 41.6 },
    defaultUrl: 'https://example.org/feed',
    requiresKey: false,
    pollIntervalSeconds: 10,
    staleAfterSeconds: 60,
    dropAfterSeconds: 120,
    create: () => ({
      poll: (context) => {
        polls.push(context);
        return answer.next();
      },
    }),
    ...overrides,
  };
  const hub = new LiveHub({
    sources: [
      {
        definition,
        settings: {
          url: definition.defaultUrl,
          key: 'sekrit',
          userAgent: 'test',
          maxRegionsPerPoll: 2,
        },
      },
    ],
    fetch: async () => {
      throw new Error('the adapter is faked');
    },
    now: () => clock.now,
    random: () => 0.5,
    publish: (delta) => deltas.push(delta),
    logger: {
      info: (object) => logs.push(object),
      warn: (object) => logs.push(object),
    },
  });
  return { hub, deltas, polls, logs, clock, answer };
}

describe('the hub', () => {
  it('polls nothing while nobody watches, and only its own kind and coverage', async () => {
    const h = harness();
    await h.hub.tick();
    expect(h.polls).toHaveLength(0);
    // Aircraft over Barcelona, and buses over New York: neither is this source's demand.
    h.hub.watch('a', [
      { tile: BARCELONA_TILE, kind: 'aircraft' },
      { tile: NEW_YORK_TILE, kind: 'transit' },
    ]);
    await h.hub.tick();
    expect(h.polls).toHaveLength(0);
    expect(h.hub.sources()[0]?.status).toBe('idle');
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    await h.hub.tick();
    expect(h.polls).toHaveLength(1);
    expect(h.polls[0]?.demand).toEqual([liveTileBounds(BARCELONA_TILE)]);
  });

  it('publishes deltas to watched rooms only, and snapshots on demand', async () => {
    const h = harness();
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.answer.next = async () => ({ entities: [bus('1', 41.39, 2.17, T0 - 5000)], rejected: 0 });
    await h.hub.tick();
    expect(h.deltas).toHaveLength(1);
    expect(h.deltas[0]).toMatchObject({ tile: BARCELONA_TILE, kind: 'transit', removes: [] });
    expect(h.deltas[0]?.upserts.map((entity) => entity.id)).toEqual(['test-bus:1']);
    expect(h.hub.snapshot(BARCELONA_TILE, 'transit').entities).toHaveLength(1);
    expect(h.hub.sources()[0]).toMatchObject({ status: 'live', entityCount: 1 });

    // The same answer again: nothing changed, nothing sent.
    h.clock.now += 10_000;
    await h.hub.tick();
    expect(h.polls).toHaveLength(2);
    expect(h.deltas).toHaveLength(1);
  });

  it('removes what a full snapshot no longer lists, but keeps what a partial poll missed', async () => {
    const full = harness();
    full.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    full.answer.next = async () => ({
      entities: [bus('1', 41.39, 2.17, T0), bus('2', 41.4, 2.18, T0)],
      rejected: 0,
    });
    await full.hub.tick();
    full.clock.now += 10_000;
    full.answer.next = async () => ({ entities: [bus('1', 41.39, 2.17, T0)], rejected: 0 });
    await full.hub.tick();
    expect(full.deltas.at(-1)).toMatchObject({ upserts: [], removes: ['test-bus:2'] });

    const partial = harness({ partialPolls: true });
    partial.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    partial.answer.next = async () => ({
      entities: [bus('1', 41.39, 2.17, T0), bus('2', 41.4, 2.18, T0)],
      rejected: 0,
    });
    await partial.hub.tick();
    partial.clock.now += 10_000;
    partial.answer.next = async () => ({
      entities: [bus('1', 41.39, 2.17, T0 + 10_000)],
      rejected: 0,
    });
    await partial.hub.tick();
    expect(partial.hub.snapshot(BARCELONA_TILE, 'transit').entities).toHaveLength(2);
    // ...until it is older than the drop bound, whatever the feed says.
    partial.clock.now = T0 + 121_000;
    partial.answer.next = async () => ({ entities: [], rejected: 0 });
    await partial.hub.tick();
    expect(
      partial.hub.snapshot(BARCELONA_TILE, 'transit').entities.map((entity) => entity.id),
    ).toEqual(['test-bus:1']);
  });

  it('never serves a fix older than the drop bound', async () => {
    const h = harness();
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.answer.next = async () => ({
      entities: [bus('old', 41.39, 2.17, T0 - 121_000)],
      rejected: 0,
    });
    await h.hub.tick();
    expect(h.deltas).toHaveLength(0);
    expect(h.hub.snapshot(BARCELONA_TILE, 'transit').entities).toEqual([]);
  });

  it('moves an entity between rooms with a remove and an upsert', async () => {
    const h = harness({ coverage: null });
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.hub.watch('b', [{ tile: NEW_YORK_TILE, kind: 'transit' }]);
    h.answer.next = async () => ({ entities: [bus('1', 41.39, 2.17, T0)], rejected: 0 });
    await h.hub.tick();
    h.clock.now += 10_000;
    h.answer.next = async () => ({ entities: [bus('1', 40.75, -73.98, T0 + 10_000)], rejected: 0 });
    await h.hub.tick();
    const [, ...moves] = h.deltas;
    expect(moves).toHaveLength(2);
    expect(moves.find((delta) => delta.tile === BARCELONA_TILE)?.removes).toEqual(['test-bus:1']);
    expect(moves.find((delta) => delta.tile === NEW_YORK_TILE)?.upserts).toHaveLength(1);
  });

  it('backs off on failure, honours Retry-After, and never logs the key', async () => {
    const h = harness();
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.answer.next = async () => {
      throw new Error('connect ECONNREFUSED https://example.org/feed?key=sekrit');
    };
    await h.hub.tick();
    expect(h.hub.sources()[0]?.status).toBe('unavailable');
    // interval 10 s × 2^1 × (0.8 + 0.4 × 0.5) = 20 s.
    h.clock.now += 19_000;
    await h.hub.tick();
    expect(h.polls).toHaveLength(1);
    h.clock.now += 1_000;
    h.answer.next = async () => {
      throw new LiveUpstreamError('upstream answered 429', 600);
    };
    await h.hub.tick();
    expect(h.polls).toHaveLength(2);
    h.clock.now += 599_000;
    await h.hub.tick();
    expect(h.polls).toHaveLength(2);
    h.clock.now += 1_000;
    await h.hub.tick();
    expect(h.polls).toHaveLength(3);
    const text = JSON.stringify(h.logs);
    expect(text).not.toContain('sekrit');
    expect(text).toContain('[redacted]');
    expect(MAX_BACKOFF_MS).toBe(300_000);
  });

  it('waits as long as a partly rate-limited poll asks', async () => {
    const h = harness();
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.answer.next = async () => ({
      entities: [bus('1', 41.39, 2.17, T0)],
      rejected: 0,
      backoffSeconds: 60,
    });
    await h.hub.tick();
    h.clock.now += 59_000;
    await h.hub.tick();
    expect(h.polls).toHaveLength(1);
    h.clock.now += 1_000;
    await h.hub.tick();
    expect(h.polls).toHaveLength(2);
    // The data that did arrive was applied.
    expect(h.hub.snapshot(BARCELONA_TILE, 'transit').entities).toHaveLength(1);
  });

  it('releases an idle source after the grace period, and starts fresh', async () => {
    const h = harness();
    h.hub.watch('a', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.answer.next = async () => ({ entities: [bus('1', 41.39, 2.17, T0)], rejected: 0 });
    await h.hub.tick();
    h.hub.unwatch('a');
    // The first tick without demand starts the grace period.
    await h.hub.tick();
    h.clock.now += 30_000;
    await h.hub.tick();
    expect(h.hub.sources()[0]).toMatchObject({ status: 'idle', entityCount: 1 });
    h.clock.now += 31_000;
    await h.hub.tick();
    expect(h.hub.sources()[0]).toMatchObject({
      status: 'idle',
      entityCount: 0,
      lastUpdatedAt: null,
    });
    expect(h.polls).toHaveLength(1);
  });

  it('turns stale when the feed stops answering, and never logs a viewport', async () => {
    const h = harness();
    h.hub.watch('viewer', [{ tile: BARCELONA_TILE, kind: 'transit' }]);
    h.answer.next = async () => ({ entities: [bus('1', 41.39, 2.17, T0)], rejected: 0 });
    await h.hub.tick();
    h.answer.next = () => new Promise(() => {});
    h.clock.now += 10_000;
    await Promise.race([h.hub.tick(), Promise.resolve()]);
    h.clock.now += 40_000;
    expect(h.hub.sources()[0]?.status).toBe('stale');
    const text = JSON.stringify(h.logs);
    for (const leak of [BARCELONA_TILE, '41.39', 'viewer']) expect(text).not.toContain(leak);
    h.hub.stop();
  });

  it('counts room watchers, so one viewer leaving keeps the room for another', async () => {
    const h = harness();
    const room = { tile: BARCELONA_TILE, kind: 'transit' as const };
    expect(h.hub.watch('a', [room]).joined).toEqual([room]);
    expect(h.hub.watch('b', [room]).joined).toEqual([room]);
    h.hub.unwatch('a');
    await h.hub.tick();
    expect(h.polls).toHaveLength(1);
    expect(h.hub.watch('b', []).left).toEqual([room]);
  });
});

/**
 * `GET /transit/nearby`'s engine, with a fake clock and a fake network:
 * licence gating, coverage, bounds, the `scheduled`/`realtime` distinction,
 * what the predictions can and cannot change, memory, and what is logged.
 */

import { describe, expect, it } from 'bun:test';
import { nearbyTransitSchema } from '@goway/contracts';
import type { LiveHubLogger, LiveHubSource } from '../hub';
import { protobufWriter as w } from '../protobuf';
import { archivesOf, isServable, SCHEDULE_IDLE_MS, TransitService } from '../transit/service';
import { TransitSchedule } from '../transit/schedule';
import type { LiveFetch, LiveSourceDefinition } from '../types';
import { archiveFiles, scheduleFiles, zip } from './transitFixtures';

/** Tuesday 2026-10-20, 11:50 in Madrid: ten minutes before T1 leaves. */
const NOW = Date.parse('2026-10-20T09:50:00Z');
const HERE = { latitude: 41.3900123, longitude: 2.1700456 };
const RT_URL = 'https://rt.example/trips.bin';
const ZIP_URL = 'https://gtfs.example/test.zip';

function definition(overrides: Partial<LiveSourceDefinition> = {}): LiveSourceDefinition {
  return {
    id: 'test-bus',
    kind: 'transit',
    name: 'Buses — Test Transit',
    attribution: { label: 'Font: Test Transit', href: 'https://transit.example' },
    licence: { label: 'Test licence', href: 'https://transit.example/licence' },
    coverage: { west: 2.0, south: 41.2, east: 2.4, north: 41.6 },
    completeness: 'network',
    licenceCheck: {
      verifiedOn: '2026-10-20',
      source: 'https://transit.example/licence',
      quote: 'free and open reuse, including commercial',
    },
    defaultUrl: RT_URL,
    requiresKey: false,
    pollIntervalSeconds: 30,
    staleAfterSeconds: 120,
    dropAfterSeconds: 300,
    staticGtfs: { zip: ZIP_URL },
    departures: { realtimeUrls: (settings) => [settings.url] },
    create: () => {
      throw new Error('not polled here');
    },
    ...overrides,
  };
}

const sourceOf = (overrides: Partial<LiveSourceDefinition> = {}): LiveHubSource => ({
  definition: definition(overrides),
  settings: { url: RT_URL, userAgent: 'test', maxRegionsPerPoll: 1 },
});

function tripUpdate(tripId: string, stops: [string, number][], canceled = false): number[] {
  return w.bytes(2, [
    ...w.string(1, tripId),
    ...w.bytes(3, [
      ...w.bytes(1, [...w.string(1, tripId), ...(canceled ? w.uint(4, 3) : [])]),
      ...stops.flatMap(([stopId, time]) =>
        w.bytes(2, [...w.bytes(2, w.uint(2, time)), ...w.string(4, stopId)]),
      ),
    ]),
  ]);
}

function feedOf(headerSeconds: number, ...entities: number[][]): Uint8Array {
  return new Uint8Array([
    ...w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, headerSeconds)]),
    ...entities.flat(),
  ]);
}

const seconds = (iso: string) => Date.parse(iso) / 1000;

interface Harness {
  service: TransitService;
  requested: string[];
  logs: string[];
  clock: { now: number };
}

function harness(
  sources: LiveHubSource[],
  options: {
    realtime?: (() => Uint8Array) | 'fail';
    clock?: { now: number };
    extra?: Partial<ConstructorParameters<typeof TransitService>[0]>;
  } = {},
): Harness {
  const requested: string[] = [];
  const logs: string[] = [];
  const clock = options.clock ?? { now: NOW };
  const logger: LiveHubLogger = {
    info: (object, message) => logs.push(JSON.stringify([object, message])),
    warn: (object, message) => logs.push(JSON.stringify([object, message])),
  };
  const archive = zip(archiveFiles());
  const fetch: LiveFetch = async (url) => {
    requested.push(url);
    const respond = (status: number, body: Uint8Array) => ({
      status,
      headers: { get: () => null },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    });
    if (url === ZIP_URL) return respond(200, archive);
    if (url === RT_URL) {
      if (options.realtime === 'fail' || !options.realtime) return respond(503, new Uint8Array());
      return respond(200, options.realtime());
    }
    return respond(404, new Uint8Array());
  };
  const service = new TransitService({
    sources,
    fetch,
    now: () => clock.now,
    logger,
    ...options.extra,
  });
  return { service, requested, logs, clock };
}

describe('what is served', () => {
  it('only an enrolled source with a read licence and a whole-archive timetable', () => {
    expect(isServable(definition())).toBe(true);
    // Not enrolled in departures.
    const { departures: _enrolled, ...notEnrolled } = definition();
    expect(isServable(notEnrolled as LiveSourceDefinition)).toBe(false);
    // No licence as READ.
    expect(
      isServable(
        definition({ licenceCheck: { verifiedOn: '', source: 'https://x.example', quote: '' } }),
      ),
    ).toBe(false);
    expect(
      isServable(definition({ licence: { label: 'Terms', href: 'http://transit.example/terms' } })),
    ).toBe(false);
    expect(isServable(definition({ attribution: { label: '', href: 'https://x.example' } }))).toBe(
      false,
    );
    // A routes-only static file has no stop times; separate files are not an archive.
    expect(isServable(definition({ staticGtfs: { zip: ZIP_URL, only: 'routes' } }))).toBe(false);
    expect(isServable(definition({ staticGtfs: { routes: 'a', trips: 'b', shapes: 'c' } }))).toBe(
      false,
    );
    expect(isServable(definition({ kind: 'aircraft' }))).toBe(false);
    expect(archivesOf(definition({ staticGtfs: { zips: ['a', 'b'] } }))).toEqual(['a', 'b']);
  });

  it('never fetches, names or answers for a source that is not servable', async () => {
    const { departures: _enrolled, ...notEnrolled } = definition({ id: 'not-enrolled' });
    const unlicensed = definition({
      id: 'unlicensed',
      licenceCheck: { verifiedOn: '', source: '', quote: '' },
    });
    const h = harness([
      { definition: notEnrolled as LiveSourceDefinition, settings: sourceOf().settings },
      { definition: unlicensed, settings: sourceOf().settings },
    ]);
    expect(h.service.operatorIds()).toEqual([]);
    const answer = await h.service.nearby(HERE);
    expect(answer.stops).toEqual([]);
    expect(answer.operators).toEqual([]);
    expect(h.requested).toEqual([]);
  });
});

describe('coverage', () => {
  it('answers an empty list, not an error, where no served operator is', async () => {
    const h = harness([sourceOf()]);
    const answer = await h.service.nearby({ latitude: 48.85, longitude: 2.35 });
    expect(answer).toMatchObject({ stops: [], operators: [] });
    expect(nearbyTransitSchema.safeParse(answer).success).toBe(true);
    // Nothing was downloaded for a point outside every coverage.
    expect(h.requested).toEqual([]);
  });

  it('lists the operator covering a point even when none of its stops is in range', async () => {
    const h = harness([sourceOf()]);
    const answer = await h.service.nearby({ latitude: 41.3, longitude: 2.3, radiusMeters: 50 });
    expect(answer.stops).toEqual([]);
    expect(answer.operators.map((o) => [o.id, o.availability])).toEqual([['test-bus', 'ready']]);
  });
});

describe('bounds', () => {
  it('refuses a radius, a stop count or a departure count outside the contract', async () => {
    const h = harness([sourceOf()]);
    for (const bad of [
      { radiusMeters: 5000 },
      { radiusMeters: 10 },
      { radiusMeters: 100.5 },
      { maxStops: 0 },
      { maxStops: 11 },
      { maxDepartures: 11 },
      { latitude: 91 },
    ])
      await expect(h.service.nearby({ ...HERE, ...bad })).rejects.toThrow();
    expect(h.requested).toEqual([]);
  });

  it('caps stops and departures at what was asked', async () => {
    const h = harness([sourceOf()]);
    const answer = await h.service.nearby({ ...HERE, maxStops: 1, maxDepartures: 1 });
    expect(answer.stops).toHaveLength(1);
    expect(answer.stops[0]?.departures).toHaveLength(1);
  });
});

describe('scheduled and realtime', () => {
  it('serves the timetable as `scheduled` when the operator publishes no predictions', async () => {
    const h = harness([sourceOf({ departures: {} })]);
    const answer = await h.service.nearby(HERE);
    expect(nearbyTransitSchema.safeParse(answer).success).toBe(true);
    expect(answer.operators[0]).toMatchObject({
      id: 'test-bus',
      realtime: 'none',
      realtimeAt: null,
      attribution: { label: 'Font: Test Transit' },
      licence: { label: 'Test licence' },
    });
    const stop = answer.stops[0];
    expect(stop).toMatchObject({
      id: 'test-bus:ST',
      operatorId: 'test-bus',
      name: 'Plaça Test',
      // Every line that calls here in the published timetable, whichever day it runs:
      // M1 is a Sunday service.
      modes: ['bus', 'subway'],
    });
    expect(stop?.distanceMeters).toBeLessThan(30);
    expect(stop?.departures.map((d) => [d.time, d.basis, d.headsign, d.delaySeconds])).toEqual([
      ['2026-10-20T10:00:00.000Z', 'scheduled', 'Nord Terminal', undefined],
      ['2026-10-20T10:10:00.000Z', 'scheduled', 'Nord Terminal', undefined],
    ]);
    expect(stop?.lines).toEqual([
      {
        id: 'L1',
        shortName: 'L1',
        longName: 'Plaça Test - Nord',
        mode: 'bus',
        color: '#112233',
        textColor: '#FFFFFF',
      },
      // No colour published, none invented; no short name, none made up.
      {
        id: 'M1',
        shortName: null,
        longName: 'Línia Metro Un',
        mode: 'subway',
        color: null,
        textColor: null,
      },
    ]);
    // The operator's prediction feed is never asked.
    expect(h.requested).toEqual([ZIP_URL]);
  });

  it('marks a predicted trip `realtime` with its delay, and leaves the rest `scheduled`', async () => {
    const h = harness([sourceOf()], {
      // T1 is predicted 4 minutes late at its first stop.
      realtime: () =>
        feedOf(
          seconds('2026-10-20T09:49:30Z'),
          tripUpdate('T1', [
            ['P1', seconds('2026-10-20T10:04:00Z')],
            ['NORD', seconds('2026-10-20T10:24:00Z')],
          ]),
        ),
    });
    const answer = await h.service.nearby(HERE);
    expect(answer.operators[0]).toMatchObject({
      realtime: 'live',
      realtimeAt: '2026-10-20T09:49:30.000Z',
    });
    expect(answer.stops[0]?.departures).toEqual([
      {
        lineId: 'L1',
        headsign: 'Nord Terminal',
        time: '2026-10-20T10:04:00.000Z',
        basis: 'realtime',
        delaySeconds: 240,
      },
      {
        lineId: 'L1',
        headsign: 'Nord Terminal',
        time: '2026-10-20T10:10:00.000Z',
        basis: 'scheduled',
      },
    ]);
    expect(nearbyTransitSchema.safeParse(answer).success).toBe(true);
  });

  it('does not apply a prediction whose trip id is not one of the timetable (never guessed)', async () => {
    const h = harness([sourceOf()], {
      realtime: () =>
        feedOf(
          seconds('2026-10-20T09:49:30Z'),
          tripUpdate('SOME-OTHER-ID', [['P1', seconds('2026-10-20T10:04:00Z')]]),
        ),
    });
    const answer = await h.service.nearby(HERE);
    expect(answer.stops[0]?.departures.map((d) => d.basis)).toEqual(['scheduled', 'scheduled']);
  });

  it('drops a departure the prediction says has already passed, and a canceled trip', async () => {
    const h = harness([sourceOf()], {
      realtime: () =>
        feedOf(
          seconds('2026-10-20T09:49:30Z'),
          // The first predicted stop of T1 is the terminus: it has left P1.
          tripUpdate('T1', [['NORD', seconds('2026-10-20T10:20:00Z')]]),
          tripUpdate('T2', [], true),
        ),
    });
    const answer = await h.service.nearby(HERE);
    expect(answer.stops[0]?.departures).toEqual([]);
    // Its lines still tell the reader which lines call here.
    expect(answer.stops[0]?.lines.map((l) => l.id)).toEqual(['L1', 'M1']);
  });

  it('shows every departure as `scheduled` when the prediction feed is down, and says so', async () => {
    const h = harness([sourceOf()], { realtime: 'fail' });
    const answer = await h.service.nearby(HERE);
    expect(answer.operators[0]).toMatchObject({ realtime: 'unavailable', realtimeAt: null });
    expect(answer.stops[0]?.departures.map((d) => d.basis)).toEqual(['scheduled', 'scheduled']);
    expect(answer.stops[0]?.departures.every((d) => d.delaySeconds === undefined)).toBe(true);
  });

  it('ignores predictions older than five minutes by the feed own clock', async () => {
    const h = harness([sourceOf()], {
      realtime: () =>
        feedOf(
          seconds('2026-10-20T09:40:00Z'),
          tripUpdate('T1', [['P1', seconds('2026-10-20T10:04:00Z')]]),
        ),
    });
    const answer = await h.service.nearby(HERE);
    expect(answer.operators[0]?.realtime).toBe('unavailable');
    expect(answer.stops[0]?.departures.map((d) => d.basis)).toEqual(['scheduled', 'scheduled']);
  });

  it('asks the prediction feed once per interval however many requests arrive', async () => {
    const h = harness([sourceOf()], {
      realtime: () => feedOf(seconds('2026-10-20T09:49:30Z')),
    });
    await Promise.all([h.service.nearby(HERE), h.service.nearby(HERE), h.service.nearby(HERE)]);
    await h.service.nearby(HERE);
    expect(h.requested.filter((url) => url === RT_URL)).toHaveLength(1);
    h.clock.now += 31_000;
    await h.service.nearby(HERE);
    expect(h.requested.filter((url) => url === RT_URL)).toHaveLength(2);
    expect(h.requested.filter((url) => url === ZIP_URL)).toHaveLength(1);
  });
});

describe('the timetable in memory', () => {
  it('answers `preparing` while a timetable is still being read, then serves it', async () => {
    let release: (schedules: TransitSchedule[]) => void = () => {};
    const slow = new Promise<TransitSchedule[]>((resolve) => {
      release = resolve;
    });
    const h = harness([sourceOf({ departures: {} })], {
      extra: { loadWaitMs: 5, loadSchedules: () => slow },
    });
    const first = await h.service.nearby(HERE);
    expect(first.stops).toEqual([]);
    expect(first.operators[0]).toMatchObject({ availability: 'preparing', scheduleReadAt: null });
    release([await TransitSchedule.build(scheduleFiles(), NOW)]);
    await slow;
    const second = await h.service.nearby(HERE);
    expect(second.operators[0]?.availability).toBe('ready');
    expect(second.stops).toHaveLength(1);
  });

  it('gives up with `unavailable` after repeated failures, backing off between tries', async () => {
    let tries = 0;
    const h = harness([sourceOf({ departures: {} })], {
      extra: {
        loadSchedules: async () => {
          tries++;
          throw new Error('upstream down');
        },
      },
    });
    for (let i = 0; i < 6; i++) {
      await h.service.nearby(HERE);
      h.clock.now += 5 * 60_000;
    }
    const answer = await h.service.nearby(HERE);
    expect(answer.operators[0]?.availability).toBe('unavailable');
    expect(tries).toBeGreaterThanOrEqual(3);
    expect(tries).toBeLessThan(7);
  });

  it('lets the least recently used timetable go past the row budget', async () => {
    const a = sourceOf({ id: 'bus-a' });
    const b = sourceOf({ id: 'bus-b' });
    const h = harness([a, b], { extra: { maxResidentRows: 12 } });
    await h.service.nearby(HERE);
    // Both cover the point and both loaded (10 rows each): the budget (12) forces one out.
    expect(h.service.residentRows()).toBeLessThanOrEqual(12);
  });

  it('releases a timetable nobody has asked about for two hours', async () => {
    const h = harness([sourceOf({ departures: {} })]);
    await h.service.nearby(HERE);
    expect(h.service.residentRows()).toBe(10);
    h.clock.now += SCHEDULE_IDLE_MS + 1;
    await h.service.nearby({ latitude: 48.85, longitude: 2.35 });
    expect(h.service.residentRows()).toBe(0);
  });
});

describe('privacy', () => {
  it('never writes the requested position to a log, whether the timetable loads or fails', async () => {
    const failing = harness([sourceOf()], {
      extra: {
        loadSchedules: async () => {
          throw new Error('upstream answered 500');
        },
      },
    });
    await failing.service.nearby(HERE);
    const working = harness([sourceOf()], { realtime: 'fail' });
    await working.service.nearby(HERE);
    const logged = [...failing.logs, ...working.logs].join('\n');
    expect(logged.length).toBeGreaterThan(0);
    expect(logged).not.toContain('41.39');
    expect(logged).not.toContain('2.1700');
    expect(logged).toContain('test-bus');
  });

  it('keeps no state keyed by a position: the same point twice reads nothing it did not before', async () => {
    const h = harness([sourceOf({ departures: {} })]);
    const first = await h.service.nearby(HERE);
    const second = await h.service.nearby(HERE);
    expect(second).toEqual(first);
    expect(h.requested).toEqual([ZIP_URL]);
  });
});

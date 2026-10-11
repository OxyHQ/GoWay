/**
 * Estimated positions from arrival predictions: where a trip's vehicle is
 * placed along its line, when it is not placed at all, and that every entity
 * says it is an estimate.
 */

import { describe, expect, it } from 'bun:test';
import {
  createArrivalEstimateAdapter,
  estimateAlong,
  MAX_LEAD_SECONDS,
} from '../adapters/arrivalEstimates';
import { protobufWriter as w } from '../protobuf';
import { buildStaticGtfs } from '../staticGtfs';

describe('estimateAlong', () => {
  const stops = [
    { along: 0, time: 900 },
    { along: 1000, time: 1060 },
    { along: 2000, time: 1180 },
  ];

  it('places the vehicle short of its next stop by the distance left at that leg’s pace', () => {
    // Due at 1000 m in 60 s; the next leg (1000 m) takes 120 s: 500 m short.
    expect(estimateAlong(stops, null, 1000, 3000)?.along).toBeCloseTo(500, 6);
  });

  it('is at a stop the feed says it is stopped at', () => {
    expect(estimateAlong(stops, 1000, 1000, 3000)).toEqual({ along: 1000 });
  });

  it('is at a stop that is due now', () => {
    expect(estimateAlong(stops, null, 1060, 3000)).toEqual({ along: 1000 });
  });

  it('never goes back more than one spacing', () => {
    // Due in 500 s, the next leg takes 120 s: capped at 1000 m back.
    expect(
      estimateAlong(
        [
          { along: 1000, time: 1500 },
          { along: 2000, time: 1620 },
        ],
        null,
        1000,
        3000,
      )?.along,
    ).toBe(0);
  });

  it('says nothing for a trip whose next stop is far off, or that has not left its first stop', () => {
    expect(
      estimateAlong(
        [
          { along: 500, time: 1000 + MAX_LEAD_SECONDS + 1 },
          { along: 900, time: 2000 },
        ],
        null,
        1000,
        3000,
      ),
    ).toBeNull();
    expect(
      estimateAlong(
        [
          { along: 0, time: 1300 },
          { along: 900, time: 1400 },
        ],
        null,
        1000,
        3000,
      ),
    ).toBeNull();
  });

  it('with one stop left, shows it only when about to arrive', () => {
    expect(estimateAlong([{ along: 2000, time: 1060 }], null, 1000, 3000)).toEqual({ along: 2000 });
    expect(estimateAlong([{ along: 2000, time: 1200 }], null, 1000, 3000)).toBeNull();
    expect(estimateAlong([], null, 1000, 3000)).toBeNull();
  });
});

// A straight line east along 41.40°N: 0.01° of longitude is ~834 m.
const gtfs = buildStaticGtfs({
  routes:
    'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\n1,1,Broadway,1,EE352E,FFFFFF\n',
  trips: 'route_id,service_id,trip_id,trip_headsign,shape_id\n1,s,T1,,east\n',
  shapes: [
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
    'east,41.40,2.10,1',
    'east,41.40,2.11,2',
    'loop..S,41.40,2.10,1',
    'loop..S,41.40,2.11,2',
  ].join('\n'),
  stops:
    'stop_id,stop_name,stop_lat,stop_lon\nA,A,41.4001,2.104\nB,B,41.4001,2.108\nFAR,Far,41.50,2.104\n',
});

function tripUpdate(tripId: string, stops: [string, number][]): number[] {
  return w.bytes(2, [
    ...w.string(1, tripId),
    ...w.bytes(3, [
      ...w.bytes(1, [...w.string(1, tripId), ...w.string(5, '1')]),
      ...stops.flatMap(([stopId, time]) =>
        w.bytes(2, [...w.bytes(2, w.uint(2, time)), ...w.string(4, stopId)]),
      ),
    ]),
  ]);
}

function feedOf(header: number, ...entities: number[][]): Uint8Array {
  return new Uint8Array([
    ...w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, header)]),
    ...entities.flat(),
  ]);
}

describe('the arrival-estimate adapter', () => {
  const now = 1_800_000_000;
  const body = feedOf(
    now,
    // Due at A (334 m) in 30 s; A→B (333 m) takes 60 s: ~167 m short of A.
    tripUpdate('T1', [
      ['A', now + 30],
      ['B', now + 90],
    ]),
    // Not in trips.txt: its shape comes from the id.
    tripUpdate('0600_loop..S', [
      ['A', now],
      ['B', now + 60],
    ]),
    // Neither listed nor named by its id: its route's shape its stops lie along, in order.
    tripUpdate('realtime-only', [
      ['A', now + 30],
      ['B', now + 90],
    ]),
    // No shape its stops lie along at all.
    tripUpdate('nowhere', [['FAR', now + 30]]),
    // Its only stop is off the line: nothing to estimate on.
    tripUpdate('0700_east', [['FAR', now + 30]]),
  );
  const adapter = createArrivalEstimateAdapter(
    {
      sourceId: 'mta-subway',
      operator: 'MTA',
      defaultMode: 'subway',
      urls: ['https://feed.test/a'],
      shapeIdOf: (id) => id.split('_').slice(1).join('_') || null,
    },
    { url: 'https://feed.test/a', userAgent: 'test', maxRegionsPerPoll: 1 },
  );
  const context = (staticGtfs: typeof gtfs | undefined) => ({
    signal: new AbortController().signal,
    fetch: (async () => new Response(body)) as unknown as typeof fetch,
    now: () => now * 1000,
    demand: [],
    staticGtfs,
  });

  it('estimates along the line, says so, and drops what it cannot place', async () => {
    const result = await adapter.poll(context(gtfs));
    expect(result.entities.map((entity) => entity.id).sort()).toEqual([
      'mta-subway:0600_loop..S',
      'mta-subway:T1',
      'mta-subway:realtime-only',
    ]);
    const fallback = result.entities.find((entity) => entity.id === 'mta-subway:realtime-only');
    expect(fallback?.kind === 'transit' && fallback.track?.shapeId).toBe('east');
    const t1 = result.entities.find((entity) => entity.id === 'mta-subway:T1');
    if (t1?.kind !== 'transit') throw new Error('expected a transit vehicle');
    expect(t1.positionBasis).toBe('estimated');
    expect(t1.trackStatus).toBe('on_track');
    expect(t1.track?.shapeId).toBe('east');
    expect(t1.track?.alongMeters).toBeGreaterThan(150);
    expect(t1.track?.alongMeters).toBeLessThan(185);
    expect(t1.position.latitude).toBeCloseTo(41.4, 6);
    expect(t1.line).toBe('1');
    expect(t1.lineColor).toBe('#EE352E');
    expect(t1.speedMetersPerSecond).toBeNull();
    const loop = result.entities.find((entity) => entity.id === 'mta-subway:0600_loop..S');
    if (loop?.kind !== 'transit') throw new Error('expected a transit vehicle');
    expect(loop.track?.shapeId).toBe('loop..S');
    // Due at A now: at A.
    expect(loop.position.longitude).toBeCloseTo(2.104, 3);
    expect(result.rejected).toBe(1);
  });

  it('shows nothing until the line is known', async () => {
    expect(await adapter.poll(context(undefined))).toEqual({ entities: [], rejected: 0 });
  });
});

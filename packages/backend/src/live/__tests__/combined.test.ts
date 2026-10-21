/**
 * One source over several upstream feeds (Renfe's commuter and long-distance
 * feeds): a train in both is drawn once, from the first; a failed feed does
 * not take the other down. And a static GTFS without shapes still loads.
 */
import { describe, expect, it } from 'bun:test';
import type { LiveEntity } from '@goway/contracts';
import { createCombinedAdapter } from '../adapters/combined';
import { sourceAreas } from '../areas';
import { LIVE_SOURCES } from '../catalogue';
import { buildStaticGtfs, findTrip } from '../staticGtfs';
import { protobufWriter as w } from '../protobuf';
import type { LiveAdapter, LiveFetch, LiveFetchContext, LivePollResult } from '../types';
import { LiveUpstreamError } from '../types';

const T0 = Date.parse('2026-10-12T20:00:00Z');

function train(id: string, label: string | null, line: string | null): LiveEntity {
  return {
    kind: 'transit',
    id: `renfe-cercanias:${id}`,
    sourceId: 'renfe-cercanias',
    position: { latitude: 41.84, longitude: 2.8 },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt: new Date(T0).toISOString(),
    mode: 'rail',
    operator: 'Renfe',
    line,
    headsign: null,
    vehicleLabel: label,
    lineColor: null,
    lineTextColor: null,
    track: null,
    trackStatus: 'unknown',
    positionBasis: 'reported',
  };
}

const fixed = (result: LivePollResult | Error): LiveAdapter => ({
  poll: async () => {
    if (result instanceof Error) throw result;
    return result;
  },
});

const clock = { now: T0 };
const context = { now: () => clock.now } as LiveFetchContext;
const byTrain = (entity: LiveEntity) =>
  entity.kind === 'transit' && entity.vehicleLabel ? `train:${entity.vehicleLabel}` : entity.id;

describe('createCombinedAdapter', () => {
  it('draws a train listed in both feeds once, from the first', async () => {
    const adapter = createCombinedAdapter(
      [
        fixed({ entities: [train('15736', '15736', 'R11')], rejected: 0 }),
        fixed({
          entities: [train('ld-15736', '15736', null), train('ld-04179', '04179', null)],
          rejected: 1,
        }),
      ],
      byTrain,
    );
    const result = await adapter.poll(context);
    expect(result.entities.map((e) => e.id)).toEqual([
      'renfe-cercanias:15736',
      'renfe-cercanias:ld-04179',
    ]);
    expect(result.rejected).toBe(1);
  });

  it('keeps the feeds that answered when one fails, and fails only when all do', async () => {
    const one = createCombinedAdapter(
      [fixed(new Error('504')), fixed({ entities: [train('ld-1', '1', null)], rejected: 0 })],
      byTrain,
    );
    expect((await one.poll(context)).entities).toHaveLength(1);
    const none = createCombinedAdapter([fixed(new Error('a')), fixed(new Error('b'))], byTrain);
    await expect(none.poll(context)).rejects.toThrow('b');
  });
});

describe('a part that fails', () => {
  /** An adapter whose answers the test sets, counting its polls. */
  const scripted = () => {
    const part = {
      calls: 0,
      next: (): LivePollResult | Error => ({ entities: [], rejected: 0 }),
      adapter: {
        poll: async () => {
          part.calls++;
          const answer = part.next();
          if (answer instanceof Error) throw answer;
          return answer;
        },
      } as LiveAdapter,
    };
    return part;
  };

  it('keeps what it last sent, says so, and is not asked again before its Retry-After', async () => {
    clock.now = T0;
    const commuter = scripted();
    const longDistance = scripted();
    commuter.next = () => ({ entities: [train('15736', '15736', 'R11')], rejected: 0 });
    longDistance.next = () => ({ entities: [train('ld-04179', '04179', null)], rejected: 0 });
    const adapter = createCombinedAdapter([commuter.adapter, longDistance.adapter], byTrain);
    expect((await adapter.poll(context)).degraded).toBeUndefined();

    // The long-distance feed goes down, asking for two minutes.
    longDistance.next = () => new LiveUpstreamError('upstream answered 503', 120, 503);
    clock.now += 20_000;
    const partial = await adapter.poll(context);
    expect(partial.entities.map((e) => e.id).sort()).toEqual([
      'renfe-cercanias:15736',
      'renfe-cercanias:ld-04179',
    ]);
    expect(partial.degraded).toMatch(/1 of 2 feeds/);
    // At +21 s and +42 s it is not asked; its trains still stand.
    for (const step of [21_000, 21_000]) {
      clock.now += step;
      const again = await adapter.poll(context);
      expect(again.entities).toHaveLength(2);
    }
    expect(longDistance.calls).toBe(2);
    // After its two minutes it is asked again, and answers.
    clock.now += 80_000;
    longDistance.next = () => ({ entities: [train('ld-04179', '04179', null)], rejected: 0 });
    expect((await adapter.poll(context)).degraded).toBeUndefined();
    expect(longDistance.calls).toBe(3);
  });

  it('keeps a train in both feeds the same id when the first fails', async () => {
    clock.now = T0;
    const commuter = scripted();
    const longDistance = scripted();
    commuter.next = () => ({ entities: [train('15736', '15736', 'R11')], rejected: 0 });
    longDistance.next = () => ({ entities: [train('ld-15736', '15736', null)], rejected: 0 });
    const adapter = createCombinedAdapter([commuter.adapter, longDistance.adapter], byTrain);
    expect((await adapter.poll(context)).entities.map((e) => e.id)).toEqual([
      'renfe-cercanias:15736',
    ]);
    commuter.next = () => new Error('504');
    clock.now += 20_000;
    expect((await adapter.poll(context)).entities.map((e) => e.id)).toEqual([
      'renfe-cercanias:15736',
    ]);
  });
});

describe('the Renfe source', () => {
  it("draws a train in both of Renfe's feeds once, by its number, and prefixes the long-distance ids", async () => {
    const renfe = LIVE_SOURCES.find((source) => source.id === 'renfe-cercanias');
    if (!renfe) throw new Error('no Renfe');
    const now = Math.floor(Date.now() / 1000);
    const feed = (vehicles: [string, string][]) => {
      const header = w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, now)]);
      const entities = vehicles.flatMap(([id, label]) =>
        w.bytes(2, [
          ...w.string(1, id),
          ...w.bytes(4, [
            ...w.bytes(8, [...w.string(1, id), ...w.string(2, label)]),
            ...w.bytes(2, [...w.float(1, 41.84), ...w.float(2, 2.8)]),
            ...w.uint(5, now),
          ]),
        ]),
      );
      return new Uint8Array([...header, ...entities]);
    };
    const bodies: Record<string, Uint8Array> = {
      'https://gtfsrt.renfe.com/vehicle_positions.pb': feed([['VP_15736', 'R11-15736-PLATF.(1)']]),
      'https://gtfsrt.renfe.com/vehicle_positions_LD.pb': feed([
        ['VP_15736', '15736'],
        ['VP_04179', '04179'],
      ]),
    };
    const fetch: LiveFetch = async (url) => {
      const body = bodies[url] ?? new Uint8Array();
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
          body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
      };
    };
    const result = await renfe
      .create({ url: renfe.defaultUrl, userAgent: 'test', maxRegionsPerPoll: 1 })
      .poll({ signal: new AbortController().signal, fetch, now: Date.now, demand: [] });
    expect(result.entities.map((e) => e.id).sort()).toEqual([
      'renfe-cercanias:VP_15736',
      'renfe-cercanias:ld-VP_04179',
    ]);
  });

  it('reads the commuter AND the long-distance feed, with both static files', () => {
    const renfe = LIVE_SOURCES.find((source) => source.id === 'renfe-cercanias');
    expect(renfe?.staticGtfs).toEqual({
      zips: [
        'https://ssl.renfe.com/ftransit/Fichero_CER_FOMENTO/fomento_transit.zip',
        'https://ssl.renfe.com/gtransit/Fichero_AV_LD/google_transit.zip',
      ],
    });
    // Its coverage is the box round both files' stations: the long-distance
    // trains reach Lyon and Marseille.
    expect(renfe?.coverage).toEqual(sourceAreas('renfe-cercanias')?.outer);
    expect(renfe?.coverage?.north).toBeGreaterThan(45.7);
  });
});

describe('a static GTFS without shapes', () => {
  it('still names the lines', () => {
    const gtfs = buildStaticGtfs({
      routes: 'route_id,route_short_name,route_long_name,route_type,route_color\nX,AVE,,2,F2F5F5\n',
      trips: 'route_id,service_id,trip_id,trip_short_name,shape_id\nX,s,0417912026-10-12,04179,\n',
      shapes: 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n',
    });
    const trip = findTrip(gtfs, '0417912026-10-12');
    expect(gtfs.routes.get(trip?.routeId ?? '')?.shortName).toBe('AVE');
    expect(trip?.shapeId).toBeNull();
  });
});

describe('a route type names the mode', () => {
  it('basic and extended GTFS types', async () => {
    const { modeOfRouteType } = await import('../staticGtfs');
    expect(['0', '1', '2', '3', '4', '6', '11', '12'].map(modeOfRouteType)).toEqual([
      'tram',
      'subway',
      'rail',
      'bus',
      'ferry',
      'cable',
      'bus',
      'subway',
    ]);
    expect(['109', '401', '700', '900', '1000', '1400', 'x', '-1'].map(modeOfRouteType)).toEqual([
      'rail',
      'subway',
      'bus',
      'tram',
      'ferry',
      'cable',
      null,
      null,
    ]);
    // Entur's airport routes are 1102, "Domestic Air Service": not a boat.
    expect(['1004', '1102', '1200', '1501'].map(modeOfRouteType)).toEqual([
      'ferry',
      null,
      'ferry',
      null,
    ]);
  });
});

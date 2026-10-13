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
import type { LiveAdapter, LiveFetchContext, LivePollResult } from '../types';

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

const context = {} as LiveFetchContext;
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

describe('the Renfe source', () => {
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

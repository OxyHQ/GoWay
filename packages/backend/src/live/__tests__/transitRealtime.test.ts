/**
 * Predictions joined to a timetable: the decoder's new fields, the day a
 * prediction belongs to, delay propagation and what is dropped.
 */

import { describe, expect, it } from 'bun:test';
import { decodeGtfsRealtime, protobufWriter as w } from '../protobuf';
import { applyRealtime, joinRealtime, MAX_RECONCILE_SECONDS } from '../transit/realtime';
import { serviceDays, TransitSchedule } from '../transit/schedule';
import { scheduleFiles } from './transitFixtures';

const NOW = Date.parse('2026-10-20T09:50:00Z');
const at = (iso: string) => Date.parse(iso) / 1000;

/** A three-stop trip on the fixture's stops: P1 12:00, P2 12:05, NORD 12:20. */
const files = scheduleFiles({
  trips: `${scheduleFiles().trips}\nL1,WD,TX,Nord Terminal`,
  stopTimes: [
    scheduleFiles().stopTimes,
    'TX,12:00:00,12:00:00,P1,1,0',
    'TX,12:05:00,12:05:00,P2,2,0',
    'TX,12:20:00,12:20:00,NORD,3,0',
  ].join('\n'),
});

function entity(tripId: string, options: { canceled?: boolean; stops?: number[][] } = {}) {
  return w.bytes(2, [
    ...w.string(1, tripId),
    ...w.bytes(3, [
      ...w.bytes(1, [...w.string(1, tripId), ...(options.canceled ? w.uint(4, 3) : [])]),
      ...(options.stops ?? []).flat(),
    ]),
  ]);
}

const stop = (stopId: string, time?: number, relationship?: number) =>
  w.bytes(2, [
    ...(time === undefined ? [] : w.bytes(2, w.uint(2, time))),
    ...w.string(4, stopId),
    ...(relationship === undefined ? [] : w.uint(5, relationship)),
  ]);

const feed = (...entities: number[][]) =>
  new Uint8Array([
    ...w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, at('2026-10-20T09:49:00Z'))]),
    ...entities.flat(),
  ]);

describe('the GTFS-Realtime reader', () => {
  it('reads a canceled trip and a skipped or empty stop', () => {
    const decoded = decodeGtfsRealtime(
      feed(
        entity('A', { canceled: true }),
        entity('B', { stops: [stop('P1', 10, 1), stop('P2', undefined, 2), stop('NORD', 30)] }),
        entity('C', { stops: [stop('P1', 10)] }),
      ),
    );
    const [a, b, c] = decoded.tripUpdates;
    expect(a).toMatchObject({ tripId: 'A', canceled: true });
    expect(b?.canceled).toBeUndefined();
    expect(b?.stops).toEqual([
      { stopId: 'P1', arrival: 10, skipped: true },
      { stopId: 'P2', noData: true },
      { stopId: 'NORD', arrival: 30 },
    ]);
    expect(c?.stops).toEqual([{ stopId: 'P1', arrival: 10 }]);
  });
});

describe('joinRealtime / applyRealtime', () => {
  const build = () => TransitSchedule.build(files, NOW);
  const days = serviceDays(NOW, 'Europe/Madrid');
  const departureAt = (schedule: TransitSchedule, tripId: string, stopId: string) => {
    const [{ group }] = schedule.stationsNear(41.39, 2.17, 300) as unknown as [{ group: number }];
    const found = schedule
      .scheduledDepartures(group, days, NOW, NOW + 6 * 3600_000, 100)
      .find(
        (d) =>
          schedule.tripIndexOf(tripId) === d.trip &&
          schedule.stopOfRow(d.row) === schedule.stopIndexOf(stopId),
      );
    if (!found) throw new Error(`no departure of ${tripId} at ${stopId}`);
    return found;
  };

  it('carries the last predicted delay to the stops after it', async () => {
    const schedule = await build();
    const updates = decodeGtfsRealtime(
      feed(entity('TX', { stops: [stop('P1', at('2026-10-20T10:02:00Z'))] })),
    ).tripUpdates;
    const joined = joinRealtime(schedule, updates, days, NOW);
    const trip = schedule.tripIndexOf('TX') as number;
    expect(joined.get(trip)?.updates).toEqual([
      { position: 0, timeMs: Date.parse('2026-10-20T10:02:00Z'), delaySeconds: 120 },
    ]);
    // P2 has no prediction: it inherits P1's two minutes.
    expect(applyRealtime(schedule, departureAt(schedule, 'TX', 'P2'), joined.get(trip))).toEqual({
      timeMs: Date.parse('2026-10-20T10:07:00Z'),
      delaySeconds: 120,
    });
  });

  it('drops the stops before the first prediction (passed), a skipped stop and a canceled trip', async () => {
    const schedule = await build();
    const joined = joinRealtime(
      schedule,
      decodeGtfsRealtime(
        feed(
          // Only P2 onwards is predicted: P1 is behind the vehicle.
          entity('TX', { stops: [stop('P2', at('2026-10-20T10:05:00Z'))] }),
          entity('T1', { stops: [stop('P1', 0, 1), stop('NORD', at('2026-10-20T10:20:00Z'))] }),
          entity('T2', { canceled: true }),
        ),
      ).tripUpdates,
      days,
      NOW,
    );
    expect(
      applyRealtime(
        schedule,
        departureAt(schedule, 'TX', 'P1'),
        joined.get(schedule.tripIndexOf('TX') as number),
      ),
    ).toBe('drop');
    expect(
      applyRealtime(
        schedule,
        departureAt(schedule, 'T1', 'P1'),
        joined.get(schedule.tripIndexOf('T1') as number),
      ),
    ).toBe('drop');
    expect(
      applyRealtime(
        schedule,
        departureAt(schedule, 'T2', 'P2'),
        joined.get(schedule.tripIndexOf('T2') as number),
      ),
    ).toBe('drop');
  });

  it('leaves a trip scheduled when its prediction is for another day or an unrelated hour', async () => {
    const schedule = await build();
    // TX runs at 12:00 local; a prediction 8 hours from any of its service days is not this trip.
    const far = at('2026-10-20T10:00:00Z') + MAX_RECONCILE_SECONDS + 3600 * 5;
    const joined = joinRealtime(
      schedule,
      decodeGtfsRealtime(feed(entity('TX', { stops: [stop('P1', far)] }))).tripUpdates,
      days,
      NOW,
    );
    expect(joined.size).toBe(0);
    // An id the timetable does not have is never matched.
    expect(
      joinRealtime(
        schedule,
        decodeGtfsRealtime(
          feed(entity('nope', { stops: [stop('P1', at('2026-10-20T10:00:00Z'))] })),
        ).tripUpdates,
        days,
        NOW,
      ).size,
    ).toBe(0);
  });

  it('applies a prediction only to the service day it was reconciled with', async () => {
    const schedule = await build();
    const joined = joinRealtime(
      schedule,
      decodeGtfsRealtime(feed(entity('TX', { stops: [stop('P1', at('2026-10-20T10:02:00Z'))] })))
        .tripUpdates,
      days,
      NOW,
    );
    const trip = schedule.tripIndexOf('TX') as number;
    const today = departureAt(schedule, 'TX', 'P1');
    const tomorrow = {
      ...today,
      dayStartMs: today.dayStartMs + 86_400_000,
      timeMs: today.timeMs + 86_400_000,
    };
    expect(applyRealtime(schedule, tomorrow, joined.get(trip))).toBeNull();
  });
});

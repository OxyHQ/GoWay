/**
 * The timetable index: what it keeps, what it refuses to guess, and how it
 * reads a service day.
 */

import { describe, expect, it } from 'bun:test';
import {
  gtfsSeconds,
  ScheduleUnsupportedError,
  serviceDays,
  TransitSchedule,
} from '../transit/schedule';
import { scheduleFiles } from './transitFixtures';

/** Tuesday 2026-10-20, 12:00 in Madrid (UTC+2). */
const NOON = Date.parse('2026-10-20T10:00:00Z');
const read = (overrides = {}) => TransitSchedule.build(scheduleFiles(overrides), NOON);
const iso = (ms: number) => new Date(ms).toISOString();

describe('gtfsSeconds', () => {
  it('reads times past 24:00 and refuses what is not a time', () => {
    expect(gtfsSeconds('06:05:00')).toBe(6 * 3600 + 300);
    expect(gtfsSeconds('6:05:00')).toBe(6 * 3600 + 300);
    expect(gtfsSeconds('25:10:00')).toBe(25 * 3600 + 600);
    for (const bad of ['', undefined, '12:00', 'ab:cd:ef', '12:61:00', '-1:00:00'])
      expect(gtfsSeconds(bad as string | undefined)).toBe(-1);
  });
});

describe('service days', () => {
  it('start at noon minus twelve hours, not at midnight, on a daylight-saving day', () => {
    // Madrid fell back on Sunday 2026-10-25: that service day is 25 hours long.
    const [, today] = serviceDays(Date.parse('2026-10-25T08:00:00Z'), 'Europe/Madrid');
    expect(today?.key).toBe(20261025);
    // 00:00 service time = noon (12:00 CET = 11:00Z) minus 12 h = 23:00Z the day before.
    expect(iso(today?.startMs ?? 0)).toBe('2026-10-24T23:00:00.000Z');
  });

  it('cover the day before, the day and the day after the local date', () => {
    const days = serviceDays(Date.parse('2026-10-20T23:30:00Z'), 'Europe/Madrid');
    // 23:30Z is 01:30 on the 21st in Madrid.
    expect(days.map((d) => d.key)).toEqual([20261020, 20261021, 20261022]);
    expect(days.map((d) => d.weekday)).toEqual([2, 3, 4]);
  });
});

describe('the index', () => {
  it('answers a station, not its platforms, and skips entrances and stops with no place', async () => {
    const schedule = await read();
    const near = schedule.stationsNear(41.39, 2.17, 300);
    expect(near).toHaveLength(1);
    const station = schedule.station((near[0] as { group: number }).group);
    expect(station).toMatchObject({ id: 'ST', name: 'Plaça Test' });
    // Nord Terminal (~7 km) is only ever a last stop: nothing leaves it, so it is no stop to show.
    expect(
      schedule.stationsNear(41.39, 2.17, 8000).map((n) => schedule.station(n.group).name),
    ).toEqual(['Plaça Test']);
    expect(schedule.stationsNear(0, 0, 1000)).toEqual([]);
  });

  it("lists a station's departures across its platforms, with the trip's own headsign or its last stop", async () => {
    const schedule = await read();
    const [{ group }] = schedule.stationsNear(41.39, 2.17, 300) as [{ group: number }];
    const days = serviceDays(NOON, schedule.timeZone);
    const departures = schedule
      .scheduledDepartures(group, days, NOON, NOON + 6 * 3600_000, 100)
      .sort((a, b) => a.timeMs - b.timeMs);
    // T1 12:00 (P1), T2 12:10 (P2). T3 is a Sunday service; T4 cannot be boarded.
    expect(departures.map((d) => iso(d.timeMs))).toEqual([
      '2026-10-20T10:00:00.000Z',
      '2026-10-20T10:10:00.000Z',
    ]);
    expect(departures.map((d) => schedule.headsignOf(d.trip))).toEqual([
      'Nord Terminal',
      // T2 has no trip_headsign: where it ends.
      'Nord Terminal',
    ]);
    expect(schedule.routes[schedule.routeOfTrip(departures[0]?.trip as number)]).toMatchObject({
      shortName: 'L1',
      color: '#112233',
      mode: 'bus',
    });
  });

  it('never serves a trip at its last stop, and keeps no row it was not given a time for', async () => {
    const schedule = await read();
    // Every trip ends at Nord Terminal, so nothing leaves it: it is not a stop to show.
    expect(schedule.stationsNear(41.45, 2.22, 100)).toEqual([]);
    expect(schedule.rowCount).toBe(10);
  });

  it('reads a trip running past 24:00 as the next morning of its service day', async () => {
    const schedule = await read();
    const [{ group }] = schedule.stationsNear(41.39, 2.17, 300) as [{ group: number }];
    // Tuesday 20:00Z is 22:00 Madrid; TN (Tuesday's service, "24:10") leaves 00:10 Wednesday = 22:10Z.
    const at = Date.parse('2026-10-20T20:00:00Z');
    const found = schedule.scheduledDepartures(
      group,
      serviceDays(at, schedule.timeZone),
      at,
      at + 6 * 3600_000,
      100,
    );
    expect(found.map((d) => iso(d.timeMs))).toEqual(['2026-10-20T22:10:00.000Z']);
    // 00:30 local on Wednesday: still Tuesday's service day that is running.
    const after = Date.parse('2026-10-20T22:00:00Z');
    const early = schedule.scheduledDepartures(
      group,
      serviceDays(after, schedule.timeZone),
      after,
      after + 3600_000,
      100,
    );
    expect(early.map((d) => iso(d.timeMs))).toEqual(['2026-10-20T22:10:00.000Z']);
    expect(early[0]?.dayStartMs).toBe(Date.parse('2026-10-19T22:00:00Z'));
  });

  it('applies the calendar and its exceptions', async () => {
    const schedule = await read();
    const [{ group }] = schedule.stationsNear(41.39, 2.17, 300) as [{ group: number }];
    // Thursday 2026-10-22 is removed for WD; the Sunday service runs on Sundays only.
    const thursday = Date.parse('2026-10-22T09:00:00Z');
    expect(
      schedule.scheduledDepartures(
        group,
        serviceDays(thursday, schedule.timeZone),
        thursday,
        thursday + 6 * 3600_000,
        100,
      ),
    ).toEqual([]);
    const sunday = Date.parse('2026-10-25T06:00:00Z');
    const found = schedule.scheduledDepartures(
      group,
      serviceDays(sunday, schedule.timeZone),
      sunday,
      sunday + 6 * 3600_000,
      100,
    );
    expect(found.map((d) => schedule.routes[schedule.routeOfTrip(d.trip)]?.id)).toEqual(['M1']);
  });

  it('keeps an operator that publishes no colour colourless, and a long name as a long name', async () => {
    const schedule = await read();
    expect(schedule.routes[1]).toMatchObject({
      shortName: null,
      longName: 'Línia Metro Un',
      color: null,
      textColor: null,
      mode: 'subway',
    });
  });
});

describe('what it refuses', () => {
  it('a feed of frequency-based trips, which it would serve as one departure a day', async () => {
    await expect(
      read({ frequencies: 'trip_id,start_time,end_time,headway_secs\nT1,06:00:00,22:00:00,600\n' }),
    ).rejects.toThrow(ScheduleUnsupportedError);
    // An empty frequencies.txt is fine.
    await expect(
      read({ frequencies: 'trip_id,start_time,end_time,headway_secs\n' }),
    ).resolves.toBeDefined();
  });

  it('a feed that does not say what time zone its times are in', async () => {
    await expect(
      read({ agency: 'agency_id,agency_name,agency_url\nA,Test,https://x.example\n' }),
    ).rejects.toThrow(/agency_timezone/);
    await expect(
      read({
        agency:
          'agency_id,agency_name,agency_url,agency_timezone\nA,T,https://x.example,Nowhere/Land\n',
      }),
    ).rejects.toThrow(/time zone/);
  });

  it('a stop_times file without its columns', async () => {
    await expect(read({ stopTimes: 'trip_id,foo\nT1,1\n' })).rejects.toThrow(
      ScheduleUnsupportedError,
    );
  });

  it('reads stop_times out of order, as some feeds publish them', async () => {
    const lines = scheduleFiles().stopTimes.split('\n');
    const shuffled = [lines[0], ...lines.slice(1).reverse()].join('\n');
    const schedule = await read({ stopTimes: shuffled });
    const [{ group }] = schedule.stationsNear(41.39, 2.17, 300) as [{ group: number }];
    const found = schedule.scheduledDepartures(
      group,
      serviceDays(NOON, schedule.timeZone),
      NOON,
      NOON + 3600_000,
      100,
    );
    expect(found).toHaveLength(2);
  });
});

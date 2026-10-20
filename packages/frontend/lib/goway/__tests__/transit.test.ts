/**
 * The nearby-transit answer as Bloom's `PlaceTransit` draws it: a scheduled
 * time is never live, the operator's own colours pass through, and only the
 * operators that contributed a stop are credited.
 */
import { describe, expect, test } from 'bun:test';
import { createGoWayClient, type NearbyTransit } from '@goway.to/sdk';

import { formatMessage } from '@/lib/i18n';
import { TRANSIT_EN } from '@/lib/messages/transit';

import { departureTime, transitView } from '../transit';

const NOW = Date.parse('2026-10-20T09:50:00Z');
const t = (key: string, values?: Record<string, string | number>) =>
  formatMessage(TRANSIT_EN[key] ?? key, values);
const formatDistance = (meters: number) => `${Math.round(meters / 10) * 10} m`;
const options = { nowMs: NOW, locale: 'en-GB', timeZone: 'Europe/Madrid', t, formatDistance };

const operator = (id: string, label: string) => ({
  id,
  name: `Buses — ${label}`,
  attribution: { label: `Font: ${label}`, href: `https://${id}.example` },
  licence: { label: `${label} licence`, href: `https://${id}.example/licence` },
  availability: 'ready' as const,
  realtime: 'live' as const,
  scheduleReadAt: '2026-10-20T04:00:00.000Z',
  realtimeAt: '2026-10-20T09:49:30.000Z',
});

const answer: NearbyTransit = {
  stops: [
    {
      id: 'amb-bus:109303',
      operatorId: 'amb-bus',
      name: 'Pl Catalunya',
      position: { latitude: 41.387, longitude: 2.169 },
      distanceMeters: 27,
      modes: ['bus', 'subway'],
      lines: [
        {
          id: 'N12',
          shortName: 'N12',
          longName: null,
          mode: 'bus',
          color: '#D0DF00',
          textColor: null,
        },
        {
          id: 'M1',
          shortName: null,
          longName: 'Línia Metro Un',
          mode: 'subway',
          color: null,
          textColor: null,
        },
        // Neither name: not drawn as a badge, and no departure borrows one.
        {
          id: '100001',
          shortName: null,
          longName: null,
          mode: 'bus',
          color: null,
          textColor: null,
        },
      ],
      departures: [
        {
          lineId: 'N12',
          headsign: 'Sant Feliu',
          time: '2026-10-20T09:54:00.000Z',
          basis: 'realtime',
          delaySeconds: 60,
        },
        {
          lineId: 'N12',
          headsign: 'Sant Feliu',
          time: '2026-10-20T10:20:00.000Z',
          basis: 'scheduled',
        },
        { lineId: '100001', headsign: null, time: '2026-10-20T10:25:00.000Z', basis: 'scheduled' },
      ],
    },
  ],
  operators: [operator('amb-bus', 'AMB'), operator('other-bus', 'Other')],
  generatedAt: '2026-10-20T09:49:50.000Z',
};

describe('transitView', () => {
  const view = transitView(answer, options);
  const stop = view.stops[0];

  test('marks only a realtime departure as live, and gives a timetable time as a clock time', () => {
    expect(stop?.departures?.map((d) => [d.time, d.realtime])).toEqual([
      ['4 min', true],
      // 10:20Z is 12:20 in Madrid: the stop's own clock, not the device's.
      ['12:20', false],
    ]);
    expect(view.anyRealtime).toBe(true);
    expect(view.anyScheduled).toBe(true);
  });

  test("carries the operator's own colours and nothing else", () => {
    expect(stop?.lines).toEqual([
      { name: 'N12', color: '#D0DF00' },
      // No colour published: none invented.
      { name: 'Línia Metro Un' },
    ]);
    expect(stop?.departures?.[0]?.line).toEqual({
      name: 'N12',
      color: '#D0DF00',
      headsign: 'Sant Feliu',
    });
  });

  test('draws the most common mode and the straight-line distance', () => {
    expect(stop).toMatchObject({
      id: 'amb-bus:109303',
      name: 'Pl Catalunya',
      mode: 'bus',
      distance: '30 m',
    });
  });

  test('credits only the operators whose stops are drawn, in their own words', () => {
    expect(view.credits).toEqual([
      {
        operatorId: 'amb-bus',
        attribution: { label: 'Font: AMB', href: 'https://amb-bus.example' },
        licence: { label: 'AMB licence', href: 'https://amb-bus.example/licence' },
        // Its predictions' stamp, in the stop's own clock (09:49:30Z is 11:49 in Madrid).
        updated: expect.stringMatching(/^Updated 20 Oct 2026.*11:49/),
      },
    ]);
  });

  test('is empty — and so absent on screen — for an answer with no stops', () => {
    const empty = transitView(
      { stops: [], operators: [], generatedAt: answer.generatedAt },
      options,
    );
    expect(empty.stops).toEqual([]);
    expect(empty.credits).toEqual([]);
  });
});

describe('departureTime', () => {
  const live = (time: string) =>
    ({ lineId: 'a', headsign: null, time, basis: 'realtime' as const, delaySeconds: 0 }) as const;
  const scheduled = (time: string) =>
    ({ lineId: 'a', headsign: null, time, basis: 'scheduled' as const }) as const;

  test('counts down a near live departure, and says Now for one that is leaving', () => {
    expect(departureTime(live('2026-10-20T09:50:20.000Z'), options)).toBe('Now');
    expect(departureTime(live('2026-10-20T10:19:00.000Z'), options)).toBe('29 min');
    // Beyond half an hour a clock time reads better than a count.
    expect(departureTime(live('2026-10-20T10:40:00.000Z'), options)).toBe('12:40');
  });

  test('never counts a timetable time down: that would read as live', () => {
    expect(departureTime(scheduled('2026-10-20T09:54:00.000Z'), options)).toBe('11:54');
  });

  test('names the weekday when the departure is on another day at the stop', () => {
    // 23:30Z Tuesday is 01:30 on Wednesday in Madrid.
    expect(departureTime(scheduled('2026-10-20T23:30:00.000Z'), options)).toBe('Wed 01:30');
  });

  test('falls back to the device clock for a zone name it does not know', () => {
    expect(
      departureTime(scheduled('2026-10-20T09:54:00.000Z'), {
        ...options,
        timeZone: 'Nowhere/Land',
      }),
    ).toMatch(/^\d{2}:\d{2}$/);
  });
});

describe('the SDK answers it', () => {
  test('parses a transit answer through the contract', async () => {
    const goway = createGoWayClient({
      fetch: async () => ({
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify(answer),
      }),
    });
    const parsed = await goway.transit.nearby({ latitude: 41.39, longitude: 2.16 });
    expect(parsed.stops[0]?.departures.map((d) => d.basis)).toEqual([
      'realtime',
      'scheduled',
      'scheduled',
    ]);
  });
});

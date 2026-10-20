import { describe, expect, it } from 'vitest';
import { createGoWayClient, GoWayUnavailableError, GoWayValidationError } from '../src/index';
import { fakeFetch, queryOf, rejection } from './helpers';

const answer = {
  stops: [
    {
      id: 'amb-bus:109303',
      operatorId: 'amb-bus',
      name: 'Pl Catalunya',
      position: { latitude: 41.387, longitude: 2.169 },
      distanceMeters: 27,
      modes: ['bus'],
      lines: [
        {
          id: 'N12',
          shortName: 'N12',
          longName: null,
          mode: 'bus',
          color: '#112233',
          textColor: null,
        },
      ],
      departures: [
        {
          lineId: 'N12',
          headsign: 'Sant Feliu',
          time: '2026-10-20T10:00:00.000Z',
          basis: 'realtime',
          delaySeconds: 60,
        },
        {
          lineId: 'N12',
          headsign: 'Sant Feliu',
          time: '2026-10-20T10:20:00.000Z',
          basis: 'scheduled',
        },
      ],
    },
  ],
  operators: [
    {
      id: 'amb-bus',
      name: 'Buses — AMB (Barcelona area)',
      attribution: { label: 'Font: AMB', href: 'https://www.ambmobilitat.cat' },
      licence: { label: 'Reuse under Llei 37/2007', href: 'https://www.amb.cat/condicions' },
      availability: 'ready',
      realtime: 'live',
      scheduleReadAt: '2026-10-20T04:00:00.000Z',
      realtimeAt: '2026-10-20T09:59:30.000Z',
    },
  ],
  generatedAt: '2026-10-20T09:59:50.000Z',
};

describe('goway.transit.nearby', () => {
  it('sends the point and bounds as a query, and parses the answer with the contract', async () => {
    const { fetch, calls } = fakeFetch(200, answer);
    const goway = createGoWayClient({ fetch });
    const result = await goway.transit.nearby({
      latitude: 41.3874,
      longitude: 2.1686,
      radiusMeters: 300,
      maxStops: 3,
      maxDepartures: 2,
    });
    expect(result.stops[0]?.departures.map((d) => d.basis)).toEqual(['realtime', 'scheduled']);
    expect(result.operators[0]?.attribution.label).toBe('Font: AMB');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.init.method).toBe('GET');
    expect(calls[0]?.url).toContain('/transit/nearby?');
    expect(new URLSearchParams(queryOf(calls[0]?.url ?? '')).get('radiusMeters')).toBe('300');
  });

  it('refuses a radius or a count outside the contract before sending anything', async () => {
    const { fetch, calls } = fakeFetch(200, answer);
    const goway = createGoWayClient({ fetch });
    for (const bad of [
      { radiusMeters: 5000 },
      { maxStops: 0 },
      { maxDepartures: 11 },
      { latitude: 120 },
    ]) {
      const error = await rejection(
        goway.transit.nearby({ latitude: 41.39, longitude: 2.16, ...bad }),
      );
      expect(error).toBeInstanceOf(GoWayValidationError);
      // The error names the field and never the value.
      expect(String((error as Error).message)).not.toContain('120');
    }
    expect(calls).toHaveLength(0);
  });

  it('takes an empty answer (no coverage) as an answer', async () => {
    const { fetch } = fakeFetch(200, { stops: [], operators: [], generatedAt: answer.generatedAt });
    const result = await createGoWayClient({ fetch }).transit.nearby({
      latitude: 0,
      longitude: 0,
    });
    expect(result.stops).toEqual([]);
    expect(result.operators).toEqual([]);
  });

  it('rejects an answer that breaks the contract: a realtime departure without its delay is allowed, an unknown basis is not', async () => {
    const broken = structuredClone(answer);
    (broken.stops[0]?.departures[0] as { basis: string }).basis = 'estimated';
    const { fetch } = fakeFetch(200, broken);
    await expect(
      createGoWayClient({ fetch }).transit.nearby({ latitude: 41.39, longitude: 2.16 }),
    ).rejects.toBeDefined();
  });

  it('maps a deployment without the live layer to GoWayUnavailableError', async () => {
    const { fetch } = fakeFetch(503, { error: { code: 'service_unavailable', message: 'off' } });
    const error = await rejection(
      createGoWayClient({ fetch }).transit.nearby({ latitude: 41.39, longitude: 2.16 }),
    );
    expect(error).toBeInstanceOf(GoWayUnavailableError);
  });
});

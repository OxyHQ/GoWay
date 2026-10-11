/**
 * The live panel's copy: every locale carries every key with the same
 * placeholders, every kind and mode has its words, and the details say only
 * what a feed said — in units a person reads.
 */
import { describe, expect, test } from 'bun:test';
import {
  LIVE_KINDS,
  LIVE_SOURCE_STATUSES,
  LIVE_TRANSIT_MODES,
  type LiveEntity,
} from '@goway.to/sdk/live';

import { formatMessage } from '@/lib/i18n';

import { entityDetails, formatAge, sourceFreshness } from '../format';
import { LIVE_EN, LIVE_ES } from '../messages';

const t = (key: string, values?: Record<string, string | number>) =>
  formatMessage(LIVE_EN[key] ?? key, values);

describe('live messages', () => {
  test('every locale carries exactly the same keys and placeholders', () => {
    expect(Object.keys(LIVE_ES).sort()).toEqual(Object.keys(LIVE_EN).sort());
    const placeholders = (text: string | undefined) => (text?.match(/\{\w+\}/g) ?? []).sort();
    for (const [key, english] of Object.entries(LIVE_EN)) {
      expect({ key, placeholders: placeholders(LIVE_ES[key]) }).toEqual({
        key,
        placeholders: placeholders(english),
      });
    }
  });

  test('every kind, mode and status has its words', () => {
    for (const kind of LIVE_KINDS) expect(LIVE_EN[`live.kind.${kind}`]).toBeDefined();
    for (const mode of LIVE_TRANSIT_MODES) expect(LIVE_EN[`live.mode.${mode}`]).toBeDefined();
    for (const status of LIVE_SOURCE_STATUSES)
      expect(LIVE_EN[`live.status.${status}`]).toBeDefined();
  });

  test('says nothing is simulated', () => {
    expect(LIVE_EN['live.real']).toMatch(/simulated/);
  });
});

describe('details', () => {
  const base = {
    sourceId: 'adsb-lol',
    position: { latitude: 41.3, longitude: 2.1 },
    observedAt: '2026-10-11T12:00:00.000Z',
  };

  test('an aircraft: metres and feet, km/h, climb, and nothing invented', () => {
    const details = entityDetails(
      {
        ...base,
        kind: 'aircraft',
        id: 'adsb-lol:34535a',
        headingDegrees: 98.8,
        speedMetersPerSecond: 259.2,
        icao24: '34535a',
        callsign: 'VLG12PY',
        registration: 'EC-MQB',
        typeCode: 'A321',
        altitudeMeters: 9251,
        altitudeReference: 'geometric',
        verticalRateMetersPerSecond: -7.3,
        onGround: false,
      },
      t,
    );
    expect(details.title).toBe('VLG12PY');
    const rows = Object.fromEntries(details.rows.map((row) => [row.label, row.value]));
    expect(rows.Altitude).toMatch(/9,?251 m \(30,?351 ft\)/);
    expect(rows.Speed).toMatch(/933 km\/h/);
    expect(rows['Vertical rate']).toBe('-7.3 m/s');
  });

  test('an aircraft with no callsign is named by its address, not made up', () => {
    const details = entityDetails(
      {
        ...base,
        kind: 'aircraft',
        id: 'adsb-lol:abcdef',
        headingDegrees: null,
        speedMetersPerSecond: null,
        icao24: 'abcdef',
        callsign: null,
        registration: null,
        typeCode: null,
        altitudeMeters: 0,
        altitudeReference: null,
        verticalRateMetersPerSecond: null,
        onGround: true,
      } satisfies LiveEntity,
      t,
    );
    expect(details.title).toBe('Aircraft ABCDEF');
    expect(details.subtitle).toBeNull();
    expect(details.rows).toEqual([{ label: 'Altitude', value: 'On the ground' }]);
  });

  test('a station and a ship', () => {
    const station = entityDetails(
      {
        ...base,
        kind: 'bikeshare',
        id: 'nyc-bikeshare:1',
        sourceId: 'nyc-bikeshare',
        headingDegrees: null,
        speedMetersPerSecond: null,
        operator: 'NYC bike share',
        name: 'W 4 St',
        bikesAvailable: 5,
        ebikesAvailable: 3,
        docksAvailable: 25,
        capacity: 30,
        renting: false,
        returning: true,
      },
      t,
    );
    expect(station.rows.map((row) => row.value)).toEqual(['5', '3', '25', 'Not renting right now']);
    const ship = entityDetails(
      {
        ...base,
        kind: 'vessel',
        id: 'digitraffic-ais:230011480',
        sourceId: 'digitraffic-ais',
        headingDegrees: 359.6,
        speedMetersPerSecond: 5.1,
        mmsi: '230011480',
        name: null,
        navigationalStatus: 'moored',
        destination: null,
      },
      t,
    );
    expect(ship.title).toBe('Vessel 230011480');
    expect(ship.rows.find((row) => row.label === 'Speed')?.value).toBe('9.9 kn');
  });

  test('ages and freshness read at a glance', () => {
    expect(formatAge(4.4)).toBe('4 s');
    expect(formatAge(185)).toBe('3 min');
    expect(formatAge(7300)).toBe('2 h');
    const now = Date.parse('2026-10-11T12:00:10Z');
    expect(
      sourceFreshness(
        {
          id: 's',
          kind: 'aircraft',
          name: 's',
          attribution: { label: 's', href: 'https://s' },
          licence: { label: 'l', href: 'https://l' },
          coverage: null,
          completeness: 'network',
          status: 'live',
          lastUpdatedAt: '2026-10-11T12:00:07Z',
          pollIntervalSeconds: 10,
          staleAfterSeconds: 30,
          dropAfterSeconds: 90,
          entityCount: 0,
        },
        now,
        t,
      ),
    ).toBe('updated 3 s ago');
  });
});

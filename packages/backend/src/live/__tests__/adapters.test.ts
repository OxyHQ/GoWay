/**
 * Adapter normalisation: real upstream shapes in, contract values out — and
 * junk refused, never coerced into a plausible entity.
 *
 * The fixtures are trimmed copies of what each feed actually answered on
 * 2026-10-11 (`docs/MAP_LIVE.md` → Sources), plus the malformed variants each
 * normaliser must refuse. Every accepted value is re-checked against
 * `liveEntitySchema` by the adapters themselves (`normalise.ts → accept`);
 * these tests pin the MAPPING: units, nulls, ids, timestamps.
 */

import { describe, expect, it } from 'bun:test';
import { liveEntitySchema } from '@goway/contracts';
import {
  discoverFeeds,
  normaliseGbfsStation,
  parseElectricTypes,
  parseStationInformation,
  createGbfsAdapter,
} from '../adapters/gbfs';
import {
  normaliseDigitrafficVessel,
  parseVesselMetadata,
  type VesselMetadata,
} from '../adapters/digitraffic';
import { geotrenPublishedMs, normaliseGeotrenTrain } from '../adapters/geotren';
import { normaliseGtfsFeed, normaliseGtfsVehicle } from '../adapters/gtfsRealtime';
import {
  createReadsbAdapter,
  isWithheld,
  normaliseReadsbAircraft,
  normaliseReadsbResponse,
  planRegions,
  READSB_MAX_RADIUS_NM,
} from '../adapters/readsb';
import { decodeGtfsRealtime, ProtobufError, protobufWriter as w } from '../protobuf';
import type { LiveFetch, LiveFetchContext } from '../types';

const NOW = Date.parse('2026-10-11T12:00:00Z');

// ---------------------------------------------------------------------------
// Aircraft (adsb.lol / readsb v2)
// ---------------------------------------------------------------------------

/** Trimmed from adsb.lol `/v2/lat/41.39/lon/2.17/dist/100`. */
const A321 = {
  hex: '34535a',
  type: 'adsb_icao',
  flight: 'VLG12PY ',
  r: 'EC-MQB',
  t: 'A321',
  alt_baro: 29075,
  alt_geom: 30350,
  gs: 503.9,
  track: 98.79,
  baro_rate: -1472,
  geom_rate: -1440,
  squawk: '6221',
  lat: 41.287537,
  lon: 0.039062,
  seen_pos: 0.136,
  seen: 0.1,
};

describe('readsb aircraft', () => {
  it('maps units, ids and the position age', () => {
    const aircraft = normaliseReadsbAircraft('adsb-lol', A321, NOW, NOW);
    expect(aircraft).not.toBeNull();
    expect(liveEntitySchema.parse(aircraft)).toEqual(aircraft as never);
    expect(aircraft).toMatchObject({
      kind: 'aircraft',
      id: 'adsb-lol:34535a',
      icao24: '34535a',
      callsign: 'VLG12PY',
      registration: 'EC-MQB',
      typeCode: 'A321',
      altitudeReference: 'geometric',
      altitudeMeters: Math.round(30350 * 0.3048),
      onGround: false,
      position: { latitude: 41.287537, longitude: 0.039062 },
    });
    // 503.9 kt ≈ 259.2 m/s; −1440 ft/min ≈ −7.3 m/s.
    expect(aircraft?.speedMetersPerSecond).toBeCloseTo(259.2, 1);
    expect(aircraft?.verticalRateMetersPerSecond).toBeCloseTo(-7.3, 1);
    expect(aircraft?.headingDegrees).toBeCloseTo(98.79, 2);
    // The position's own age, not the response time.
    expect(aircraft?.observedAt).toBe(new Date(NOW - 136).toISOString());
  });

  it('falls back to barometric altitude, and reads "ground"', () => {
    const { alt_geom: _ignored, ...baroOnly } = A321;
    expect(normaliseReadsbAircraft('adsb-lol', baroOnly, NOW, NOW)).toMatchObject({
      altitudeReference: 'barometric',
      altitudeMeters: Math.round(29075 * 0.3048),
    });
    expect(
      normaliseReadsbAircraft('adsb-lol', { ...baroOnly, alt_baro: 'ground', gs: 12 }, NOW, NOW),
    ).toMatchObject({ onGround: true, altitudeMeters: 0, altitudeReference: null });
  });

  it('turns absent and impossible optional values into null', () => {
    const sparse = normaliseReadsbAircraft(
      'adsb-lol',
      { hex: 'ABCDEF', lat: 40.7, lon: -73.9, seen_pos: 2, alt_baro: 400_000, gs: -5, track: 'x' },
      NOW,
      NOW,
    );
    expect(sparse).toMatchObject({
      icao24: 'abcdef',
      callsign: null,
      registration: null,
      typeCode: null,
      altitudeMeters: null,
      altitudeReference: null,
      speedMetersPerSecond: null,
      headingDegrees: null,
      verticalRateMetersPerSecond: null,
    });
  });

  it('refuses junk records', () => {
    const junk: unknown[] = [
      null,
      'aircraft',
      [],
      { ...A321, hex: 'nothex' },
      { ...A321, hex: undefined },
      { ...A321, lat: undefined },
      { ...A321, lat: 91 },
      { ...A321, lon: 'two' },
      { ...A321, lat: 0, lon: 0 },
      { ...A321, seen_pos: undefined },
      { ...A321, seen_pos: -1 },
      // A position "two hours old" is not a live position.
      { ...A321, seen_pos: 7200 },
    ];
    for (const record of junk) {
      expect(normaliseReadsbAircraft('adsb-lol', record, NOW, NOW)).toBeNull();
    }
    // An observation in the future beyond the skew bound.
    expect(normaliseReadsbAircraft('adsb-lol', A321, NOW + 10 * 60_000, NOW)).toBeNull();
  });

  it('withholds LADD and PIA aircraft without counting them as junk', () => {
    expect(isWithheld({ dbFlags: 8 })).toBe(true);
    expect(isWithheld({ dbFlags: 4 })).toBe(true);
    expect(isWithheld({ dbFlags: 1 })).toBe(false);
    const result = normaliseReadsbResponse(
      'adsb-lol',
      { now: NOW, ac: [A321, { ...A321, hex: '111111', dbFlags: 8 }, { hex: 'zz' }] },
      NOW,
    );
    expect(result.entities.map((entity) => entity.id)).toEqual(['adsb-lol:34535a']);
    expect(result.rejected).toBe(1);
  });

  it('refuses a body that is not an answer', () => {
    expect(normaliseReadsbResponse('adsb-lol', { msg: 'oops' }, NOW)).toEqual({
      entities: [],
      rejected: 1,
    });
  });

  it('stops asking at the first 429, keeps what answered, and asks the hub to wait', async () => {
    const asked: string[] = [];
    const fetch: LiveFetch = async (url) => {
      asked.push(url);
      const limited = asked.length === 2;
      return {
        status: limited ? 429 : 200,
        headers: { get: () => null },
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify({ now: NOW, ac: [A321] })).buffer as ArrayBuffer,
      };
    };
    const adapter = createReadsbAdapter('adsb-lol', {
      url: 'https://api.example',
      userAgent: 't',
      maxRegionsPerPoll: 3,
    });
    const result = await adapter.poll({
      signal: new AbortController().signal,
      fetch,
      now: () => NOW,
      demand: [
        { west: 0, south: 40.98, east: 2.81, north: 43.07 },
        { west: -75.94, south: 40.98, east: -73.13, north: 43.07 },
        { west: 139, south: 35, east: 140, north: 36 },
      ],
    });
    expect(asked).toHaveLength(2);
    expect(result.entities).toHaveLength(1);
    expect(result.backoffSeconds).toBe(60);
  });

  it('plans one circle per watched z6 tile, within the API radius', () => {
    // Two adjacent z7 rooms over Barcelona share a z6 parent.
    const regions = planRegions([
      { west: 0, south: 40.98, east: 2.81, north: 43.07 },
      { west: 2.81, south: 40.98, east: 5.62, north: 43.07 },
      { west: -75.94, south: 40.98, east: -73.13, north: 43.07 },
    ]);
    expect(regions).toHaveLength(2);
    expect(regions[0]?.weight).toBe(2);
    for (const region of regions) {
      expect(region.radiusNm).toBeLessThanOrEqual(READSB_MAX_RADIUS_NM);
      expect(region.radiusNm).toBeGreaterThan(100);
    }
  });
});

// ---------------------------------------------------------------------------
// GTFS-Realtime
// ---------------------------------------------------------------------------

function vehicleEntity(fields: {
  id?: string;
  routeId?: string;
  vehicleId?: string;
  label?: string;
  lat?: number;
  lon?: number;
  bearing?: number;
  speed?: number;
  timestamp?: number;
  deleted?: boolean;
}): number[] {
  const trip = fields.routeId ? w.bytes(1, w.string(5, fields.routeId)) : [];
  const descriptor = w.bytes(8, [
    ...(fields.vehicleId ? w.string(1, fields.vehicleId) : []),
    ...(fields.label ? w.string(2, fields.label) : []),
  ]);
  const position =
    fields.lat === undefined
      ? []
      : w.bytes(2, [
          ...w.float(1, fields.lat),
          ...w.float(2, fields.lon ?? 0),
          ...(fields.bearing === undefined ? [] : w.float(3, fields.bearing)),
          ...(fields.speed === undefined ? [] : w.float(5, fields.speed)),
        ]);
  const vehicle = w.bytes(4, [
    ...trip,
    ...descriptor,
    ...position,
    ...(fields.timestamp === undefined ? [] : w.uint(5, fields.timestamp)),
  ]);
  return w.bytes(2, [
    ...w.string(1, fields.id ?? 'e'),
    ...(fields.deleted ? w.uint(2, 1) : []),
    ...vehicle,
  ]);
}

function feed(headerTimestamp: number | undefined, ...entities: number[][]): Uint8Array {
  const header = w.bytes(1, [
    ...w.string(1, '2.0'),
    ...(headerTimestamp === undefined ? [] : w.uint(3, headerTimestamp)),
  ]);
  return new Uint8Array([...header, ...entities.flat()]);
}

const RENFE = {
  sourceId: 'renfe-cercanias',
  operator: 'Renfe',
  coverage: { west: -9.6, south: 35.8, east: 4.6, north: 44 },
  defaultMode: 'rail' as const,
  lineOf: (vehicle: { vehicleLabel?: string }) => vehicle.vehicleLabel?.split('-')[0] ?? null,
};

describe('GTFS-Realtime vehicles', () => {
  const seconds = NOW / 1000;

  it('decodes and maps a vehicle position', () => {
    const result = normaliseGtfsFeed(
      RENFE,
      feed(
        seconds,
        vehicleEntity({
          id: 'VP_R15-15010',
          vehicleId: '15010',
          label: 'R15-15010',
          lat: 41.38975,
          lon: 2.16162,
          timestamp: seconds - 4,
        }),
      ),
      NOW,
    );
    expect(result.rejected).toBe(0);
    expect(result.entities).toHaveLength(1);
    const [train] = result.entities;
    expect(train).toMatchObject({
      kind: 'transit',
      id: 'renfe-cercanias:15010',
      mode: 'rail',
      operator: 'Renfe',
      line: 'R15',
      vehicleLabel: 'R15-15010',
      headingDegrees: null,
      speedMetersPerSecond: null,
      observedAt: new Date(NOW - 4000).toISOString(),
    });
    expect(train?.position.latitude).toBeCloseTo(41.38975, 4);
  });

  it('keeps bearing and speed when the feed sends them, and the route as the line', () => {
    const bus = normaliseGtfsVehicle(
      { sourceId: 'mta-bus', operator: 'MTA', coverage: null, defaultMode: 'bus' },
      {
        vehicleId: 'MTA NYCT_9771',
        routeId: 'M50',
        latitude: 40.753,
        longitude: -73.968,
        bearing: 336.9,
        speed: 5.5,
        timestamp: seconds,
      },
      undefined,
      NOW,
    );
    expect(bus).toMatchObject({ line: 'M50', mode: 'bus', speedMetersPerSecond: 5.5 });
    expect(bus?.headingDegrees).toBeCloseTo(336.9, 1);
  });

  it('dates a vehicle by the header when it has no timestamp of its own', () => {
    const result = normaliseGtfsFeed(
      RENFE,
      feed(seconds - 10, vehicleEntity({ vehicleId: '1', lat: 41.4, lon: 2.1 })),
      NOW,
    );
    expect(result.entities[0]?.observedAt).toBe(new Date(NOW - 10_000).toISOString());
  });

  it('refuses junk vehicles and counts them', () => {
    const result = normaliseGtfsFeed(
      RENFE,
      feed(
        undefined,
        // no timestamp anywhere
        vehicleEntity({ vehicleId: 'a', lat: 41.4, lon: 2.1 }),
        // Null Island
        vehicleEntity({ vehicleId: 'b', lat: 0, lon: 0, timestamp: seconds }),
        // Tokyo is outside Renfe's coverage
        vehicleEntity({ vehicleId: 'c', lat: 35.68, lon: 139.76, timestamp: seconds }),
        // no position
        vehicleEntity({ vehicleId: 'd', timestamp: seconds }),
        // deleted
        vehicleEntity({ vehicleId: 'e', lat: 41.4, lon: 2.1, timestamp: seconds, deleted: true }),
        // no id at all
        vehicleEntity({ id: '', lat: 41.4, lon: 2.1, timestamp: seconds }),
        // fine
        vehicleEntity({ vehicleId: 'ok', lat: 41.4, lon: 2.1, timestamp: seconds }),
      ),
      NOW,
    );
    expect(result.entities.map((entity) => entity.id)).toEqual(['renfe-cercanias:ok']);
    expect(result.rejected).toBe(6);
  });

  it('throws on bytes that are not a feed, rather than half-reading one', () => {
    expect(() => decodeGtfsRealtime(new Uint8Array([0x0a, 0x05, 0x01]))).toThrow(ProtobufError);
    expect(() => decodeGtfsRealtime(new TextEncoder().encode('<html>503</html>'))).toThrow(
      ProtobufError,
    );
    expect(() => decodeGtfsRealtime(new Uint8Array([]))).toThrow(ProtobufError);
    const truncated = feed(seconds, vehicleEntity({ vehicleId: 'x', lat: 41.4, lon: 2.1 }));
    expect(() => decodeGtfsRealtime(truncated.subarray(0, truncated.length - 3))).toThrow(
      ProtobufError,
    );
  });
});

// ---------------------------------------------------------------------------
// GBFS
// ---------------------------------------------------------------------------

const GBFS_OPTIONS = {
  sourceId: 'nyc-bikeshare',
  operator: 'NYC bike share',
  coverage: { west: -74.3, south: 40.45, east: -73.65, north: 40.95 },
};

/** Trimmed from the NYC GBFS 2.3 feeds. */
const INFORMATION = {
  data: {
    stations: [
      {
        station_id: 's1',
        name: 'Bailey Ave & Sedgwick Ave',
        lat: 40.86571,
        lon: -73.90857,
        capacity: 20,
      },
      {
        station_id: 's2',
        name: [{ text: 'W 4 St', language: 'en' }],
        lat: 40.73,
        lon: -74.0,
        capacity: 30,
      },
      { station_id: 'far', name: 'Tokyo', lat: 35.68, lon: 139.76, capacity: 10 },
      { station_id: 'noname', lat: 40.7, lon: -73.9 },
    ],
  },
};

describe('GBFS stations', () => {
  const stations = parseStationInformation(INFORMATION, GBFS_OPTIONS.coverage);

  it('reads v2 and v3 information, refusing stations outside coverage or unnamed', () => {
    expect([...stations.keys()]).toEqual(['s1', 's2']);
    expect(stations.get('s2')?.name).toBe('W 4 St');
  });

  it('maps a status row, with ebikes counted directly', () => {
    const station = normaliseGbfsStation(
      GBFS_OPTIONS,
      {
        station_id: 's1',
        num_bikes_available: 20,
        num_ebikes_available: 8,
        num_docks_available: 0,
        is_installed: 1,
        is_renting: 1,
        is_returning: 1,
        last_reported: NOW / 1000 - 458,
      },
      stations.get('s1'),
      new Set(),
      null,
      NOW,
    );
    expect(station).toMatchObject({
      id: 'nyc-bikeshare:s1',
      kind: 'bikeshare',
      name: 'Bailey Ave & Sedgwick Ave',
      bikesAvailable: 20,
      ebikesAvailable: 8,
      docksAvailable: 0,
      capacity: 20,
      renting: true,
      returning: true,
      observedAt: new Date(NOW - 458_000).toISOString(),
    });
  });

  it('derives ebikes from vehicle types, and reads v3 timestamps and booleans', () => {
    const electric = parseElectricTypes({
      data: {
        vehicle_types: [
          { vehicle_type_id: 'ICONIC', propulsion_type: 'human' },
          { vehicle_type_id: 'BOOST', propulsion_type: 'electric_assist' },
        ],
      },
    });
    const station = normaliseGbfsStation(
      GBFS_OPTIONS,
      {
        station_id: 's2',
        num_bikes_available: 5,
        num_docks_available: 25,
        is_installed: true,
        is_renting: false,
        is_returning: true,
        last_reported: new Date(NOW - 60_000).toISOString(),
        vehicle_types_available: [
          { vehicle_type_id: 'ICONIC', count: 2 },
          { vehicle_type_id: 'BOOST', count: 3 },
        ],
      },
      stations.get('s2'),
      electric,
      null,
      NOW,
    );
    expect(station).toMatchObject({ ebikesAvailable: 3, renting: false, returning: true });
  });

  it('refuses junk status rows', () => {
    const base = { station_id: 's1', num_bikes_available: 1, last_reported: NOW / 1000 };
    const junk: [unknown, ReturnType<typeof stations.get>][] = [
      [null, stations.get('s1')],
      [base, undefined], // unknown station
      [{ ...base, num_bikes_available: -1 }, stations.get('s1')],
      [{ ...base, num_bikes_available: 1.5 }, stations.get('s1')],
      [{ ...base, num_bikes_available: '3' }, stations.get('s1')],
      [{ ...base, last_reported: undefined }, stations.get('s1')],
      [{ ...base, last_reported: 12 }, stations.get('s1')],
    ];
    for (const [row, info] of junk) {
      expect(normaliseGbfsStation(GBFS_OPTIONS, row, info, new Set(), null, NOW)).toBeNull();
    }
  });

  it('discovers feeds in v2 and v3 documents, https only', () => {
    expect(
      discoverFeeds({
        data: {
          en: {
            feeds: [
              { name: 'station_status', url: 'https://x/status' },
              { name: 'x', url: 'http://plain' },
            ],
          },
        },
      }),
    ).toEqual(new Map([['station_status', 'https://x/status']]));
    expect(
      discoverFeeds({ data: { feeds: [{ name: 'station_information', url: 'https://x/i' }] } }).get(
        'station_information',
      ),
    ).toBe('https://x/i');
    expect(discoverFeeds('nonsense').size).toBe(0);
  });

  it('polls discovery and information once, then status', async () => {
    const calls: string[] = [];
    const bodies: Record<string, unknown> = {
      'https://feed/gbfs.json': {
        data: {
          en: {
            feeds: [
              { name: 'station_information', url: 'https://feed/info' },
              { name: 'station_status', url: 'https://feed/status' },
            ],
          },
        },
      },
      'https://feed/info': INFORMATION,
      'https://feed/status': {
        last_updated: NOW / 1000,
        data: {
          stations: [
            {
              station_id: 's1',
              num_bikes_available: 3,
              is_renting: 1,
              is_returning: 1,
              is_installed: 1,
              last_reported: NOW / 1000,
            },
          ],
        },
      },
    };
    const fetch: LiveFetch = async (url) => {
      calls.push(url);
      const body = bodies[url];
      return {
        status: body ? 200 : 404,
        headers: { get: () => null },
        arrayBuffer: async () =>
          new TextEncoder().encode(JSON.stringify(body ?? {})).buffer as ArrayBuffer,
      };
    };
    const adapter = createGbfsAdapter(GBFS_OPTIONS, {
      url: 'https://feed/gbfs.json',
      userAgent: 'test',
      maxRegionsPerPoll: 1,
    });
    const context: LiveFetchContext = {
      signal: new AbortController().signal,
      fetch,
      now: () => NOW,
      demand: [],
    };
    const first = await adapter.poll(context);
    const second = await adapter.poll(context);
    expect(first.entities).toHaveLength(1);
    expect(second.entities).toHaveLength(1);
    expect(calls).toEqual([
      'https://feed/gbfs.json',
      'https://feed/info',
      'https://feed/status',
      'https://feed/status',
    ]);
  });
});

// ---------------------------------------------------------------------------
// AIS (Digitraffic)
// ---------------------------------------------------------------------------

/** From `/api/ais/v1/locations`. */
const AIS = {
  mmsi: 230011480,
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [21.074575, 60.515837] },
  properties: {
    mmsi: 230011480,
    sog: 10.0,
    cog: 359.6,
    navStat: 0,
    heading: 223,
    timestamp: 50,
    timestampExternal: NOW - 20_000,
  },
};

const BALTIC = {
  sourceId: 'digitraffic-ais',
  coverage: { west: 9, south: 53, east: 31, north: 66.5 },
  windowSeconds: 900,
};

describe('Digitraffic vessels', () => {
  const metadata = new Map<string, VesselMetadata>();
  parseVesselMetadata(
    [{ mmsi: 230011480, name: 'FINNMAID@@@', destination: 'HELSINKI' }, { mmsi: 'x' }, null],
    metadata,
  );

  it('joins the static report and maps AIS units', () => {
    const vessel = normaliseDigitrafficVessel(BALTIC, AIS, metadata, NOW);
    expect(vessel).toMatchObject({
      kind: 'vessel',
      id: 'digitraffic-ais:230011480',
      mmsi: '230011480',
      name: 'FINNMAID',
      destination: 'HELSINKI',
      navigationalStatus: 'under way using engine',
      observedAt: new Date(NOW - 20_000).toISOString(),
    });
    expect(vessel?.speedMetersPerSecond).toBeCloseTo(5.1, 1);
    expect(vessel?.headingDegrees).toBeCloseTo(359.6, 1);
  });

  it('reads the in-band "not available" values as null', () => {
    const vessel = normaliseDigitrafficVessel(
      BALTIC,
      {
        ...AIS,
        properties: { ...AIS.properties, sog: 102.3, cog: 360, heading: 511, navStat: 15 },
      },
      new Map(),
      NOW,
    );
    expect(vessel).toMatchObject({
      speedMetersPerSecond: null,
      headingDegrees: null,
      navigationalStatus: null,
      name: null,
    });
    // Course unavailable, true heading available: the heading is used.
    expect(
      normaliseDigitrafficVessel(
        BALTIC,
        { ...AIS, properties: { ...AIS.properties, cog: 360 } },
        new Map(),
        NOW,
      )?.headingDegrees,
    ).toBe(223);
  });

  it('refuses junk features', () => {
    const junk: unknown[] = [
      null,
      { ...AIS, geometry: { type: 'LineString', coordinates: [] } },
      { ...AIS, geometry: { type: 'Point', coordinates: [181, 60] } },
      { ...AIS, geometry: { type: 'Point', coordinates: [-73.9, 40.7] } }, // not the Baltic
      { ...AIS, properties: { ...AIS.properties, mmsi: -5 } },
      { ...AIS, properties: { ...AIS.properties, mmsi: 12345678901 } },
      { ...AIS, properties: { ...AIS.properties, timestampExternal: undefined } },
    ];
    for (const feature of junk) {
      expect(normaliseDigitrafficVessel(BALTIC, feature, metadata, NOW)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// FGC Geotren
// ---------------------------------------------------------------------------

describe('FGC Geotren', () => {
  const options = {
    sourceId: 'fgc-geotren',
    operator: 'FGC',
    coverage: { west: 0.1, south: 40.5, east: 3.4, north: 42.9 },
  };

  it('dates every train by the dataset publication', () => {
    expect(
      geotrenPublishedMs({
        metas: { default: { data_processed: '2026-10-11T12:30:03.074000+00:00' } },
      }),
    ).toBe(Date.parse('2026-10-11T12:30:03.074Z'));
    expect(geotrenPublishedMs({ metas: {} })).toBeNull();
    const train = normaliseGeotrenTrain(
      options,
      {
        id: '6c4b|6a2d',
        lin: 'S1',
        geo_point_2d: { lon: 2.153035, lat: 41.398662 },
        desti: 'PC',
        ut: '1f2cc4fd0272',
      },
      '2026-10-11T12:30:03.074Z',
    );
    expect(train).toMatchObject({
      id: 'fgc-geotren:6c4b|6a2d',
      line: 'S1',
      mode: 'rail',
      headsign: null,
      observedAt: '2026-10-11T12:30:03.074Z',
    });
  });

  it('refuses trains without an id or a position', () => {
    for (const raw of [
      { lin: 'S1', geo_point_2d: { lon: 2.1, lat: 41.4 } },
      { id: 'x' },
      { id: 'x', geo_point_2d: { lon: 2.1 } },
    ]) {
      expect(normaliseGeotrenTrain(options, raw, '2026-10-11T12:30:03.074Z')).toBeNull();
    }
  });
});

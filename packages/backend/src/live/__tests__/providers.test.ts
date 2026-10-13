/**
 * Providers are data, built by one adapter per standard: an entry's format
 * picks the adapter, its auth puts the key where the provider wants it, and
 * `LIVE_SOURCES=all` takes the whole licence-checked catalogue, skipping a
 * keyed feed that has no key.
 */
import { describe, expect, it } from 'bun:test';
import { parseLiveConfig } from '../../config/live';
import { LIVE_SOURCE_IDS } from '../catalogue';
import { configuredLiveSources, createLiveService } from '../index';
import { protobufWriter as w } from '../protobuf';
import { type LiveProvider, providerSource } from '../providers';
import type { LiveFetch } from '../types';

const BASE: LiveProvider = {
  id: 'test-city-bus',
  place: 'Test City',
  country: 'XX',
  name: 'Buses — Test City',
  operator: 'Test',
  kind: 'transit',
  format: 'gtfs-rt-vp',
  url: 'https://feeds.example/vp.pb',
  defaultMode: 'bus',
  coverage: { west: 10, south: 59, east: 11, north: 60 },
  completeness: 'network',
  attribution: { label: 'Test', href: 'https://example.org' },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
  licenceCheck: {
    verifiedOn: '2026-10-12',
    source: 'https://example.org/licence',
    quote: 'commercial use allowed',
  },
  auth: { kind: 'none' },
  pollIntervalSeconds: 15,
};

function feed(): Uint8Array {
  const header = w.bytes(1, [...w.string(1, '2.0'), ...w.uint(3, Math.floor(Date.now() / 1000))]);
  const vehicle = w.bytes(2, [
    ...w.string(1, 'e1'),
    ...w.bytes(4, [
      // A trip on route `100001`: an id, not what riders call the line.
      ...w.bytes(1, [...w.string(1, 'T9'), ...w.string(5, '100001')]),
      ...w.bytes(8, w.string(1, 'bus-7')),
      ...w.bytes(2, [...w.float(1, 59.9), ...w.float(2, 10.75)]),
      ...w.uint(5, Math.floor(Date.now() / 1000)),
    ]),
  ]);
  return new Uint8Array([...header, ...vehicle]);
}

function recordingFetch(body: Uint8Array) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const fetch: LiveFetch = async (url, init) => {
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return {
      status: 200,
      headers: { get: () => null },
      arrayBuffer: async () =>
        body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer,
    };
  };
  return { fetch, calls };
}

const context = (fetch: LiveFetch) => ({
  signal: new AbortController().signal,
  fetch,
  now: Date.now,
  demand: [],
});
const settings = (url: string, key?: string) => ({
  url,
  userAgent: 'test',
  maxRegionsPerPoll: 1,
  ...(key ? { key } : {}),
});

describe('a provider entry', () => {
  it('a keyless GTFS-RT feed: positions, sent with its own headers', async () => {
    const source = providerSource({ ...BASE, headers: { 'ET-Client-Name': 'goway-live' } });
    expect(source.requiresKey).toBe(false);
    const { fetch, calls } = recordingFetch(feed());
    const result = await source.create(settings(BASE.url)).poll(context(fetch));
    expect(result.entities.map((e) => e.id)).toEqual(['test-city-bus:bus-7']);
    expect(calls[0]?.headers['ET-Client-Name']).toBe('goway-live');
    // Trapeze servers answer 406 without a wildcard; Adelaide answers JSON
    // unless Google's protobuf type comes first.
    const accept = calls[0]?.headers.accept ?? '';
    expect(accept.split(',')[0]).toBe('application/x-google-protobuf');
    expect(accept).toContain('application/protocol-buffer');
    expect(accept).toContain('*/*');
  });

  it('a keyed feed: needs a key, names where to register, and sends it where the provider wants', async () => {
    const header = providerSource({
      ...BASE,
      auth: {
        kind: 'header',
        header: 'Authorization',
        prefix: 'apikey ',
        registrationUrl: 'https://register.example',
      },
    });
    expect(header.requiresKey).toBe(true);
    expect(header.keyRegistrationUrl).toBe('https://register.example');
    const a = recordingFetch(feed());
    await header.create(settings(BASE.url, 's3cret')).poll(context(a.fetch));
    expect(a.calls[0]?.headers.Authorization).toBe('apikey s3cret');
    const query = providerSource({
      ...BASE,
      auth: { kind: 'query', parameter: 'api_key', registrationUrl: 'https://register.example' },
    });
    const b = recordingFetch(feed());
    await query.create(settings(BASE.url, 's3cret')).poll(context(b.fetch));
    expect(b.calls[0]?.url).toBe('https://feeds.example/vp.pb?api_key=s3cret');
  });

  it("a GBFS feed: stations, sent with the operator's own headers", async () => {
    const source = providerSource({
      ...BASE,
      kind: 'bikeshare',
      format: 'gbfs',
      url: 'https://gbfs.example/gbfs.json',
      headers: { 'Client-Identifier': 'oxy-goway' },
    });
    const now = Math.floor(Date.now() / 1000);
    const bodies: Record<string, unknown> = {
      'https://gbfs.example/gbfs.json': {
        data: {
          en: {
            feeds: [
              { name: 'station_information', url: 'https://gbfs.example/info.json' },
              { name: 'station_status', url: 'https://gbfs.example/status.json' },
            ],
          },
        },
      },
      'https://gbfs.example/info.json': {
        data: {
          stations: [{ station_id: 's1', name: 'Torget', lat: 59.91, lon: 10.75, capacity: 20 }],
        },
      },
      'https://gbfs.example/status.json': {
        last_updated: now,
        data: {
          stations: [
            {
              station_id: 's1',
              num_bikes_available: 4,
              num_docks_available: 16,
              is_renting: 1,
              is_returning: 1,
              last_reported: now,
            },
          ],
        },
      },
    };
    const calls: Record<string, string>[] = [];
    const fetch: LiveFetch = async (url, init) => {
      calls.push((init?.headers ?? {}) as Record<string, string>);
      const text = JSON.stringify(bodies[url]);
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
        text: async () => text,
        json: async () => JSON.parse(text),
      } as never;
    };
    const result = await source.create(settings(source.defaultUrl)).poll(context(fetch));
    expect(result.entities.map((e) => e.id)).toEqual(['test-city-bus:s1']);
    expect(calls.length).toBe(3);
    for (const headers of calls) expect(headers['Client-Identifier']).toBe('oxy-goway');
  });

  it('a route id is never shown as the line, unless the entry says riders use it', async () => {
    const { fetch } = recordingFetch(feed());
    const opaque = await providerSource(BASE).create(settings(BASE.url)).poll(context(fetch));
    expect(opaque.entities[0]).toMatchObject({ kind: 'transit', line: null });
    // The route still names the vehicle's line in the static GTFS (the hub's join).
    expect(opaque.hints?.get('test-city-bus:bus-7')).toEqual({ tripId: 'T9', route: '100001' });
    const named = await providerSource({ ...BASE, routeIdIsLine: true })
      .create(settings(BASE.url))
      .poll(context(fetch));
    expect(named.entities[0]).toMatchObject({ kind: 'transit', line: '100001' });
  });

  it('picks the adapter by format', () => {
    for (const format of ['gtfs-rt-vp', 'gtfs-rt-tu', 'gbfs', 'siri-vm'] as const) {
      const adapter = providerSource({
        ...BASE,
        format,
        ...(format === 'gtfs-rt-tu'
          ? { staticGtfs: { zip: 'https://feeds.example/gtfs.zip' } }
          : {}),
      }).create(settings(BASE.url));
      expect(typeof adapter.poll).toBe('function');
    }
  });
});

describe('LIVE_SOURCES=all', () => {
  it('takes the whole catalogue, and skips a keyed source without its key, quietly', () => {
    const config = parseLiveConfig({ LIVE_SOURCES: 'all' }, LIVE_SOURCE_IDS);
    expect(config.all).toBe(true);
    expect(config.sources).toEqual([...LIVE_SOURCE_IDS]);
    const warnings: unknown[] = [];
    const service = createLiveService({
      config,
      logger: { info: () => {}, warn: (object) => warnings.push(object) },
    });
    expect(service).not.toBeNull();
    expect(warnings).toEqual([]);
    service?.stop();
  });

  it('leaves out a source still awaiting a permission, unless it is named', () => {
    const quiet = { info: () => {}, warn: () => {} };
    const all = configuredLiveSources(
      parseLiveConfig({ LIVE_SOURCES: 'all' }, LIVE_SOURCE_IDS),
      quiet,
    );
    const ids = all.map((source) => source.definition.id);
    expect(ids).not.toContain('adsb-lol');
    expect(ids).not.toContain('nyc-bikeshare');
    expect(ids).not.toContain('york-yrt');
    expect(ids).toContain('renfe-cercanias');
    expect(ids).toContain('helsinki-hsl');
    const named = configuredLiveSources(
      parseLiveConfig({ LIVE_SOURCES: 'all,adsb-lol' }, LIVE_SOURCE_IDS),
      quiet,
    ).map((source) => source.definition.id);
    expect(named).toContain('adsb-lol');
    expect(named).not.toContain('nyc-bikeshare');
    // Listed alone, as before, it is served: the owner listing it is the decision.
    const listed = configuredLiveSources(
      parseLiveConfig({ LIVE_SOURCES: 'nyc-bikeshare' }, LIVE_SOURCE_IDS),
      quiet,
    ).map((source) => source.definition.id);
    expect(listed).toEqual(['nyc-bikeshare']);
  });
});

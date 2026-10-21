/**
 * A static GTFS of several parts (Renfe's commuter and long-distance zips)
 * loads part by part: one zip down never costs the other its tracks, a
 * failed part is retried within half an hour however often it failed, and
 * static loads run one at a time.
 */
import { describe, expect, it } from 'bun:test';
import { liveTileOf } from '@goway/contracts';
import { LiveHub, MAX_CONCURRENT_STATIC_LOADS, STATIC_GTFS_MAX_BACKOFF_MS } from '../hub';
import type { LiveFetch, LiveSourceDefinition } from '../types';

/** A stored (uncompressed) zip. */
function zip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = encoder.encode(text);
    const nameBytes = encoder.encode(name);
    const local = new Uint8Array(30);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    const head = new Uint8Array(46);
    const hv = new DataView(head.buffer);
    hv.setUint32(0, 0x02014b50, true);
    hv.setUint32(20, data.length, true);
    hv.setUint32(24, data.length, true);
    hv.setUint16(28, nameBytes.length, true);
    hv.setUint32(42, offset, true);
    parts.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(10, Object.keys(files).length, true);
  ev.setUint32(12, size, true);
  ev.setUint32(16, offset, true);
  return new Uint8Array(Buffer.concat([...parts, ...central, end]));
}

const COMMUTER = zip({
  'routes.txt': 'route_id,route_short_name,route_type\nR2N,R2N,2\n',
  'trips.txt': 'route_id,service_id,trip_id,shape_id\nR2N,s,T1,line\n',
  'shapes.txt':
    'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nline,41.39,2.16,1\nline,41.39,2.18,2\n',
});
const BARCELONA_ROOM = {
  tile: liveTileOf({ latitude: 41.39, longitude: 2.17 }, 'transit'),
  kind: 'transit' as const,
};

function definition(
  id: string,
  staticGtfs: LiveSourceDefinition['staticGtfs'],
): LiveSourceDefinition {
  return {
    id,
    kind: 'transit',
    name: id,
    attribution: { label: 'Test', href: 'https://example.org' },
    licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
    licenceCheck: { verifiedOn: '2026-10-12', source: 'https://example.org', quote: 'test' },
    coverage: { west: 1.9, south: 41.2, east: 2.4, north: 41.6 },
    completeness: 'network',
    defaultUrl: 'https://example.org/feed',
    requiresKey: false,
    pollIntervalSeconds: 10,
    staleAfterSeconds: 60,
    dropAfterSeconds: 120,
    ...(staticGtfs ? { staticGtfs } : {}),
    create: () => ({ poll: async () => ({ entities: [], rejected: 0 }) }),
  };
}

const settings = { url: 'https://example.org/feed', userAgent: 'test', maxRegionsPerPoll: 1 };

describe('static GTFS in parts', () => {
  it('keeps the commuter tracks when the long-distance zip fails, and retries it within half an hour', async () => {
    const clock = { now: Date.parse('2026-10-15T08:00:00Z') };
    const asked: string[] = [];
    const fetch: LiveFetch = async (url) => {
      asked.push(url);
      if (url.endsWith('/ld.zip'))
        return {
          status: 503,
          headers: { get: () => null },
          arrayBuffer: async () => new ArrayBuffer(0),
        };
      return {
        status: 200,
        headers: { get: () => null },
        arrayBuffer: async () => COMMUTER.slice().buffer as ArrayBuffer,
      };
    };
    const hub = new LiveHub({
      sources: [
        {
          definition: definition('renfe-like', {
            zips: ['https://gtfs.example/cer.zip', 'https://gtfs.example/ld.zip'],
          }),
          settings,
        },
      ],
      fetch,
      now: () => clock.now,
      publish: () => {},
    });
    hub.watch('viewer', [BARCELONA_ROOM]);
    await hub.tick();
    expect(hub.shape('renfe-like', 'line')).not.toBeNull();
    // However often the long-distance zip fails, it is asked again within 30 min.
    for (let attempt = 0; attempt < 12; attempt++) {
      const before = asked.filter((url) => url.endsWith('/ld.zip')).length;
      clock.now += STATIC_GTFS_MAX_BACKOFF_MS + 1_000;
      await hub.tick();
      expect(asked.filter((url) => url.endsWith('/ld.zip')).length).toBe(before + 1);
      // And the commuter part it holds is never lost.
      expect(hub.shape('renfe-like', 'line')).not.toBeNull();
    }
    hub.stop();
  });

  it(`loads at most ${MAX_CONCURRENT_STATIC_LOADS} static GTFS at once`, async () => {
    const pending: (() => void)[] = [];
    let inFlight = 0;
    let most = 0;
    const fetch: LiveFetch = (url) =>
      new Promise((resolve) => {
        inFlight++;
        most = Math.max(most, inFlight);
        pending.push(() => {
          inFlight--;
          resolve({
            status: 200,
            headers: { get: () => null },
            arrayBuffer: async () => COMMUTER.slice().buffer as ArrayBuffer,
          });
        });
        void url;
      });
    const hub = new LiveHub({
      sources: ['a', 'b', 'c'].map((id) => ({
        definition: definition(id, { zip: `https://gtfs.example/${id}.zip` }),
        settings,
      })),
      fetch,
      publish: () => {},
    });
    hub.watch('viewer', [BARCELONA_ROOM]);
    for (let round = 0; round < 3; round++) {
      void hub.tick();
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(most).toBeLessThanOrEqual(MAX_CONCURRENT_STATIC_LOADS);
      for (const release of pending.splice(0)) release();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(['a', 'b', 'c'].every((id) => hub.shape(id, 'line') !== null)).toBe(true);
    hub.stop();
  });
});

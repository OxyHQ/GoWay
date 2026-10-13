/**
 * Static GTFS and track matching: the zip reader, the CSV, shapes with their
 * running length, and the rule that puts a reported vehicle on its operator's
 * own shape — or refuses to.
 */

import { describe, expect, it } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import {
  buildStaticGtfs,
  findTrip,
  loadStaticGtfs,
  makeShape,
  matchTrack,
  modeOfRouteType,
  parseCsv,
  project,
  SNAP_TOLERANCE_METERS,
} from '../staticGtfs';
import { getRangeSource } from '../normalise';
import { type RangeSource, readZipEntries, readZipEntriesRanged, ZipError } from '../zip';

/** A zip with deflated entries, built by hand (local headers + central directory). */
function zip(files: Record<string, string>): Uint8Array {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = deflateRawSync(Buffer.from(text));
    const nameBytes = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(8, 10);
    head.writeUInt32LE(data.length, 20);
    head.writeUInt32LE(Buffer.byteLength(text), 24);
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    chunks.push(local, nameBytes, data);
    central.push(head, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...chunks, centralBytes, end]));
}

// A line running east along a parallel, then turning north: 0.01° of
// longitude at 41.4° is ~834 m.
const ROUTES =
  'route_id,route_short_name,route_long_name,route_type,route_color,route_text_color\nR2N_A ,R2N ,Aeroport - Maçanet ,2,D0DF00,FFFFFF\nR2N_B,R2N,Maçanet - Aeroport,2,D0DF00,FFFFFF\nLB,,"Babylon Branch",2,00985F,FFFFFF\n';
const SHAPES = [
  'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence',
  // Out of order on purpose: the sequence decides.
  'east,41.40,2.11,2',
  'east,41.40,2.10,1',
  'east,41.41,2.11,3',
  // The same track, the other way.
  'west,41.41,2.11,1',
  'west,41.40,2.11,2',
  'west,41.40,2.10,3',
  'lb,40.70,-73.30,1',
  'lb,40.71,-73.30,2',
].join('\n');
const TRIPS = [
  'route_id,service_id,trip_id,trip_headsign,trip_short_name,shape_id',
  'R2N_A,s,T1,,8716,east',
  'R2N_B,s,T2,,8717,west',
  'LB,s,GO202_26_8716,,1229,lb',
].join('\n');

const gtfs = buildStaticGtfs({ routes: ROUTES, trips: TRIPS, shapes: SHAPES });

describe('the zip reader', () => {
  it('reads the named files and skips the rest', () => {
    const entries = readZipEntries(
      zip({ 'routes.txt': 'a', 'stop_times.txt': 'huge', 'gtfs/trips.txt': 'b' }),
      ['routes.txt', 'trips.txt'],
    );
    expect(new TextDecoder().decode(entries.get('routes.txt'))).toBe('a');
    expect(new TextDecoder().decode(entries.get('trips.txt'))).toBe('b');
    expect(entries.has('stop_times.txt')).toBe(false);
  });

  it('throws on a truncated or foreign file', () => {
    const good = zip({ 'routes.txt': 'route_id' });
    expect(() => readZipEntries(good.subarray(0, good.length - 30), ['routes.txt'])).toThrow(
      ZipError,
    );
    expect(() => readZipEntries(new TextEncoder().encode('<html>'), ['routes.txt'])).toThrow(
      ZipError,
    );
  });

  it('loads a GTFS zip end to end', async () => {
    const bytes = zip({ 'routes.txt': ROUTES, 'trips.txt': TRIPS, 'shapes.txt': SHAPES });
    const loaded = await loadStaticGtfs({ zip: 'x' }, async () => bytes);
    expect(loaded.shapes.size).toBe(3);
    await expect(
      loadStaticGtfs({ zip: 'x' }, async () => zip({ 'routes.txt': ROUTES })),
    ).rejects.toThrow(/trips.txt missing/);
  });

  it('loads an operator whose zip has no shapes.txt: modes and colours, no tracks', async () => {
    const loaded = await loadStaticGtfs({ zip: 'x' }, async () =>
      zip({ 'routes.txt': ROUTES, 'trips.txt': TRIPS }),
    );
    expect(loaded.shapes.size).toBe(0);
    expect(loaded.routes.get('R2N_B')?.mode).toBe('rail');
  });
});

describe('the static GTFS', () => {
  it('parses quoted, padded CSV', () => {
    expect(parseCsv('"a","b"\n" x ","y ""z"""\r\n').rows).toEqual([['x', 'y "z"']]);
  });

  it('keeps colours, orders shapes by sequence and measures them', () => {
    expect(gtfs.routes.get('R2N_A')).toEqual({
      shortName: 'R2N',
      longName: 'Aeroport - Maçanet',
      mode: 'rail',
      color: '#D0DF00',
      textColor: '#FFFFFF',
    });
    const east = gtfs.shapes.get('east');
    expect(east?.lon[0]).toBe(2.1);
    expect(east?.length).toBeGreaterThan(834 + 1100);
    expect(east?.length).toBeLessThan(834 + 1120);
    expect([...(gtfs.shapesByRoute.get('R2N') ?? [])].sort()).toEqual(['east', 'west']);
  });

  it('finds a realtime trip by id, LIRR suffix or train number', () => {
    expect(findTrip(gtfs, 'T1')?.shapeId).toBe('east');
    expect(findTrip(gtfs, 'GO202_26_8716_1')?.shapeId).toBe('lb');
    expect(findTrip(gtfs, '1229')?.shapeId).toBe('lb');
    expect(findTrip(gtfs, 'nope')).toBeUndefined();
  });
});

describe('projection and matching', () => {
  const east = makeShape('e', [
    [41.4, 2.1],
    [41.4, 2.11],
    [41.41, 2.11],
  ]);

  it('projects onto the nearest segment, measuring along the line', () => {
    const p = project(east, 41.4003, 2.105); // ~33 m north of the first leg's middle
    expect(p.along).toBeCloseTo(417, -1);
    expect(p.offset).toBeCloseTo(33, 0);
    const around = project(east, 41.405, 2.1103); // the second leg, after the corner
    expect(around.along).toBeGreaterThan(834 + 500);
  });

  it("puts a vehicle on its trip's shape, with the line's colour", () => {
    const m = matchTrack(gtfs, { tripId: 'T1' }, { latitude: 41.4002, longitude: 2.104 }, null);
    expect(m.trackStatus).toBe('on_track');
    expect(m.track?.shapeId).toBe('east');
    expect(m.route?.color).toBe('#D0DF00');
  });

  it('refuses a report beyond the tolerance, and says why', () => {
    const far = matchTrack(gtfs, { tripId: 'T1' }, { latitude: 41.402, longitude: 2.104 }, null); // ~220 m off
    expect(far).toMatchObject({ track: null, trackStatus: 'off_track' });
    expect(SNAP_TOLERANCE_METERS).toBe(75);
    expect(
      matchTrack(gtfs, { route: 'NOPE' }, { latitude: 41.4, longitude: 2.1 }, null).trackStatus,
    ).toBe('unknown');
  });

  it("tells a route's two directions apart by the way the vehicle has been moving", () => {
    const at = { latitude: 41.4, longitude: 2.105 };
    // First report: a tie, either is fine.
    const first = matchTrack(gtfs, { route: 'R2N' }, at, null);
    expect(first.trackStatus).toBe('on_track');
    // It was on `west` at 1200 m along and is now at ~1250: forward on west — kept.
    const west = gtfs.shapes.get('west');
    if (!west) throw new Error('fixture shape missing');
    const westAt = project(west, at.latitude, at.longitude).along;
    const kept = matchTrack(gtfs, { route: 'R2N' }, at, { shapeId: 'west', along: westAt - 50 });
    expect(kept.track?.shapeId).toBe('west');
    // It was on `west` FURTHER along than now: that is backwards on west, so it is going east.
    const flipped = matchTrack(gtfs, { route: 'R2N' }, at, {
      shapeId: 'west',
      along: westAt + 300,
    });
    expect(flipped.track?.shapeId).toBe('east');
  });
});

describe('route_type → mode', () => {
  it('reads the basic types and the extended hundreds, and refuses what it does not know', () => {
    expect([0, 1, 2, 3, 4, 5, 7, 11, 12].map(modeOfRouteType)).toEqual([
      'tram',
      'subway',
      'rail',
      'bus',
      'ferry',
      'cable',
      'cable',
      'bus',
      'other',
    ]);
    expect([101, 200, 401, 700, 800, 900, 1000, 1200, 1300, 1400].map(modeOfRouteType)).toEqual([
      'rail',
      'bus',
      'subway',
      'bus',
      'bus',
      'tram',
      'ferry',
      'ferry',
      'cable',
      'cable',
    ]);
    expect(modeOfRouteType(-1)).toBeNull();
    expect(modeOfRouteType(2.5)).toBeNull();
    expect(modeOfRouteType(9999)).toBeNull();
  });

  it('is on each route that states one', () => {
    const gtfs = buildStaticGtfs({
      routes: ROUTES,
      trips: 'route_id,trip_id\n',
      shapes: 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n',
    });
    expect(gtfs.routes.get('R2N_B')?.mode).toBe('rail');
  });
});

/** A remote file served from memory, remembering which bytes were asked for. */
function remote(bytes: Uint8Array): RangeSource & { asked: [number, number][] } {
  const asked: [number, number][] = [];
  return {
    size: bytes.byteLength,
    asked,
    async read(start, end) {
      asked.push([start, end]);
      return bytes.slice(start, end + 1);
    },
  };
}

describe('reading a zip by range', () => {
  const archive = zip({
    'routes.txt': ROUTES,
    'trips.txt': TRIPS,
    // Large enough that fetching it by mistake would show in what was asked for.
    'shapes.txt': `${SHAPES}\n${randomBytes(60_000).toString('base64')}`,
    'stop_times.txt': randomBytes(200_000).toString('base64'),
  });

  it('fetches the directory and the files wanted, and never the ones not', async () => {
    const source = remote(archive);
    const { entries } = await readZipEntriesRanged(source, ['routes.txt', 'trips.txt']);
    expect(new TextDecoder().decode(entries.get('routes.txt'))).toBe(ROUTES);
    expect(entries.has('shapes.txt')).toBe(false);
    const fetched = source.asked.reduce((total, [a, b]) => total + (b - a + 1), 0);
    // Directory + two small files and their headers, a fraction of the archive.
    expect(fetched).toBeLessThan(archive.byteLength / 2);
  });

  it('skips a file larger than its limit and says so, instead of reading or failing', async () => {
    const { entries, skipped } = await readZipEntriesRanged(
      remote(archive),
      ['routes.txt', 'shapes.txt'],
      (name) => (name === 'shapes.txt' ? 1_000 : Number.POSITIVE_INFINITY),
    );
    expect(entries.has('routes.txt')).toBe(true);
    expect(entries.has('shapes.txt')).toBe(false);
    expect(skipped.get('shapes.txt')).toBeGreaterThan(50_000);
  });

  it('builds a network from a ranged zip, routes only, with modes', async () => {
    const loaded = await loadStaticGtfs({ zip: 'x', routesOnly: true }, async () =>
      remote(archive),
    );
    expect(loaded.routes.get('R2N_A')?.mode).toBe('rail');
    expect(loaded.trips.size).toBe(0);
    expect(loaded.shapes.size).toBe(0);
  });

  it('refuses a truncated remote archive', async () => {
    await expect(
      readZipEntriesRanged(remote(archive.subarray(0, archive.byteLength - 100)), ['routes.txt']),
    ).rejects.toThrow(ZipError);
  });
});

describe('getRangeSource', () => {
  const body = new TextEncoder().encode('0123456789abcdefghij');
  const headersOf = (values: Record<string, string>) => ({
    get: (name: string) => values[name.toLowerCase()] ?? null,
  });

  it('serves the tail it already holds without another request, and other slices by range', async () => {
    const requests: string[] = [];
    const fetch = async (_url: string, init: { headers: Record<string, string> }) => {
      const range = init.headers.range as string;
      requests.push(range);
      const match = /bytes=(-?)(\d+)(?:-(\d+))?/.exec(range) as RegExpExecArray;
      const [from, to] = match[1]
        ? [body.length - Number(match[2]), body.length - 1]
        : [Number(match[2]), Number(match[3])];
      const slice = body.slice(from, to + 1);
      return {
        status: 206,
        headers: headersOf({ 'content-range': `bytes ${from}-${to}/${body.length}` }),
        arrayBuffer: async () =>
          slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength) as ArrayBuffer,
      };
    };
    const source = (await getRangeSource(
      fetch,
      'https://x/z.zip',
      new AbortController().signal,
      {},
      8,
      100,
    )) as RangeSource;
    expect(source.size).toBe(20);
    expect(new TextDecoder().decode(await source.read(14, 17))).toBe('efgh');
    expect(requests).toEqual(['bytes=-8']);
    expect(new TextDecoder().decode(await source.read(2, 4))).toBe('234');
    expect(requests).toEqual(['bytes=-8', 'bytes=2-4']);
  });

  it('takes the whole file from a server that ignores Range, within the size limit', async () => {
    const whole = async () => ({
      status: 200,
      headers: headersOf({ 'content-length': String(body.length) }),
      arrayBuffer: async () => body.buffer.slice(0) as ArrayBuffer,
    });
    const got = await getRangeSource(whole, 'https://x', new AbortController().signal, {}, 8, 100);
    expect(got).toBeInstanceOf(Uint8Array);
    await expect(
      getRangeSource(whole, 'https://x', new AbortController().signal, {}, 8, 10),
    ).rejects.toThrow(/too large/);
  });

  it('is an error when a slice comes back the wrong length', async () => {
    let calls = 0;
    const fetch = async () => {
      calls++;
      const bytes = calls === 1 ? body.slice(12) : body.slice(0, 2);
      return {
        status: 206,
        headers: headersOf({ 'content-range': `bytes 12-19/${body.length}` }),
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      };
    };
    const source = (await getRangeSource(
      fetch,
      'https://x',
      new AbortController().signal,
      {},
      8,
      100,
    )) as RangeSource;
    await expect(source.read(0, 4)).rejects.toThrow(/wrong length/);
  });
});

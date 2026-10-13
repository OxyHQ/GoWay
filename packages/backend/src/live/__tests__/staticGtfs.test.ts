/**
 * Static GTFS and track matching: the zip reader, the CSV, shapes with their
 * running length, and the rule that puts a reported vehicle on its operator's
 * own shape — or refuses to.
 */

import { describe, expect, it } from 'bun:test';
import { deflateRawSync } from 'node:zlib';
import {
  buildStaticGtfs,
  findTrip,
  loadStaticGtfs,
  makeShape,
  matchTrack,
  parseCsv,
  project,
  SNAP_TOLERANCE_METERS,
} from '../staticGtfs';
import { readZipEntries, readZipEntriesRanged, type ZipRangeReader, ZipError } from '../zip';

/** A zip with deflated entries, built by hand (local headers + central directory). */
function zip(files: Record<string, string>, options: { zip64?: boolean } = {}): Uint8Array {
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
    head.writeUInt16LE(nameBytes.length, 28);
    head.writeUInt32LE(offset, 42);
    // ZIP64, as Nice's writer does it: the sizes overflowed to 0xFFFFFFFF and
    // the real ones in the 0x0001 extra record (uncompressed, then compressed).
    const extra = Buffer.alloc(options.zip64 ? 20 : 0);
    if (options.zip64) {
      head.writeUInt32LE(0xffffffff, 20);
      head.writeUInt32LE(0xffffffff, 24);
      head.writeUInt16LE(extra.length, 30);
      extra.writeUInt16LE(0x0001, 0);
      extra.writeUInt16LE(16, 2);
      extra.writeBigUInt64LE(BigInt(Buffer.byteLength(text)), 4);
      extra.writeBigUInt64LE(BigInt(data.length), 12);
    } else {
      head.writeUInt32LE(data.length, 20);
      head.writeUInt32LE(Buffer.byteLength(text), 24);
    }
    chunks.push(local, nameBytes, data);
    central.push(head, nameBytes, extra);
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

  it('reads ZIP64 sizes from the extra field', () => {
    const entries = readZipEntries(
      zip({ 'routes.txt': ROUTES, 'shapes.txt': SHAPES }, { zip64: true }),
      ['routes.txt'],
    );
    expect(new TextDecoder().decode(entries.get('routes.txt'))).toBe(ROUTES);
  });

  it("reads a big archive's small files by range, and the whole of it from a server without ranges", async () => {
    // A stop_times.txt that barely compresses: ~800 KB the ranged read must not fetch.
    let seed = 7;
    const noise = Array.from({ length: 400_000 }, () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return String(seed % 100_000).padStart(5, '0');
    }).join('');
    const archive = zip({ 'routes.txt': ROUTES, 'stop_times.txt': noise, 'trips.txt': TRIPS });
    const server = (honoursRanges: boolean) => {
      let sent = 0;
      const read: ZipRangeReader = async (range) => {
        if (!honoursRanges) {
          sent += archive.byteLength;
          return { bytes: archive, partial: false };
        }
        const suffix = /^bytes=-(\d+)$/.exec(range);
        const span = /^bytes=(\d+)-(\d+)$/.exec(range);
        const from = suffix
          ? Math.max(0, archive.byteLength - Number(suffix[1]))
          : Number(span?.[1]);
        const to = suffix
          ? archive.byteLength - 1
          : Math.min(archive.byteLength - 1, Number(span?.[2]));
        const part = archive.subarray(from, to + 1);
        sent += part.byteLength;
        return { bytes: part, partial: true };
      };
      return { read, sent: () => sent };
    };
    const ranged = server(true);
    const entries = await readZipEntriesRanged(ranged.read, ['routes.txt']);
    expect(new TextDecoder().decode(entries.get('routes.txt'))).toBe(ROUTES);
    expect(archive.byteLength).toBeGreaterThan(700_000);
    expect(ranged.sent()).toBeLessThan(250_000);
    const whole = server(false);
    const again = await readZipEntriesRanged(whole.read, ['routes.txt', 'trips.txt']);
    expect(new TextDecoder().decode(again.get('trips.txt'))).toBe(TRIPS);
    // loadStaticGtfs takes the ranged path when only part of the file is wanted.
    const viaLoad = server(true);
    const routesOnly = await loadStaticGtfs(
      { zip: 'x', only: 'routes' },
      async () => {
        throw new Error('the whole archive was downloaded');
      },
      (_url, range) => viaLoad.read(range),
    );
    expect(routesOnly.routes.size).toBe(3);
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
    // Shapes are optional (Renfe's long-distance file has none): lines, no tracks.
    const shapeless = await loadStaticGtfs({ zip: 'x' }, async () =>
      zip({ 'routes.txt': ROUTES, 'trips.txt': TRIPS }),
    );
    expect(shapeless.shapes.size).toBe(0);
    expect(shapeless.routes.size).toBeGreaterThan(0);
  });

  it('reads only routes, or routes and trips, when that is all a feed needs', async () => {
    const bytes = zip({ 'routes.txt': ROUTES, 'trips.txt': TRIPS, 'shapes.txt': SHAPES });
    const routes = await loadStaticGtfs({ zip: 'x', only: 'routes' }, async () =>
      zip({ 'routes.txt': ROUTES }),
    );
    expect([routes.routes.size, routes.trips.size, routes.shapes.size]).toEqual([3, 0, 0]);
    const trips = await loadStaticGtfs({ zip: 'x', only: 'trips' }, async () => bytes);
    expect(trips.trips.get('T1')?.routeId).toBe('R2N_A');
    expect(trips.shapes.size).toBe(0);
    // The line, colour and mode, by the vehicle's route id; no track.
    const match = matchTrack(
      routes,
      { route: 'R2N_A' },
      { latitude: 41.4, longitude: 2.105 },
      null,
    );
    expect(match.route?.shortName).toBe('R2N');
    expect(match.route?.mode).toBe('rail');
    expect(match.track).toBeNull();
  });

  it("a route id is looked up as an id before as another route's short name", () => {
    const routes = buildStaticGtfs({
      routes: 'route_id,route_short_name,route_type\n2,165,3\n9,2,0\n',
      trips: 'route_id,trip_id\n',
      shapes: 'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n',
    });
    const match = matchTrack(routes, { route: '2' }, { latitude: 60, longitude: 25 }, null);
    expect(match.route?.shortName).toBe('165');
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
      color: '#D0DF00',
      textColor: '#FFFFFF',
      mode: 'rail', // route_type 2
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

/**
 * Compile an OpenStreetMap extract into GoWay's ROAD tiles — the lane and
 * footway network the city-life simulation drives and walks on
 * (`lib/map/cityRoads.ts`, `docs/MAP_CITY_LIFE.md`).
 *
 * ```bash
 * bun run --cwd packages/frontend map:city-roads --pbf=<cataluna.osm.pbf> --area=barcelona
 * bun run --cwd packages/frontend map:city-roads --verify --archive=<path>
 * # One region of the planet build (the region builder writes the file):
 * bun run --cwd packages/frontend map:city-roads --pbf=<file> --ownership=<region.ownership.json>
 * ```
 *
 * A separate archive from the buildings (`build-city-tiles.ts`), on the same
 * z15 grid, from the same extract: why separate is measured in
 * `cityRoads.ts`. Serve both from the dev server by listing both in
 * `GOWAY_CITY_TILES_ARCHIVE`; the dev route tells them apart by the
 * archive's `goway:kind` metadata.
 *
 * Licence: as the building archive — a Derivative Database of OpenStreetMap
 * under the ODbL, with a receipt naming the extract it came from.
 */
import { closeSync, openSync } from 'node:fs';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { decodeRoadTile } from '../components/map/engine/roads/roadTiles';
import {
  CITY_ARCHIVE_KIND_KEY,
  CITY_RESTRICTION_LAYER,
  CITY_ROAD_LAYER,
  CITY_ROAD_NODE_LAYER,
  CITY_ROAD_SCHEMA_VERSION,
  RESTRICTION_PROPS,
  ROAD_NODE_PROPS,
  ROAD_PROPS,
} from '../lib/map/cityRoads';
import { CITY_TILE_EXTENT, CITY_TILE_ZOOM } from '../lib/map/cityTiles';
import { COMPRESSION, PMTiles, TILE_TYPE } from '@goway/map-service/pmtiles.js';
import { AREAS } from './build-city-tiles';
import { peakRssMb } from './citygen/memory';
import { encodeTileLayers } from './citygen/mvtEncode';
import { readBlob, readHeader, scanBlobs } from './citygen/osmPbf';
import { writePmtiles } from './citygen/pmtilesWriter';
import {
  assertOwned,
  densestTile,
  type LoadedOwnership,
  loadOwnership,
  ownershipOf,
  PROBE_METADATA_KEY,
  probeTile,
  regionMetadata,
} from './citygen/regionArchive';
import { compileRoads, roadLayers } from './citygen/roads';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(FRONTEND_ROOT, '.tiles');

interface Args {
  pbf?: string;
  out?: string;
  area?: string;
  bbox?: [number, number, number, number];
  verify: boolean;
  archive?: string;
  /** A region's ownership file (`citygen/regionArchive.ts`): build only its tiles. */
  ownership?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { verify: false };
  for (const raw of argv) {
    const [flag, value] = raw.startsWith('--') ? raw.slice(2).split('=', 2) : [raw, undefined];
    if (flag === 'pbf' && value) args.pbf = value;
    else if (flag === 'out' && value) args.out = value;
    else if (flag === 'archive' && value) args.archive = value;
    else if (flag === 'area' && value) args.area = value;
    else if (flag === 'ownership' && value) args.ownership = value;
    else if (flag === 'verify') args.verify = true;
    else if (flag === 'bbox' && value) {
      const parts = value.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error('--bbox=west,south,east,north');
      }
      args.bbox = parts as [number, number, number, number];
    }
  }
  return args;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

const pct = (part: number, whole: number) =>
  whole === 0 ? '0' : ((100 * part) / whole).toFixed(part / whole < 0.01 ? 2 : 1);

async function build(args: Args): Promise<string> {
  if (!args.pbf) throw new Error('--pbf=<extract.osm.pbf> is required to build');
  const area = args.area ? AREAS[args.area] : undefined;
  if (args.area && !area) {
    throw new Error(`unknown --area=${args.area}; known: ${Object.keys(AREAS).join(', ')}`);
  }
  const bbox = args.bbox ?? area?.bbox;
  const owned: LoadedOwnership | null = args.ownership ? loadOwnership(args.ownership) : null;
  if (owned && bbox) throw new Error('--ownership decides the area: drop --area/--bbox');
  const name = owned?.file.region ?? args.area ?? basename(args.pbf).replace(/\.osm\.pbf$/, '');
  const zoom = CITY_TILE_ZOOM;
  const out =
    args.out ?? join(BUILD_DIR, `city-roads-${name.replaceAll('/', '-')}-z${zoom}.pmtiles`);
  await mkdir(dirname(out), { recursive: true });

  console.log(`· compiling roads from ${args.pbf}${bbox ? ` within ${bbox.join(',')}` : ''}`);
  const started = performance.now();
  const result = compileRoads({
    pbf: args.pbf,
    zoom,
    bbox,
    keepTile: owned?.keepTile,
    log: (line) => console.log(line),
  });

  const encodeStarted = performance.now();
  const tiles: { z: number; x: number; y: number; bytes: Uint8Array }[] = [];
  const gzSizes: number[] = [];
  for (const [key, tile] of result.tiles) {
    const raw = encodeTileLayers(roadLayers(tile));
    if (raw.length === 0) continue;
    const gz = new Uint8Array(gzipSync(raw, { level: 9 }));
    const [z, x, y] = key.split('/').map(Number);
    tiles.push({ z, x, y, bytes: gz });
    gzSizes.push(gz.length);
  }
  const encodeMs = performance.now() - encodeStarted;
  assertOwned(tiles, owned?.keepTile);

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const { x, y, z } of tiles) {
    const n = 2 ** z;
    west = Math.min(west, (x / n) * 360 - 180);
    east = Math.max(east, ((x + 1) / n) * 360 - 180);
    south = Math.min(
      south,
      (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI,
    );
    north = Math.max(north, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI);
  }

  // The replication stamp, for the receipt (the extract's own header block).
  const headerBlob = scanBlobs(args.pbf).find((blob) => blob.type === 'OSMHeader');
  const fd = openSync(args.pbf, 'r');
  const header = headerBlob ? readHeader(readBlob(fd, headerBlob)) : {};
  closeSync(fd);
  const layer = (id: string, props: Record<string, string>) => ({
    id,
    minzoom: zoom,
    maxzoom: zoom,
    fields: Object.fromEntries(Object.values(props).map((key) => [key, 'see schema'])),
  });
  const metadata = {
    name: `GoWay city roads — ${name}`,
    format: 'pbf',
    type: 'overlay',
    attribution:
      '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
    license: 'ODbL-1.0 — a Derivative Database of OpenStreetMap',
    vector_layers: [
      layer(CITY_ROAD_LAYER, ROAD_PROPS),
      layer(CITY_ROAD_NODE_LAYER, ROAD_NODE_PROPS),
      layer(CITY_RESTRICTION_LAYER, RESTRICTION_PROPS),
    ],
    [CITY_ARCHIVE_KIND_KEY]: 'roads',
    ...(owned ? regionMetadata(owned.file) : {}),
    [PROBE_METADATA_KEY]: densestTile(tiles),
    'goway:schema': CITY_ROAD_SCHEMA_VERSION,
    'goway:extent': CITY_TILE_EXTENT,
    'goway:source': basename(args.pbf),
    'goway:replication': header,
  };
  const archive = writePmtiles(tiles, {
    minZoom: zoom,
    maxZoom: zoom,
    bounds: [west, south, east, north],
    center: [(west + east) / 2, (south + north) / 2, zoom],
    metadata,
  });
  await writeFile(out, archive);
  const totalMs = performance.now() - started;

  const r = result.coverage;
  gzSizes.sort((a, b) => a - b);
  console.log(`  encode     ${(encodeMs / 1000).toFixed(1)} s`);
  console.log(`\n${out}`);
  console.log(`  total      ${(totalMs / 1000).toFixed(1)} s`);
  console.log(`  archive    ${(archive.length / 1e6).toFixed(2)} MB (${tiles.length} tiles)`);
  console.log(
    `  tile gzip  p50 ${(percentile(gzSizes, 50) / 1e3).toFixed(1)} kB, p95 ${(percentile(gzSizes, 95) / 1e3).toFixed(1)} kB, max ${(gzSizes[gzSizes.length - 1] / 1e3).toFixed(1)} kB`,
  );
  console.log(
    `  ways       ${r.ways} (${r.carWays} car, ${r.footWays} foot) in ${r.pieces} pieces · ${JSON.stringify(r.byClass)}`,
  );
  console.log(
    `  coverage   lanes ${pct(r.withLanes, r.carWays)}% · maxspeed ${pct(r.withMaxspeed, r.carWays)}% (${r.maxspeedRefused} refused) · sidewalk ${pct(r.withSidewalk, r.carWays)}% · oneway ${pct(r.oneway, r.carWays)}% of car ways`,
  );
  console.log(
    `  nodes      ${JSON.stringify(r.nodes)} · footway=sidewalk ${r.sidewalkFootways} · footway=crossing ${r.crossingFootways} · tunnels ${r.tunnels}`,
  );
  console.log(
    `  turns      ${r.restrictions} node-via restrictions (${r.restrictionsSkipped} via-way or unreadable, skipped)`,
  );
  const st = r.street;
  console.log(
    `  street     name ${pct(st.named, r.carWays)}% · width ${pct(st.width, r.carWays)}% · turn:lanes ${pct(st.turnLanes, r.carWays)}% · bus ${pct(st.busLanes, r.carWays)}% · cycle lane ${pct(st.cycleLanes, r.carWays)}% · parking ${pct(st.parking, r.carWays)}% · change:lanes ${pct(st.changeLanes, r.carWays)}% of car ways · ${st.cycleways} cycleways; refused ${JSON.stringify(st.refused)}`,
  );

  await writeFile(
    `${out}.receipt.json`,
    `${JSON.stringify(
      {
        archive: out,
        bytes: archive.length,
        source: {
          file: basename(args.pbf),
          extract: owned?.file.extract ?? area?.extract,
          ...header,
        },
        region: owned
          ? {
              id: owned.file.region,
              name: owned.file.name,
              polygon: owned.file.polygon,
              part: owned.file.part,
              ownedTiles: owned.file.tiles,
              bounds: owned.file.bounds,
            }
          : undefined,
        bbox,
        zoom,
        schema: CITY_ROAD_SCHEMA_VERSION,
        seconds: Math.round(totalMs / 100) / 10,
        timingsMs: { ...result.timings, encode: Math.round(encodeMs) },
        tiles: tiles.length,
        tileGzipBytes: { p50: percentile(gzSizes, 50), p95: percentile(gzSizes, 95) },
        coverage: r,
        peakRssMb: peakRssMb(),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return out;
}

/** Reopen with the Worker's reader and decode every tile with the simulation's decoder. */
async function verify(path: string): Promise<string[]> {
  const problems: string[] = [];
  const handle = await open(path, 'r');
  const archive = new PMTiles({
    async read(offset: number, length: number) {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      return new Uint8Array(buffer.subarray(0, bytesRead));
    },
  });
  const header = await archive.header();
  const metadata = (await archive.metadata()) as Record<string, unknown>;
  if (header.tileType !== TILE_TYPE.MVT) problems.push(`tile type ${header.tileType}, not MVT`);
  if (header.tileCompression !== COMPRESSION.GZIP) problems.push('tiles are not gzipped');
  if (metadata[CITY_ARCHIVE_KIND_KEY] !== 'roads') problems.push('not a road archive');
  if (metadata['goway:schema'] !== CITY_ROAD_SCHEMA_VERSION) problems.push('schema mismatch');
  const z = header.maxZoom;
  const { x: cx, y: cy } = probeTile(metadata, header.bounds as number[], z);
  const owns = ownershipOf(metadata);
  let opened = 0;
  let pieces = 0;
  let car = 0;
  let nodes = 0;
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const tile = await archive.getTile(z, cx + dx, cy + dy);
      if (!tile) continue;
      opened++;
      if (owns && !owns(cx + dx, cy + dy)) {
        problems.push(`tile ${z}/${cx + dx}/${cy + dy} is outside the region's ownership`);
      }
      const decoded = decodeRoadTile(Bun.gunzipSync(tile.bytes), { x: cx + dx, y: cy + dy });
      nodes += decoded.nodes.length;
      for (const piece of decoded.pieces) {
        pieces++;
        if (piece.car) car++;
        const ox = (cx + dx) * CITY_TILE_EXTENT;
        const oy = (cy + dy) * CITY_TILE_EXTENT;
        for (const [x, y] of piece.points) {
          if (x < ox || x > ox + CITY_TILE_EXTENT || y < oy || y > oy + CITY_TILE_EXTENT) {
            problems.push(`a piece of way ${piece.way} leaves its tile`);
            break;
          }
        }
      }
    }
  }
  // An archive with tiles must open some around its densest one. A region
  // whose densest tile has no drivable road (Clipperton: an atoll with a
  // footpath) is real, not broken — said, not failed.
  if (opened === 0 && header.addressedTiles > 0) problems.push('no tile around the probe tile');
  if (opened > 0 && car === 0) console.log('  (no drivable road around the probe tile)');
  await handle.close();
  const { size } = await stat(path);
  console.log(
    `\n  verify     ${opened} tiles, ${pieces} pieces (${car} drivable), ${nodes} tagged nodes; ${(size / 1e6).toFixed(2)} MB`,
  );
  return problems;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = args.verify ? args.archive : await build(args);
  if (!path) throw new Error('--verify needs --archive=<path>');
  const problems = await verify(path);
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log('  ✓ verified');
}

if (import.meta.main) {
  await main();
}

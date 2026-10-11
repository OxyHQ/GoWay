/**
 * Compile an OpenStreetMap extract into GoWay's per-building 3D city tiles.
 *
 * ```bash
 * # Barcelona, from the Catalonia extract the basemap build also reads.
 * bun run --cwd packages/frontend map:city-tiles --pbf=<cataluna.osm.pbf> --area=barcelona
 *
 * # The whole extract, for timing and size (no --area / --bbox).
 * bun run --cwd packages/frontend map:city-tiles --pbf=<file> --out=.tiles/city-cataluna.pmtiles
 *
 * # Re-check a finished archive with the readers that will serve and draw it.
 * bun run --cwd packages/frontend map:city-tiles --verify --archive=<path>
 *
 * # Merge an official 3D building model (LOD2 roofs) — files named, never fetched.
 * bun run --cwd packages/frontend map:city-tiles --pbf=<new-york.osm.pbf> --area=manhattan \
 *   --lod2=nyc-3dbm:<DA12_3D_Buildings_Merged.gml>,<DA13_3D_Buildings_Merged.gml>
 *
 * # One region of the planet build: only the tiles the region owns
 * # (`citygen/ownership.ts`; the region builder writes the file).
 * bun run --cwd packages/frontend map:city-tiles --pbf=<file> --ownership=<region.ownership.json>
 * ```
 *
 * `--lod2=<source>:<file>[,<file>…]` (repeatable) reads a dataset listed in
 * `citygen/lod2/sources.ts` — CityGML or CityJSON — keeps its roof surfaces,
 * conflates them with the OSM buildings (`citygen/lod2/conflate.ts`) and writes
 * them as a second tile layer; `docs/MAP_3D_SOURCES.md` says which datasets
 * are licensed for this and what each obliges.
 *
 * Then point the dev server at it and open the map with the flags on:
 *
 * ```bash
 * GOWAY_CITY_TILES_ARCHIVE=$PWD/packages/frontend/.tiles/city-barcelona.pmtiles \
 *   bun run --cwd packages/frontend web -- --port 8105
 * # http://localhost:8105/?city3d=1&cityTiles=1
 * ```
 *
 * ## Why a GoWay program and not Planetiler
 *
 * The basemap is Planetiler (`build-map-tiles.ts`) because GoWay speaks an
 * existing schema there. These tiles are a schema of GoWay's own
 * (`lib/map/cityTiles.ts`) with two rules Planetiler is built around the
 * opposite of: a building is never clipped (it goes whole to one tile), and
 * an outline with `building:part`s is replaced by its parts. Both are a few
 * lines here; in a Planetiler profile both fight the engine. The cost is
 * scale — this holds the needed nodes in memory, so the planet is compiled in
 * shards (see `citygen/compile.ts` and the doc). Everything the two builds
 * share is shared: the extract (`~/osm-data`, the same Geofabrik files), the
 * archive format (PMTiles v3, read by `worker/pmtiles.js`), the `.tiles/`
 * output directory and the receipt beside it.
 *
 * ## Licence
 *
 * The archive is a Derivative Database of OpenStreetMap under the ODbL: the
 * receipt records the extract and replication stamp it came from, the
 * archive's own metadata carries the attribution, and `docs/MAP_3D_CITY.md` →
 * Obligations says what serving it requires.
 */
import { stat, writeFile } from 'node:fs/promises';
import { mkdir, open } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { decodeCityTile } from '../components/map/engine/city3d/osmTiles';
import { decodeLod2Tile } from '../components/map/engine/city3d/lod2Tiles';
import {
  CITY_TILE_EXTENT,
  CITY_TILE_LAYER,
  CITY_COVERAGE_METADATA_KEY,
  CITY_TILE_SCHEMA_VERSION,
  CITY_TILE_ZOOM,
  CITY_PROPS,
} from '../lib/map/cityTiles';
import { CITY_LOD2_PROPS, CITY_LOD2_SOURCES, CITY_TILE_LOD2_LAYER } from '../lib/map/cityOfficial';
import { COMPRESSION, PMTiles, TILE_TYPE } from '../worker/pmtiles.js';
import { compile } from './citygen/compile';
import { type ConflateStats, conflate, type Lod2TileFeature } from './citygen/lod2/conflate';
import { type IngestedFile, ingest } from './citygen/lod2/ingest';
import type { PrepareStats } from './citygen/lod2/prepare';
import { isLod2Source, LOD2_SOURCES } from './citygen/lod2/sources';
import { peakRssMb } from './citygen/memory';
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
import { encodeCityTile, encodeTreeLayer } from './citygen/mvtEncode';
import { writePmtiles } from './citygen/pmtilesWriter';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(FRONTEND_ROOT, '.tiles');

/**
 * Named areas: a bounding box over a building's representative point, and the
 * Geofabrik extract that contains it (the file is passed with `--pbf`; it is
 * never fetched by this script, so the compiler never runs on bytes nobody
 * chose).
 */
export const AREAS: Record<string, { bbox: [number, number, number, number]; extract: string }> = {
  barcelona: {
    bbox: [2.052, 41.317, 2.228, 41.468],
    extract: 'https://download.geofabrik.de/europe/spain/cataluna-latest.osm.pbf',
  },
  manhattan: {
    bbox: [-74.03, 40.698, -73.906, 40.882],
    extract: 'https://download.geofabrik.de/north-america/us/new-york-latest.osm.pbf',
  },
  madrid: {
    // Inside the M-30, with Chamberí, Salamanca, Retiro and Arganzuela.
    bbox: [-3.735, 40.385, -3.655, 40.46],
    extract: 'https://download.geofabrik.de/europe/spain/madrid-latest.osm.pbf',
  },
};

/**
 * Buildings the verifier must find, by tile feature id (`osmId × 10 + 2|3`)
 * at a point inside them, with the roof OSM records: the landmarks the doc's
 * screenshots look at. A build that loses one of them — a parts rule gone
 * wrong, a roof parser that stopped reading — fails here rather than in a
 * screenshot nobody takes.
 */
const EXPECTED: Record<
  string,
  { id: number; name: string; lon: number; lat: number; roof?: string }[]
> = {
  barcelona: [
    {
      id: 359084982 * 10 + 2,
      name: 'Sagrada Família, a tower (way/359084982)',
      lon: 2.17435,
      lat: 41.40363,
      roof: 'pyramidal',
    },
    {
      id: 305857559 * 10 + 2,
      name: 'Catedral de Barcelona, a roof part (way/305857559)',
      lon: 2.17619,
      lat: 41.38387,
      roof: 'hipped',
    },
  ],
};

/**
 * Buildings of an official 3D model the verifier must find in the
 * `building_lod2` layer, by the dataset's own id, at a point inside them, with
 * a floor on their measured height: a conflation rule that starts discarding
 * landmarks fails the build, not a screenshot.
 */
const EXPECTED_LOD2: Record<
  string,
  { sourceId: string; name: string; lon: number; lat: number; minTop: number }[]
> = {
  manhattan: [
    {
      sourceId: '1015862',
      name: 'Empire State Building (BIN 1015862)',
      lon: -73.98566,
      lat: 40.74844,
      minTop: 350,
    },
  ],
};

/**
 * OSM buildings that record no height and must get one from an official
 * dataset when that dataset is merged: the flat Carrer de Mallorca block the
 * owner reported (5 m boxes beside 25 m neighbours).
 */
const EXPECTED_HEIGHTS: Record<
  string,
  { id: number; name: string; lon: number; lat: number; source: string; minTop: number }[]
> = {
  barcelona: [
    {
      id: 249405068 * 10 + 2,
      name: 'Carrer de Mallorca block (way/249405068)',
      lon: 2.161,
      lat: 41.3935,
      source: 'es-catastro',
      minTop: 15,
    },
    {
      id: 249408232 * 10 + 2,
      name: 'Carrer de Mallorca block (way/249408232)',
      lon: 2.161,
      lat: 41.3935,
      source: 'es-catastro',
      minTop: 15,
    },
  ],
};

interface Args {
  pbf?: string;
  out?: string;
  area?: string;
  bbox?: [number, number, number, number];
  zoom: number;
  verify: boolean;
  archive?: string;
  lod2: { source: string; files: string[] }[];
  /** A region's ownership file (`citygen/regionArchive.ts`): build only its tiles. */
  ownership?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { zoom: CITY_TILE_ZOOM, verify: false, lod2: [] };
  for (const raw of argv) {
    const [flag, value] = raw.startsWith('--') ? raw.slice(2).split('=', 2) : [raw, undefined];
    if (flag === 'pbf' && value) args.pbf = value;
    else if (flag === 'out' && value) args.out = value;
    else if (flag === 'archive' && value) args.archive = value;
    else if (flag === 'area' && value) args.area = value;
    else if (flag === 'ownership' && value) args.ownership = value;
    else if (flag === 'zoom' && value) args.zoom = Number(value);
    else if (flag === 'verify') args.verify = true;
    else if (flag === 'lod2' && value) {
      const colon = value.indexOf(':');
      const source = value.slice(0, colon);
      const files = value
        .slice(colon + 1)
        .split(',')
        .filter(Boolean);
      if (colon <= 0 || !isLod2Source(source) || files.length === 0) {
        throw new Error(
          `--lod2=<source>:<file>[,<file>…] with a source from ${Object.keys(LOD2_SOURCES).join(', ')}`,
        );
      }
      args.lod2.push({ source, files });
    } else if (flag === 'bbox' && value) {
      const parts = value.split(',').map(Number);
      if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n))) {
        throw new Error('--bbox=west,south,east,north');
      }
      args.bbox = parts as [number, number, number, number];
    }
  }
  return args;
}

const tileXY = (lon: number, lat: number, z: number) => {
  const n = 2 ** z;
  const phi = (lat * Math.PI) / 180;
  return {
    x: Math.floor(((lon + 180) / 360) * n),
    y: Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * n),
  };
};

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
  if (owned && (bbox || args.zoom !== CITY_TILE_ZOOM)) {
    throw new Error('--ownership decides the area and the zoom: drop --area/--bbox/--zoom');
  }
  const name = owned?.file.region ?? args.area ?? basename(args.pbf).replace(/\.osm\.pbf$/, '');
  const out =
    args.out ?? join(BUILD_DIR, `city-${name.replaceAll('/', '-')}-z${args.zoom}.pmtiles`);
  await mkdir(dirname(out), { recursive: true });

  console.log(`· compiling ${args.pbf}${bbox ? ` within ${bbox.join(',')}` : ''} at z${args.zoom}`);
  const started = performance.now();
  const result = compile({
    pbf: args.pbf,
    zoom: args.zoom,
    bbox,
    keepTile: owned?.keepTile,
    log: (line) => console.log(line),
  });

  // ── Official 3D models: read, conflate with OSM, second layer ──────────
  const lod2Tiles = new Map<string, Lod2TileFeature[]>();
  const lod2Receipts: {
    source: string;
    files: IngestedFile[];
    crs: string[];
    prepare: PrepareStats;
    outsideArea: number;
    conflate: ConflateStats;
    timingsMs: { read: number; conflate: number };
  }[] = [];
  for (const input of args.lod2) {
    if (!isLod2Source(input.source)) continue;
    const info = LOD2_SOURCES[input.source];
    const readStarted = performance.now();
    // A regional build reads only the official buildings within its owned
    // tiles' box; the tiles it does not own are dropped below.
    const ingested = ingest(info, input.files, bbox ?? owned?.file.bounds, (line) =>
      console.log(line),
    );
    const readMs = performance.now() - readStarted;
    const conflateStarted = performance.now();
    const merged = conflate(result.tiles, ingested.buildings, {
      source: input.source,
      zoom: args.zoom,
      policy: info.policy,
    });
    const conflateMs = performance.now() - conflateStarted;
    for (const [key, features] of merged.tiles) {
      const list = lod2Tiles.get(key);
      if (list) list.push(...features);
      else lod2Tiles.set(key, features);
    }
    lod2Receipts.push({
      source: input.source,
      files: ingested.files,
      crs: ingested.crs,
      prepare: ingested.prepare,
      outsideArea: ingested.outside,
      conflate: merged.stats,
      timingsMs: { read: Math.round(readMs), conflate: Math.round(conflateMs) },
    });
    const c = merged.stats;
    console.log(
      `  lod2         ${input.source}: ${ingested.prepare.kept} buildings prepared (${ingested.outside} outside the area), ${c.drawn} drawn, ${c.unconfirmed} not in OSM, ${c.stale} stale, ${c.osmRicher} where OSM's 3D is richer; ${c.osmDrawnByModel} of ${c.osmFeatures} OSM features drawn by it, ${c.osmHeightsSet} given its height (${c.osmHeightsFromDefault} had none), ${c.osmLevelsRemodelled} OSM storey counts re-heighted, ${c.osmConflicts} in height conflict; ${c.roofFeatures} roof surfaces (${c.slopedRoofFeatures} sloped); read ${(readMs / 1000).toFixed(1)} s, conflate ${(conflateMs / 1000).toFixed(1)} s`,
    );
  }

  const encodeStarted = performance.now();
  const tiles: { z: number; x: number; y: number; bytes: Uint8Array }[] = [];
  const rawSizes: number[] = [];
  const gzSizes: number[] = [];
  const featureCounts: number[] = [];
  let rawTotal = 0;
  let largest = { key: '', bytes: 0, features: 0 };
  const keys = new Set([...result.tiles.keys(), ...result.trees.keys(), ...lod2Tiles.keys()]);
  for (const key of keys) {
    // Official surfaces go to the tile of their own position, which a
    // regional build may not own (`citygen/ownership.ts`); OSM's never do.
    if (owned) {
      const [, kx, ky] = key.split('/').map(Number);
      if (!owned.keepTile(kx, ky)) continue;
    }
    const features = result.tiles.get(key) ?? [];
    const surfaces = (lod2Tiles.get(key) ?? []).sort((a, b) =>
      String(a.properties[CITY_LOD2_PROPS.sourceId]).localeCompare(
        String(b.properties[CITY_LOD2_PROPS.sourceId]),
      ),
    );
    const buildingLayer = encodeCityTile(
      features,
      surfaces.length > 0 ? [{ name: CITY_TILE_LOD2_LAYER, features: surfaces }] : [],
    );
    // The `tree` layer appended: one tile, more layers (`encodeTreeLayer`).
    const treeLayer = encodeTreeLayer(result.trees.get(key) ?? []);
    const raw = new Uint8Array(buildingLayer.length + treeLayer.length);
    raw.set(buildingLayer);
    raw.set(treeLayer, buildingLayer.length);
    if (raw.length === 0) continue;
    const gz = new Uint8Array(gzipSync(raw, { level: 9 }));
    const [z, x, y] = key.split('/').map(Number);
    tiles.push({ z, x, y, bytes: gz });
    rawSizes.push(raw.length);
    gzSizes.push(gz.length);
    featureCounts.push(features.length + surfaces.length);
    rawTotal += raw.length;
    if (raw.length > largest.bytes) {
      largest = { key, bytes: raw.length, features: features.length + surfaces.length };
    }
  }
  const encodeMs = performance.now() - encodeStarted;
  assertOwned(tiles, owned?.keepTile);

  let west = 180;
  let south = 90;
  let east = -180;
  let north = -90;
  for (const { x, y, z } of tiles) {
    const n = 2 ** z;
    const lon0 = (x / n) * 360 - 180;
    const lon1 = ((x + 1) / n) * 360 - 180;
    const lat0 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + 1)) / n))) * 180) / Math.PI;
    const lat1 = (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI;
    west = Math.min(west, lon0);
    east = Math.max(east, lon1);
    south = Math.min(south, lat0);
    north = Math.max(north, lat1);
  }

  const lod2Used = lod2Receipts.filter((r) => r.conflate.roofFeatures > 0);
  const metadata = {
    name: `GoWay city tiles — ${name}`,
    format: 'pbf',
    type: 'overlay',
    attribution: [
      '<a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>',
      ...lod2Used.map((r) => {
        const credit = CITY_LOD2_SOURCES[r.source as keyof typeof CITY_LOD2_SOURCES];
        return `<a href="${credit.href}" target="_blank">${credit.label}</a>`;
      }),
    ].join(' '),
    license:
      lod2Used.length > 0
        ? `ODbL-1.0 — a Derivative Database of OpenStreetMap, containing ${lod2Used.map((r) => LOD2_SOURCES[r.source as keyof typeof LOD2_SOURCES].name).join(', ')} (see goway:lod2)`
        : 'ODbL-1.0 — a Derivative Database of OpenStreetMap',
    vector_layers: [
      {
        id: CITY_TILE_LAYER,
        minzoom: args.zoom,
        maxzoom: args.zoom,
        fields: Object.fromEntries(Object.values(CITY_PROPS).map((key) => [key, 'see schema'])),
      },
      ...(lod2Used.length > 0
        ? [
            {
              id: CITY_TILE_LOD2_LAYER,
              minzoom: args.zoom,
              maxzoom: args.zoom,
              fields: Object.fromEntries(
                [...Object.values(CITY_LOD2_PROPS), CITY_PROPS.renderHeight].map((key) => [
                  key,
                  'see schema',
                ]),
              ),
            },
          ]
        : []),
    ],
    // The area every building of which is in the archive: the compile box, or
    // the tiles' extent for a whole extract. Clients draw city tiles only
    // inside it (`lib/map/cityTiles.ts` → `CITY_COVERAGE_PATH`).
    [CITY_COVERAGE_METADATA_KEY]: owned?.file.bounds ?? bbox ?? [west, south, east, north],
    ...(owned ? regionMetadata(owned.file) : {}),
    [PROBE_METADATA_KEY]: densestTile(tiles),
    'goway:schema': CITY_TILE_SCHEMA_VERSION,
    'goway:extent': CITY_TILE_EXTENT,
    'goway:source': basename(args.pbf),
    'goway:replication': result.header,
    'goway:lod2': lod2Used.map((r) => {
      const info = LOD2_SOURCES[r.source as keyof typeof LOD2_SOURCES];
      return {
        id: info.id,
        name: info.name,
        publisher: info.publisher,
        url: info.url,
        licence: info.licence,
        attribution: info.attribution,
        referenceDate: info.referenceDate,
        files: r.files.map((f) => ({ file: f.file, sha256: f.sha256 })),
      };
    }),
  };
  const archive = writePmtiles(tiles, {
    minZoom: args.zoom,
    maxZoom: args.zoom,
    bounds: [west, south, east, north],
    center: [(west + east) / 2, (south + north) / 2, args.zoom],
    metadata,
  });
  await writeFile(out, archive);
  const totalMs = performance.now() - started;

  const c = result.coverage;
  rawSizes.sort((a, b) => a - b);
  gzSizes.sort((a, b) => a - b);
  featureCounts.sort((a, b) => a - b);
  console.log(`  encode       ${(encodeMs / 1000).toFixed(1)} s`);
  console.log(`\n${out}`);
  console.log(`  total        ${(totalMs / 1000).toFixed(1)} s`);
  console.log(`  archive      ${(archive.length / 1e6).toFixed(2)} MB (${tiles.length} tiles)`);
  console.log(
    `  tile raw     p50 ${(percentile(rawSizes, 50) / 1e3).toFixed(0)} kB, p95 ${(percentile(rawSizes, 95) / 1e3).toFixed(0)} kB, max ${(largest.bytes / 1e3).toFixed(0)} kB (${largest.key}, ${largest.features} buildings)`,
  );
  console.log(
    `  tile gzip    p50 ${(percentile(gzSizes, 50) / 1e3).toFixed(0)} kB, p95 ${(percentile(gzSizes, 95) / 1e3).toFixed(0)} kB, max ${(gzSizes[gzSizes.length - 1] / 1e3).toFixed(0)} kB`,
  );
  console.log(
    `  features     ${c.features} (${c.outlines} outlines, ${c.parts} parts; ${c.outlinesDroppedForParts} outlines replaced by their parts)`,
  );
  console.log(
    `  per tile     p50 ${percentile(featureCounts, 50)}, p95 ${percentile(featureCounts, 95)}`,
  );
  console.log(
    `  coverage     height ${pct(c.withHeight, c.features)}% · levels ${pct(c.withLevels, c.features)}% · roof:shape ${pct(c.withRoofShape, c.features)}% (non-flat ${pct(c.withRoofShapeNonFlat, c.features)}%) · colour ${pct(c.withColour, c.features)}% · roof:colour ${pct(c.withRoofColour, c.features)}% · material ${pct(c.withMaterial, c.features)}% · roof:material ${pct(c.withRoofMaterial, c.features)}% · lit at night ${c.withFloodlit}`,
  );
  console.log(`  roof shapes  ${JSON.stringify(c.roofShapes)}`);
  console.log(`  roof height  ${JSON.stringify(c.roofHeightSources)}`);
  console.log(`  rejected     ${JSON.stringify(c.rejected)}`);
  console.log(`  problems     ${JSON.stringify(result.problems)}; nodes kept ${result.nodesKept}`);
  const t = result.treeCoverage;
  console.log(
    `  trees        ${t.trees} natural=tree · crown ${pct(t.withCrown, t.trees)}% ${JSON.stringify(t.crowns)} · height ${pct(t.withHeight, t.trees)}% · diameter_crown ${pct(t.withCrownDiameter, t.trees)}%`,
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
          ...result.header,
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
        zoom: args.zoom,
        schema: CITY_TILE_SCHEMA_VERSION,
        seconds: Math.round(totalMs / 100) / 10,
        timingsMs: { ...result.timings, encode: Math.round(encodeMs) },
        tiles: tiles.length,
        rawBytes: rawTotal,
        tileRawBytes: {
          p50: percentile(rawSizes, 50),
          p95: percentile(rawSizes, 95),
          max: largest.bytes,
          maxTile: largest.key,
        },
        tileGzipBytes: { p50: percentile(gzSizes, 50), p95: percentile(gzSizes, 95) },
        coverage: c,
        treeCoverage: result.treeCoverage,
        lod2: lod2Receipts,
        problems: result.problems,
        peakRssMb: peakRssMb(),
        builtAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );
  return out;
}

/** Open the archive with the Worker's reader and decode tiles with the client's decoder. */
async function verify(path: string, area?: string): Promise<string[]> {
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
  if (header.minZoom !== header.maxZoom) problems.push('expected a single zoom');
  if (metadata['goway:schema'] !== CITY_TILE_SCHEMA_VERSION) {
    problems.push(
      `schema ${String(metadata['goway:schema'])}, expected ${CITY_TILE_SCHEMA_VERSION}`,
    );
  }
  const z = header.maxZoom;
  const centre = probeTile(metadata, header.bounds as number[], z);
  const owns = ownershipOf(metadata);
  let opened = 0;
  let buildings = 0;
  let surfaces = 0;
  const wanted = new Map((EXPECTED[area ?? ''] ?? []).map((item) => [item.id, item]));
  const found = new Set<number>();
  for (const item of wanted.values()) {
    const at = tileXY(item.lon, item.lat, z);
    const tile = await archive.getTile(z, at.x, at.y);
    const building = tile
      ? decodeCityTile(Bun.gunzipSync(tile.bytes))?.buildings.find((b) => b.id === item.id)
      : undefined;
    if (!building) continue;
    found.add(item.id);
    if (item.roof && building.roof?.shape !== item.roof) {
      problems.push(`${item.name}: roof ${building.roof?.shape ?? 'flat'}, expected ${item.roof}`);
    }
  }
  for (let dx = -3; dx <= 3; dx++) {
    for (let dy = -3; dy <= 3; dy++) {
      const tile = await archive.getTile(z, centre.x + dx, centre.y + dy);
      if (!tile) continue;
      opened++;
      if (owns && !owns(centre.x + dx, centre.y + dy)) {
        problems.push(
          `tile ${z}/${centre.x + dx}/${centre.y + dy} is outside the region's ownership`,
        );
      }
      const decoded = decodeCityTile(Bun.gunzipSync(tile.bytes));
      if (!decoded) {
        problems.push(
          `tile ${z}/${centre.x + dx}/${centre.y + dy} has no ${CITY_TILE_LAYER} layer`,
        );
        continue;
      }
      if (decoded.extent !== CITY_TILE_EXTENT) problems.push(`extent ${decoded.extent}`);
      for (const building of decoded.buildings) {
        buildings++;
        if (!(building.top > building.base)) problems.push(`building ${building.id}: top <= base`);
      }
      surfaces += decodeLod2Tile(Bun.gunzipSync(tile.bytes)).length;
    }
  }
  if (opened === 0) problems.push('no tile around the archive centre');
  for (const [id, item] of wanted) {
    if (!found.has(id)) problems.push(`${item.name} (${id}) is not in its tile`);
  }
  const lod2Sources = (metadata['goway:lod2'] as { id: string }[] | undefined) ?? [];
  for (const item of EXPECTED_HEIGHTS[area ?? ''] ?? []) {
    if (!lod2Sources.some((s) => s.id === item.source)) continue;
    let found: { top: number; source?: unknown } | null = null;
    const at = tileXY(item.lon, item.lat, z);
    for (let dx = -1; dx <= 1 && !found; dx++) {
      for (let dy = -1; dy <= 1 && !found; dy++) {
        const tile = await archive.getTile(z, at.x + dx, at.y + dy);
        if (!tile) continue;
        const building = decodeCityTile(Bun.gunzipSync(tile.bytes))?.buildings.find(
          (b) => b.id === item.id,
        );
        if (building) found = { top: building.top, source: building.heightSource };
      }
    }
    if (!found) problems.push(`${item.name}: not in the archive`);
    else if (found.top < item.minTop || found.source === undefined) {
      problems.push(
        `${item.name}: ${found.top} m from ${String(found.source ?? 'nothing')}, expected ≥ ${item.minTop} m from an official source`,
      );
    }
  }
  for (const item of lod2Sources.length > 0 ? (EXPECTED_LOD2[area ?? ''] ?? []) : []) {
    const at = tileXY(item.lon, item.lat, z);
    const tile = await archive.getTile(z, at.x, at.y);
    const mine = tile
      ? decodeLod2Tile(Bun.gunzipSync(tile.bytes)).filter((s) => s.sourceId === item.sourceId)
      : [];
    const top = Math.max(0, ...mine.map((s) => s.top));
    if (mine.length === 0) problems.push(`${item.name}: no LOD2 surfaces in its tile`);
    else if (top < item.minTop)
      problems.push(`${item.name}: LOD2 top ${top.toFixed(0)} m < ${item.minTop} m`);
  }
  await handle.close();
  const { size } = await stat(path);
  console.log(
    `\n  verify       ${opened} tiles, ${buildings} buildings and ${surfaces} LOD2 surfaces decoded; ${(size / 1e6).toFixed(2)} MB`,
  );
  return problems;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const path = args.verify ? args.archive : await build(args);
  if (!path) throw new Error('--verify needs --archive=<path>');
  const problems = await verify(path, args.area);
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

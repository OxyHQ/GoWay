/**
 * Build cells of ONE imagery set: per cell, the pixels fetched and warped to
 * the cell's grid, cut into 512 px WebP tiles, packed into one PMTiles
 * archive, verified with the Worker's own reader, and described by a receipt;
 * then the set's manifest entry for the cells built (`docs/MAP_SATELLITE.md`).
 *
 * ```bash
 * bun run --cwd packages/frontend map:satellite-set --set=icgc-ortofoto-2025 \
 *   --stamp=20261012-local --out=<dir> [--cells=all | --cells=12/2072/1529,… | --box=w,s,e,n]
 *   [--input=<local GDAL dataset>] [--cache=<dir>] [--gdal=<bin dir>] [--jobs=N] [--strips=N]
 * ```
 *
 * Writes, under `--out`, the bucket's layout:
 *
 *     satellite/<set>/<stamp>/<z>/<x>/<y>.pmtiles            one archive per cell
 *     satellite/<set>/<stamp>/<z>/<x>/<y>.pmtiles.receipt.json
 *     entries/<set>@<stamp>[~<part>].json                    the manifest entry for these cells
 *
 * GDAL ≥ 3.11 does the raster work (`gdalwarp`, `gdal raster tile`); the
 * pinned build is `scripts/imagery/environment.yml`, the same locally and in
 * CI. A cell whose pixels are all transparent (open sea, outside a flight)
 * produces no archive and is left out of the entry.
 *
 * ## Why fetch, then tile
 *
 * Every remote source is first WARPED to the cell's own grid at the set's
 * deepest zoom — in parallel horizontal strips, each its own `gdalwarp` and
 * its own HTTP connection, retried whole on failure — into a local,
 * losslessly compressed GeoTIFF. The tiler then reads only local pixels on an
 * identical grid (nearest = no second resampling). Tiling straight from a
 * remote dataset would turn one dropped connection into a silently blank
 * tile; a strip that fails is fetched again, and a strip that cannot be
 * fetched fails the cell.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { encodeCoverageTree } from '@goway/map-service/coverageTree.js';
import { PMTiles, TILE_TYPE } from '@goway/map-service/pmtiles.js';
import { IMAGERY_SOURCES } from '../lib/map/imagerySources';
import {
  BLUE_MARBLE_URL,
  catalogueSet,
  type ImagerySetDefinition,
  WORLDCOVER_BUCKET,
  WORLDCOVER_STRETCH,
  WORLDCOVER_WATER,
} from './imagery/catalogue';
import {
  type Cell,
  cellKey,
  cellLonLat,
  cellMercator,
  cellsInBox,
  cellsTree,
  cellTileRange,
  type LonLatBox,
  parseCellKey,
} from './imagery/cells';
import { listTiles, packTileDirectory } from './imagery/pmtilesStream';

const TILE_SIZE = 512;
const USER_AGENT = 'goway-satellite-tiles (+https://goway.to; https://github.com/OxyHQ/GoWay)';

/** GDAL's HTTP behaviour for every remote read: retries, polite chunking, no sidecar probes. */
const GDAL_HTTP_CONFIG: Record<string, string> = {
  GDAL_HTTP_MAX_RETRY: '20',
  GDAL_HTTP_RETRY_DELAY: '2',
  GDAL_HTTP_USERAGENT: USER_AGENT,
  CPL_VSIL_CURL_CHUNK_SIZE: '1048576',
  CPL_VSIL_CURL_CACHE_SIZE: '1000000000',
  GDAL_PAM_ENABLED: 'NO',
  GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR',
};

/** A set's manifest entry, as `build-satellite-manifest.ts` merges it. */
export interface SetEntry {
  id: string;
  stamp: string;
  name: string;
  tiers: string[];
  minZoom: number;
  maxZoom: number;
  cellZoom: number;
  sources: string[];
  vintage: string;
  /** The tiles' image format (`webp`). */
  format: 'webp';
  bbox: LonLatBox;
  /** The cells built, by key (`z/x/y`); the manifest stores them as a tree. */
  cellKeys: string[];
  tiles: number;
  bytes: number;
  builtAt: string;
}

export interface CellReceipt {
  schema: 1;
  set: string;
  stamp: string;
  cell: string;
  key: string;
  bytes: number;
  sha256: string;
  tiles: number;
  contents: number;
  perZoom: Record<number, number>;
  sources: { id: string; notice: string }[];
  input: Record<string, unknown>;
  encoding: { format: 'webp'; quality: number; tileSize: number; resampling: string };
  gdal: string;
  seconds: { prepare: number; tile: number; pack: number };
  builtAt: string;
}

interface Args {
  set: string;
  stamp: string;
  out: string;
  cells: string;
  box: LonLatBox | null;
  input: string | null;
  cache: string;
  gdal: string;
  jobs: number;
  strips: number;
  part: string | null;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const set = value('set');
  const stamp = value('stamp');
  const out = value('out');
  if (!set || !stamp || !out) {
    throw new Error(
      'usage: --set=<id> --stamp=<YYYYMMDD[-suffix]> --out=<dir> [--cells=…|--box=…]',
    );
  }
  if (!/^[0-9]{8}(-[a-z0-9]{1,24})?$/.test(stamp)) throw new Error(`"${stamp}" is not a stamp`);
  const box = value('box');
  const parsedBox = box ? (box.split(',').map(Number) as LonLatBox) : null;
  if (parsedBox && (parsedBox.length !== 4 || parsedBox.some((v) => !Number.isFinite(v)))) {
    throw new Error(`--box=${box} is not w,s,e,n`);
  }
  const cpus = navigator.hardwareConcurrency || 4;
  return {
    set,
    stamp,
    out: resolve(out),
    cells: value('cells') ?? 'all',
    box: parsedBox,
    input: value('input') ?? null,
    cache: resolve(value('cache') ?? join(out, '.cache')),
    gdal: value('gdal') ?? '',
    jobs: Number(value('jobs') ?? cpus),
    strips: Number(value('strips') ?? 8),
    part: value('part') ?? null,
  };
}

/** Run a program, failing with its stderr. */
async function run(
  program: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<string> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun(stdout);
      else
        reject(
          new Error(
            `${program} ${args.slice(0, 3).join(' ')}… exited ${code}: ${stderr.slice(-1500)}`,
          ),
        );
    });
  });
}

function configArgs(config: Record<string, string>): string[] {
  return Object.entries(config).flatMap(([key, value]) => ['--config', key, value]);
}

async function retry<T>(what: string, tries: number, attempt: () => Promise<T>): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= tries; i++) {
    try {
      return await attempt();
    } catch (error) {
      last = error;
      console.warn(`  ${what}: try ${i} failed (${String(error).slice(0, 200)})`);
      await new Promise((r) => setTimeout(r, 2000 * i));
    }
  }
  throw new Error(`${what}: failed ${tries} times: ${String(last)}`);
}

/** Download a URL to a file once (resumable, retried); the cache is keyed by file name. */
async function cached(url: string, dir: string): Promise<string> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, url.split('/').pop() ?? 'download');
  if (existsSync(file)) return file;
  await retry(`download ${url}`, 6, async () => {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    await Bun.write(`${file}.part`, response);
  });
  await run('mv', [`${file}.part`, file]);
  return file;
}

/** Blue Marble, georeferenced as the plate-carrée image it is. */
async function blueMarble(gdal: (tool: string) => string, cache: string): Promise<string> {
  const png = await cached(BLUE_MARBLE_URL, cache);
  const vrt = join(cache, 'blue-marble.vrt');
  if (!existsSync(vrt)) {
    await run(gdal('gdal_translate'), [
      '-q',
      '-of',
      'VRT',
      '-a_srs',
      'EPSG:4326',
      '-a_ullr',
      '-180',
      '90',
      '180',
      '-90',
      png,
      vrt,
    ]);
  }
  return vrt;
}

/** The WorldCover tiles that exist for a year, listed once per run from the bucket. */
const worldCoverIndex = new Map<number, Promise<Set<string>>>();
function worldCoverTiles(year: number): Promise<Set<string>> {
  let listing = worldCoverIndex.get(year);
  if (!listing) {
    listing = (async () => {
      const names = new Set<string>();
      let token: string | null = null;
      do {
        const query = new URLSearchParams({ 'list-type': '2', prefix: `rgbnir/${year}/` });
        if (token) query.set('continuation-token', token);
        const xml = await retry('list WorldCover', 6, async () => {
          const response = await fetch(`${WORLDCOVER_BUCKET}/?${query}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.text();
        });
        for (const match of xml.matchAll(/<Key>([^<]+\.tif)<\/Key>/g)) names.add(match[1]);
        token = /<IsTruncated>true<\/IsTruncated>/.test(xml)
          ? (/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1] ?? null)
          : null;
      } while (token);
      return names;
    })();
    worldCoverIndex.set(year, listing);
  }
  return listing;
}

function worldCoverKey(year: number, lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  const la = String(Math.abs(lat)).padStart(2, '0');
  const lo = String(Math.abs(lon)).padStart(3, '0');
  const version = year === 2020 ? 'v100' : 'v200';
  return `rgbnir/${year}/${ns}${la}/ESA_WorldCover_10m_${year}_${version}_${ns}${la}${ew}${lo}_S2RGBNIR.tif`;
}

interface Prepared {
  /** The dataset the tiler reads. */
  dataset: string;
  /** Resampling at the deepest zoom: `nearest` when the dataset is already on the cell's grid. */
  resampling: 'nearest' | 'lanczos';
  /** Whether the tiles need alpha. */
  alpha: boolean;
  input: Record<string, unknown>;
  /** Nothing to draw in this cell: skip it. */
  empty?: boolean;
}

/**
 * Warp `sources` (drawn in order, later over earlier) onto the cell's grid at
 * the set's deepest zoom, in horizontal strips fetched in parallel.
 */
async function warpToCell(
  gdal: (tool: string) => string,
  set: ImagerySetDefinition,
  cell: Cell,
  sources: string[],
  dir: string,
  strips: number,
): Promise<string> {
  const [minX, minY, maxX, maxY] = cellMercator(cell);
  const side = TILE_SIZE * 2 ** (set.maxZoom - cell.z);
  const rowsPerStrip = Math.max(TILE_SIZE, Math.ceil(side / strips / TILE_SIZE) * TILE_SIZE);
  const metresPerRow = (maxY - minY) / side;
  const parts: string[] = [];
  const tasks: Promise<void>[] = [];
  for (let row = 0; row < side; row += rowsPerStrip) {
    const rows = Math.min(rowsPerStrip, side - row);
    const top = maxY - row * metresPerRow;
    const bottom = top - rows * metresPerRow;
    const file = join(dir, `strip-${row}.tif`);
    parts.push(file);
    tasks.push(
      retry(`warp ${cellKey(cell)} rows ${row}+${rows}`, 5, async () => {
        await rm(file, { force: true });
        await run(gdal('gdalwarp'), [
          '-q',
          '-overwrite',
          '-t_srs',
          'EPSG:3857',
          '-te',
          String(minX),
          String(bottom),
          String(maxX),
          String(top),
          '-ts',
          String(side),
          String(rows),
          '-r',
          'lanczos',
          '-dstalpha',
          '-multi',
          '-wo',
          'NUM_THREADS=2',
          '-co',
          'TILED=YES',
          '-co',
          'COMPRESS=ZSTD',
          '-co',
          'PREDICTOR=2',
          '-co',
          'BIGTIFF=IF_SAFER',
          ...configArgs(GDAL_HTTP_CONFIG),
          ...sources,
          file,
        ]);
      }),
    );
  }
  await Promise.all(tasks);
  const vrt = join(dir, 'cell.vrt');
  await run(gdal('gdalbuildvrt'), ['-q', '-overwrite', vrt, ...parts]);
  return vrt;
}

async function prepareCell(
  gdal: (tool: string) => string,
  set: ImagerySetDefinition,
  cell: Cell,
  dir: string,
  args: Args,
): Promise<Prepared> {
  const input = set.input;
  if (input.kind === 'blue-marble') {
    // Local once downloaded, and a whole-world cell: tiled straight from the image.
    const vrt = await blueMarble(gdal, args.cache);
    return {
      dataset: vrt,
      resampling: 'lanczos',
      alpha: false,
      input: { kind: input.kind, url: BLUE_MARBLE_URL },
    };
  }
  if (input.kind === 'ortho') {
    const source = args.input ?? `/vsicurl/${input.url}`;
    const dataset = await warpToCell(gdal, set, cell, [source], dir, args.strips);
    return {
      dataset,
      resampling: 'nearest',
      alpha: true,
      input: { kind: input.kind, url: input.url, read: source },
    };
  }
  // WorldCover: the 1° tiles under the cell, stretched to 8-bit sRGB; the sea stays transparent.
  const [w, s, e, n] = cellLonLat(cell);
  const available = await worldCoverTiles(input.year);
  const keys: string[] = [];
  for (let lat = Math.floor(s); lat < Math.ceil(n); lat++) {
    for (let lon = Math.floor(w); lon < Math.ceil(e); lon++) {
      const key = worldCoverKey(input.year, lat, lon);
      if (available.has(key)) keys.push(key);
    }
  }
  if (keys.length === 0) {
    return {
      dataset: '',
      resampling: 'nearest',
      alpha: true,
      input: { kind: input.kind },
      empty: true,
    };
  }
  const urls = keys.map((key) => `/vsicurl/${WORLDCOVER_BUCKET}/${key}`);
  const raw = join(dir, 'worldcover.vrt');
  const stretched = join(dir, 'worldcover-srgb.vrt');
  await retry('WorldCover VRT', 4, () =>
    run(gdal('gdalbuildvrt'), [
      '-q',
      '-overwrite',
      '-b',
      '1',
      '-b',
      '2',
      '-b',
      '3',
      '-b',
      '4',
      ...configArgs(GDAL_HTTP_CONFIG),
      raw,
      ...urls,
    ]),
  );
  await run(gdal('gdal_translate'), [
    '-q',
    '-of',
    'VRT',
    '-ot',
    'Byte',
    '-scale',
    '0',
    String(WORLDCOVER_STRETCH.max),
    '1',
    '255',
    '-exponent',
    String(WORLDCOVER_STRETCH.exponent),
    '-b',
    '1',
    '-b',
    '2',
    '-b',
    '3',
    raw,
    stretched,
  ]);
  await maskWater(stretched, raw);
  const dataset = await warpToCell(gdal, set, cell, [stretched], dir, args.strips);
  return {
    dataset,
    resampling: 'nearest',
    alpha: true,
    input: {
      kind: input.kind,
      year: input.year,
      tiles: keys.map((key) => `${WORLDCOVER_BUCKET}/${key}`),
      stretch: WORLDCOVER_STRETCH,
      water: { ndwiAbove: WORLDCOVER_WATER.ndwi, nirBelow: WORLDCOVER_WATER.nir },
    },
  };
}

/**
 * Make the composite's water transparent: a dataset mask computed from its
 * green and NIR bands (`WORLDCOVER_WATER`: NDWI above a threshold and NIR
 * below a ceiling is water; nodata, 0, is masked too). The composite keeps
 * near-shore water and masks the open sea in blocks, and its water stretches
 * to a grey-blue that met the style's ocean in visible steps along every
 * coast; masked, every sea, lake and wide river is the one ocean colour at
 * every zoom, Blue Marble's.
 */
async function maskWater(stretched: string, raw: string): Promise<void> {
  await writeFile(stretched, withWaterMask(await readFile(stretched, 'utf8'), raw));
}

/** {@link maskWater}'s rewrite of a VRT document: pure, so it is a test. */
export function withWaterMask(xml: string, raw: string): string {
  const { ndwi, nir } = WORLDCOVER_WATER;
  // muparser, in an XML attribute: B1 is green (B03), B2 is NIR (B08).
  const expression = `(B1 == 0) ? 0 : (((((B1 - B2) / (B1 + B2)) &gt; ${ndwi}) &amp;&amp; (B2 &lt; ${nir})) ? 0 : 255)`;
  const source = (band: number) => `      <SimpleSource>
        <SourceFilename relativeToVRT="0">${raw}</SourceFilename>
        <SourceBand>${band}</SourceBand>
      </SimpleSource>`;
  const mask = `  <MaskBand>
    <VRTRasterBand dataType="Byte" subClass="VRTDerivedRasterBand">
      <PixelFunctionType>expression</PixelFunctionType>
      <PixelFunctionArguments expression="${expression}" dialect="muparser" />
      <SourceTransferType>Float32</SourceTransferType>
${source(2)}
${source(4)}
    </VRTRasterBand>
  </MaskBand>
</VRTDataset>`;
  if (!xml.includes('</VRTDataset>')) throw new Error('not a VRT document');
  // The bands' inherited NoDataValue would win over the mask in gdalwarp; the
  // mask covers nodata already.
  const bands = xml.replace(/\s*<NoDataValue>[^<]*<\/NoDataValue>/g, '');
  return bands.replace('</VRTDataset>', mask);
}

/** Read the archive back as the Worker will, and compare every tile to what was tiled. */
async function verifyArchive(
  path: string,
  tileDir: string,
  set: ImagerySetDefinition,
): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await verifyWith(
      new PMTiles({
        async read(offset: number, length: number) {
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await handle.read(buffer, 0, length, offset);
          return new Uint8Array(buffer.subarray(0, bytesRead));
        },
      }),
      path,
      tileDir,
      set,
    );
  } finally {
    await handle.close();
  }
}

async function verifyWith(
  archive: PMTiles,
  path: string,
  tileDir: string,
  set: ImagerySetDefinition,
): Promise<void> {
  const header = await archive.header();
  if (header.tileType !== TILE_TYPE.WEBP)
    throw new Error(`${path}: tile type ${header.tileType}, not WebP`);
  if (header.minZoom < set.minZoom || header.maxZoom > set.maxZoom) {
    throw new Error(`${path}: zooms ${header.minZoom}–${header.maxZoom} outside the set's`);
  }
  const tiles = await listTiles(tileDir, 'webp');
  if (header.addressedTiles !== tiles.length) {
    throw new Error(`${path}: ${header.addressedTiles} tiles addressed, ${tiles.length} tiled`);
  }
  for (const tile of tiles) {
    const got = await archive.getTile(tile.z, tile.x, tile.y);
    const want = await readFile(tile.path);
    if (!got || Buffer.compare(Buffer.from(got.bytes), want) !== 0) {
      throw new Error(`${path}: tile ${tile.z}/${tile.x}/${tile.y} does not read back`);
    }
  }
  const metadata = await archive.metadata();
  if (metadata['goway:set'] !== set.id)
    throw new Error(`${path}: metadata names ${metadata['goway:set']}`);
}

async function buildCell(
  gdal: (tool: string) => string,
  gdalVersion: string,
  set: ImagerySetDefinition,
  cell: Cell,
  args: Args,
): Promise<CellReceipt | null> {
  const key = `satellite/${set.id}/${args.stamp}/${cell.z}/${cell.x}/${cell.y}.pmtiles`;
  const work = join(args.out, '.work', set.id, `${cell.z}-${cell.x}-${cell.y}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });

  const t0 = performance.now();
  const prepared = await prepareCell(gdal, set, cell, work, args);
  const t1 = performance.now();
  if (prepared.empty) {
    await rm(work, { recursive: true, force: true });
    return null;
  }

  const [x0, y0, x1, y1] = cellTileRange(cell, set.maxZoom);
  const tileDir = join(work, 'tiles');
  await run(gdal('gdal'), [
    'raster',
    'tile',
    '-q',
    '-f',
    'WEBP',
    '--co',
    `QUALITY=${set.quality}`,
    '--tile-size',
    String(TILE_SIZE),
    '--min-zoom',
    String(set.minZoom),
    '--max-zoom',
    String(set.maxZoom),
    '--min-x',
    String(x0),
    '--max-x',
    String(x1),
    '--min-y',
    String(y0),
    '--max-y',
    String(y1),
    '-r',
    prepared.resampling,
    '--overview-resampling',
    'average',
    ...(prepared.alpha ? [] : ['--no-alpha']),
    '--skip-blank',
    '--webviewer',
    'none',
    '-j',
    String(args.jobs),
    ...configArgs(GDAL_HTTP_CONFIG),
    prepared.dataset,
    tileDir,
  ]);
  const t2 = performance.now();
  if (!existsSync(tileDir) || (await listTiles(tileDir, 'webp')).length === 0) {
    await rm(work, { recursive: true, force: true });
    return null;
  }

  const out = join(args.out, key);
  await mkdir(join(out, '..'), { recursive: true });
  const [w, s, e, n] = cellLonLat(cell);
  const extent = set.extent;
  const bounds: LonLatBox = [
    Math.max(w, extent[0]),
    Math.max(s, extent[1]),
    Math.min(e, extent[2]),
    Math.min(n, extent[3]),
  ];
  const sources = set.sources.map((id) => ({ id, notice: IMAGERY_SOURCES[id].notice }));
  const packed = await packTileDirectory({
    dir: tileDir,
    ext: 'webp',
    out,
    bounds,
    metadata: {
      name: set.name,
      'goway:set': set.id,
      'goway:stamp': args.stamp,
      'goway:cell': cellKey(cell),
      'goway:sources': set.sources,
      attribution: sources.map((source) => source.notice).join(' '),
      vintage: set.vintage,
      generator: 'packages/frontend/scripts/build-satellite-set.ts',
    },
  });
  if (!packed) throw new Error(`${key}: tiles vanished between tiling and packing`);
  await verifyArchive(out, tileDir, set);
  const t3 = performance.now();

  const receipt: CellReceipt = {
    schema: 1,
    set: set.id,
    stamp: args.stamp,
    cell: cellKey(cell),
    key,
    bytes: packed.bytes,
    sha256: packed.sha256,
    tiles: packed.tiles,
    contents: packed.contents,
    perZoom: packed.perZoom,
    sources,
    input: prepared.input,
    encoding: {
      format: 'webp',
      quality: set.quality,
      tileSize: TILE_SIZE,
      resampling: 'lanczos, overviews average',
    },
    gdal: gdalVersion,
    seconds: {
      prepare: Math.round((t1 - t0) / 100) / 10,
      tile: Math.round((t2 - t1) / 100) / 10,
      pack: Math.round((t3 - t2) / 100) / 10,
    },
    builtAt: new Date().toISOString(),
  };
  await writeFile(`${out}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  await rm(work, { recursive: true, force: true });
  return receipt;
}

/**
 * The cells to build: those given, or every cell of the set's extent (∩
 * `--box`). For the WorldCover mosaic, only cells some WorldCover tile meets:
 * the open ocean has no 10 m tiles (it is the Blue Marble set's, z0–7, and
 * the style's ocean beyond).
 */
async function plannedCells(set: ImagerySetDefinition, args: Args): Promise<Cell[]> {
  if (args.cells !== 'all') {
    return args.cells.split(',').map((key) => {
      const cell = parseCellKey(key.trim());
      if (cell.z !== set.cellZoom)
        throw new Error(`cell ${key} is not at ${set.id}'s cell zoom ${set.cellZoom}`);
      return cell;
    });
  }
  const e = set.extent;
  const box: LonLatBox = args.box
    ? [
        Math.max(e[0], args.box[0]),
        Math.max(e[1], args.box[1]),
        Math.min(e[2], args.box[2]),
        Math.min(e[3], args.box[3]),
      ]
    : e;
  const cells = cellsInBox(box, set.cellZoom);
  if (set.input.kind !== 'worldcover') return cells;
  const available = await worldCoverTiles(set.input.year);
  const degrees = new Set<string>();
  for (const key of available) {
    const match = /_([NS])(\d{2})([EW])(\d{3})_S2RGBNIR\.tif$/.exec(key);
    if (!match) continue;
    const lat = (match[1] === 'N' ? 1 : -1) * Number(match[2]);
    const lon = (match[3] === 'E' ? 1 : -1) * Number(match[4]);
    degrees.add(`${lat}/${lon}`);
  }
  return cells.filter((cell) => {
    const [w, s, e2, n] = cellLonLat(cell);
    for (let lat = Math.floor(s); lat < Math.ceil(n); lat++) {
      for (let lon = Math.floor(w); lon < Math.ceil(e2); lon++) {
        if (degrees.has(`${lat}/${lon}`)) return true;
      }
    }
    return false;
  });
}

/**
 * `--plan --cells-per-job=N`: print the workflow's matrix (one line,
 * `batches=<json>`) — the cells of every `--set` (comma-separated), in jobs of
 * at most N cells of one set each.
 */
async function plan(argv: string[]): Promise<void> {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const per = Number(value('cells-per-job') ?? 24);
  const batches: { index: number; set: string; cells: string }[] = [];
  for (const id of (value('set') ?? '').split(',').filter(Boolean)) {
    const set = catalogueSet(id);
    const args = parseArgs([
      `--set=${id}`,
      '--stamp=00000000',
      '--out=.',
      ...argv.filter((a) => a.startsWith('--box=') || a.startsWith('--cells=')),
    ]);
    const cells = (await plannedCells(set, args)).map(cellKey);
    for (let i = 0; i < cells.length; i += per) {
      batches.push({ index: batches.length, set: id, cells: cells.slice(i, i + per).join(',') });
    }
    console.error(`${id}: ${cells.length} cells`);
  }
  if (batches.length > 256)
    throw new Error(`${batches.length} jobs: raise --cells-per-job (a matrix holds 256)`);
  console.log(`batches=${JSON.stringify(batches)}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const set = catalogueSet(args.set);
  const gdal = (tool: string) => (args.gdal ? join(args.gdal, tool) : tool);
  const gdalVersion = (await run(gdal('gdalinfo'), ['--version'])).trim();
  const [major, minor] = (/GDAL (\d+)\.(\d+)/.exec(gdalVersion) ?? []).slice(1).map(Number);
  if (!(major > 3 || (major === 3 && minor >= 11)))
    throw new Error(`${gdalVersion}: GDAL ≥ 3.11 is needed (gdal raster tile)`);

  const cells = await plannedCells(set, args);
  console.log(
    `${set.id} @ ${args.stamp}: ${cells.length} cells at z${set.cellZoom} (${gdalVersion})`,
  );
  const built: CellReceipt[] = [];
  for (const [index, cell] of cells.entries()) {
    const started = performance.now();
    const receipt = await buildCell(gdal, gdalVersion, set, cell, args);
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    if (!receipt) {
      console.log(
        `  [${index + 1}/${cells.length}] ${cellKey(cell)}: empty, skipped (${seconds} s)`,
      );
      continue;
    }
    built.push(receipt);
    console.log(
      `  [${index + 1}/${cells.length}] ${cellKey(cell)}: ${receipt.tiles} tiles, ` +
        `${(receipt.bytes / 1e6).toFixed(1)} MB (${seconds} s: ${receipt.seconds.prepare} fetch, ${receipt.seconds.tile} tile, ${receipt.seconds.pack} pack)`,
    );
  }
  if (built.length === 0) {
    console.log('no cell had any pixels; no entry written');
    return;
  }

  const builtCells = built.map((receipt) => parseCellKey(receipt.cell));
  const boxes = builtCells.map(cellLonLat);
  const extent = set.extent;
  const entry: SetEntry = {
    id: set.id,
    stamp: args.stamp,
    name: set.name,
    tiers: [...set.tiers],
    minZoom: set.minZoom,
    maxZoom: set.maxZoom,
    cellZoom: set.cellZoom,
    sources: [...set.sources],
    vintage: set.vintage,
    format: 'webp',
    bbox: [
      Math.max(extent[0], Math.min(...boxes.map((b) => b[0]))),
      Math.max(extent[1], Math.min(...boxes.map((b) => b[1]))),
      Math.min(extent[2], Math.max(...boxes.map((b) => b[2]))),
      Math.min(extent[3], Math.max(...boxes.map((b) => b[3]))),
    ],
    cellKeys: built.map((receipt) => receipt.cell).sort(),
    tiles: built.reduce((sum, receipt) => sum + receipt.tiles, 0),
    bytes: built.reduce((sum, receipt) => sum + receipt.bytes, 0),
    builtAt: new Date().toISOString(),
  };
  // Encodes: refuses a tree the manifest could not carry.
  encodeCoverageTree(cellsTree(builtCells, set.cellZoom), set.cellZoom);
  const entries = join(args.out, 'entries');
  await mkdir(entries, { recursive: true });
  const name = `${set.id}@${args.stamp}${args.part ? `~${args.part}` : ''}.json`;
  await writeFile(join(entries, name), `${JSON.stringify(entry, null, 2)}\n`);
  const total = (await Promise.all(built.map((r) => stat(join(args.out, r.key))))).reduce(
    (sum, s) => sum + s.size,
    0,
  );
  console.log(
    `${set.id}: ${built.length} cells, ${entry.tiles} tiles, ${(total / 1e9).toFixed(2)} GB → entries/${name}`,
  );
}

if (import.meta.main) {
  if (process.argv.includes('--plan')) await plan(process.argv.slice(2));
  else await main();
}

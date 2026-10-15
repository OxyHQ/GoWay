/**
 * Build cells of ONE terrain set (`docs/MAP_TERRAIN_GLOBE.md` → "The
 * archive"): per cell, the set's bare-earth heights on a z14 analysis grid in
 * EGM2008, judged by the contamination gate, feathered into the fallback
 * terrain where the set ends, averaged down to z12 and the pyramid, encoded
 * as Terrarium lossless WebP, packed into one PMTiles archive, verified with
 * the Worker's own reader, and described by a receipt.
 *
 * ```bash
 * bun run --cwd packages/frontend map:terrain-set --set=icgc-met-2021 \
 *   --stamp=20261015-local --out=<dir> [--cells=all | --cells=7/64/47,… | --box=w,s,e,n] \
 *   --gdal=<env>/bin [--cache=<dir>] [--city=https://goway.to] [--fallback=<{z}/{x}/{y} template>]
 * bun run --cwd packages/frontend map:terrain-set --plan --set=<id,…> [--box=…] [--cells-per-job=4]
 * ```
 *
 * Writes, under `--out`, the bucket's layout:
 *
 *     terrain/<set>/<stamp>/<z>/<x>/<y>.pmtiles               one archive per cell (z7)
 *     terrain/<set>/<stamp>/<z>/<x>/<y>.pmtiles.receipt.json  what it was built from, how, the gate's numbers
 *     entries/<set>@<stamp>.json                              the manifest entry for these cells
 *
 * ## One cell
 *
 * A cell (z7) is processed in BLOCKS (z10 tiles), each a window of
 * 8,192² z14 pixels plus a margin (the feather and the gate's ring must see
 * past the block's edge): read the set (`inputs.ts`), the footprints
 * (`/map/city/15/…`) and tree cover (WorldCover); gate; correct only if the
 * set asks; read the fallback (Mapterhorn z12, bilinear as MapLibre draws
 * it) and feather the set into it; average the block's core down to its z12,
 * z11 and z10 tiles. z9–z7 are averaged from the blocks' z10 tiles (the
 * fallback's own tile filling a quadrant no block covered). A tile is
 * published only where the set has ground in it; elsewhere the fallback
 * stays what the map draws.
 */
import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { MAPTERHORN_ENDPOINTS } from '../lib/map/provider';
import { TERRAIN_SOURCES } from '../lib/map/terrainSources';
import { canopyClasses, gdalRun } from './check-terrain-ground';
import {
  type Cell,
  cellKey,
  cellLonLat,
  cellsInBox,
  cellTileRange,
  type LonLatBox,
  parseCellKey,
} from './imagery/cells';
import { packTileDirectory, verifyPackedArchive } from './imagery/pmtilesStream';
import { blendIntoFallback, FEATHER_M } from './terrain/blend';
import {
  catalogueSet,
  TERRAIN_ANALYSIS_ZOOM,
  TERRAIN_BLOCK_ZOOM,
  TERRAIN_CELL_ZOOM,
  TERRAIN_MAX_ZOOM,
  TERRAIN_MIN_ZOOM,
  type TerrainSetDefinition,
} from './terrain/catalogue';
import { footprintsInWindow } from './terrain/footprints';
import {
  CONTAMINATION_THRESHOLD_M,
  correctWindow,
  type GateSummary,
  gateWindow,
  labelWindow,
  ringBand,
} from './terrain/gate';
import { downsample, type PixelWindow, TERRAIN_TILE_SIZE, windowOfTile } from './terrain/grid';
import { type InputContext, readSetWindow, USER_AGENT, windowGroundPixelM } from './terrain/inputs';
import { sampleServed, templateFetcher } from './terrain/served';
import { decodeTerrarium, encodeTerrarium, terrainStepM } from './terrain/terrarium';
import { decodeWebp, encodeLosslessWebp } from './terrain/webp';

const S = TERRAIN_TILE_SIZE;

interface Args {
  set: string;
  stamp: string;
  out: string;
  cells: string;
  box: LonLatBox | null;
  gdal: string;
  cache: string;
  city: string;
  fallback: string;
}

function parseArgs(argv: string[]): Args {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const set = value('set');
  const stamp = value('stamp');
  const out = value('out');
  if (!set || !stamp || !out) {
    throw new Error(
      'usage: --set=<id> --stamp=<YYYYMMDD[-suffix]> --out=<dir> --gdal=<bin> [--cells=…|--box=…]',
    );
  }
  if (!/^[0-9]{8}(-[a-z0-9]{1,24})?$/.test(stamp))
    throw new Error(`--stamp=${stamp}: YYYYMMDD[-suffix]`);
  const box = value('box');
  return {
    set,
    stamp,
    out: resolve(out),
    cells: value('cells') ?? 'all',
    box: box ? (box.split(',').map(Number) as LonLatBox) : null,
    gdal: value('gdal') ?? '',
    cache: resolve(value('cache') ?? join(out, '.cache')),
    city: value('city') ?? 'https://goway.to',
    fallback: value('fallback') ?? MAPTERHORN_ENDPOINTS.tiles,
  };
}

function intersects(a: LonLatBox, b: LonLatBox): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** The set's cells (or those named, or those meeting `--box`), in row order. */
export function planCells(set: TerrainSetDefinition, cells: string, box: LonLatBox | null): Cell[] {
  if (cells !== 'all') return cells.split(',').map(parseCellKey);
  const area = box ?? set.extent;
  return cellsInBox(area, TERRAIN_CELL_ZOOM).filter((cell) =>
    intersects(cellLonLat(cell), set.extent),
  );
}

/** A cell's blocks that meet the set's extent (and `--box`). */
export function planBlocks(set: TerrainSetDefinition, cell: Cell, box: LonLatBox | null): Cell[] {
  const [x0, y0, x1, y1] = cellTileRange(cell, TERRAIN_BLOCK_ZOOM);
  const out: Cell[] = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const block = { z: TERRAIN_BLOCK_ZOOM, x, y };
      const bounds = cellLonLat(block);
      if (intersects(bounds, set.extent) && (!box || intersects(bounds, box))) out.push(block);
    }
  }
  return out;
}

/** The gate's numbers for a block or a cell: per kind, judged and over each threshold. */
interface GateCounts {
  judged: number;
  areaM2: number;
  over: Record<string, { count: number; areaM2: number }>;
}

function countsOf(summary: GateSummary, inCore: (at: number) => boolean): GateCounts {
  const judged = summary.judged.filter((f) => inCore(f.at));
  const over: GateCounts['over'] = {};
  for (const { thresholdM } of summary.over) {
    const above = judged.filter((f) => f.p90AboveM > thresholdM);
    over[`${thresholdM}`] = {
      count: above.length,
      areaM2: Math.round(above.reduce((sum, f) => sum + f.areaM2, 0)),
    };
  }
  return {
    judged: judged.length,
    areaM2: Math.round(judged.reduce((s, f) => s + f.areaM2, 0)),
    over,
  };
}

function addCounts(into: GateCounts, more: GateCounts) {
  into.judged += more.judged;
  into.areaM2 += more.areaM2;
  for (const [t, v] of Object.entries(more.over)) {
    into.over[t] ??= { count: 0, areaM2: 0 };
    into.over[t].count += v.count;
    into.over[t].areaM2 += v.areaM2;
  }
}

interface BuiltTile {
  z: number;
  x: number;
  y: number;
  heights: Float32Array;
  /** Share of the tile's analysis pixels the set had ground for (before the feather). */
  sourceShare: number;
}

interface BlockResult {
  tiles: BuiltTile[];
  /** The block's own z10 tile (always: z9–z7 average it). */
  top: BuiltTile;
  buildings: GateCounts;
  stands: GateCounts;
  correctedPixels: number;
  footprintTiles: number;
  seconds: Record<string, number>;
}

/** The analysis margin around a block: the feather and the gate's ring must see past its edge. */
function blockMargin(window: PixelWindow): number {
  return Math.ceil(FEATHER_M / windowGroundPixelM(window)) + 16;
}

/** Copy the core of a window (the block itself) out of the window's array. */
function core(data: Float32Array, window: PixelWindow, margin: number, size: number): Float32Array {
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    out.set(
      data.subarray(
        (y + margin) * window.width + margin,
        (y + margin) * window.width + margin + size,
      ),
      y * size,
    );
  }
  return out;
}

/** Split a square grid of `n × n` tiles into its tiles. */
export function tilesOf(data: Float32Array, size: number, z: number, x0: number, y0: number) {
  const n = size / S;
  const out: { z: number; x: number; y: number; heights: Float32Array }[] = [];
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      const heights = new Float32Array(S * S);
      for (let y = 0; y < S; y++) {
        heights.set(
          data.subarray((ty * S + y) * size + tx * S, (ty * S + y) * size + tx * S + S),
          y * S,
        );
      }
      out.push({ z, x: x0 + tx, y: y0 + ty, heights });
    }
  }
  return out;
}

async function buildBlock(
  set: TerrainSetDefinition,
  block: Cell,
  args: Args,
  context: InputContext,
): Promise<BlockResult | null> {
  const seconds: Record<string, number> = {};
  let t = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    seconds[name] = +((now - t) / 1000).toFixed(2);
    t = now;
  };
  const probe = windowOfTile(block, TERRAIN_ANALYSIS_ZOOM);
  const margin = blockMargin(probe);
  const window = windowOfTile(block, TERRAIN_ANALYSIS_ZOOM, margin);
  const size = probe.width;

  const source = await readSetWindow(set, window, context);
  lap('read');
  const sourceCore = core(source, window, margin, size);
  let any = false;
  for (const v of sourceCore) {
    if (!Number.isNaN(v)) {
      any = true;
      break;
    }
  }
  if (!any) return null;

  const [footprints, classes] = await Promise.all([
    footprintsInWindow(args.city, window, USER_AGENT),
    canopyClasses(window, context.gdal),
  ]);
  lap('footprints');
  const pixelM = windowGroundPixelM(window);
  const labels = labelWindow(window, footprints.polygons, classes, pixelM);
  const gate = gateWindow(
    source,
    window,
    labels,
    ringBand(pixelM, set.pixelM),
    CONTAMINATION_THRESHOLD_M,
  );
  const inCore = (at: number) => {
    const x = at % window.width;
    const y = Math.floor(at / window.width);
    return x >= margin && x < margin + size && y >= margin && y < margin + size;
  };
  let ground = source;
  let correctedPixels = 0;
  if (set.correct) {
    const corrected = correctWindow(source, window, gate);
    ground = corrected.data;
    correctedPixels = corrected.pixels;
  }
  lap('gate');

  const fallback = await sampleServed(
    templateFetcher(args.fallback, USER_AGENT),
    TERRAIN_MAX_ZOOM,
    window,
  );
  lap('fallback');
  const blended = blendIntoFallback(
    ground,
    fallback,
    window.width,
    window.height,
    Math.ceil(FEATHER_M / pixelM),
    classes,
  );
  const blendedCore = core(blended, window, margin, size);
  lap('blend');

  // Down to z12 (×4), z11, z10, with each tile's share of set ground.
  const shareGrid = new Float32Array(sourceCore.length);
  for (let i = 0; i < sourceCore.length; i++) shareGrid[i] = Number.isNaN(sourceCore[i]) ? 0 : 1;
  const tiles: BuiltTile[] = [];
  type Level = { data: Float32Array; width: number; height: number };
  let level: Level = { data: blendedCore, width: size, height: size };
  let share: Level = { data: shareGrid, width: size, height: size };
  const factor = 2 ** (TERRAIN_ANALYSIS_ZOOM - TERRAIN_MAX_ZOOM);
  level = downsample(level.data, level.width, level.height, factor);
  share = downsample(share.data, share.width, share.height, factor);
  let top: BuiltTile | null = null;
  for (let z = TERRAIN_MAX_ZOOM; z >= TERRAIN_BLOCK_ZOOM; z--) {
    const k = 2 ** (z - TERRAIN_BLOCK_ZOOM);
    const heights = tilesOf(level.data, level.width, z, block.x * k, block.y * k);
    const shares = tilesOf(share.data, share.width, z, block.x * k, block.y * k);
    for (let i = 0; i < heights.length; i++) {
      let sum = 0;
      for (const v of shares[i].heights) sum += v;
      const tile = { ...heights[i], sourceShare: sum / (S * S) };
      if (tile.sourceShare > 0) tiles.push(tile);
      if (z === TERRAIN_BLOCK_ZOOM) top = tile;
    }
    if (z > TERRAIN_BLOCK_ZOOM) {
      level = downsample(level.data, level.width, level.height, 2);
      share = downsample(share.data, share.width, share.height, 2);
    }
  }
  lap('pyramid');
  return {
    tiles,
    top: top as BuiltTile,
    buildings: countsOf(gate.buildings, inCore),
    stands: countsOf(gate.stands, inCore),
    correctedPixels,
    footprintTiles: footprints.tiles,
    seconds,
  };
}

/** The fallback's own tile (z, x, y), decoded; sea level where it has none. */
async function fallbackTile(args: Args, z: number, x: number, y: number): Promise<Float32Array> {
  const bytes = await templateFetcher(args.fallback, USER_AGENT)(z, x, y);
  if (!bytes) return new Float32Array(S * S);
  return decodeTerrarium((await decodeWebp(bytes)).data);
}

/** z9–z7 of a cell from its blocks' z10 tiles; a quadrant no block covered is the fallback's own. */
async function upperPyramid(
  cell: Cell,
  tops: Map<string, BuiltTile>,
  args: Args,
): Promise<BuiltTile[]> {
  const out: BuiltTile[] = [];
  let level = tops;
  for (let z = TERRAIN_BLOCK_ZOOM - 1; z >= TERRAIN_MIN_ZOOM; z--) {
    const next = new Map<string, BuiltTile>();
    const [x0, y0, x1, y1] = cellTileRange(cell, z);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const children = [0, 1, 2, 3].map((q) =>
          level.get(`${2 * x + (q & 1)}/${2 * y + (q >> 1)}`),
        );
        if (children.every((c) => !c)) continue;
        const own = children.some((c) => !c) ? await fallbackTile(args, z, x, y) : null;
        const heights = new Float32Array(S * S);
        let share = 0;
        for (let q = 0; q < 4; q++) {
          const child = children[q];
          const qx = (q & 1) * (S / 2);
          const qy = (q >> 1) * (S / 2);
          if (child) share += child.sourceShare / 4;
          for (let py = 0; py < S / 2; py++) {
            for (let px = 0; px < S / 2; px++) {
              let v: number;
              if (child) {
                const a = child.heights;
                const i = 2 * py * S + 2 * px;
                v = (a[i] + a[i + 1] + a[i + S] + a[i + S + 1]) / 4;
              } else {
                v = (own as Float32Array)[(qy + py) * S + qx + px];
              }
              heights[(qy + py) * S + qx + px] = v;
            }
          }
        }
        const tile = { z, x, y, heights, sourceShare: share };
        next.set(`${x}/${y}`, tile);
        if (share > 0) out.push(tile);
      }
    }
    level = next;
  }
  return out;
}

export interface TerrainCellReceipt {
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
  bytesPerZoom: Record<number, number>;
  sources: { id: string; notice: string }[];
  input: TerrainSetDefinition['input'];
  crs: string;
  transform: string | null;
  datum: 'EGM2008';
  encoding: {
    format: 'webp';
    lossless: true;
    terrarium: true;
    tileSize: number;
    stepM: Record<number, number>;
  };
  analysis: { zoom: number; blockZoom: number; featherM: number; fallback: string };
  gate: {
    thresholdM: number;
    corrected: boolean;
    correctedPixels: number;
    buildings: GateCounts;
    stands: GateCounts;
  };
  blocks: number;
  seconds: Record<string, number>;
  gdal: string;
  builtAt: string;
}

export interface TerrainSetEntry {
  id: string;
  stamp: string;
  name: string;
  /** The one tier of the terrain family (`worker/terrain.js`). */
  tiers: ['terrain'];
  minZoom: number;
  maxZoom: number;
  cellZoom: number;
  sources: string[];
  vintage: string;
  format: 'webp';
  bbox: LonLatBox;
  cellKeys: string[];
  tiles: number;
  bytes: number;
  builtAt: string;
}

async function buildCell(
  set: TerrainSetDefinition,
  cell: Cell,
  args: Args,
  context: InputContext,
): Promise<TerrainCellReceipt | null> {
  const key = `terrain/${set.id}/${args.stamp}/${cellKey(cell)}.pmtiles`;
  const work = join(args.out, '.work', set.id, `${cell.z}-${cell.x}-${cell.y}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const seconds: Record<string, number> = {};
  const buildings: GateCounts = { judged: 0, areaM2: 0, over: {} };
  const stands: GateCounts = { judged: 0, areaM2: 0, over: {} };
  let correctedPixels = 0;
  const tops = new Map<string, BuiltTile>();
  const tileDir = join(work, 'tiles');
  const bytesPerZoom: Record<number, number> = {};
  const writeTile = async (tile: BuiltTile) => {
    const step = terrainStepM(tile.z);
    const webp = await encodeLosslessWebp(encodeTerrarium(tile.heights, step), S, S);
    const dir = join(tileDir, String(tile.z), String(tile.x));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${tile.y}.webp`), webp);
    bytesPerZoom[tile.z] = (bytesPerZoom[tile.z] ?? 0) + webp.length;
  };

  const blocks = planBlocks(set, cell, args.box);
  let built = 0;
  for (const block of blocks) {
    const started = performance.now();
    const result = await buildBlock(set, block, args, context);
    if (!result) continue;
    built++;
    for (const [name, s] of Object.entries(result.seconds))
      seconds[name] = +((seconds[name] ?? 0) + s).toFixed(2);
    addCounts(buildings, result.buildings);
    addCounts(stands, result.stands);
    correctedPixels += result.correctedPixels;
    tops.set(`${result.top.x}/${result.top.y}`, result.top);
    const t0 = performance.now();
    for (const tile of result.tiles) await writeTile(tile);
    seconds.encode = +((seconds.encode ?? 0) + (performance.now() - t0) / 1000).toFixed(2);
    console.log(
      `  block ${cellKey(block)}: ${result.tiles.length} tiles, ${result.buildings.judged} footprints judged, ` +
        `${result.buildings.over[`${CONTAMINATION_THRESHOLD_M}`]?.count ?? 0} over ${CONTAMINATION_THRESHOLD_M} m ` +
        `(${((performance.now() - started) / 1000).toFixed(0)} s)`,
    );
  }
  if (built === 0) return null;
  const t0 = performance.now();
  for (const tile of await upperPyramid(cell, tops, args)) await writeTile(tile);
  seconds.pyramid = +((seconds.pyramid ?? 0) + (performance.now() - t0) / 1000).toFixed(2);

  const out = join(args.out, key);
  await mkdir(join(out, '..'), { recursive: true });
  const t1 = performance.now();
  const packed = await packTileDirectory({
    dir: tileDir,
    ext: 'webp',
    out,
    bounds: cellLonLat(cell),
    metadata: {
      name: `GoWay terrain — ${set.name}`,
      'goway:set': set.id,
      'goway:stamp': args.stamp,
      'goway:cell': cellKey(cell),
      encoding: 'terrarium',
      datum: 'EGM2008',
      attribution: set.sources.map((id) => TERRAIN_SOURCES[id].notice).join(' '),
    },
  });
  if (!packed) return null;
  await verifyPackedArchive(out, tileDir, {
    set: set.id,
    minZoom: TERRAIN_MIN_ZOOM,
    maxZoom: TERRAIN_MAX_ZOOM,
  });
  seconds.pack = +((performance.now() - t1) / 1000).toFixed(2);
  await rm(work, { recursive: true, force: true });

  const stepM: Record<number, number> = {};
  for (let z = TERRAIN_MIN_ZOOM; z <= TERRAIN_MAX_ZOOM; z++) stepM[z] = terrainStepM(z);
  const receipt: TerrainCellReceipt = {
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
    bytesPerZoom,
    sources: set.sources.map((id) => ({ id, notice: TERRAIN_SOURCES[id].notice })),
    input: set.input,
    crs: set.crs,
    transform: set.transform ?? null,
    datum: 'EGM2008',
    encoding: { format: 'webp', lossless: true, terrarium: true, tileSize: S, stepM },
    analysis: {
      zoom: TERRAIN_ANALYSIS_ZOOM,
      blockZoom: TERRAIN_BLOCK_ZOOM,
      featherM: FEATHER_M,
      fallback: args.fallback,
    },
    gate: {
      thresholdM: CONTAMINATION_THRESHOLD_M,
      corrected: set.correct,
      correctedPixels,
      buildings,
      stands,
    },
    blocks: built,
    seconds,
    gdal: args.gdal,
    builtAt: new Date().toISOString(),
  };
  await writeFile(`${out}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

/**
 * `--plan --set=a,b --cells-per-job=N`: print the workflow's matrix (one line,
 * `batches=<json>`) — the cells of every set, in jobs of at most N cells of
 * one set each.
 */
function plan(argv: string[]) {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const per = Number(value('cells-per-job') ?? 4);
  const box = value('box');
  const batches: { index: number; set: string; cells: string }[] = [];
  for (const id of (value('set') ?? '').split(',').filter(Boolean)) {
    const cells = planCells(
      catalogueSet(id),
      value('cells') ?? 'all',
      box ? (box.split(',').map(Number) as LonLatBox) : null,
    );
    for (let i = 0; i < cells.length; i += per) {
      batches.push({
        index: batches.length,
        set: id,
        cells: cells
          .slice(i, i + per)
          .map(cellKey)
          .join(','),
      });
    }
    console.error(`${id}: ${cells.length} cells`);
  }
  if (batches.length > 256)
    throw new Error(`${batches.length} jobs: raise --cells-per-job (a matrix holds 256)`);
  console.log(`batches=${JSON.stringify(batches)}`);
}

async function main(argv: string[]) {
  if (argv.includes('--plan')) {
    plan(argv);
    return;
  }
  const args = parseArgs(argv);
  const set = catalogueSet(args.set);
  const cells = planCells(set, args.cells, args.box);
  const context: InputContext = {
    gdal: gdalRun(args.gdal, join(args.cache, 'scratch')),
    cache: args.cache,
  };
  await mkdir(join(args.cache, 'scratch'), { recursive: true });
  const receipts: TerrainCellReceipt[] = [];
  for (const cell of cells) {
    console.log(`cell ${cellKey(cell)} (${planBlocks(set, cell, args.box).length} blocks)`);
    const receipt = await buildCell(set, cell, args, context);
    if (!receipt) {
      console.log(`cell ${cellKey(cell)}: no ground of the set`);
      continue;
    }
    receipts.push(receipt);
    console.log(
      `cell ${cellKey(cell)}: ${receipt.tiles} tiles, ${(receipt.bytes / 1e6).toFixed(1)} MB, ` +
        `${receipt.blocks} blocks, ${JSON.stringify(receipt.seconds)}`,
    );
  }
  if (receipts.length === 0) return;
  const bbox = receipts
    .map((r) => cellLonLat(parseCellKey(r.cell)))
    .reduce(
      (a, b): LonLatBox => [
        Math.min(a[0], b[0]),
        Math.min(a[1], b[1]),
        Math.max(a[2], b[2]),
        Math.max(a[3], b[3]),
      ],
    );
  const entry: TerrainSetEntry = {
    id: set.id,
    stamp: args.stamp,
    name: set.name,
    tiers: ['terrain'],
    minZoom: TERRAIN_MIN_ZOOM,
    maxZoom: TERRAIN_MAX_ZOOM,
    cellZoom: TERRAIN_CELL_ZOOM,
    sources: [...set.sources],
    vintage: set.vintage,
    format: 'webp',
    bbox,
    cellKeys: receipts.map((r) => r.cell),
    tiles: receipts.reduce((s, r) => s + r.tiles, 0),
    bytes: receipts.reduce((s, r) => s + r.bytes, 0),
    builtAt: new Date().toISOString(),
  };
  const part = createHash('sha256').update(entry.cellKeys.join(',')).digest('hex').slice(0, 8);
  await mkdir(join(args.out, 'entries'), { recursive: true });
  await writeFile(
    join(args.out, 'entries', `${set.id}@${args.stamp}~${part}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

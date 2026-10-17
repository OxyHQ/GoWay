/**
 * Build ONE region of the planet's city tiles: its building archive and its
 * road archive, each holding exactly the tiles the region owns, plus the
 * manifest entry that names them.
 *
 * ```bash
 * # The extract and its polygon are downloaded by the caller (the workflow, or
 * # you): this script never fetches, so it never compiles bytes nobody chose.
 * bun run --cwd packages/frontend map:city-region --region=europe/portugal \
 *   --pbf=<portugal-latest.osm.pbf> --poly=<portugal.poly> --stamp=20261011-local \
 *   --out=<dir>
 * ```
 *
 * Writes, under `--out`, the layout the R2 bucket has
 * (`docs/MAP_CITY_PLANET.md` → "Keys"):
 *
 *     city/<stamp>/<region>.pmtiles            (+ .receipt.json)
 *     city-roads/<stamp>/<region>.pmtiles      (+ .receipt.json)
 *     entries/<region>.json                    the manifest entry
 *
 * ## What "region" means
 *
 * A Geofabrik extract, named by its download path (`europe/portugal`,
 * `north-america/us/texas`) and listed in `citygen/regions.json` with how many
 * PARTS it is built in. The region owns the z15 tiles wholly inside its
 * polygon (`citygen/ownership.ts`). A region too large for one build machine's
 * memory is split into parts — tile rectangles of even node weight, each cut
 * from the extract with `osmium extract` — and each part is built and
 * published as a region of its own (`<region>~<i>of<n>`), owning its share.
 *
 * Each compiler runs in its own process, one after the other, so the memory
 * one released is never counted against the next; the receipt records each
 * process's peak as the operating system measured it.
 *
 * ## Official data
 *
 * Regions the catalogue lists with `official` sources (Spain's Catastro,
 * NYC's 3D Building Model; `docs/MAP_3D_SOURCES.md`) merge them through the
 * compiler's `--lod2` when the files are passed with
 * `--official=<source>:<file|dir>[,…]` — fetched by the caller like the
 * extract (the workflow's `official` input; `docs/MAP_CITY_PLANET.md`). A
 * source the catalogue does not list for the region is refused. Without
 * them the region is built from OpenStreetMap alone and the entry says so
 * (`official: []`), so a later run with the data replaces it cleanly.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  countCoverageTiles,
  coverageTreeBounds,
  encodeCoverageTree,
  type CoverageNode,
} from '@goway/map-service/coverageTree.js';
import { nodeDensity } from './citygen/density';
import {
  OWNERSHIP_ZOOM,
  parsePoly,
  partOwnership,
  polygonOwnership,
  rectBounds,
  splitByDensity,
  type TileRect,
} from './citygen/ownership';
import type { OwnershipFile } from './citygen/regionArchive';
import { type CityRegion, catalogueRegion, extractUrl, polyUrl } from './citygen/regions';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The zoom parts are cut on: coarse enough to be cheap, fine enough to balance a city. */
const SPLIT_ZOOM = 10;

/**
 * How far past a part's rectangle its extract reaches, in degrees.
 *
 * `osmium extract --strategy=smart` brings every way with a node inside the
 * box complete, so a building whose representative point is in the part is
 * there as long as one of its nodes is inside — always, for anything a
 * kilometre across. Roads are cut at tile edges, so a road crossing into the
 * part must have a node within reach; 0.05° (~5 km) covers every road but a
 * very long straight one, which the neighbouring part then also lacks.
 */
const PART_BUFFER_DEGREES = 0.05;

/** A region's manifest entry (`docs/MAP_CITY_PLANET.md` → "The manifest"). */
export interface RegionEntry {
  id: string;
  name: string;
  /** The catalogue region this is (itself, or the region a part belongs to). */
  region: string;
  part: { index: number; of: number; rect: TileRect } | null;
  stamp: string;
  bbox: [number, number, number, number];
  ownership: { maxZoom: number; nodes: number; bits: string };
  ownedTiles: number;
  source: {
    extract: string;
    polygon: { url: string; sha256: string };
    replicationTimestamp?: string;
    replicationSequence?: number;
  };
  official: string[];
  city: ArchiveRef | null;
  roads: ArchiveRef | null;
  builtAt: string;
}

export interface ArchiveRef {
  key: string;
  receipt: string;
  bytes: number;
  sha256: string;
  tiles: number;
  seconds: number;
  peakRssMb: number;
}

interface Args {
  region?: string;
  pbf?: string;
  poly?: string;
  out?: string;
  stamp?: string;
  parts?: number;
  osmium: string;
  only?: 'city' | 'roads';
  official: string[];
  keepParts: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { osmium: 'osmium', official: [], keepParts: false };
  for (const raw of argv) {
    const [flag, value] = raw.startsWith('--') ? raw.slice(2).split('=', 2) : [raw, undefined];
    if (flag === 'region' && value) args.region = value;
    else if (flag === 'pbf' && value) args.pbf = value;
    else if (flag === 'poly' && value) args.poly = value;
    else if (flag === 'out' && value) args.out = value;
    else if (flag === 'stamp' && value) args.stamp = value;
    else if (flag === 'parts' && value) args.parts = Number(value);
    else if (flag === 'osmium' && value) args.osmium = value;
    else if (flag === 'only' && (value === 'city' || value === 'roads')) args.only = value;
    else if (flag === 'official' && value) args.official.push(value);
    else if (flag === 'keep-parts') args.keepParts = true;
    else throw new Error(`unknown argument ${raw}`);
  }
  return args;
}

/** `YYYYMMDD` plus an optional suffix: what dated keys are made of. */
export const STAMP = /^[0-9]{8}(-[a-z0-9]{1,24})?$/;

/** The id of part `index` (1-based) of `of`, or the region's own id when whole. */
export function partId(region: string, index: number, of: number): string {
  return of === 1 ? region : `${region}~${index}of${of}`;
}

/** The object key of a region's archive. */
export function archiveKey(kind: 'city' | 'city-roads', stamp: string, id: string): string {
  return `${kind}/${stamp}/${id}.pmtiles`;
}

async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  const file = Bun.file(path);
  const reader = file.stream().getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
  }
  return hash.digest('hex');
}

/** Run a compiler in its own process; its peak RSS as the OS measured it. */
async function runCompiler(script: string, args: string[]): Promise<number> {
  const proc = Bun.spawn(['bun', join(FRONTEND_ROOT, 'scripts', script), ...args], {
    cwd: FRONTEND_ROOT,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${script} ${args.join(' ')} exited ${code}`);
  // Bun reports maxRSS in bytes.
  const usage = proc.resourceUsage();
  return usage ? Math.round(Number(usage.maxRSS) / 1e6) : 0;
}

async function run(cmd: string[]): Promise<void> {
  const proc = Bun.spawn(cmd, { stdout: 'inherit', stderr: 'inherit' });
  const code = await proc.exited;
  if (code !== 0) throw new Error(`${cmd.join(' ')} exited ${code}`);
}

interface Part {
  id: string;
  part: RegionEntry['part'];
  pbf: string;
  tree: CoverageNode;
}

/** Decide the parts: the whole region, or density-balanced tile rectangles cut by osmium. */
async function planParts(
  region: CityRegion,
  args: Args,
  tree: CoverageNode,
  workDir: string,
): Promise<Part[]> {
  const parts = args.parts ?? region.parts;
  if (parts === 1) return [{ id: region.id, part: null, pbf: args.pbf as string, tree }];

  console.log(`· ${region.id}: splitting into ${parts} parts by node density (z${SPLIT_ZOOM})`);
  const started = performance.now();
  const density = nodeDensity(args.pbf as string, SPLIT_ZOOM);
  // The region's owned tiles, as a rectangle on the split grid.
  const bounds = coverageTreeBounds(tree);
  if (!bounds) throw new Error(`${region.id} owns no tile`);
  const span = 2 ** SPLIT_ZOOM;
  const toX = (lon: number) => Math.floor(((lon + 180) / 360) * span);
  const toY = (lat: number) => {
    const phi = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(phi) + 1 / Math.cos(phi)) / Math.PI) / 2) * span);
  };
  const grid: TileRect = {
    zoom: SPLIT_ZOOM,
    x0: toX(bounds[0]),
    y0: toY(bounds[3]),
    x1: Math.min(span, toX(bounds[2] - 1e-9) + 1),
    y1: Math.min(span, toY(bounds[1] + 1e-9) + 1),
  };
  const rects = splitByDensity(density, grid, parts);
  console.log(
    `  density      ${((performance.now() - started) / 1000).toFixed(1)} s, ${rects.length} rectangles`,
  );

  const out: Part[] = [];
  for (let i = 0; i < rects.length; i++) {
    const rect = rects[i];
    const owned = partOwnership(tree, rect);
    if (countCoverageTiles(owned, OWNERSHIP_ZOOM) === 0) {
      console.log(`  part ${i + 1}/${rects.length} owns nothing (sea): skipped`);
      continue;
    }
    const id = partId(region.id, i + 1, rects.length);
    const [w, s, e, n] = rectBounds(rect);
    const b = PART_BUFFER_DEGREES;
    const pbf = join(workDir, `${id.replaceAll('/', '_')}.osm.pbf`);
    console.log(
      `  part ${i + 1}/${rects.length}: osmium extract ${[w, s, e, n].map((v) => v.toFixed(4)).join(',')}`,
    );
    await run([
      args.osmium,
      'extract',
      '--strategy=smart',
      '--overwrite',
      '--bbox',
      [
        Math.max(-180, w - b),
        Math.max(-85.06, s - b),
        Math.min(180, e + b),
        Math.min(85.06, n + b),
      ].join(','),
      '--output',
      pbf,
      args.pbf as string,
    ]);
    out.push({ id, part: { index: i + 1, of: rects.length, rect }, pbf, tree: owned });
  }
  return out;
}

async function buildRegion(args: Args): Promise<RegionEntry[]> {
  if (!args.region || !args.pbf || !args.poly || !args.out || !args.stamp) {
    throw new Error('--region, --pbf, --poly, --out and --stamp are required');
  }
  if (!STAMP.test(args.stamp)) throw new Error(`--stamp=${args.stamp} is not YYYYMMDD[-suffix]`);
  const region = catalogueRegion(args.region);
  const out = resolve(args.out);
  const workDir = join(out, 'work');
  await mkdir(workDir, { recursive: true });

  const polyText = readFileSync(args.poly, 'utf8');
  const polygon = {
    url: polyUrl(region.id),
    sha256: createHash('sha256').update(polyText).digest('hex'),
  };
  const started = performance.now();
  const tree = polygonOwnership(parsePoly(polyText));
  console.log(
    `· ${region.id}: owns ${countCoverageTiles(tree, OWNERSHIP_ZOOM)} z${OWNERSHIP_ZOOM} tiles (${((performance.now() - started) / 1000).toFixed(1)} s)`,
  );

  const official: string[] = [];
  const lod2Args: string[] = [];
  for (const value of args.official) {
    const source = value.slice(0, value.indexOf(':'));
    if (!region.official.includes(source)) {
      throw new Error(`${source} is not an official source the catalogue lists for ${region.id}`);
    }
    lod2Args.push(`--lod2=${value}`);
    official.push(source);
  }
  for (const source of region.official) {
    if (!official.includes(source)) {
      console.log(
        `· official data: ${source} covers ${region.id} but none was passed (--official); building from OpenStreetMap alone`,
      );
    }
  }

  const entries: RegionEntry[] = [];
  const parts = await planParts(region, args, tree, workDir);
  for (const part of parts) {
    const encoded = encodeCoverageTree(part.tree, OWNERSHIP_ZOOM);
    const bounds = coverageTreeBounds(part.tree) as [number, number, number, number];
    const ownership: OwnershipFile = {
      region: part.id,
      name: part.part ? `${region.name} (${part.part.index}/${part.part.of})` : region.name,
      extract: extractUrl(region.id),
      polygon,
      part: part.part,
      ownership: { maxZoom: encoded.maxZoom, nodes: encoded.nodes, bits: encoded.bits },
      tiles: countCoverageTiles(part.tree, OWNERSHIP_ZOOM),
      bounds,
    };
    const ownershipPath = join(workDir, `${part.id.replaceAll('/', '_')}.ownership.json`);
    await writeFile(ownershipPath, `${JSON.stringify(ownership)}\n`);

    const refs: { city: ArchiveRef | null; roads: ArchiveRef | null } = { city: null, roads: null };
    let header: { replicationTimestamp?: string; replicationSequence?: number } = {};
    for (const kind of ['city', 'city-roads'] as const) {
      if (args.only && args.only !== (kind === 'city' ? 'city' : 'roads')) continue;
      const key = archiveKey(kind, args.stamp, part.id);
      const path = join(out, key);
      await mkdir(dirname(path), { recursive: true });
      const script = kind === 'city' ? 'build-city-tiles.ts' : 'build-city-roads.ts';
      const t0 = performance.now();
      const peak = await runCompiler(script, [
        `--pbf=${part.pbf}`,
        `--ownership=${ownershipPath}`,
        `--out=${path}`,
        ...(kind === 'city' ? lod2Args : []),
      ]);
      const seconds = Math.round((performance.now() - t0) / 100) / 10;
      const receipt = JSON.parse(await readFile(`${path}.receipt.json`, 'utf8'));
      // The receipt names the archive by its R2 key, not by this machine's path.
      receipt.archive = key;
      receipt.processPeakRssMb = peak;
      await writeFile(`${path}.receipt.json`, `${JSON.stringify(receipt, null, 2)}\n`);
      header = receipt.source ?? header;
      const ref: ArchiveRef = {
        key,
        receipt: `${key}.receipt.json`,
        bytes: (await stat(path)).size,
        sha256: await sha256(path),
        tiles: receipt.tiles,
        seconds,
        peakRssMb: peak,
      };
      if (kind === 'city') refs.city = ref;
      else refs.roads = ref;
    }

    const entry: RegionEntry = {
      id: part.id,
      name: ownership.name,
      region: region.id,
      part: part.part,
      stamp: args.stamp,
      bbox: bounds,
      ownership: ownership.ownership,
      ownedTiles: ownership.tiles,
      source: {
        extract: ownership.extract,
        polygon,
        replicationTimestamp: header.replicationTimestamp,
        replicationSequence: header.replicationSequence,
      },
      official,
      city: refs.city,
      roads: refs.roads,
      builtAt: new Date().toISOString(),
    };
    const entryPath = join(out, 'entries', `${part.id.replaceAll('/', '_')}.json`);
    await mkdir(dirname(entryPath), { recursive: true });
    await writeFile(entryPath, `${JSON.stringify(entry, null, 2)}\n`);
    entries.push(entry);
    if (part.part && !args.keepParts && part.pbf !== args.pbf) await rm(part.pbf, { force: true });
  }
  if (!args.keepParts && existsSync(workDir)) await rm(workDir, { recursive: true, force: true });

  for (const entry of entries) {
    console.log(
      `\n✓ ${entry.id}: ${entry.ownedTiles} owned tiles · city ${entry.city ? `${(entry.city.bytes / 1e6).toFixed(1)} MB, ${entry.city.tiles} tiles, ${entry.city.seconds} s, ${entry.city.peakRssMb} MB peak` : '—'} · roads ${entry.roads ? `${(entry.roads.bytes / 1e6).toFixed(1)} MB, ${entry.roads.tiles} tiles, ${entry.roads.seconds} s, ${entry.roads.peakRssMb} MB peak` : '—'}`,
    );
  }
  return entries;
}

if (import.meta.main) {
  await buildRegion(parseArgs(process.argv.slice(2)));
}

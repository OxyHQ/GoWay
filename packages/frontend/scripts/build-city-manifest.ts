/**
 * Assemble the city-tile MANIFEST: the one document the Worker reads to know
 * which archive answers which tile (`worker/index.js` → `/map/city/*`).
 *
 * ```bash
 * bun run --cwd packages/frontend map:city-manifest \
 *   --entries=<dir of entries/*.json> [--previous=<manifest.json>] --out=<manifest.json>
 * ```
 *
 * A run of the planet workflow rebuilds some regions, not necessarily all, so
 * the new manifest is the PREVIOUS one with this run's regions replaced: a
 * region rebuilt in a different number of parts replaces every part it had.
 * Regions keep their order by id, and that order is the tie-break when two
 * regions own the same tile (their polygons overlap at a border; both
 * archives then hold the same buildings).
 *
 * It also computes what the client asks for (`/map/city/coverage.json`): the
 * union of every region's owned tiles, coarsened to z14 — the zoom the client
 * decides per tile at — so a z14 tile is covered only when all four of its
 * z15 tiles are owned by SOME region.
 *
 * Everything an entry claims is checked before it is merged — its ownership
 * decodes to the tile count it states, its keys are the dated keys the Worker
 * accepts — because the manifest is the one file that, if wrong, mis-serves
 * every region at once. Keys no longer referenced are listed, never deleted:
 * deleting a superseded archive is a separate act, after the new manifest has
 * been live long enough to trust.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CITY_TILE_ZOOM } from '../lib/map/cityTiles';
import {
  coarsenCoverageTree,
  countCoverageTiles,
  type CoverageNode,
  decodeCoverageTree,
  EMPTY,
  encodeCoverageTree,
  unionCoverageTrees,
} from '../worker/coverageTree.js';
import type { ArchiveRef, RegionEntry } from './build-city-region';

/** The manifest's schema version; the Worker refuses any other. */
export const CITY_MANIFEST_SCHEMA = 1;

/** The zoom the client's coverage is decided at (`components/map/engine/city3d/sources.ts`). */
export const CLIENT_COVERAGE_ZOOM = 14;

/** A dated archive key, exactly as the Worker accepts it (`CITY_ARCHIVE_KEY` there). */
export const ARCHIVE_KEY =
  /^(city|city-roads)\/[0-9]{8}(-[a-z0-9]{1,24})?\/[a-z0-9-]+(\/[a-z0-9-]+)*(~[0-9]+of[0-9]+)?\.pmtiles$/;

export interface CityManifest {
  schema: number;
  generatedAt: string;
  tileZoom: number;
  regions: RegionEntry[];
  /** The union of the regions' building ownership at {@link CLIENT_COVERAGE_ZOOM}. */
  coverage: { maxZoom: number; nodes: number; bits: string };
  /** The same for the road archives. */
  roadsCoverage: { maxZoom: number; nodes: number; bits: string };
  attribution: string;
  license: string;
}

function checkRef(entry: RegionEntry, ref: ArchiveRef | null, kind: 'city' | 'city-roads') {
  if (ref === null) return;
  if (!ARCHIVE_KEY.test(ref.key) || !ref.key.startsWith(`${kind}/`)) {
    throw new Error(`${entry.id}: ${kind} key "${ref.key}" is not a dated ${kind} key`);
  }
  if (!ref.key.endsWith(`/${entry.id}.pmtiles`) || !ref.key.includes(`/${entry.stamp}/`)) {
    throw new Error(
      `${entry.id}: ${kind} key "${ref.key}" does not name the entry's region and stamp`,
    );
  }
  if (ref.receipt !== `${ref.key}.receipt.json`) throw new Error(`${entry.id}: receipt key`);
  if (!(ref.bytes > 0) || !/^[0-9a-f]{64}$/.test(ref.sha256)) {
    throw new Error(`${entry.id}: ${kind} archive size or hash missing`);
  }
}

/** Check one entry; returns its decoded ownership. */
export function checkEntry(entry: RegionEntry): CoverageNode {
  if (!/^[a-z0-9-]+(\/[a-z0-9-]+)*(~[0-9]+of[0-9]+)?$/.test(entry.id)) {
    throw new Error(`"${entry.id}" is not a region id`);
  }
  if (entry.ownership?.maxZoom !== CITY_TILE_ZOOM) {
    throw new Error(`${entry.id}: ownership is not at z${CITY_TILE_ZOOM}`);
  }
  const tree = decodeCoverageTree(entry.ownership);
  if (countCoverageTiles(tree, CITY_TILE_ZOOM) !== entry.ownedTiles) {
    throw new Error(`${entry.id}: ownership does not own the ${entry.ownedTiles} tiles it states`);
  }
  if (!entry.city && !entry.roads) throw new Error(`${entry.id}: names no archive`);
  checkRef(entry, entry.city, 'city');
  checkRef(entry, entry.roads, 'city-roads');
  return tree;
}

/** The region a part belongs to (`europe/netherlands~1of2` → `europe/netherlands`). */
const baseRegion = (id: string) => id.replace(/~[0-9]+of[0-9]+$/, '');

/** The new manifest: `previous` with `fresh`'s regions replaced. Pure. */
export function mergeManifest(
  previous: CityManifest | null,
  fresh: readonly RegionEntry[],
  generatedAt: string,
): { manifest: CityManifest; retired: string[] } {
  if (previous && previous.schema !== CITY_MANIFEST_SCHEMA) {
    throw new Error(
      `the previous manifest is schema ${previous.schema}, not ${CITY_MANIFEST_SCHEMA}`,
    );
  }
  const rebuilt = new Set(fresh.map((entry) => baseRegion(entry.id)));
  const ids = new Set<string>();
  for (const entry of fresh) {
    if (ids.has(entry.id)) throw new Error(`${entry.id} appears twice in this run`);
    ids.add(entry.id);
  }
  const kept = (previous?.regions ?? []).filter((entry) => !rebuilt.has(baseRegion(entry.id)));
  const regions = [...kept, ...fresh].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let city: CoverageNode = EMPTY;
  let roads: CoverageNode = EMPTY;
  for (const entry of regions) {
    const tree = checkEntry(entry);
    if (entry.city) city = unionCoverageTrees(city, tree);
    if (entry.roads) roads = unionCoverageTrees(roads, tree);
  }
  const encode = (tree: CoverageNode) => {
    const encoded = encodeCoverageTree(
      coarsenCoverageTree(tree, CLIENT_COVERAGE_ZOOM),
      CLIENT_COVERAGE_ZOOM,
    );
    return { maxZoom: encoded.maxZoom, nodes: encoded.nodes, bits: encoded.bits };
  };

  const live = new Set(
    regions.flatMap((entry) => [entry.city?.key, entry.roads?.key].filter(Boolean) as string[]),
  );
  const retired = (previous?.regions ?? [])
    .flatMap((entry) => [entry.city, entry.roads])
    .filter((ref): ref is ArchiveRef => ref !== null && !live.has(ref.key))
    .flatMap((ref) => [ref.key, ref.receipt]);

  return {
    manifest: {
      schema: CITY_MANIFEST_SCHEMA,
      generatedAt,
      tileZoom: CITY_TILE_ZOOM,
      regions,
      coverage: encode(city),
      roadsCoverage: encode(roads),
      attribution: '© OpenStreetMap contributors',
      license: 'ODbL-1.0 — each archive is a Derivative Database of OpenStreetMap',
    },
    retired,
  };
}

async function main(): Promise<void> {
  const args = Object.fromEntries(
    process.argv.slice(2).map((raw) => {
      const [flag, value] = raw.replace(/^--/, '').split('=', 2);
      return [flag, value ?? 'true'];
    }),
  );
  if (!args.entries || !args.out) throw new Error('--entries=<dir> and --out=<file> are required');
  const previous = args.previous
    ? (JSON.parse(await readFile(args.previous, 'utf8')) as CityManifest)
    : null;
  const files = (await readdir(args.entries)).filter((name) => name.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`${args.entries} holds no entries`);
  const fresh = await Promise.all(
    files.map(
      async (name) => JSON.parse(await readFile(join(args.entries, name), 'utf8')) as RegionEntry,
    ),
  );
  const { manifest, retired } = mergeManifest(
    previous,
    fresh,
    args.generated ?? new Date().toISOString(),
  );
  await writeFile(args.out, `${JSON.stringify(manifest)}\n`);

  const bytes = (kind: 'city' | 'roads') =>
    manifest.regions.reduce((sum, entry) => sum + (entry[kind]?.bytes ?? 0), 0);
  console.log(`${args.out}`);
  console.log(
    `  regions      ${manifest.regions.length} (${fresh.length} from this run, ${manifest.regions.length - fresh.length} carried over)`,
  );
  console.log(
    `  archives     city ${(bytes('city') / 1e9).toFixed(2)} GB · roads ${(bytes('roads') / 1e9).toFixed(2)} GB`,
  );
  console.log(
    `  coverage     ${countCoverageTiles(decodeCoverageTree(manifest.coverage), CLIENT_COVERAGE_ZOOM)} z${CLIENT_COVERAGE_ZOOM} tiles, ${manifest.coverage.bits.length} B encoded`,
  );
  console.log(`  manifest     ${(JSON.stringify(manifest).length / 1e3).toFixed(1)} kB`);
  if (args.retired) {
    await writeFile(args.retired, `${retired.join('\n')}${retired.length ? '\n' : ''}`);
    console.log(`  retired      ${retired.length} keys no longer referenced → ${args.retired}`);
  }
}

if (import.meta.main) {
  await main();
}

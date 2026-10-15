/**
 * Write a raster family's manifest — the satellite imagery's
 * (`docs/MAP_SATELLITE.md` → The manifest) or GoWay's own terrain's
 * (`docs/MAP_TERRAIN_GLOBE.md` → "The archive") — the previous one with a
 * run's set entries merged in. Both are served by `worker/rasterSets.js`.
 *
 * ```bash
 * bun run --cwd packages/frontend map:satellite-manifest --entries=<dir>/entries \
 *   [--previous=<manifest.json>] --out=<dir>/manifest.json
 * bun run --cwd packages/frontend map:terrain-manifest …   # the same, --family=terrain
 * ```
 *
 * - Entries of one set and stamp (a set built across several jobs) are one.
 * - A new stamp of a set is listed BEFORE the set's older stamps, and its
 *   cells are taken out of them, so every cell is served by one stamp; an
 *   older stamp left with no cells is dropped. The cells it gave up are
 *   listed (`retired`), never deleted here.
 * - Sets are listed in catalogue order — the catalogue's order IS the
 *   priority (`scripts/imagery/catalogue.ts`, `scripts/terrain/catalogue.ts`)
 *   — and a set no longer in the catalogue keeps its place after those that are.
 * - The result is read back with the Worker's own parser before it is written.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type CoverageNode,
  coverageCells,
  countCoverageTiles,
  decodeCoverageTree,
  EMPTY,
  encodeCoverageTree,
  intersectCoverageTrees,
  subtractCoverageTrees,
  unionCoverageTrees,
} from '../worker/coverageTree.js';
import { parseSatelliteManifest } from '../worker/satellite.js';
import { parseTerrainManifest } from '../worker/terrain.js';
import type { SetEntry } from './build-satellite-set';
import { checkSet, IMAGERY_SETS } from './imagery/catalogue';
import { cellsTree, parseCellKey } from './imagery/cells';
import { catalogueSet, TERRAIN_SETS } from './terrain/catalogue';

/** What differs between the families: the key prefix, the priority, the checks. */
export interface ManifestFamily {
  name: 'satellite' | 'terrain';
  /** Set ids in catalogue (priority) order. */
  order: readonly string[];
  /** Check a set the catalogue knows (an unknown one is kept as it was). */
  check(id: string): void;
  /** The Worker's own parser. */
  parse(document: unknown): void;
}

export const MANIFEST_FAMILIES: Record<ManifestFamily['name'], ManifestFamily> = {
  satellite: {
    name: 'satellite',
    order: IMAGERY_SETS.map((set) => set.id),
    check(id) {
      const known = IMAGERY_SETS.find((candidate) => candidate.id === id);
      if (known) checkSet(known);
    },
    parse: parseSatelliteManifest,
  },
  terrain: {
    name: 'terrain',
    order: TERRAIN_SETS.map((set) => set.id),
    check(id) {
      if (TERRAIN_SETS.some((candidate) => candidate.id === id)) catalogueSet(id);
    },
    parse: parseTerrainManifest,
  },
};

export interface ManifestSet {
  id: string;
  stamp: string;
  name: string;
  tiers: string[];
  minZoom: number;
  maxZoom: number;
  cellZoom: number;
  sources: string[];
  vintage: string;
  format: 'webp';
  bbox: [number, number, number, number];
  cells: { maxZoom: number; nodes: number; bits: string };
  cellCount: number;
  builtAt: string;
}

export interface SatelliteManifest {
  schema: 1;
  generatedAt: string;
  sets: ManifestSet[];
}

function treeOf(set: ManifestSet): CoverageNode {
  return decodeCoverageTree(set.cells);
}

function withTree(set: Omit<ManifestSet, 'cells' | 'cellCount'>, tree: CoverageNode): ManifestSet {
  return {
    ...set,
    cells: encodeCoverageTree(tree, set.cellZoom),
    cellCount: countCoverageTiles(tree, set.cellZoom),
  };
}

/** Every cell key under a tree, at the set's cell zoom. */
function cellKeysOf(tree: CoverageNode, cellZoom: number): string[] {
  const out: string[] = [];
  for (const [z, x, y] of coverageCells(tree)) {
    const k = 2 ** (cellZoom - z);
    for (let dy = 0; dy < k; dy++)
      for (let dx = 0; dx < k; dx++) out.push(`${cellZoom}/${x * k + dx}/${y * k + dy}`);
  }
  return out;
}

/** One entry per set and stamp: a set built in several jobs, merged. */
export function mergeEntries(entries: readonly SetEntry[]): ManifestSet[] {
  const byKey = new Map<string, SetEntry[]>();
  for (const entry of entries) {
    const key = `${entry.id}@${entry.stamp}`;
    byKey.set(key, [...(byKey.get(key) ?? []), entry]);
  }
  return [...byKey.values()].map((group) => {
    const first = group[0];
    for (const other of group) {
      for (const field of [
        'tiers',
        'minZoom',
        'maxZoom',
        'cellZoom',
        'sources',
        'vintage',
        'format',
      ] as const) {
        if (JSON.stringify(other[field]) !== JSON.stringify(first[field])) {
          throw new Error(`${first.id}@${first.stamp}: parts disagree on ${field}`);
        }
      }
    }
    const cells = [...new Set(group.flatMap((entry) => entry.cellKeys))].map(parseCellKey);
    const tree = cellsTree(cells, first.cellZoom);
    return withTree(
      {
        id: first.id,
        stamp: first.stamp,
        name: first.name,
        tiers: first.tiers,
        minZoom: first.minZoom,
        maxZoom: first.maxZoom,
        cellZoom: first.cellZoom,
        sources: first.sources,
        vintage: first.vintage,
        format: first.format,
        bbox: [
          Math.min(...group.map((e) => e.bbox[0])),
          Math.min(...group.map((e) => e.bbox[1])),
          Math.max(...group.map((e) => e.bbox[2])),
          Math.max(...group.map((e) => e.bbox[3])),
        ],
        builtAt:
          group
            .map((e) => e.builtAt)
            .sort()
            .at(-1) ?? first.builtAt,
      },
      tree,
    );
  });
}

/**
 * The previous manifest with `fresh` merged in. Returns the manifest and the
 * archive keys it no longer names (a rebuilt cell's older stamp).
 */
export function mergeManifest(
  previous: SatelliteManifest | null,
  fresh: readonly ManifestSet[],
  generatedAt: string,
  family: ManifestFamily = MANIFEST_FAMILIES.satellite,
): { manifest: SatelliteManifest; retired: string[] } {
  const retired: string[] = [];
  let sets: ManifestSet[] = previous ? [...previous.sets] : [];
  for (const entry of fresh) {
    const same = sets.find((set) => set.id === entry.id && set.stamp === entry.stamp);
    let merged = entry;
    if (same) {
      // A re-run of the same stamp (a failed job retried): the cells add up.
      merged = withTree(entry, unionCoverageTrees(treeOf(same), treeOf(entry)));
      sets = sets.filter((set) => set !== same);
    }
    const tree = treeOf(merged);
    sets = sets.flatMap((set) => {
      if (set.id !== merged.id) return [set];
      if (set.cellZoom !== merged.cellZoom) {
        throw new Error(
          `${set.id}: stamp ${set.stamp} has cell zoom ${set.cellZoom}, ${merged.stamp} ${merged.cellZoom}; rebuild every cell under a new set id`,
        );
      }
      const old = treeOf(set);
      const taken = intersectCoverageTrees(old, tree);
      for (const key of cellKeysOf(taken, set.cellZoom)) {
        retired.push(`${family.name}/${set.id}/${set.stamp}/${key}.pmtiles`);
        retired.push(`${family.name}/${set.id}/${set.stamp}/${key}.pmtiles.receipt.json`);
      }
      const left = subtractCoverageTrees(old, tree);
      return left === EMPTY ? [] : [withTree(set, left)];
    });
    sets.push(merged);
  }

  // Catalogue order, then newer stamps first within a set; unknown sets last, as they were.
  const rank = (id: string) => {
    const index = family.order.indexOf(id);
    return index === -1 ? family.order.length : index;
  };
  const before = new Map(sets.map((set, i) => [set, i]));
  sets.sort(
    (a, b) =>
      rank(a.id) - rank(b.id) ||
      (a.id === b.id
        ? b.stamp.localeCompare(a.stamp)
        : (before.get(a) ?? 0) - (before.get(b) ?? 0)),
  );
  for (const set of sets) family.check(set.id);
  const manifest: SatelliteManifest = { schema: 1, generatedAt, sets };
  family.parse(JSON.parse(JSON.stringify(manifest)));
  return { manifest, retired };
}

async function main(): Promise<void> {
  const value = (name: string) =>
    process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const dir = value('entries');
  const out = value('out');
  const familyName = (value('family') ?? 'satellite') as ManifestFamily['name'];
  const family = MANIFEST_FAMILIES[familyName];
  if (!family) throw new Error(`--family=${familyName}: satellite | terrain`);
  if (!dir || !out)
    throw new Error('usage: --entries=<dir> [--previous=<manifest.json>] --out=<file>');
  const previousPath = value('previous');
  const previous = previousPath
    ? (JSON.parse(await readFile(previousPath, 'utf8')) as SatelliteManifest)
    : null;
  if (previous) family.parse(previous);
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  const entries = await Promise.all(
    files.map(async (name) => JSON.parse(await readFile(join(dir, name), 'utf8')) as SetEntry),
  );
  const { manifest, retired } = mergeManifest(
    previous,
    mergeEntries(entries),
    new Date().toISOString(),
    family,
  );
  await writeFile(out, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(`${out}.retired.txt`, retired.length ? `${retired.join('\n')}\n` : '');
  for (const set of manifest.sets) {
    console.log(
      `${set.id}@${set.stamp}: ${set.cellCount} cells at z${set.cellZoom}, z${set.minZoom}–${set.maxZoom} (${set.tiers.join(', ')})`,
    );
  }
  console.log(`${out}: ${manifest.sets.length} set entries; ${retired.length / 2} cells retired`);
}

if (import.meta.main) {
  await main();
}

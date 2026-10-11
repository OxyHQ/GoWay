/**
 * What a REGIONAL city archive carries beyond the tiles: which region it is,
 * which tiles it owns, and where to look first when checking it.
 *
 * The two compilers (`build-city-tiles.ts`, `build-city-roads.ts`) read an
 * ownership file written by the region builder (`build-city-region.ts`) with
 * `--ownership=<file>`, keep only the owned tiles, and write the same facts
 * into the archive's metadata and receipt — so an archive found on its own,
 * without the manifest that names it, still says what it covers and what OSM
 * snapshot it came from (the ODbL receipt), and the manifest builder can
 * check the two agree.
 */
import { readFileSync } from 'node:fs';

import {
  type CoverageNode,
  countCoverageTiles,
  coverageTreeBounds,
  decodeCoverageTree,
} from '../../worker/coverageTree.js';
import { OWNERSHIP_ZOOM, ownsTile, type TileRect } from './ownership';

/** Metadata keys a regional archive adds (beside `goway:coverage`, `goway:kind`…). */
export const REGION_METADATA_KEY = 'goway:region';
export const OWNERSHIP_METADATA_KEY = 'goway:ownership';
/** The tile the verifier opens first: the densest one, so it is never open sea. */
export const PROBE_METADATA_KEY = 'goway:probe';

/** The ownership file the region builder writes and the compilers read. */
export interface OwnershipFile {
  /** The region's id: its Geofabrik path, e.g. `europe/portugal`; a part adds `~1of2`. */
  region: string;
  /** Geofabrik's name for it. */
  name: string;
  /** The extract it is compiled from. */
  extract: string;
  /** The polygon the ownership was computed from, and its hash. */
  polygon: { url: string; sha256: string };
  /** For a part of a split region: which part, and its tile rectangle. */
  part: { index: number; of: number; rect: TileRect } | null;
  /** The owned tiles (`worker/coverageTree.js` encoding) at {@link OWNERSHIP_ZOOM}. */
  ownership: { maxZoom: number; nodes: number; bits: string };
  /** How many z15 tiles that is. */
  tiles: number;
  /** Their bounding box, `[west, south, east, north]`. */
  bounds: [number, number, number, number];
}

export interface LoadedOwnership {
  file: OwnershipFile;
  tree: CoverageNode;
  keepTile: (x: number, y: number) => boolean;
}

/** Read and check an ownership file: its tree must decode and match its own counts. */
export function loadOwnership(path: string): LoadedOwnership {
  const file = JSON.parse(readFileSync(path, 'utf8')) as OwnershipFile;
  if (typeof file.region !== 'string' || !/^[a-z0-9][a-z0-9/_~-]*$/.test(file.region)) {
    throw new Error(`${path}: region "${String(file.region)}" is not a region id`);
  }
  if (file.ownership?.maxZoom !== OWNERSHIP_ZOOM) {
    throw new Error(`${path}: ownership is not at z${OWNERSHIP_ZOOM}`);
  }
  const tree = decodeCoverageTree(file.ownership);
  const tiles = countCoverageTiles(tree, OWNERSHIP_ZOOM);
  if (tiles !== file.tiles) {
    throw new Error(`${path}: the tree owns ${tiles} tiles, the file says ${file.tiles}`);
  }
  if (tiles === 0) throw new Error(`${path}: owns no tile`);
  const bounds = coverageTreeBounds(tree);
  if (!bounds || bounds.some((v, i) => Math.abs(v - file.bounds[i]) > 1e-9)) {
    throw new Error(`${path}: bounds disagree with the tree`);
  }
  return { file, tree, keepTile: ownsTile(tree) };
}

/** The metadata entries a regional archive adds. */
export function regionMetadata(ownership: OwnershipFile): Record<string, unknown> {
  return {
    [REGION_METADATA_KEY]: {
      id: ownership.region,
      name: ownership.name,
      extract: ownership.extract,
      polygon: ownership.polygon,
      part: ownership.part,
    },
    [OWNERSHIP_METADATA_KEY]: ownership.ownership,
  };
}

/** The densest tile of a build, `z/x/y`, by stored bytes. */
export function densestTile(
  tiles: readonly { z: number; x: number; y: number; bytes: Uint8Array }[],
) {
  let best: { z: number; x: number; y: number; bytes: Uint8Array } | null = null;
  for (const tile of tiles) if (!best || tile.bytes.length > best.bytes.length) best = tile;
  return best ? `${best.z}/${best.x}/${best.y}` : null;
}

/** Refuse to write an archive holding a tile its region does not own. */
export function assertOwned(
  tiles: readonly { x: number; y: number }[],
  keepTile: ((x: number, y: number) => boolean) | undefined,
): void {
  if (!keepTile) return;
  const stray = tiles.find((tile) => !keepTile(tile.x, tile.y));
  if (stray) throw new Error(`tile ${stray.x}/${stray.y} is not owned by this region`);
}

/** Where verification starts: the probe tile in the metadata, else the archive's centre. */
export function probeTile(
  metadata: Record<string, unknown>,
  bounds: number[],
  z: number,
): { x: number; y: number } {
  const probe = metadata[PROBE_METADATA_KEY];
  if (typeof probe === 'string') {
    const [pz, px, py] = probe.split('/').map(Number);
    if (pz === z && Number.isInteger(px) && Number.isInteger(py)) return { x: px, y: py };
  }
  const [w, s, e, n] = bounds;
  const span = 2 ** z;
  const lat = (((s + n) / 2) * Math.PI) / 180;
  return {
    x: Math.floor((((w + e) / 2 + 180) / 360) * span),
    y: Math.floor(((1 - Math.log(Math.tan(lat) + 1 / Math.cos(lat)) / Math.PI) / 2) * span),
  };
}

/** The ownership an archive's metadata declares, as `keepTile`; `null` when it declares none. */
export function ownershipOf(
  metadata: Record<string, unknown>,
): ((x: number, y: number) => boolean) | null {
  const encoded = metadata[OWNERSHIP_METADATA_KEY] as { maxZoom: number; bits: string } | undefined;
  if (!encoded) return null;
  return ownsTile(decodeCoverageTree(encoded), encoded.maxZoom);
}

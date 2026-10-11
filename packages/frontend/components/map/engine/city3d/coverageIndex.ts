/**
 * Whether a tile lies wholly inside the city tiles' coverage, for either form
 * of the coverage document (`lib/map/cityTiles.ts` → `CITY_COVERAGE_PATH`):
 * development's compile boxes, or production's owned-tile set — the union of
 * every published region's tiles (`worker/city.js`).
 *
 * The owned-tile set arrives encoded and is decoded here, once per document,
 * because this module is the engine's alone: the coverage-tree decoder must
 * not land in a module both lazy chunks share, which Expo would hoist into
 * the first-paint bundle (`components/engine3d/lazyChunk.ts`).
 */
import {
  type CityCoverageArea,
  type CityCoverageBox,
  type CityCoverageTiles,
  tileCovered,
} from '@/lib/map/cityTiles';
import { type CoverageNode, coverageAt, decodeCoverageTree, FULL } from '@/worker/coverageTree.js';

const decoded = new Map<string, CoverageNode | null>();

/** The decoded tree for an encoded one; `null` (covers nothing) if it does not decode. */
function treeOf(tiles: CityCoverageTiles): CoverageNode | null {
  let tree = decoded.get(tiles.bits);
  if (tree === undefined) {
    try {
      tree = decodeCoverageTree(tiles);
    } catch {
      // A broken document covers nothing: the basemap draws, never a flat map.
      tree = null;
    }
    // Documents are few (one per page load), so this never needs evicting.
    decoded.set(tiles.bits, tree);
  }
  return tree;
}

const isBox = (area: CityCoverageArea): area is CityCoverageBox => Array.isArray(area);

/** Whether tile (z, x, y) is wholly covered by some area. */
export function coverageCovers(
  tile: { z: number; x: number; y: number },
  areas: readonly CityCoverageArea[],
): boolean {
  const boxes: CityCoverageBox[] = [];
  for (const area of areas) {
    if (isBox(area)) {
      boxes.push(area);
      continue;
    }
    const tree = treeOf(area);
    if (tree !== null && coverageAt(tree, area.maxZoom, tile.z, tile.x, tile.y) === FULL)
      return true;
  }
  return boxes.length > 0 && tileCovered(tile, boxes);
}

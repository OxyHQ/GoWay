/**
 * The trees of one tile, as the mesh worker gathers them: the trees
 * OpenStreetMap records (GoWay city tiles), the optional styling fill of
 * mapped woods (`trees.ts`), and none standing inside a building.
 *
 * Out of `meshWorker.ts` so it can be tested with its fetch injected
 * (`__tests__/city3dWorkerTrees.test.ts`). Two rules it exists to keep:
 *
 *  - **A tree never stands in a building.** Every tree — mapped or fill — whose
 *    point falls inside a footprint of the tile's own buildings is dropped
 *    (owner report: trees on Eixample rooftops). A `natural=tree` inside a
 *    building outline is a mapping or tiling artefact (a courtyard tree is in
 *    a HOLE, so it stays); a fill tree there is simply wrong. Buildings of a
 *    neighbouring tile that spill over the edge are not consulted.
 *  - **A failed fetch is not an answer.** The fill of a city tile reads the
 *    basemap tile under it; when that fetch FAILS (not a 204/404, which is
 *    "nothing there"), the trees come back marked incomplete, so the engine
 *    draws what it has and asks again later — the first version cached the
 *    fill-less result as final (PR #126 review).
 */
import type { Point2 } from './mesher';
import type { MeshWorkerRequest } from './protocol';
import { tileSizeMetres } from './tileMath';
import { decodeMappedTrees, decodeTreeSources } from './treeSources';
import { mappedTreePoints, standTrees, type TreePoint } from './trees';

type MeshRequest = Extract<MeshWorkerRequest, { type: 'mesh' }>;

/** A footprint as decoded: rings in tile units, even-odd. */
export interface Footprint {
  rings: readonly (readonly Point2[])[];
}

/** Bytes of a tile, `null` for "no such tile" (204/404); throws when the fetch fails. */
export type FetchBytes = (url: string) => Promise<ArrayBuffer | null>;

/** Even-odd point-in-polygon over every ring of one footprint. */
function inside(rings: Footprint['rings'], x: number, y: number): boolean {
  let hit = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
    }
  }
  return hit;
}

/**
 * The trees not standing inside any footprint. Trees are in metres from the
 * tile's north-west corner (y south); footprints in tile units of
 * `metresPerUnit`. Footprints are bucketed by a 64-unit grid of their boxes,
 * so each tree tests only the few near it.
 */
export function dropTreesInBuildings(
  trees: readonly TreePoint[],
  footprints: readonly Footprint[],
  metresPerUnit: number,
): TreePoint[] {
  if (trees.length === 0 || footprints.length === 0) return trees.slice();
  const CELL = 64;
  const grid = new Map<number, Footprint[]>();
  const key = (i: number, j: number) => i * 100_003 + j;
  for (const footprint of footprints) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const ring of footprint.rings) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (!(minX <= maxX)) continue;
    for (let i = Math.floor(minX / CELL); i <= Math.floor(maxX / CELL); i++) {
      for (let j = Math.floor(minY / CELL); j <= Math.floor(maxY / CELL); j++) {
        const cell = grid.get(key(i, j));
        if (cell) cell.push(footprint);
        else grid.set(key(i, j), [footprint]);
      }
    }
  }
  return trees.filter((tree) => {
    const x = tree.x / metresPerUnit;
    const y = tree.y / metresPerUnit;
    const near = grid.get(key(Math.floor(x / CELL), Math.floor(y / CELL)));
    return !near?.some((footprint) => inside(footprint.rings, x, y));
  });
}

/**
 * A tile's trees: mapped ones from a city tile, the fill when asked for (from
 * this tile's own landcover, or the basemap tile under a city tile), none in
 * a building of the tile. `complete: false` when the basemap tile under a city
 * tile could not be fetched.
 */
export async function treesFor(
  request: MeshRequest,
  bytes: ArrayBuffer,
  size: number,
  footprints: { list: readonly Footprint[]; extent: number },
  fetchBytes: FetchBytes,
): Promise<{ points: TreePoint[]; complete: boolean }> {
  const layers = request.trees;
  if (!layers) return { points: [], complete: true };
  const metresPerUnit = size / footprints.extent;
  const finish = (points: TreePoint[], complete: boolean) => ({
    points: dropTreesInBuildings(points, footprints.list, metresPerUnit),
    complete,
  });
  const fill = request.treeFill;
  if (!fill) {
    // An OpenMapTiles tile: no mapped trees, only the fill (when asked).
    if (!request.treeFillWoods) return { points: [], complete: true };
    const sources = decodeTreeSources(bytes, layers);
    return finish(sources ? standTrees(sources, request.tile, size) : [], true);
  }
  const mapped = decodeMappedTrees(bytes, fill.mappedLayer);
  const points = mappedTreePoints(mapped.trees, mapped.extent, size);
  if (!request.treeFillWoods) return finish(points, true);
  let parentBytes: ArrayBuffer | null;
  try {
    parentBytes = await fetchBytes(fill.url);
  } catch {
    return finish(points, false);
  }
  const sources = parentBytes ? decodeTreeSources(parentBytes, layers) : null;
  if (!sources) return finish(points, true);
  // This tile's quarter of the parent, in the parent's tile units.
  const scale = 2 ** (request.tile.z - fill.tile.z);
  const qx = request.tile.x - fill.tile.x * scale;
  const qy = request.tile.y - fill.tile.y * scale;
  const span = sources.extent / scale;
  const window = { x0: qx * span, y0: qy * span, x1: (qx + 1) * span, y1: (qy + 1) * span };
  const toParent = sources.extent / scale / mapped.extent;
  const parentSize = tileSizeMetres(fill.tile);
  const filled = standTrees(sources, fill.tile, parentSize, {
    window,
    mapped: mapped.trees.map(
      (t): Point2 => [window.x0 + t.x * toParent, window.y0 + t.y * toParent],
    ),
  });
  // Back into this tile's frame (metres from its north-west corner).
  const offset = parentSize / scale;
  for (const tree of filled) {
    points.push({ ...tree, x: tree.x - qx * offset, y: tree.y - qy * offset });
  }
  return finish(points, true);
}

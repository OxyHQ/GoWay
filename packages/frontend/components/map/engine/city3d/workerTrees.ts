/**
 * The trees of one tile, as the mesh worker gathers them: the trees
 * OpenStreetMap records (GoWay city tiles), each set in what surrounds it
 * (`treeContext.ts`), the optional styling fill of mapped woods (`trees.ts`),
 * and none standing inside a building.
 *
 * Out of `meshWorker.ts` so it can be tested with its fetch injected
 * (`__tests__/city3dWorkerTrees.test.ts`). The rules it exists to keep:
 *
 *  - **A tree never stands in a building.** Every tree — mapped or fill — whose
 *    point falls inside a footprint of the tile's own buildings is dropped
 *    (owner report: trees on Eixample rooftops). A `natural=tree` inside a
 *    building outline is a mapping or tiling artefact (a courtyard tree is in
 *    a HOLE, so it stays); a fill tree there is simply wrong. Buildings of a
 *    neighbouring tile that spill over the edge are not consulted.
 *  - **A tree never stands on a carriageway, and a street tree looks like
 *    one** (owner report: crowns closing over Carrer de Mallorca). The road
 *    archive's tile at the same address and the basemap tile under it say
 *    where the carriageways, sidewalks, parks, woods and urban landuse are.
 *  - **A failed fetch is not an answer.** When a tile the context or the fill
 *    reads FAILS (not a 204/404, which is "nothing there"), the trees come
 *    back marked incomplete, so the engine draws what it has and asks again
 *    later — the first version cached the fill-less result as final (PR #126
 *    review).
 */
import { CITY_TILE_EXTENT } from '@/lib/map/cityTiles';
import { latitudeFromMercatorY, longitudeFromMercatorX } from '@/lib/map/geo';

import { crossSection, paintRulesAt } from '../cityStreets/lanes';
import { drivingSideAt } from '../roads/drivingSide';
import { decodeRoadTile } from '../roads/roadTiles';
import type { Point2 } from './mesher';
import type { MeshWorkerRequest } from './protocol';
import {
  type Carriageway,
  settleTrees,
  type TreeContext,
  type TreeSettingCounts,
} from './treeContext';
import { type TileId, tileSizeMetres } from './tileMath';
import {
  decodeMappedTrees,
  decodeTreeSources,
  openTile,
  treeAreasOf,
  treeSourcesOf,
} from './treeSources';
import { type AreaRings, mappedTreePoints, standTrees, type TreePoint } from './trees';

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

/** Areas of the OpenMapTiles parent that reach into this tile's window, in this tile's units. */
function areasInWindow(
  areas: readonly AreaRings[],
  window: { x0: number; y0: number; x1: number; y1: number },
  toParent: number,
): AreaRings[] {
  const out: AreaRings[] = [];
  for (const rings of areas) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const ring of rings) {
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (y < y0) y0 = y;
        if (x > x1) x1 = x;
        if (y > y1) y1 = y;
      }
    }
    if (x1 < window.x0 || x0 > window.x1 || y1 < window.y0 || y0 > window.y1) continue;
    out.push(
      rings.map((ring) =>
        ring.map(([x, y]): Point2 => [(x - window.x0) / toParent, (y - window.y0) / toParent]),
      ),
    );
  }
  return out;
}

/**
 * The carriageways (as wide as the street detail draws them) and mapped
 * sidewalks of a road-archive tile, in the city tile's units of `extent`.
 */
export function roadContext(
  bytes: ArrayBuffer,
  tile: TileId,
  extent: number,
): Pick<TreeContext, 'carriageways' | 'sidewalks'> {
  const decoded = decodeRoadTile(bytes, tile);
  const scale = extent / CITY_TILE_EXTENT;
  const ox = tile.x * CITY_TILE_EXTENT;
  const oy = tile.y * CITY_TILE_EXTENT;
  const n = 2 ** tile.z;
  const lng = longitudeFromMercatorX((tile.x + 0.5) / n);
  const lat = latitudeFromMercatorY((tile.y + 0.5) / n);
  const rules = paintRulesAt(lng, lat, drivingSideAt(lng, lat));
  const local = (points: readonly [number, number][]) =>
    points.map(([x, y]): Point2 => [(x - ox) * scale, (y - oy) * scale]);
  const carriageways: Carriageway[] = [];
  const sidewalks: Point2[][] = [];
  for (const piece of decoded.pieces) {
    // Not at ground level, or a shared surface with no carriageway.
    if (piece.tunnel || piece.bridge) continue;
    if (piece.car) {
      if (piece.highway === 'living_street' || piece.highway === 'pedestrian') continue;
      carriageways.push({
        points: local(piece.points),
        halfWidthM: crossSection(piece, rules).width / 2,
      });
    } else if (piece.footway === 'sidewalk') {
      sidewalks.push(local(piece.points));
    }
  }
  return { carriageways, sidewalks };
}

/** A fetch that failed (not a 204/404, which is an answer). */
const FAILED = Symbol('failed');

/**
 * A tile's trees: mapped ones from a city tile, each set in its context
 * (`treeContext.ts`: street or nature, never on a carriageway), the fill when
 * asked for (from this tile's own landcover, or the basemap tile under a city
 * tile), none in a building of the tile. `complete: false` when a tile the
 * context or the fill reads could not be fetched: what is known is drawn,
 * and the engine asks again.
 */
export async function treesFor(
  request: MeshRequest,
  bytes: ArrayBuffer,
  size: number,
  footprints: { list: readonly Footprint[]; extent: number },
  fetchBytes: FetchBytes,
): Promise<{ points: TreePoint[]; complete: boolean; settings?: TreeSettingCounts }> {
  const layers = request.trees;
  if (!layers) return { points: [], complete: true };
  const metresPerUnit = size / footprints.extent;
  const finish = (points: TreePoint[], complete: boolean, settings?: TreeSettingCounts) => ({
    points: dropTreesInBuildings(points, footprints.list, metresPerUnit),
    complete,
    ...(settings ? { settings } : {}),
  });
  const context = request.treeContext;
  if (!context) {
    // An OpenMapTiles tile: no mapped trees, only the fill (when asked).
    if (!request.treeFillWoods) return { points: [], complete: true };
    const sources = decodeTreeSources(bytes, layers);
    return finish(sources ? standTrees(sources, request.tile, size) : [], true);
  }
  const mapped = decodeMappedTrees(bytes, context.mappedLayer);
  if (mapped.trees.length === 0 && !request.treeFillWoods) return { points: [], complete: true };

  const fetchOr = async (url: string | undefined) => {
    if (!url) return null;
    try {
      return await fetchBytes(url);
    } catch {
      return FAILED;
    }
  };
  const [parentBytes, roadBytes] = await Promise.all([
    fetchOr(context.url),
    mapped.trees.length > 0 ? fetchOr(context.roadsUrl) : null,
  ]);
  const complete = parentBytes !== FAILED && roadBytes !== FAILED;

  // This tile's quarter of the parent, in the parent's tile units.
  const parent = parentBytes && parentBytes !== FAILED ? openTile(parentBytes) : null;
  const areas = parent ? treeAreasOf(parent, layers) : null;
  const scale = 2 ** (request.tile.z - context.tile.z);
  const qx = request.tile.x - context.tile.x * scale;
  const qy = request.tile.y - context.tile.y * scale;
  const span = (areas?.extent ?? 4096) / scale;
  const window = { x0: qx * span, y0: qy * span, x1: (qx + 1) * span, y1: (qy + 1) * span };
  const toParent = span / mapped.extent;

  const settled = settleTrees(
    mapped.trees,
    {
      ...(roadBytes && roadBytes !== FAILED
        ? roadContext(roadBytes, request.tile, mapped.extent)
        : { carriageways: [], sidewalks: [] }),
      nature: areas ? areasInWindow([...areas.wood, ...areas.park], window, toParent) : [],
      urban: areas ? areasInWindow(areas.urban, window, toParent) : [],
    },
    mapped.extent === 0 ? 1 : size / mapped.extent,
  );
  const points = mappedTreePoints(settled.trees, mapped.extent, size);
  const sources =
    request.treeFillWoods && parent && areas ? treeSourcesOf(parent, layers, areas) : null;
  if (!sources) return finish(points, complete, settled.counts);
  const parentSize = tileSizeMetres(context.tile);
  const filled = standTrees(sources, context.tile, parentSize, {
    window,
    mapped: settled.trees.map(
      (t): Point2 => [window.x0 + t.x * toParent, window.y0 + t.y * toParent],
    ),
  });
  // Back into this tile's frame (metres from its north-west corner).
  const offset = parentSize / scale;
  for (const tree of filled) {
    points.push({ ...tree, x: tree.x - qx * offset, y: tree.y - qy * offset });
  }
  return finish(points, complete, settled.counts);
}

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
  TREE_CONTEXT,
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
type TreesRequest = Extract<MeshWorkerRequest, { type: 'trees' }>;

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

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(points: readonly Point2[]): Box {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
}

/**
 * A road-archive tile's ground-level carriageways (as wide as the street
 * detail draws them, with their recorded parking) and mapped sidewalks, in
 * GLOBAL tile units (`x + 4096 · tileX`, `lib/map/cityRoads.ts`), so one
 * decode serves its own city tile and its neighbours (`roadContext`).
 */
export interface RoadLines {
  carriageways: readonly (Carriageway & { box: Box })[];
  sidewalks: readonly { points: readonly Point2[]; box: Box }[];
}

/** Decode a road tile's {@link RoadLines}. */
export function decodeRoadLines(bytes: ArrayBuffer, tile: TileId): RoadLines {
  const decoded = decodeRoadTile(bytes, tile);
  const n = 2 ** tile.z;
  const lng = longitudeFromMercatorX((tile.x + 0.5) / n);
  const lat = latitudeFromMercatorY((tile.y + 0.5) / n);
  const rules = paintRulesAt(lng, lat, drivingSideAt(lng, lat));
  const carriageways: (Carriageway & { box: Box })[] = [];
  const sidewalks: { points: Point2[]; box: Box }[] = [];
  for (const piece of decoded.pieces) {
    // Not at ground level, or a shared surface with no carriageway.
    if (piece.tunnel || piece.bridge) continue;
    if (piece.car) {
      if (piece.highway === 'living_street' || piece.highway === 'pedestrian') continue;
      const section = crossSection(piece, rules);
      const first = section.bands[0];
      const last = section.bands.at(-1);
      const left = first?.kind === 'parking' ? first.left - first.right : 0;
      const right = last?.kind === 'parking' && last !== first ? last.left - last.right : 0;
      carriageways.push({
        points: piece.points,
        halfWidthM: section.width / 2,
        ...(left > 0 || right > 0 ? { parkingM: { left, right } } : {}),
        box: boxOf(piece.points),
      });
    } else if (piece.footway === 'sidewalk') {
      sidewalks.push({ points: piece.points, box: boxOf(piece.points) });
    }
  }
  return { carriageways, sidewalks };
}

/**
 * The carriageways and mapped sidewalks of `roads` (this tile's road tile and
 * any neighbours') that reach this tile — a carriageway within its half width
 * plus `nearCarriagewayM` of it, a sidewalk within `nearSidewalkM` — in the
 * city tile's units of `extent`.
 */
export function roadContext(
  roads: readonly RoadLines[],
  tile: TileId,
  extent: number,
): Pick<TreeContext, 'carriageways' | 'sidewalks'> {
  const scale = extent / CITY_TILE_EXTENT;
  const ox = tile.x * CITY_TILE_EXTENT;
  const oy = tile.y * CITY_TILE_EXTENT;
  const unitsPerM = CITY_TILE_EXTENT / tileSizeMetres(tile);
  const reaches = (box: Box, metres: number) => {
    const pad = metres * unitsPerM;
    return (
      box.x1 + pad >= ox &&
      box.x0 - pad <= ox + CITY_TILE_EXTENT &&
      box.y1 + pad >= oy &&
      box.y0 - pad <= oy + CITY_TILE_EXTENT
    );
  };
  const local = (points: readonly Point2[]) =>
    points.map(([x, y]): Point2 => [(x - ox) * scale, (y - oy) * scale]);
  const carriageways: Carriageway[] = [];
  const sidewalks: Point2[][] = [];
  for (const lines of roads) {
    for (const c of lines.carriageways) {
      if (!reaches(c.box, c.halfWidthM + TREE_CONTEXT.nearCarriagewayM)) continue;
      carriageways.push({
        points: local(c.points),
        halfWidthM: c.halfWidthM,
        ...(c.parkingM ? { parkingM: c.parkingM } : {}),
      });
    }
    for (const s of lines.sidewalks) {
      if (reaches(s.box, TREE_CONTEXT.nearSidewalkM)) sidewalks.push(local(s.points));
    }
  }
  return { carriageways, sidewalks };
}

/** A road tile's lines; `null` for "no such tile"; throws when the fetch fails. */
export type FetchRoads = (url: string, tile: TileId) => Promise<RoadLines | null>;

/** The mapped trees of a city tile (`treeSources.ts` → `decodeMappedTrees`). */
export type MappedTreeTile = ReturnType<typeof decodeMappedTrees>;

/** The tiles a city tile's trees are read against, and the road tiles' addresses. */
export interface TreeTiles {
  /** The basemap tile under it (areas; the fill's landcover). */
  parent?: string;
  /** Its own road tile, then the neighbours' its trees come near. */
  roads: { url: string; tile: TileId }[];
}

/**
 * What `treesFor` will read for a city tile: nothing without mapped trees
 * (and no fill); its road tile and, for each edge (or corner) a mapped tree
 * stands within {@link TREE_CONTEXT}`.edgeReachM` of, the neighbour's — road
 * pieces are cut at the edge with no buffer (`lib/map/cityRoads.ts`), so a
 * street just across it is only in the neighbour's tile. The mesh service
 * asks for these as soon as the tile's own bytes are in (`meshService.ts`).
 */
export function treeTilesFor(request: MeshRequest | TreesRequest, mapped: MappedTreeTile): TreeTiles {
  const context = request.treeContext;
  if (!request.trees || !context) return { roads: [] };
  const any = mapped.trees.length > 0;
  if (!any && !request.treeFillWoods) return { roads: [] };
  const parent = context.url;
  if (!any || !context.roadsUrl) return { parent, roads: [] };
  const roads = [{ url: context.roadsUrl, tile: request.tile }];
  const reach = (TREE_CONTEXT.edgeReachM / tileSizeMetres(request.tile)) * mapped.extent;
  let near = 0;
  const bit = (dx: number, dy: number) => 1 << ((dy + 1) * 3 + dx + 1);
  for (const { x, y } of mapped.trees) {
    const dx = x < reach ? -1 : x > mapped.extent - reach ? 1 : 0;
    const dy = y < reach ? -1 : y > mapped.extent - reach ? 1 : 0;
    if (dx !== 0) near |= bit(dx, 0);
    if (dy !== 0) near |= bit(0, dy);
    if (dx !== 0 && dy !== 0) near |= bit(dx, dy);
  }
  for (const neighbour of context.roadNeighbours ?? []) {
    const dx = neighbour.tile.x - request.tile.x;
    const dy = neighbour.tile.y - request.tile.y;
    if (Math.abs(dx) <= 1 && Math.abs(dy) <= 1 && near & bit(dx, dy)) roads.push(neighbour);
  }
  return { parent, roads };
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
  request: MeshRequest | TreesRequest,
  bytes: ArrayBuffer,
  size: number,
  footprints: { list: readonly Footprint[]; extent: number },
  fetchBytes: FetchBytes,
  options: {
    /** Road tiles, decoded (the service keeps the decodes); absent: decoded from `fetchBytes`. */
    fetchRoads?: FetchRoads;
    /** This tile's mapped trees, when the caller has already decoded them. */
    mapped?: MappedTreeTile;
  } = {},
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
  const mapped = options.mapped ?? decodeMappedTrees(bytes, context.mappedLayer);
  if (mapped.trees.length === 0 && !request.treeFillWoods) return { points: [], complete: true };

  const fetchRoads: FetchRoads =
    options.fetchRoads ??
    (async (url, tile) => {
      const roadBytes = await fetchBytes(url);
      return roadBytes ? decodeRoadLines(roadBytes, tile) : null;
    });
  const tiles = treeTilesFor(request, mapped);
  const fetchOr = async <T>(read: () => Promise<T | null>) => {
    try {
      return await read();
    } catch {
      return FAILED;
    }
  };
  const { parent: parentUrl } = tiles;
  const [parentBytes, roadTiles] = await Promise.all([
    parentUrl ? fetchOr(() => fetchBytes(parentUrl)) : null,
    Promise.all(tiles.roads.map((road) => fetchOr(() => fetchRoads(road.url, road.tile)))),
  ]);
  const roads = roadTiles.filter((lines): lines is RoadLines => lines !== null && lines !== FAILED);
  const complete = parentBytes !== FAILED && !roadTiles.includes(FAILED);

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
      ...roadContext(roads, request.tile, mapped.extent),
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

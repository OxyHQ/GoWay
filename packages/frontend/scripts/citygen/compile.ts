/**
 * OSM extract → per-building city tiles, in memory.
 *
 * ## Passes
 *
 *  1. **Ways and relations.** Every blob is inflated once; ways tagged
 *     `building`/`building:part` are kept with their node refs and the tags
 *     the tile needs, and `type=multipolygon` relations tagged the same way
 *     are kept with their way members and roles. What each blob holds is
 *     recorded so the later passes inflate only what they read.
 *  2. **Member ways.** A multipolygon's member ways are usually untagged, so
 *     the way blobs are read again for the refs of the ones pass 1 skipped.
 *  3. **Nodes.** The needed node ids, sorted, and every node blob read once:
 *     each node is looked up by binary search and its position kept.
 *
 * Then, without the file: rings are closed or assembled, inner rings are
 * given to the outer that contains them, outlines that have `building:part`s
 * are dropped (Simple 3D Buildings: the parts ARE the building; drawing both
 * would put the outline's flat box around the parts), tags are resolved
 * (`tags.ts`), and each building goes WHOLE to the tile holding its
 * representative point (`lib/map/cityTiles.ts` explains why not clipped).
 *
 * ## Memory, and the planet
 *
 * Positions are kept only for the nodes buildings use, in two `Float64Array`s
 * beside a sorted id array: 24 bytes a node. Catalonia is a few million; the
 * planet's ~710 M buildings reference roughly 4–5 billion nodes, 100+ GB in
 * this layout. A planet build is therefore SHARDED by extract (continent or
 * country), each shard compiled alone and the archives merged; see the doc's
 * "Planet" note for the measured throughput this extrapolates from.
 */
import { closeSync, openSync } from 'node:fs';

import { roofFrame } from '../../components/map/engine/city3d/roofs';
import {
  type BuildingEra,
  type BuildingUse,
  CITY_PROPS,
  CITY_TILE_EXTENT,
  type CityTileTree,
} from '../../lib/map/cityTiles';
import type { CityTileFeature, TilePoint, TilePolygon } from './mvtEncode';
import { collectGarbage, rssMb } from './memory';
import {
  type BlobRef,
  MEMBER_WAY,
  type OsmHeader,
  readBlob,
  readBlock,
  readHeader,
  scanBlobs,
} from './osmPbf';
import {
  buildingKind,
  type CityFeatureProperties,
  parseDirection,
  parseOrientation,
  LIT_KEYS,
  parseBuildingEra,
  parseBuildingUse,
  resolveProperties,
  type Tags,
} from './tags';
import { TREE_KEYS, treeProperties } from './treeTags';

/** The tags a city tile can use. Everything else is dropped on read. */
export const KEPT_KEYS: ReadonlySet<string> = new Set([
  ...LIT_KEYS,
  'building',
  'building:part',
  'type',
  'location',
  'height',
  'min_height',
  'building:levels',
  'building:min_level',
  'roof:shape',
  'roof:height',
  'roof:levels',
  'roof:angle',
  'roof:direction',
  'roof:orientation',
  'building:colour',
  'colour',
  'roof:colour',
  'building:material',
  'roof:material',
  // The facade styling's era (`CITY_PROPS.era`).
  'start_date',
]);

const EARTH_CIRCUMFERENCE_M = 2 * Math.PI * 6371008.8;

export interface CompileOptions {
  pbf: string;
  zoom: number;
  /** `[west, south, east, north]`: keep buildings whose representative point is inside. */
  bbox?: [number, number, number, number];
  /**
   * Keep only the tiles (at {@link CompileOptions.zoom}) this returns true for:
   * the tiles a regional build OWNS (`ownership.ts`). A building or tree goes
   * to the tile holding its representative point, so this decides per tile
   * exactly as the Worker does when it picks a region's archive for one.
   */
  keepTile?: (x: number, y: number) => boolean;
  log?: (line: string) => void;
}

/** What the extract said about the tags that matter, for the doc and the receipt. */
export interface Coverage {
  features: number;
  outlines: number;
  parts: number;
  outlinesDroppedForParts: number;
  withHeight: number;
  withLevels: number;
  withMinHeight: number;
  withRoofShape: number;
  withRoofShapeNonFlat: number;
  roofShapeUnrecognised: number;
  withRoofHeight: number;
  roofHeightSources: Record<string, number>;
  withColour: number;
  withRoofColour: number;
  withMaterial: number;
  withRoofMaterial: number;
  /** Buildings and parts that record being lit at night (`floodlit`, `lit`). */
  withFloodlit: number;
  /** Features with a building class / an era for the facade styling (own or inherited). */
  withUse: number;
  withEra: number;
  /** Values present but unreadable, by key: the junk the parser refused. */
  rejected: Record<string, number>;
  roofShapes: Record<string, number>;
}

export interface CompileResult {
  header: OsmHeader;
  tiles: Map<string, CityTileFeature[]>;
  /** `natural=tree` nodes, by the same `z/x/y` key (`CITY_TREE_LAYER`). */
  trees: Map<string, CityTileTree[]>;
  treeCoverage: TreeCoverage;
  coverage: Coverage;
  timings: Record<string, number>;
  problems: { unclosedWays: number; missingNodes: number; failedRelations: number };
  nodesKept: number;
}

/** What the extract records about its trees. */
export interface TreeCoverage {
  trees: number;
  withCrown: number;
  crowns: Record<string, number>;
  withHeight: number;
  withCrownDiameter: number;
  withCircumference: number;
  /** Recorded as street or avenue trees (`treeTags.ts` → `street`). */
  street: number;
}

interface StoredWay {
  id: number;
  tags: Tags | null;
  refs: Float64Array;
}

interface StoredRelation {
  id: number;
  tags: Tags;
  members: { way: number; inner: boolean }[];
}

function tagsOf(strings: string[], keys: number[], vals: number[]): Record<string, string> {
  const tags: Record<string, string> = {};
  for (let i = 0; i < keys.length; i++) {
    const key = strings[keys[i]];
    if (KEPT_KEYS.has(key)) tags[key] = strings[vals[i]];
  }
  return tags;
}

/** Whether a way or relation's raw tags name a building, without building the tag object. */
function looksLikeBuilding(strings: string[], keys: number[]): boolean {
  for (const k of keys) {
    const key = strings[k];
    if (key === 'building' || key === 'building:part') return true;
  }
  return false;
}

function lowerBound(sorted: Float64Array, value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] < value) low = middle + 1;
    else high = middle;
  }
  return low;
}

const mercX = (lon: number) => (lon + 180) / 360;
function mercY(lat: number): number {
  const phi = (Math.max(-85.051129, Math.min(85.051129, lat)) * Math.PI) / 180;
  return (1 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / Math.PI) / 2;
}
const latFromMercY = (y: number) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;

type Ring = Float64Array; // [mx0, my0, mx1, my1, …], open (no closing duplicate)

/** Join way segments into closed rings by matching endpoints. Unclosable pieces are dropped. */
export function assembleRings(segments: number[][]): number[][] {
  const rings: number[][] = [];
  const remaining = segments.filter((s) => s.length >= 2).map((s) => s.slice());
  while (remaining.length > 0) {
    const ring = remaining.pop() as number[];
    let progress = true;
    while (ring[0] !== ring[ring.length - 1] && progress) {
      progress = false;
      const end = ring[ring.length - 1];
      for (let i = 0; i < remaining.length; i++) {
        const candidate = remaining[i];
        if (candidate[0] === end) {
          ring.push(...candidate.slice(1));
        } else if (candidate[candidate.length - 1] === end) {
          ring.push(...candidate.slice(0, -1).reverse());
        } else {
          continue;
        }
        remaining.splice(i, 1);
        progress = true;
        break;
      }
    }
    if (ring.length >= 4 && ring[0] === ring[ring.length - 1]) rings.push(ring);
  }
  return rings;
}

/** Point-in-ring (even–odd), on an open interleaved ring. */
function insideRing(ring: Ring, x: number, y: number): boolean {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const yi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const yj = ring[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function ringArea(ring: Ring): number {
  let sum = 0;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    sum += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return sum / 2;
}

/**
 * A point that is inside the polygon: the outer's centroid when it is inside,
 * else a vertex midpoint.
 *
 * The centroid is taken RELATIVE TO THE FIRST VERTEX. Absolute mercator
 * coordinates are ~0.5 while a building spans ~1e-7 of them, so the shoelace
 * sums cancel catastrophically: the first version's centroid was off by
 * kilometres, failed the inside test, and every building silently fell back
 * to the midpoint of its first edge — a point ON the boundary, which is what
 * let a bounding box cut an outline whose middle was well inside it.
 */
export function representativePoint(outer: Ring): [number, number] {
  const ox = outer[0];
  const oy = outer[1];
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = outer.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x1 = outer[i * 2] - ox;
    const y1 = outer[i * 2 + 1] - oy;
    const x2 = outer[j * 2] - ox;
    const y2 = outer[j * 2 + 1] - oy;
    const cross = x1 * y2 - x2 * y1;
    a += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }
  if (a !== 0) {
    const point: [number, number] = [ox + cx / (3 * a), oy + cy / (3 * a)];
    if (insideRing(outer, point[0], point[1])) return point;
  }
  // Concave footprint whose centroid falls outside: nudge from an edge midpoint inward.
  return [(outer[0] + outer[2]) / 2, (outer[1] + outer[3]) / 2];
}

/**
 * A building as its tile will hold it, with the tile coordinates computed
 * only when the encoder reads them.
 *
 * Materialising every footprint as `[x, y]` pairs up front cost more memory
 * than anything else the compiler does — measured on Portugal, the tiling
 * step alone took the process from 2.9 GB to 5.4 GB — and memory is what
 * decides how large a region one machine can compile. The mercator rings the
 * geometry step already made are kept instead, and each tile's points exist
 * only while that tile is being encoded.
 */
class LazyTileFeature implements CityTileFeature {
  constructor(
    readonly id: number,
    readonly properties: CityTileFeature['properties'],
    private readonly rings: readonly { outer: Ring; holes: Ring[] }[],
    private readonly tx: number,
    private readonly ty: number,
    private readonly span: number,
  ) {}

  get polygons(): TilePolygon[] {
    const toTile = (ring: Ring): TilePoint[] => {
      const out: TilePoint[] = [];
      for (let i = 0; i < ring.length; i += 2) {
        out.push([
          (ring[i] * this.span - this.tx) * CITY_TILE_EXTENT,
          (ring[i + 1] * this.span - this.ty) * CITY_TILE_EXTENT,
        ]);
      }
      return out;
    };
    return this.rings.map(({ outer, holes }) => ({
      outer: toTile(outer),
      holes: holes.map(toTile),
    }));
  }
}

interface Building {
  id: number;
  kind: 'building' | 'part';
  tags: Tags;
  polygons: { outer: Ring; holes: Ring[] }[];
  point: [number, number];
}

export function compile(options: CompileOptions): CompileResult {
  const log = options.log ?? (() => {});
  const timings: Record<string, number> = {};
  let started = performance.now();
  const lap = (name: string) => {
    const now = performance.now();
    timings[name] = Math.round(now - started);
    started = now;
    log(`  ${name.padEnd(12)} ${(timings[name] / 1000).toFixed(1)} s · rss ${rssMb()} MB`);
  };

  const blobs = scanBlobs(options.pbf);
  const fd = openSync(options.pbf, 'r');
  const nodeBlobs: BlobRef[] = [];
  const wayBlobs: BlobRef[] = [];
  let header: OsmHeader = { requiredFeatures: [], optionalFeatures: [] };

  // ── Pass 1: buildings among ways and relations ──────────────────────────
  const ways = new Map<number, StoredWay>();
  const relations: StoredRelation[] = [];
  // The nodes of `natural=tree_row` ways: a tree among them is a row tree.
  const treeRowNodes = new Set<number>();
  for (const blob of blobs) {
    const bytes = readBlob(fd, blob);
    if (blob.type === 'OSMHeader') {
      header = readHeader(bytes);
      continue;
    }
    if (blob.type !== 'OSMData') continue;
    let strings: string[] = [];
    let naturalKey = -1;
    let treeRowValue = -1;
    const contents = readBlock(bytes, {
      onStrings(table) {
        strings = table;
        naturalKey = table.indexOf('natural');
        treeRowValue = table.indexOf('tree_row');
      },
      onWay(id, keys, vals, refs) {
        if (naturalKey >= 0 && treeRowValue >= 0) {
          for (let i = 0; i < keys.length; i++) {
            if (keys[i] === naturalKey && vals[i] === treeRowValue) {
              for (const ref of refs) treeRowNodes.add(ref);
              return;
            }
          }
        }
        if (!looksLikeBuilding(strings, keys)) return;
        const tags = tagsOf(strings, keys, vals);
        if (!buildingKind(tags)) return;
        ways.set(id, { id, tags, refs: Float64Array.from(refs) });
      },
      onRelation(id, keys, vals, memberIds, memberTypes, roles) {
        if (!looksLikeBuilding(strings, keys)) return;
        const tags = tagsOf(strings, keys, vals);
        if (tags.type !== 'multipolygon' || !buildingKind(tags)) return;
        const members: StoredRelation['members'] = [];
        for (let i = 0; i < memberIds.length; i++) {
          if (memberTypes[i] !== MEMBER_WAY) continue;
          members.push({ way: memberIds[i], inner: strings[roles[i]] === 'inner' });
        }
        relations.push({ id, tags, members });
      },
    });
    if (contents.nodes) nodeBlobs.push(blob);
    if (contents.ways || contents.relations) wayBlobs.push(blob);
  }
  lap('ways+rels');

  // ── Pass 2: member ways the relations need ──────────────────────────────
  const missingWays = new Set<number>();
  for (const relation of relations) {
    for (const member of relation.members) if (!ways.has(member.way)) missingWays.add(member.way);
  }
  if (missingWays.size > 0) {
    for (const blob of wayBlobs) {
      readBlock(readBlob(fd, blob), {
        onWay(id, _keys, _vals, refs) {
          if (missingWays.has(id)) ways.set(id, { id, tags: null, refs: Float64Array.from(refs) });
        },
      });
    }
  }
  lap('member ways');

  // ── Pass 3: node positions ──────────────────────────────────────────────
  let unique = 0;
  let nodeIds: Float64Array;
  {
    let refCount = 0;
    for (const way of ways.values()) refCount += way.refs.length;
    const all = new Float64Array(refCount);
    let at = 0;
    for (const way of ways.values()) {
      all.set(way.refs, at);
      at += way.refs.length;
    }
    all.sort();
    for (let i = 0; i < all.length; i++)
      if (i === 0 || all[i] !== all[i - 1]) all[unique++] = all[i];
    nodeIds = all.subarray(0, unique);
  }
  let nodeX: Float64Array = new Float64Array(unique).fill(Number.NaN);
  let nodeY: Float64Array = new Float64Array(unique).fill(Number.NaN);
  let hint = 0;
  // Trees ride along on the node pass: `natural=tree` is a tagged node.
  const treeNodes: { id: number; x: number; y: number; tags: Tags }[] = [];
  for (const blob of nodeBlobs) {
    let strings: string[] = [];
    let naturalKey = -1;
    let treeValue = -1;
    readBlock(readBlob(fd, blob), {
      wantNodes: true,
      onStrings(table) {
        strings = table;
        naturalKey = table.indexOf('natural');
        treeValue = table.indexOf('tree');
      },
      onTaggedNode(id, lon, lat, keys, vals) {
        if (naturalKey < 0 || treeValue < 0) return;
        for (let i = 0; i < keys.length; i++) {
          if (keys[i] === naturalKey && vals[i] === treeValue) {
            const tags: Record<string, string> = {};
            for (let k = 0; k < keys.length; k++) {
              const key = strings[keys[k]];
              if (TREE_KEYS.has(key)) tags[key] = strings[vals[k]];
            }
            treeNodes.push({ id, x: mercX(lon), y: mercY(lat), tags });
            return;
          }
        }
      },
      onNode(id, lon, lat) {
        // Extracts are sorted by id, so the next needed id is usually at the hint.
        if (hint < unique && nodeIds[hint] === id) {
          nodeX[hint] = mercX(lon);
          nodeY[hint] = mercY(lat);
          hint++;
          return;
        }
        if (hint < unique && nodeIds[hint] < id) {
          hint = lowerBound(nodeIds, id);
          if (hint < unique && nodeIds[hint] === id) {
            nodeX[hint] = mercX(lon);
            nodeY[hint] = mercY(lat);
            hint++;
          }
          return;
        }
        const index = lowerBound(nodeIds, id);
        if (index < unique && nodeIds[index] === id) {
          nodeX[index] = mercX(lon);
          nodeY[index] = mercY(lat);
        }
      },
    });
  }
  closeSync(fd);
  lap('nodes');

  // ── Geometry ────────────────────────────────────────────────────────────
  const problems = { unclosedWays: 0, missingNodes: 0, failedRelations: 0 };
  const ringOf = (refs: ArrayLike<number>): Ring | null => {
    const n = refs.length - 1; // open: drop the closing duplicate
    const ring = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const index = lowerBound(nodeIds, refs[i]);
      const x = nodeX[index];
      if (nodeIds[index] !== refs[i] || Number.isNaN(x)) return null;
      ring[i * 2] = x;
      ring[i * 2 + 1] = nodeY[index];
    }
    return ring;
  };

  const buildings: Building[] = [];
  const outerMembers = new Set<number>();
  for (const relation of relations) {
    const kind = buildingKind(relation.tags);
    if (!kind) continue;
    const outerSegments: number[][] = [];
    const innerSegments: number[][] = [];
    let complete = true;
    for (const member of relation.members) {
      const way = ways.get(member.way);
      if (!way) {
        complete = false;
        break;
      }
      (member.inner ? innerSegments : outerSegments).push(Array.from(way.refs));
      if (!member.inner) outerMembers.add(member.way);
    }
    if (!complete) {
      problems.failedRelations++;
      continue;
    }
    const outers = assembleRings(outerSegments)
      .map(ringOf)
      .filter((r): r is Ring => r !== null);
    const inners = assembleRings(innerSegments)
      .map(ringOf)
      .filter((r): r is Ring => r !== null);
    if (outers.length === 0) {
      problems.failedRelations++;
      continue;
    }
    const polygons = outers.map((outer) => ({ outer, holes: [] as Ring[] }));
    for (const inner of inners) {
      const owner = polygons.find((p) => insideRing(p.outer, inner[0], inner[1]));
      owner?.holes.push(inner);
    }
    const largest = polygons.reduce((a, b) =>
      Math.abs(ringArea(b.outer)) > Math.abs(ringArea(a.outer)) ? b : a,
    );
    buildings.push({
      id: relation.id * 10 + 3,
      kind,
      tags: relation.tags,
      polygons,
      point: representativePoint(largest.outer),
    });
  }
  for (const way of ways.values()) {
    if (!way.tags) continue;
    const kind = buildingKind(way.tags);
    if (!kind) continue;
    // An outer of a building multipolygon is drawn by the relation.
    if (outerMembers.has(way.id)) continue;
    const refs = way.refs;
    if (refs.length < 4 || refs[0] !== refs[refs.length - 1]) {
      problems.unclosedWays++;
      continue;
    }
    const outer = ringOf(refs);
    if (!outer) {
      problems.missingNodes++;
      continue;
    }
    buildings.push({
      id: way.id * 10 + 2,
      kind,
      tags: way.tags,
      polygons: [{ outer, holes: [] }],
      point: representativePoint(outer),
    });
  }
  // Everything the passes kept is in `buildings` now. Release it before the
  // tiling allocates, so the two never peak together: measured on Portugal
  // (2.2 M buildings), holding both put the process at 8.5 GB.
  ways.clear();
  relations.length = 0;
  nodeIds = new Float64Array(0);
  nodeX = nodeIds;
  nodeY = nodeIds;
  collectGarbage();
  lap('geometry');

  // ── Which buildings are emitted ─────────────────────────────────────────
  const box = options.bbox
    ? {
        x0: mercX(options.bbox[0]),
        x1: mercX(options.bbox[2]),
        y0: mercY(options.bbox[3]),
        y1: mercY(options.bbox[1]),
      }
    : null;
  const span = 2 ** options.zoom;
  const keepTile = options.keepTile;
  const tileKept = (px: number, py: number): boolean =>
    !keepTile ||
    keepTile(Math.min(span - 1, Math.floor(px * span)), Math.min(span - 1, Math.floor(py * span)));
  const emitted = (building: Building): boolean => {
    const [px, py] = building.point;
    return (
      (!box || (px >= box.x0 && px <= box.x1 && py >= box.y0 && py <= box.y1)) && tileKept(px, py)
    );
  };

  // ── Outlines with parts ─────────────────────────────────────────────────
  // A grid of parts' representative points, in cells of ~150 m (z18 at the
  // equator is 152 m), so each outline tests only the parts near it. Only
  // parts that will be EMITTED go in: an outline replaced by a part that the
  // bounding box then drops would leave neither on the map.
  const CELL = 2 ** 18;
  const grid = new Map<number, Building[]>();
  const cellKey = (x: number, y: number) => Math.floor(x * CELL) * CELL + Math.floor(y * CELL);
  for (const building of buildings) {
    if (building.kind !== 'part' || !emitted(building)) continue;
    const key = cellKey(building.point[0], building.point[1]);
    const cell = grid.get(key);
    if (cell) cell.push(building);
    else grid.set(key, [building]);
  }
  /** The emitted parts inside an outline (just the first, with `first`). */
  const partsInside = (building: Building, first: boolean): Building[] => {
    const found: Building[] = [];
    for (const { outer, holes } of building.polygons) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (let i = 0; i < outer.length; i += 2) {
        minX = Math.min(minX, outer[i]);
        maxX = Math.max(maxX, outer[i]);
        minY = Math.min(minY, outer[i + 1]);
        maxY = Math.max(maxY, outer[i + 1]);
      }
      for (let cx = Math.floor(minX * CELL); cx <= Math.floor(maxX * CELL); cx++) {
        for (let cy = Math.floor(minY * CELL); cy <= Math.floor(maxY * CELL); cy++) {
          for (const part of grid.get(cx * CELL + cy) ?? []) {
            const [px, py] = part.point;
            if (px < minX || px > maxX || py < minY || py > maxY) continue;
            if (insideRing(outer, px, py) && !holes.some((hole) => insideRing(hole, px, py))) {
              found.push(part);
              if (first) return found;
            }
          }
        }
      }
    }
    return found;
  };
  const hasParts = (building: Building): boolean => partsInside(building, true).length > 0;

  // ── What parts inherit from their outline ───────────────────────────────
  // A `building:part` records shape, not purpose: the class and the era are
  // the outline's (`building=*`, `start_date`), so its parts carry them for
  // the facade styling. A part's own tags win. Barcelona's buildings are
  // drawn entirely as Catastro parts; without this none would have a class.
  const inherited = new Map<Building, { use?: BuildingUse; era?: BuildingEra }>();
  for (const building of buildings) {
    if (building.kind !== 'building' || !emitted(building)) continue;
    const use = parseBuildingUse(building.tags.building);
    const era = parseBuildingEra(building.tags.start_date);
    if (!use && !era) continue;
    for (const part of partsInside(building, false)) {
      const prior = inherited.get(part);
      inherited.set(part, { use: prior?.use ?? use, era: prior?.era ?? era });
    }
  }

  // ── Tiles ───────────────────────────────────────────────────────────────
  const coverage: Coverage = {
    features: 0,
    outlines: 0,
    parts: 0,
    outlinesDroppedForParts: 0,
    withHeight: 0,
    withLevels: 0,
    withMinHeight: 0,
    withRoofShape: 0,
    withRoofShapeNonFlat: 0,
    roofShapeUnrecognised: 0,
    withRoofHeight: 0,
    roofHeightSources: {},
    withColour: 0,
    withRoofColour: 0,
    withMaterial: 0,
    withRoofMaterial: 0,
    withFloodlit: 0,
    withUse: 0,
    withEra: 0,
    rejected: {},
    roofShapes: {},
  };
  const tiles = new Map<string, CityTileFeature[]>();

  for (const building of buildings) {
    if (!emitted(building)) continue;
    const [px, py] = building.point;
    if (building.kind === 'building' && hasParts(building)) {
      coverage.outlinesDroppedForParts++;
      continue;
    }

    // The roof frame, in metres around the representative point, y north.
    const metresPerUnit = EARTH_CIRCUMFERENCE_M * Math.cos((latFromMercY(py) * Math.PI) / 180);
    const largest = building.polygons.reduce((a, b) =>
      Math.abs(ringArea(b.outer)) > Math.abs(ringArea(a.outer)) ? b : a,
    );
    const local: [number, number][] = [];
    for (let i = 0; i < largest.outer.length; i += 2) {
      local.push([
        (largest.outer[i] - px) * metresPerUnit,
        -(largest.outer[i + 1] - py) * metresPerUnit,
      ]);
    }
    const tags = building.tags;
    const frame = tags['roof:shape']
      ? roofFrame(local, {
          direction: parseDirection(tags['roof:direction']),
          across: parseOrientation(tags['roof:orientation']) === 'across',
        })
      : null;
    let footprint = 0;
    for (const polygon of building.polygons) {
      footprint += Math.abs(ringArea(polygon.outer));
      for (const hole of polygon.holes) footprint -= Math.abs(ringArea(hole));
    }
    const properties = resolveProperties(
      tags,
      building.kind,
      frame ? { halfWidth: frame.halfWidth, halfLength: frame.halfLength } : undefined,
      footprint * metresPerUnit * metresPerUnit,
    );
    const fromOutline = building.kind === 'part' ? inherited.get(building) : undefined;
    if (fromOutline?.use && properties[CITY_PROPS.use] === undefined) {
      properties[CITY_PROPS.use] = fromOutline.use;
    }
    if (fromOutline?.era && properties[CITY_PROPS.era] === undefined) {
      properties[CITY_PROPS.era] = fromOutline.era;
    }
    count(coverage, tags, properties, building.kind);

    const tx = Math.min(span - 1, Math.floor(px * span));
    const ty = Math.min(span - 1, Math.floor(py * span));
    const key = `${options.zoom}/${tx}/${ty}`;
    const feature = new LazyTileFeature(building.id, properties, building.polygons, tx, ty, span);
    const list = tiles.get(key);
    if (list) list.push(feature);
    else tiles.set(key, [feature]);
  }
  for (const list of tiles.values()) list.sort((a, b) => a.id - b.id);
  buildings.length = 0;
  grid.clear();
  collectGarbage();
  lap('tags+tiles');

  // ── Trees ───────────────────────────────────────────────────────────────
  const trees = new Map<string, CityTileTree[]>();
  const treeCoverage: TreeCoverage = {
    trees: 0,
    withCrown: 0,
    crowns: {},
    withHeight: 0,
    withCrownDiameter: 0,
    withCircumference: 0,
    street: 0,
  };
  for (const node of treeNodes) {
    if (box && (node.x < box.x0 || node.x > box.x1 || node.y < box.y0 || node.y > box.y1)) continue;
    if (!tileKept(node.x, node.y)) continue;
    const properties = treeProperties(node.tags, treeRowNodes.has(node.id));
    treeCoverage.trees++;
    if (properties.crown) {
      treeCoverage.withCrown++;
      treeCoverage.crowns[properties.crown] = (treeCoverage.crowns[properties.crown] ?? 0) + 1;
    }
    if (properties.height !== undefined) treeCoverage.withHeight++;
    if (properties.crown_diameter !== undefined) treeCoverage.withCrownDiameter++;
    if (properties.circumference !== undefined) treeCoverage.withCircumference++;
    if (properties.street) treeCoverage.street++;
    const tx = Math.min(span - 1, Math.floor(node.x * span));
    const ty = Math.min(span - 1, Math.floor(node.y * span));
    const key = `${options.zoom}/${tx}/${ty}`;
    const tree: CityTileTree = {
      id: node.id,
      point: [(node.x * span - tx) * CITY_TILE_EXTENT, (node.y * span - ty) * CITY_TILE_EXTENT],
      properties,
    };
    const list = trees.get(key);
    if (list) list.push(tree);
    else trees.set(key, [tree]);
  }
  for (const list of trees.values()) list.sort((a, b) => a.id - b.id);
  lap('trees');

  return { header, tiles, trees, treeCoverage, coverage, timings, problems, nodesKept: unique };
}

function count(
  coverage: Coverage,
  tags: Tags,
  props: CityFeatureProperties,
  kind: 'building' | 'part',
): void {
  coverage.features++;
  if (kind === 'part') coverage.parts++;
  else coverage.outlines++;
  const reject = (key: string) => {
    coverage.rejected[key] = (coverage.rejected[key] ?? 0) + 1;
  };
  const check = (key: string, prop: string, counter: keyof Coverage) => {
    if (props[prop] !== undefined) (coverage[counter] as number)++;
    else if (tags[key] !== undefined) reject(key);
  };
  check('height', 'height', 'withHeight');
  check('building:levels', 'levels', 'withLevels');
  if (tags.min_height !== undefined) coverage.withMinHeight++;
  check('building:colour', 'colour', 'withColour');
  check('roof:colour', 'roof_colour', 'withRoofColour');
  check('building:material', 'material', 'withMaterial');
  check('roof:material', 'roof_material', 'withRoofMaterial');
  if (props.floodlit === true) coverage.withFloodlit++;
  if (props.use !== undefined) coverage.withUse++;
  if (props.era !== undefined) coverage.withEra++;
  if (tags['roof:shape'] !== undefined) {
    const shape = props.roof_shape;
    if (shape === undefined) {
      coverage.roofShapeUnrecognised++;
      reject('roof:shape');
    } else {
      coverage.withRoofShape++;
      if (shape !== 'flat') coverage.withRoofShapeNonFlat++;
      coverage.roofShapes[String(shape)] = (coverage.roofShapes[String(shape)] ?? 0) + 1;
    }
  }
  if (props.roof_height !== undefined) {
    coverage.withRoofHeight++;
    const source = String(props.roof_height_source ?? 'tag');
    coverage.roofHeightSources[source] = (coverage.roofHeightSources[source] ?? 0) + 1;
  }
}

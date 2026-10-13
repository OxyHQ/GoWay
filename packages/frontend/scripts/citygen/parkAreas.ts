/**
 * Park-like areas of an OSM extract, to tell a road through a park from a road.
 *
 * A service lane in a park is mapped like a service lane anywhere, and the
 * simulation sent it as much traffic as a delivery alley in a dense block. The
 * only thing that says otherwise is WHERE it is: inside a park, a garden, a
 * cemetery. So the road compiler asks {@link ParkAreas.contains} for a piece's
 * midpoint and flags the piece (`ROAD_PROPS.park`).
 *
 * Same three passes as the building compiler (`compile.ts`) — areas among ways
 * and multipolygon relations, the member ways relations need, node positions —
 * over the same readers, with `rings.ts` shared. Positions are mercator
 * `0..1`, the road compiler's own frame, so a piece's midpoint needs no
 * conversion.
 *
 * ## What counts, and what deliberately does not
 *
 * `leisure=park|garden|nature_reserve|golf_course|common|dog_park` and
 * `landuse=cemetery|recreation_ground|village_green|forest`. Not
 * `boundary=national_park|protected_area` (huge administrative areas that
 * contain towns and their roads), not `natural=wood` (forestry tracks are not
 * car roads already), not a playground or a pitch (too small to matter and
 * often mapped over the street beside it).
 */
import { closeSync, openSync } from 'node:fs';

import { collectGarbage, rssMb } from './memory';
import { type BlobRef, MEMBER_WAY, readBlob, readBlock, scanBlobs } from './osmPbf';
import { assembleRings, insideRing } from './rings';

/** `key=value` pairs that make an area park-like. */
const PARK_TAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  leisure: new Set(['park', 'garden', 'nature_reserve', 'golf_course', 'common', 'dog_park']),
  landuse: new Set(['cemetery', 'recreation_ground', 'village_green', 'forest']),
};

/** Mercator cell size of the lookup grid: a z12 tile. */
const CELL = 1 / 2 ** 12;

export interface ParkAreas {
  /** How many areas were assembled. */
  readonly count: number;
  /** Whether the mercator point `(mx, my)` (both 0..1) is inside a park-like area. */
  contains(mx: number, my: number): boolean;
}

interface Area {
  outer: Float64Array;
  holes: Float64Array[];
  box: [number, number, number, number];
}

/** Whether the tags (as key/value strings) describe a park-like area. */
export function isParkLike(tags: Readonly<Record<string, string>>): boolean {
  for (const [key, values] of Object.entries(PARK_TAGS)) {
    const value = tags[key];
    if (value !== undefined && values.has(value)) return true;
  }
  return false;
}

/** The lookup over assembled areas: a grid of cells, each listing the areas whose box meets it. */
export function indexAreas(areas: readonly Area[]): ParkAreas {
  const grid = new Map<number, number[]>();
  const key = (cx: number, cy: number) => cx * 1_000_000 + cy;
  areas.forEach((area, index) => {
    const [x0, y0, x1, y1] = area.box;
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        const k = key(cx, cy);
        const list = grid.get(k);
        if (list) list.push(index);
        else grid.set(k, [index]);
      }
    }
  });
  return {
    count: areas.length,
    contains(mx, my) {
      const list = grid.get(key(Math.floor(mx / CELL), Math.floor(my / CELL)));
      if (!list) return false;
      for (const index of list) {
        const area = areas[index] as Area;
        const [x0, y0, x1, y1] = area.box;
        if (mx < x0 || mx > x1 || my < y0 || my > y1) continue;
        if (insideRing(area.outer, mx, my) && !area.holes.some((h) => insideRing(h, mx, my))) {
          return true;
        }
      }
      return false;
    },
  };
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

interface StoredWay {
  refs: Float64Array;
}
interface StoredRelation {
  members: { way: number; inner: boolean }[];
}

export function scanParkAreas(pbf: string, log: (line: string) => void = () => {}): ParkAreas {
  const blobs = scanBlobs(pbf);
  const fd = openSync(pbf, 'r');
  const nodeBlobs: BlobRef[] = [];
  const wayBlobs: BlobRef[] = [];
  const closedWays = new Map<number, StoredWay>();
  const relations: StoredRelation[] = [];
  const memberWays = new Map<number, StoredWay>();

  // ── Pass 1: park-like ways and multipolygon relations ───────────────────
  for (const blob of blobs) {
    if (blob.type !== 'OSMData') continue;
    let strings: string[] = [];
    const parkKeys = (keys: number[], vals: number[]) => {
      const tags: Record<string, string> = {};
      for (let i = 0; i < keys.length; i++) {
        const key = strings[keys[i]];
        if (key === 'leisure' || key === 'landuse' || key === 'type') tags[key] = strings[vals[i]];
      }
      return tags;
    };
    const contents = readBlock(readBlob(fd, blob), {
      onStrings(table) {
        strings = table;
      },
      onWay(id, keys, vals, refs) {
        if (refs.length < 4 || refs[0] !== refs[refs.length - 1]) return;
        if (isParkLike(parkKeys(keys, vals))) closedWays.set(id, { refs: Float64Array.from(refs) });
      },
      onRelation(_id, keys, vals, memberIds, memberTypes, roles) {
        const tags = parkKeys(keys, vals);
        if (tags.type !== 'multipolygon' || !isParkLike(tags)) return;
        const members: StoredRelation['members'] = [];
        for (let i = 0; i < memberIds.length; i++) {
          if (memberTypes[i] !== MEMBER_WAY) continue;
          members.push({ way: memberIds[i], inner: strings[roles[i]] === 'inner' });
        }
        relations.push({ members });
      },
    });
    if (contents.nodes) nodeBlobs.push(blob);
    if (contents.ways || contents.relations) wayBlobs.push(blob);
  }
  log(
    `  parks ways+rels · ${closedWays.size} ways · ${relations.length} relations · rss ${rssMb()} MB`,
  );

  // ── Pass 2: the untagged member ways the relations are made of ──────────
  const missing = new Set<number>();
  for (const relation of relations) for (const m of relation.members) missing.add(m.way);
  if (missing.size > 0) {
    for (const blob of wayBlobs) {
      readBlock(readBlob(fd, blob), {
        onWay(id, _keys, _vals, refs) {
          if (missing.has(id)) memberWays.set(id, { refs: Float64Array.from(refs) });
        },
      });
    }
  }

  // ── Pass 3: node positions ──────────────────────────────────────────────
  const ids: number[] = [];
  for (const way of closedWays.values()) for (const ref of way.refs) ids.push(ref);
  for (const way of memberWays.values()) for (const ref of way.refs) ids.push(ref);
  const sorted = Float64Array.from(ids).sort();
  let unique = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0 || sorted[i] !== sorted[i - 1]) sorted[unique++] = sorted[i];
  }
  const nodeIds = sorted.subarray(0, unique);
  const nodeX = new Float64Array(unique).fill(Number.NaN);
  const nodeY = new Float64Array(unique).fill(Number.NaN);
  for (const blob of nodeBlobs) {
    readBlock(readBlob(fd, blob), {
      wantNodes: true,
      onNode(id, lon, lat) {
        const index = lowerBound(nodeIds, id);
        if (index < unique && nodeIds[index] === id) {
          nodeX[index] = mercX(lon);
          nodeY[index] = mercY(lat);
        }
      },
    });
  }
  closeSync(fd);
  collectGarbage();

  // ── Geometry ────────────────────────────────────────────────────────────
  const ringOf = (refs: ArrayLike<number>): Float64Array | null => {
    const n = refs.length - 1; // open: drop the closing duplicate
    const ring = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) {
      const index = lowerBound(nodeIds, refs[i]);
      if (nodeIds[index] !== refs[i] || Number.isNaN(nodeX[index])) return null;
      ring[i * 2] = nodeX[index];
      ring[i * 2 + 1] = nodeY[index];
    }
    return ring;
  };
  const boxOf = (ring: Float64Array): Area['box'] => {
    let x0 = Number.POSITIVE_INFINITY;
    let y0 = Number.POSITIVE_INFINITY;
    let x1 = Number.NEGATIVE_INFINITY;
    let y1 = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < ring.length; i += 2) {
      x0 = Math.min(x0, ring[i]);
      x1 = Math.max(x1, ring[i]);
      y0 = Math.min(y0, ring[i + 1]);
      y1 = Math.max(y1, ring[i + 1]);
    }
    return [x0, y0, x1, y1];
  };

  const areas: Area[] = [];
  for (const way of closedWays.values()) {
    const ring = ringOf(way.refs);
    if (ring && ring.length >= 6) areas.push({ outer: ring, holes: [], box: boxOf(ring) });
  }
  for (const relation of relations) {
    const outerSegments: number[][] = [];
    const innerSegments: number[][] = [];
    let complete = true;
    for (const member of relation.members) {
      const way = memberWays.get(member.way) ?? closedWays.get(member.way);
      if (!way) {
        complete = false;
        break;
      }
      (member.inner ? innerSegments : outerSegments).push(Array.from(way.refs));
    }
    // A relation with a member outside the extract is half a park: left out.
    if (!complete) continue;
    const outers = assembleRings(outerSegments)
      .map(ringOf)
      .filter((r): r is Float64Array => r !== null && r.length >= 6);
    const inners = assembleRings(innerSegments)
      .map(ringOf)
      .filter((r): r is Float64Array => r !== null && r.length >= 6);
    const polygons = outers.map((outer) => ({ outer, holes: [] as Float64Array[] }));
    for (const inner of inners) {
      polygons.find((p) => insideRing(p.outer, inner[0], inner[1]))?.holes.push(inner);
    }
    for (const polygon of polygons) areas.push({ ...polygon, box: boxOf(polygon.outer) });
  }
  log(`  parks areas · ${areas.length} · rss ${rssMb()} MB`);
  return indexAreas(areas);
}

/**
 * Where a tree OpenStreetMap records stands — on a street, or in a park, a
 * wood or the countryside — read from what the tiles around it record, and
 * the rule that no tree is drawn on a carriageway.
 *
 * A tree is a STREET tree (drawn with `trees.ts` → `STREET_TREE`'s
 * proportions: a clear trunk, a modest crown above a bus) when it stands
 * within {@link TREE_CONTEXT}`.kerbM` of a carriageway's kerb — wherever it is
 * mapped, a park's edge included: its crown is over the street — or when it
 * is not in a mapped park, garden or wood and
 *
 *  - OSM records it as one (`street`: a member of a `natural=tree_row`, or
 *    `denotation=avenue|urban` — `scripts/citygen/treeTags.ts`), or
 *  - it stands within {@link TREE_CONTEXT}`.nearCarriagewayM` of a
 *    carriageway's kerb, or `nearSidewalkM` of a mapped sidewalk, or
 *  - it stands in urban landuse (residential, commercial, retail, industrial).
 *
 * Every other tree is drawn as before. The areas are OpenMapTiles' (the
 * basemap tile under the city tile, `treeSources.ts` → `decodeTreeAreas`);
 * the carriageways are the road archive's, as wide as the street detail
 * draws them (`cityStreets/lanes.ts` → `crossSection`).
 *
 * **Never on the carriageway.** A tree whose point falls inside a drawn
 * carriageway is either a kerb tree a little off (OSM positions and road
 * centrelines are each good to a metre or two, and an unrecorded road width
 * is the class default): within {@link TREE_CONTEXT}`.nudgeM` it is moved
 * square to the kerb and `kerbClearanceM` past it, counted as `nudged`; or it
 * is deeper in the road (a mis-mapped point, or a planted median the road's
 * one centreline runs through): it is not drawn, counted as `offCarriageway`
 * (the engine's dev stats show both). Shared surfaces (`living_street`,
 * `pedestrian`), tunnels and bridges have no carriageway at ground level.
 *
 * Pure: tested in `components/map/__tests__/city3dTreeContext.test.ts`.
 */
import type { Point2 } from './mesher';
import type { AreaRings } from './trees';

export const TREE_CONTEXT = {
  /** A tree this close to a carriageway's kerb (metres) is a street tree, even in a park. */
  kerbM: 3,
  /** Outside parks and woods, a tree this close to a carriageway's kerb is a street tree. */
  nearCarriagewayM: 8,
  /** …or this close to a mapped sidewalk's centreline. */
  nearSidewalkM: 4,
  /** How far inside a drawn carriageway a tree is still a kerb tree, moved out (metres). */
  nudgeM: 1.5,
  /** Where a moved tree stands: this far past the kerb (metres). */
  kerbClearanceM: 0.75,
} as const;

/** A carriageway as drawn: its centreline and half its kerb-to-kerb width. */
export interface Carriageway {
  /** Tile units, y down (the city tile's). */
  points: readonly Point2[];
  halfWidthM: number;
}

/** What the tiles around a city tile record, in its tile units. */
export interface TreeContext {
  carriageways: readonly Carriageway[];
  /** Sidewalks mapped as their own ways (`footway=sidewalk`): centrelines. */
  sidewalks: readonly (readonly Point2[])[];
  /** Parks, gardens and woods: a tree here keeps its park look. */
  nature: readonly AreaRings[];
  /** Urban landuse: a tree here is a street tree. */
  urban: readonly AreaRings[];
}

/** How many of a tile's mapped trees went where. */
export interface TreeSettingCounts {
  street: number;
  nature: number;
  /** Moved from just inside a carriageway to its kerb. */
  nudged: number;
  /** Deep in a carriageway: not drawn. */
  offCarriageway: number;
}

export const NO_TREE_CONTEXT: TreeContext = {
  carriageways: [],
  sidewalks: [],
  nature: [],
  urban: [],
};

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function boxOf(points: Iterable<Point2>): Box {
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

/** Areas with their boxes, for a point-in-area test that skips most of them. */
function indexAreas(areas: readonly AreaRings[]) {
  return areas.map((rings) => ({ rings, box: boxOf(rings.flat()) }));
}

function insideAny(areas: ReturnType<typeof indexAreas>, x: number, y: number): boolean {
  for (const { rings, box } of areas) {
    if (x < box.x0 || x > box.x1 || y < box.y0 || y > box.y1) continue;
    let hit = false;
    for (const ring of rings) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
      }
    }
    if (hit) return true;
  }
  return false;
}

/** One segment of a line, with what it belongs to. */
interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  /** Half width in tile units (carriageways); 0 for a sidewalk. */
  half: number;
}

/** Segments bucketed by a square grid of their (padded) boxes. */
class SegmentGrid {
  private readonly cells = new Map<number, Segment[]>();

  constructor(
    private readonly cell: number,
    segments: readonly Segment[],
    pad: number,
  ) {
    for (const s of segments) {
      const reach = s.half + pad;
      const i0 = Math.floor((Math.min(s.ax, s.bx) - reach) / cell);
      const i1 = Math.floor((Math.max(s.ax, s.bx) + reach) / cell);
      const j0 = Math.floor((Math.min(s.ay, s.by) - reach) / cell);
      const j1 = Math.floor((Math.max(s.ay, s.by) + reach) / cell);
      for (let i = i0; i <= i1; i++) {
        for (let j = j0; j <= j1; j++) {
          const key = i * 100_003 + j;
          const list = this.cells.get(key);
          if (list) list.push(s);
          else this.cells.set(key, [s]);
        }
      }
    }
  }

  near(x: number, y: number): readonly Segment[] {
    return this.cells.get(Math.floor(x / this.cell) * 100_003 + Math.floor(y / this.cell)) ?? [];
  }
}

function segmentsOf(lines: readonly (readonly Point2[])[], half: (k: number) => number) {
  const out: Segment[] = [];
  lines.forEach((points, k) => {
    for (let i = 0; i + 1 < points.length; i++) {
      out.push({
        ax: points[i][0],
        ay: points[i][1],
        bx: points[i + 1][0],
        by: points[i + 1][1],
        half: half(k),
      });
    }
  });
  return out;
}

/** The nearest point of a segment to (x, y), and the distance to it. */
function nearest(s: Segment, x: number, y: number): { px: number; py: number; d: number } {
  const dx = s.bx - s.ax;
  const dy = s.by - s.ay;
  const length2 = dx * dx + dy * dy;
  const t =
    length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / length2));
  const px = s.ax + dx * t;
  const py = s.ay + dy * t;
  return { px, py, d: Math.hypot(x - px, y - py) };
}

/** How deep (x, y) is inside the deepest carriageway, tile units (≤ 0: outside all). */
function deepest(grid: SegmentGrid, x: number, y: number) {
  let depth = -Infinity;
  let at: { s: Segment; px: number; py: number; d: number } | null = null;
  for (const s of grid.near(x, y)) {
    if (s.half === 0) continue;
    const n = nearest(s, x, y);
    const inside = s.half - n.d;
    if (inside > depth) {
      depth = inside;
      at = { s, ...n };
    }
  }
  return { depth, at };
}

/**
 * Settle a tile's mapped trees in their context: each one's setting, kerb
 * trees moved out of the carriageway, deep ones left out. Trees and context
 * are in the same tile units; `metresPerUnit` converts the distances.
 * Returns the trees to draw (with `street` and maybe a new position) and the
 * counts.
 */
export function settleTrees<T extends { x: number; y: number; street?: boolean }>(
  trees: readonly T[],
  context: TreeContext,
  metresPerUnit: number,
): { trees: (Omit<T, 'street'> & { street: boolean })[]; counts: TreeSettingCounts } {
  const counts: TreeSettingCounts = { street: 0, nature: 0, nudged: 0, offCarriageway: 0 };
  const unit = (metres: number) => metres / metresPerUnit;
  const near = unit(TREE_CONTEXT.nearCarriagewayM);
  const nearWalk = unit(TREE_CONTEXT.nearSidewalkM);
  const segments = [
    ...segmentsOf(
      context.carriageways.map((c) => c.points),
      (k) => unit(context.carriageways[k].halfWidthM),
    ),
  ];
  const walks = segmentsOf(context.sidewalks, () => 0);
  const grid = new SegmentGrid(unit(16), [...segments, ...walks], Math.max(near, nearWalk));
  const nature = indexAreas(context.nature);
  const urban = indexAreas(context.urban);

  const out: (Omit<T, 'street'> & { street: boolean })[] = [];
  for (const tree of trees) {
    let { x, y } = tree;
    const inRoad = deepest(grid, x, y);
    if (inRoad.depth > 0 && inRoad.at) {
      if (inRoad.depth > unit(TREE_CONTEXT.nudgeM)) {
        counts.offCarriageway++;
        continue;
      }
      // Square to the kerb, out the side the point is on.
      const { s, px, py, d } = inRoad.at;
      let ux = x - px;
      let uy = y - py;
      if (d === 0) {
        // On the centreline itself: either side is as good; take the left.
        ux = -(s.by - s.ay);
        uy = s.bx - s.ax;
      }
      const length = Math.hypot(ux, uy) || 1;
      const to = s.half + unit(TREE_CONTEXT.kerbClearanceM);
      x = px + (ux / length) * to;
      y = py + (uy / length) * to;
      // Moved into another carriageway (a junction's corner): not drawn.
      if (deepest(grid, x, y).depth > 0) {
        counts.offCarriageway++;
        continue;
      }
      counts.nudged++;
    }

    // The nearest kerb, and whether a mapped sidewalk is near.
    let kerb = Infinity;
    let walk = false;
    for (const s of grid.near(x, y)) {
      const { d } = nearest(s, x, y);
      if (s.half > 0) kerb = Math.min(kerb, d - s.half);
      else if (d <= nearWalk) walk = true;
    }
    const street =
      kerb <= unit(TREE_CONTEXT.kerbM) ||
      (!insideAny(nature, x, y) &&
        (tree.street === true || kerb <= near || walk || insideAny(urban, x, y)));
    if (street) counts.street++;
    else counts.nature++;
    out.push({ ...tree, x, y, street });
  }
  return { trees: out, counts };
}

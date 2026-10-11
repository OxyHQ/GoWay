/**
 * Which z15 tiles a regional city build OWNS, from the region's polygon.
 *
 * ## The rule
 *
 * A region (a Geofabrik extract: `europe/portugal`, `north-america/us/texas`)
 * owns exactly the tiles that lie WHOLLY inside its polygon — the `.poly`
 * Geofabrik cut the extract with. Its archive holds those tiles and no
 * others, and the Worker answers a tile from the archive of the region that
 * owns it (`worker/index.js`).
 *
 * Why wholly inside, and not "the tile's centre is inside":
 *
 *  - **Completeness.** Every building whose representative point lies in an
 *    owned tile is in the extract — the polygon contains the whole tile, so it
 *    contains the point, and Geofabrik extracts carry complete ways. A tile
 *    the border crosses may hold buildings the extract does not, so it is
 *    nobody's rather than half of somebody's.
 *  - **Independence.** Ownership depends on the region's own polygon and
 *    nothing else, so a region can be rebuilt alone, at any time, and never
 *    changes what its neighbours own. Where two polygons overlap (Geofabrik
 *    draws them with slack across borders) a tile can be owned twice; both
 *    archives then hold the same buildings and the Worker takes the first
 *    region in the manifest. Where they do not quite meet, a strip of tiles is
 *    owned by nobody and the client draws the basemap's buildings there — the
 *    same fallback as anywhere not yet built. Measured for Portugal–Spain in
 *    `docs/MAP_CITY_PLANET.md` → "Borders".
 *
 * The test is done in longitude/latitude, where a web-mercator tile is an
 * axis-aligned rectangle and the polygon's edges are the straight lines
 * osmium cut with — so "inside" here means what it meant to the extract.
 *
 * ## Shards
 *
 * A region too large for one build machine is compiled in parts: rectangles
 * on a tile grid (so no tile straddles two parts), each cut from the extract
 * with `osmium extract` and owning the intersection of the region's tiles and
 * its rectangle. {@link splitByDensity} chooses the rectangles from where the
 * extract's nodes are, so the parts are even in memory, not in area.
 */
import {
  buildCoverageTree,
  type CoverageNode,
  coverageAt,
  EMPTY,
  FULL,
  intersectCoverageTrees,
  MIXED,
} from '../../worker/coverageTree.js';

/** A ring of `[lon, lat]` points; the closing point may or may not repeat the first. */
export type Ring = [number, number][];

/** The zoom ownership is decided at: the city tiles' own. */
export const OWNERSHIP_ZOOM = 15;

/**
 * Read an osmosis `.poly` file (Geofabrik publishes one beside every
 * extract): rings, holes marked with `!`. Even–odd over all rings is the
 * format's meaning, so holes need no special treatment beyond being rings.
 */
export function parsePoly(text: string): Ring[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const rings: Ring[] = [];
  let i = 1; // line 0 is the file's name
  while (i < lines.length) {
    const head = lines[i++];
    if (head === '' || head === 'END') continue;
    const ring: Ring = [];
    while (i < lines.length && lines[i] !== 'END') {
      const parts = lines[i++].split(/\s+/).map(Number);
      if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
        throw new Error(`.poly: unreadable coordinate line ${i}: "${lines[i - 1]}"`);
      }
      ring.push([parts[0], parts[1]]);
    }
    if (i >= lines.length) throw new Error('.poly: a ring has no END');
    i++; // the ring's END
    if (ring.length < 3) throw new Error(`.poly: ring "${head}" has fewer than three points`);
    rings.push(ring);
  }
  if (rings.length === 0) throw new Error('.poly: no rings');
  return rings;
}

/** A GeoJSON (Multi)Polygon's rings, outers and holes alike (even–odd). */
export function geoJsonRings(geometry: { type: string; coordinates: unknown }): Ring[] {
  if (geometry.type === 'Polygon') return geometry.coordinates as Ring[];
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as Ring[][]).flat();
  throw new Error(`not a polygon: ${geometry.type}`);
}

const tileWest = (x: number, z: number) => (x / 2 ** z) * 360 - 180;
const tileNorth = (y: number, z: number) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

/**
 * Whether segment (ax,ay)–(bx,by) passes through the rectangle's INTERIOR
 * (Liang–Barsky, strict). An edge lying along the tile's boundary, or touching
 * it at a corner, does not: the polygon does not enter the tile there, so the
 * tile's centre still decides it — which is what lets two polygons sharing a
 * border along a tile edge own the tiles on each side.
 */
export function segmentCrossesRect(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  w: number,
  s: number,
  e: number,
  n: number,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q > 0;
    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };
  return clip(-dx, ax - w) && clip(dx, e - ax) && clip(-dy, ay - s) && clip(dy, n - ay) && t0 < t1;
}

/**
 * The z15 tiles wholly inside the polygon, as a coverage tree.
 *
 * Descends from z0, keeping per branch only the edges that cross the current
 * tile: a tile no edge crosses is all in or all out (decided by its centre),
 * one an edge crosses is looked at closer, and at z15 a crossed tile is not
 * owned.
 */
export function polygonOwnership(rings: readonly Ring[], maxZoom = OWNERSHIP_ZOOM): CoverageNode {
  const coords: number[] = [];
  for (const ring of rings) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[(i + 1) % n];
      if (ax === bx && ay === by) continue;
      coords.push(ax, ay, bx, by);
    }
  }
  const edges = Float64Array.from(coords);
  const edgeCount = edges.length / 4;
  const all = new Int32Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) all[i] = i;

  // Even–odd over every edge: a centre's inside-ness is not inherited.
  const inside = (x: number, y: number): boolean => {
    let crossings = false;
    for (let i = 0; i < edgeCount; i++) {
      const ax = edges[i * 4];
      const ay = edges[i * 4 + 1];
      const bx = edges[i * 4 + 2];
      const by = edges[i * 4 + 3];
      if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) {
        crossings = !crossings;
      }
    }
    return crossings;
  };

  return buildCoverageTree(
    maxZoom,
    (z, x, y, candidates: Int32Array) => {
      const w = tileWest(x, z);
      const e = tileWest(x + 1, z);
      const n = tileNorth(y, z);
      const s = tileNorth(y + 1, z);
      const crossing: number[] = [];
      for (const i of candidates) {
        if (
          segmentCrossesRect(
            edges[i * 4],
            edges[i * 4 + 1],
            edges[i * 4 + 2],
            edges[i * 4 + 3],
            w,
            s,
            e,
            n,
          )
        ) {
          crossing.push(i);
        }
      }
      if (crossing.length === 0) {
        return { state: inside((w + e) / 2, (s + n) / 2) ? FULL : EMPTY, context: candidates };
      }
      return { state: MIXED, context: Int32Array.from(crossing) };
    },
    all,
  );
}

/** A rectangle of tiles at `zoom`: `x0 ≤ x < x1`, `y0 ≤ y < y1`. */
export interface TileRect {
  zoom: number;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The tiles of a {@link TileRect}, as a coverage tree at `maxZoom` (≥ the rect's zoom). */
export function rectOwnership(rect: TileRect, maxZoom = OWNERSHIP_ZOOM): CoverageNode {
  return buildCoverageTree(
    maxZoom,
    (z, x, y) => {
      // The tile in the rect's grid: compare at the coarser of the two zooms.
      if (z >= rect.zoom) {
        const f = 2 ** (z - rect.zoom);
        const rx = Math.floor(x / f);
        const ry = Math.floor(y / f);
        const inRect = rx >= rect.x0 && rx < rect.x1 && ry >= rect.y0 && ry < rect.y1;
        return { state: inRect ? FULL : EMPTY, context: null };
      }
      const f = 2 ** (rect.zoom - z);
      const x0 = x * f;
      const y0 = y * f;
      const x1 = x0 + f;
      const y1 = y0 + f;
      if (x1 <= rect.x0 || x0 >= rect.x1 || y1 <= rect.y0 || y0 >= rect.y1) {
        return { state: EMPTY, context: null };
      }
      if (x0 >= rect.x0 && x1 <= rect.x1 && y0 >= rect.y0 && y1 <= rect.y1) {
        return { state: FULL, context: null };
      }
      return { state: MIXED, context: null };
    },
    null,
  );
}

/** A tile rectangle's extent in degrees, `[west, south, east, north]`. */
export function rectBounds(rect: TileRect): [number, number, number, number] {
  return [
    tileWest(rect.x0, rect.zoom),
    tileNorth(rect.y1, rect.zoom),
    tileWest(rect.x1, rect.zoom),
    tileNorth(rect.y0, rect.zoom),
  ];
}

/** `keepTile` for the compilers: whether the tree owns tile (x, y) at its leaf zoom. */
export function ownsTile(tree: CoverageNode, maxZoom = OWNERSHIP_ZOOM) {
  return (x: number, y: number): boolean => coverageAt(tree, maxZoom, maxZoom, x, y) === FULL;
}

/**
 * Split a region into `parts` tile rectangles of roughly equal WEIGHT, by
 * recursive halving along the longer side at the weighted median.
 *
 * `weights` counts something proportional to what a part will cost to
 * compile — the extract's nodes per tile at `zoom` (`nodeDensity`). Areas are
 * a bad proxy: a country's capital holds more buildings than its mountains.
 * The rectangles cover `bounds` exactly and never overlap, so their
 * ownerships (each intersected with the region's) partition the region.
 */
export function splitByDensity(
  weights: ReadonlyMap<string, number>,
  bounds: TileRect,
  parts: number,
): TileRect[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error(`parts must be ≥ 1, got ${parts}`);
  const weightIn = (rect: TileRect) => {
    let total = 0;
    for (const [key, weight] of weights) {
      const [x, y] = key.split('/').map(Number);
      if (x >= rect.x0 && x < rect.x1 && y >= rect.y0 && y < rect.y1) total += weight;
    }
    return total;
  };
  const split = (rect: TileRect, count: number): TileRect[] => {
    if (count === 1) return [rect];
    const wide = rect.x1 - rect.x0 >= rect.y1 - rect.y0;
    const lo = wide ? rect.x0 : rect.y0;
    const hi = wide ? rect.x1 : rect.y1;
    if (hi - lo < 2) return [rect]; // one tile wide: cannot be cut further at this zoom
    const leftCount = Math.floor(count / 2);
    const total = weightIn(rect);
    const target = (total * leftCount) / count;
    // The cut c in (lo, hi): rows/columns [lo, c) go left.
    const along = new Map<number, number>();
    for (const [key, weight] of weights) {
      const [x, y] = key.split('/').map(Number);
      if (x < rect.x0 || x >= rect.x1 || y < rect.y0 || y >= rect.y1) continue;
      const at = wide ? x : y;
      along.set(at, (along.get(at) ?? 0) + weight);
    }
    let cut = lo + 1;
    let running = along.get(lo) ?? 0;
    while (cut < hi - 1 && running + (along.get(cut) ?? 0) <= target) {
      running += along.get(cut) ?? 0;
      cut++;
    }
    const left = wide ? { ...rect, x1: cut } : { ...rect, y1: cut };
    const right = wide ? { ...rect, x0: cut } : { ...rect, y0: cut };
    return [...split(left, leftCount), ...split(right, count - leftCount)];
  };
  return split(bounds, parts);
}

/** A part's ownership: the region's tiles inside its rectangle. */
export function partOwnership(region: CoverageNode, rect: TileRect): CoverageNode {
  return intersectCoverageTrees(region, rectOwnership(rect));
}

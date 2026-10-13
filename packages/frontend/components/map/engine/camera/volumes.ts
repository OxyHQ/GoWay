/**
 * Where the buildings are, for the camera: a compact index of solid volumes
 * that answers "how high must an eye at this point be to clear them?".
 *
 * The camera rule (`clearance.ts`, `docs/MAP_CAMERA_CLEARANCE.md`) keeps the
 * map's eye out of every building it draws. It asks one question per camera
 * change, about one point, and must answer in microseconds; it must not hold
 * a second copy of the city's geometry to do it. So each tile mesh carries,
 * beside its vertices, one convex FOOTPRINT per unit (a building, a building
 * part, or a polygon of a far level) and the unit's TOP — built where the mesh
 * is built (`tileMeshing.ts`, on the mesh worker), from the packed vertices
 * the mesher already wrote — and a coarse grid over them so a query looks at
 * the few units near its point. Landmark models, hand-made and taller than
 * any footprint prism, get the same index from their own triangles
 * ({@link surfaceVolumes}): a column per few metres, as tall as the model is
 * there.
 *
 * A unit is a vertical prism from its ground to its top. A footprint is the
 * convex hull of the unit's lowest vertices: exact for a convex footprint
 * (most buildings), a little generous for an L or a courtyard, never smaller
 * than the building. A part that starts in the air (a skybridge) is a prism
 * from the ground too: the eye goes over it, never under.
 *
 * Pure: typed arrays in, typed arrays out — no three.js, no DOM, no map
 * engine — so the mesh worker, the city engine and the tests share it, and
 * the native host will too.
 *
 * ## Units
 *
 * Positions are in the packed mesh's STORED units (`packing.ts`): `0…65535`
 * across the mesh, x east, y SOUTH, one unit `unitM` metres, stored `(0, 0)`
 * at `originM` in the owner's local ENU metres (y north). Tops are metres
 * above the ground the unit stands on, which the caller adds
 * (`VolumeQuery.anchorOf`): on 3D terrain every building stands on its own
 * ground (`terrainGround.ts`), so an absolute top is only known where the
 * drawn ground is.
 */
import { Z_UNITS_PER_METRE } from '../city3d/packing';

/** Stored units across a mesh's frame (`packing.ts`). */
const SPAN = 65_535;
/** Grid cells per side: 64² cells, ~14 m in a z15 city tile, ~29 m in a z14 basemap tile. */
const GRID = 64;
/** Stored units per grid cell. */
const CELL = 1024;
/** A vertex this close above a unit's lowest one is on its footprint, metres. */
const FOOT_M = 0.5;

/** One mesh's (or model's) buildings, as prisms, with a grid over them. */
export interface VolumeIndex {
  /** Metres per stored unit. */
  unitM: number;
  /** Local ENU metres of stored `(0, 0)`; stored y runs south. */
  originM: [number, number];
  /** Per unit: its footprint's vertices are `hull[2·hullStarts[u] … 2·hullStarts[u+1])`. */
  hullStarts: Uint32Array;
  /** Footprint vertices, `x, y` in stored units, counter-clockwise in the stored frame. */
  hull: Uint16Array;
  /** Per unit: its footprint's box in stored units, `minX, minY, maxX, maxY`. */
  box: Uint16Array;
  /** Per unit: its top, metres above its ground. */
  top: Float32Array;
  /** The grid: cell `c` (row-major, {@link GRID}² of {@link CELL} units) lists `cellUnits[cellStarts[c] … cellStarts[c+1])`. */
  cellStarts: Uint32Array;
  /** 16-bit while the index has at most 65,536 units (every tile measured), else 32-bit. */
  cellUnits: Uint16Array | Uint32Array;
  /** Per cell: the highest top of its units (0 for none). */
  cellTop: Float32Array;
  /** The highest top of all. */
  maxTop: number;
}

/** The arrays an index is made of, for a worker's transfer list. */
export function volumeTransferables(index: VolumeIndex): ArrayBuffer[] {
  return [
    index.hullStarts.buffer as ArrayBuffer,
    index.hull.buffer as ArrayBuffer,
    index.box.buffer as ArrayBuffer,
    index.top.buffer as ArrayBuffer,
    index.cellStarts.buffer as ArrayBuffer,
    index.cellUnits.buffer as ArrayBuffer,
    index.cellTop.buffer as ArrayBuffer,
  ];
}

/** Bytes an index holds. */
export function volumeBytes(index: VolumeIndex): number {
  return (
    index.hullStarts.byteLength +
    index.hull.byteLength +
    index.box.byteLength +
    index.top.byteLength +
    index.cellStarts.byteLength +
    index.cellUnits.byteLength +
    index.cellTop.byteLength
  );
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/** Growable scratch, reused across units and calls on one thread. */
let keys = new Uint32Array(256);
let hullScratch = new Int32Array(512);

/**
 * The convex hull of `n` packed points (`x·65536 + y`, any order, repeats
 * allowed), appended to `out` as `x, y` pairs, counter-clockwise in the
 * stored frame (Andrew's monotone chain on exact integers). Returns the
 * number of hull points (1 or 2 for a degenerate footprint).
 */
function appendHull(points: Uint32Array, n: number, out: number[]): number {
  const sorted = points.subarray(0, n).sort();
  // Unique points, unpacked into the scratch as x, y.
  let unique = 0;
  if (hullScratch.length < n * 4 + 8) hullScratch = new Int32Array(n * 4 + 8);
  const xs = hullScratch;
  const at = n * 2 + 4;
  for (let i = 0; i < n; i++) {
    if (i > 0 && sorted[i] === sorted[i - 1]) continue;
    xs[unique * 2] = Math.floor(sorted[i] / 65_536);
    xs[unique * 2 + 1] = sorted[i] % 65_536;
    unique++;
  }
  if (unique <= 2) {
    for (let i = 0; i < unique; i++) out.push(xs[i * 2], xs[i * 2 + 1]);
    return unique;
  }
  // The chain, as indices into the unique points.
  const chain = xs.subarray(at);
  let k = 0;
  const cross = (o: number, a: number, b: number) =>
    (xs[a * 2] - xs[o * 2]) * (xs[b * 2 + 1] - xs[o * 2 + 1]) -
    (xs[a * 2 + 1] - xs[o * 2 + 1]) * (xs[b * 2] - xs[o * 2]);
  for (let i = 0; i < unique; i++) {
    while (k >= 2 && cross(chain[k - 2], chain[k - 1], i) <= 0) k--;
    chain[k++] = i;
  }
  for (let i = unique - 2, lower = k + 1; i >= 0; i--) {
    while (k >= lower && cross(chain[k - 2], chain[k - 1], i) <= 0) k--;
    chain[k++] = i;
  }
  // The last point repeats the first.
  const count = k - 1;
  for (let i = 0; i < count; i++) out.push(xs[chain[i] * 2], xs[chain[i] * 2 + 1]);
  return count;
}

/**
 * The grid and boxes over finished hulls: the part of an index both builders
 * share.
 */
function finishIndex(
  unitM: number,
  originM: [number, number],
  hullStarts: Uint32Array,
  hull: Uint16Array,
  top: Float32Array,
): VolumeIndex {
  const units = top.length;
  const box = new Uint16Array(units * 4);
  const counts = new Uint32Array(GRID * GRID + 1);
  let maxTop = 0;
  for (let u = 0; u < units; u++) {
    let minX = SPAN;
    let minY = SPAN;
    let maxX = 0;
    let maxY = 0;
    for (let p = hullStarts[u]; p < hullStarts[u + 1]; p++) {
      const x = hull[p * 2];
      const y = hull[p * 2 + 1];
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    box[u * 4] = minX;
    box[u * 4 + 1] = minY;
    box[u * 4 + 2] = maxX;
    box[u * 4 + 3] = maxY;
    if (top[u] > maxTop) maxTop = top[u];
    if (minX > maxX) continue;
    for (let cy = (minY / CELL) | 0; cy <= ((maxY / CELL) | 0); cy++)
      for (let cx = (minX / CELL) | 0; cx <= ((maxX / CELL) | 0); cx++) counts[cy * GRID + cx]++;
  }
  const cellStarts = new Uint32Array(GRID * GRID + 1);
  for (let c = 0; c < GRID * GRID; c++) cellStarts[c + 1] = cellStarts[c] + counts[c];
  const cellUnits =
    units <= 65_536
      ? new Uint16Array(cellStarts[GRID * GRID])
      : new Uint32Array(cellStarts[GRID * GRID]);
  const cellTop = new Float32Array(GRID * GRID);
  const fill = cellStarts.slice(0, GRID * GRID);
  for (let u = 0; u < units; u++) {
    const minX = box[u * 4];
    const maxX = box[u * 4 + 2];
    if (minX > maxX) continue;
    for (let cy = (box[u * 4 + 1] / CELL) | 0; cy <= ((box[u * 4 + 3] / CELL) | 0); cy++) {
      for (let cx = (minX / CELL) | 0; cx <= ((maxX / CELL) | 0); cx++) {
        const c = cy * GRID + cx;
        cellUnits[fill[c]++] = u;
        if (top[u] > cellTop[c]) cellTop[c] = top[u];
      }
    }
  }
  return { unitM, originM, hullStarts, hull, box, top, cellStarts, cellUnits, cellTop, maxTop };
}

/** What {@link meshVolumes} reads of a packed mesh (`packing.ts` → `PackedMesh`). */
export interface VolumeSource {
  chunks: ReadonlyArray<{ position: Uint16Array }>;
  polygonStarts: Uint32Array;
  unitM: number;
  originM: readonly [number, number];
}

/**
 * How much one index may hold: the quality profile's `camera` knobs
 * (`lib/map/quality/profile.ts`), handed to the mesh worker with each tile.
 */
export interface VolumeLimits {
  /** The most bytes one tile's index may hold. */
  maxBytes: number;
  /** The most vertices of one footprint; a rounder one is its smallest enclosing rectangle. */
  maxFootprintVertices: number;
}

/** No limit: what the tests and a caller without a profile get. */
export const UNLIMITED_VOLUMES: VolumeLimits = {
  maxBytes: Number.POSITIVE_INFINITY,
  maxFootprintVertices: Number.POSITIVE_INFINITY,
};

/**
 * The most bytes an index of only grid cells can hold ({@link meshVolumes}'
 * last fallback): each of the {@link GRID}² cells a unit of four corners,
 * listed in up to four cells. A `maxBytes` under this cannot be honoured.
 */
export const CELL_INDEX_MAX_BYTES =
  GRID * GRID * (4 * 4 + 4 + 8 + 4 + 4 * 2) + (GRID * GRID + 1) * 4 + GRID * GRID * 4 + 4;

/**
 * Replace the `count` hull points at `out[from…]` (a flat `x, y` list) by
 * their smallest enclosing rectangle (rotating calipers over the hull's
 * edges), its corners rounded outward: never smaller than the footprint.
 */
function enclosingRectangle(out: number[], from: number, count: number): void {
  let best = Number.POSITIVE_INFINITY;
  let corners: number[] = [];
  for (let i = 0; i < count; i++) {
    const j = (i + 1) % count;
    const ex = out[from + j * 2] - out[from + i * 2];
    const ey = out[from + j * 2 + 1] - out[from + i * 2 + 1];
    const length = Math.hypot(ex, ey);
    if (length === 0) continue;
    const ux = ex / length;
    const uy = ey / length;
    let minA = Number.POSITIVE_INFINITY;
    let maxA = Number.NEGATIVE_INFINITY;
    let minB = Number.POSITIVE_INFINITY;
    let maxB = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < count; k++) {
      const x = out[from + k * 2];
      const y = out[from + k * 2 + 1];
      const a = x * ux + y * uy;
      const b = -x * uy + y * ux;
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
    const area = (maxA - minA) * (maxB - minB);
    if (area >= best) continue;
    best = area;
    // Back from (along the edge, across it) to (x, y), in the order
    // `appendHull` writes (positive turns).
    const at = (a: number, b: number) => [a * ux - b * uy, a * uy + b * ux];
    corners = [...at(minA, minB), ...at(maxA, minB), ...at(maxA, maxB), ...at(minA, maxB)];
  }
  if (corners.length === 0) return;
  const cx = (corners[0] + corners[4]) / 2;
  const cy = (corners[1] + corners[5]) / 2;
  const outward = (v: number, centre: number) =>
    Math.max(0, Math.min(SPAN, v < centre ? Math.floor(v) : Math.ceil(v)));
  out.length = from;
  for (let k = 0; k < 4; k++) {
    out.push(outward(corners[k * 2], cx), outward(corners[k * 2 + 1], cy));
  }
}

/** Every unit of an index as its smallest enclosing rectangle (the first fallback). */
function rectangles(index: VolumeIndex): VolumeIndex {
  const units = index.top.length;
  const hullStarts = new Uint32Array(units + 1);
  const hull: number[] = [];
  for (let u = 0; u < units; u++) {
    hullStarts[u] = hull.length / 2;
    const from = hull.length;
    const n = index.hullStarts[u + 1] - index.hullStarts[u];
    for (let p = index.hullStarts[u]; p < index.hullStarts[u + 1]; p++) {
      hull.push(index.hull[p * 2], index.hull[p * 2 + 1]);
    }
    if (n > 4) enclosingRectangle(hull, from, n);
  }
  hullStarts[units] = hull.length / 2;
  return finishIndex(index.unitM, index.originM, hullStarts, Uint16Array.from(hull), index.top);
}

/**
 * The grid's cells as the units, each as tall as its tallest building (the
 * last fallback): at most {@link GRID}² units whatever the tile holds, so
 * never more than {@link CELL_INDEX_MAX_BYTES}. Coarse — a street narrower
 * than a cell rises to its buildings — but bounded.
 */
function cells(index: VolumeIndex): VolumeIndex {
  const hull: number[] = [];
  const starts: number[] = [];
  const tops: number[] = [];
  for (let cy = 0; cy < GRID; cy++) {
    for (let cx = 0; cx < GRID; cx++) {
      const top = index.cellTop[cy * GRID + cx];
      if (top <= 0) continue;
      const x0 = cx * CELL;
      const y0 = cy * CELL;
      const x1 = Math.min(SPAN, x0 + CELL - 1);
      const y1 = Math.min(SPAN, y0 + CELL - 1);
      starts.push(hull.length / 2);
      hull.push(x0, y0, x1, y0, x1, y1, x0, y1);
      tops.push(top);
    }
  }
  starts.push(hull.length / 2);
  return finishIndex(
    index.unitM,
    index.originM,
    Uint32Array.from(starts),
    Uint16Array.from(hull),
    Float32Array.from(tops),
  );
}

/**
 * The volume index of a packed tile mesh: per unit (`polygonStarts`), the
 * convex hull of its lowest vertices — a rounder footprint than
 * `maxFootprintVertices` is its smallest enclosing rectangle — and its highest
 * `z`. An index over `maxBytes` falls back to every footprint's rectangle,
 * then to the grid's cells, so it never holds more (for any `maxBytes` of at
 * least {@link CELL_INDEX_MAX_BYTES}).
 *
 * Measured on the mesh worker: see `docs/MAP_CAMERA_CLEARANCE.md` → Cost.
 */
export function meshVolumes(
  mesh: VolumeSource,
  limits: VolumeLimits = UNLIMITED_VOLUMES,
): VolumeIndex {
  // The units' vertex runs cross chunk seams only in the abstract (every
  // mesh is one chunk today, `packing.ts`); joined, they never do.
  const position =
    mesh.chunks.length === 1
      ? mesh.chunks[0].position
      : (() => {
          const all = new Uint16Array(mesh.chunks.reduce((n, c) => n + c.position.length, 0));
          let at = 0;
          for (const chunk of mesh.chunks) {
            all.set(chunk.position, at);
            at += chunk.position.length;
          }
          return all;
        })();
  const vertices = position.length / 4;
  const starts = mesh.polygonStarts;
  const units = starts.length;
  const hullStarts = new Uint32Array(units + 1);
  const top = new Float32Array(units);
  const hull: number[] = [];
  // Inside the function: `packing.ts` imports this module too.
  const footZ = Math.round(FOOT_M * Z_UNITS_PER_METRE);
  for (let u = 0; u < units; u++) {
    const from = starts[u];
    const to = u + 1 < units ? starts[u + 1] : vertices;
    let minZ = 65_535;
    let maxZ = 0;
    for (let v = from; v < to; v++) {
      const z = position[v * 4 + 2];
      if (z < minZ) minZ = z;
      if (z > maxZ) maxZ = z;
    }
    let n = 0;
    if (keys.length < to - from) keys = new Uint32Array(Math.max(keys.length * 2, to - from));
    for (let v = from; v < to; v++) {
      if (position[v * 4 + 2] > minZ + footZ) continue;
      keys[n++] = position[v * 4] * 65_536 + position[v * 4 + 1];
    }
    hullStarts[u] = hull.length / 2;
    if (n > 0) {
      const at = hull.length;
      const count = appendHull(keys, n, hull);
      if (count > limits.maxFootprintVertices) enclosingRectangle(hull, at, count);
    }
    top[u] = to > from ? maxZ / Z_UNITS_PER_METRE : 0;
  }
  hullStarts[units] = hull.length / 2;
  const index = finishIndex(
    mesh.unitM,
    [mesh.originM[0], mesh.originM[1]],
    hullStarts,
    Uint16Array.from(hull),
    top,
  );
  if (volumeBytes(index) <= limits.maxBytes) return index;
  const boxed = rectangles(index);
  return volumeBytes(boxed) <= limits.maxBytes ? boxed : cells(index);
}

/** Columns lower than this are ground, a plinth or a lawn: not an obstacle. */
const MIN_COLUMN_M = 0.5;
/** Most samples along a triangle's side: a 1 km triangle is not a million points. */
const MAX_TRIANGLE_STEPS = 64;

/** One mesh of a model, in its metres: `x` east, `y` north, `z` up, origin at its anchor. */
export interface SurfaceMesh {
  positions: Float32Array;
  /** Triangles; `null`: every three vertices are one. */
  index: ArrayLike<number> | null;
}

/**
 * The volume index of a hand-made model, from its own triangles: one square
 * column per `cellM` cell it covers, as tall as the model is anywhere in that
 * cell. Each triangle is sampled at half a column's width (its corners and a
 * barycentric lattice), straight into the height raster, so a big flat roof
 * whose corners are far apart still marks every column under it. A spire is a
 * tall thin column beside a low nave, not one box as tall as the spire over
 * the whole church.
 */
export function surfaceVolumes(meshes: readonly SurfaceMesh[], cellM: number): VolumeIndex | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const { positions } of meshes) {
    for (let i = 0; i < positions.length; i += 3) {
      if (positions[i] < minX) minX = positions[i];
      if (positions[i] > maxX) maxX = positions[i];
      if (positions[i + 1] < minY) minY = positions[i + 1];
      if (positions[i + 1] > maxY) maxY = positions[i + 1];
    }
  }
  if (!(minX <= maxX)) return null;
  const cols = Math.max(1, Math.ceil((maxX - minX) / cellM + 1e-9));
  const rows = Math.max(1, Math.ceil((maxY - minY) / cellM + 1e-9));
  const heights = new Float32Array(cols * rows);
  const stepM = cellM / 2;
  for (const { positions: p, index } of meshes) {
    const triangles = index ? index.length / 3 : p.length / 9;
    for (let t = 0; t < triangles; t++) {
      const a = (index ? index[t * 3] : t * 3) * 3;
      const b = (index ? index[t * 3 + 1] : t * 3 + 1) * 3;
      const c = (index ? index[t * 3 + 2] : t * 3 + 2) * 3;
      // A triangle wholly under the lowest column marks nothing.
      if (Math.max(p[a + 2], p[b + 2], p[c + 2]) < MIN_COLUMN_M) continue;
      const edge = Math.max(
        Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1]),
        Math.hypot(p[c] - p[b], p[c + 1] - p[b + 1]),
        Math.hypot(p[a] - p[c], p[a + 1] - p[c + 1]),
      );
      const steps = Math.min(MAX_TRIANGLE_STEPS, Math.max(1, Math.ceil(edge / stepM)));
      for (let i = 0; i <= steps; i++) {
        for (let j = 0; j <= steps - i; j++) {
          const wb = i / steps;
          const wc = j / steps;
          const wa = 1 - wb - wc;
          const z = p[a + 2] * wa + p[b + 2] * wb + p[c + 2] * wc;
          if (z < MIN_COLUMN_M) continue;
          const x = p[a] * wa + p[b] * wb + p[c] * wc;
          const y = p[a + 1] * wa + p[b + 1] * wb + p[c + 1] * wc;
          const cx = Math.min(cols - 1, Math.floor((x - minX) / cellM));
          const cy = Math.min(rows - 1, Math.floor((maxY - y) / cellM));
          if (z > heights[cy * cols + cx]) heights[cy * cols + cx] = z;
        }
      }
    }
  }
  const unitM = Math.max(cols, rows) * (cellM / SPAN);
  const originM: [number, number] = [minX, maxY];
  const toUnit = (metres: number) => Math.max(0, Math.min(SPAN, Math.round(metres / unitM)));
  const hull: number[] = [];
  const starts: number[] = [];
  const tops: number[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const height = heights[cy * cols + cx];
      if (height < MIN_COLUMN_M) continue;
      const x0 = toUnit(cx * cellM);
      const x1 = toUnit((cx + 1) * cellM);
      const y0 = toUnit(cy * cellM);
      const y1 = toUnit((cy + 1) * cellM);
      starts.push(hull.length / 2);
      // The order `appendHull` writes: positive turns in the stored frame.
      hull.push(x0, y0, x1, y0, x1, y1, x0, y1);
      tops.push(height);
    }
  }
  starts.push(hull.length / 2);
  return finishIndex(
    unitM,
    originM,
    Uint32Array.from(starts),
    Uint16Array.from(hull),
    Float32Array.from(tops),
  );
}

// ---------------------------------------------------------------------------
// Querying
// ---------------------------------------------------------------------------

/**
 * Distance from a point to a unit's footprint, in stored units: 0 inside it.
 * The hull is convex and counter-clockwise, so "inside" is "left of (or on)
 * every edge".
 */
function footprintDistance(index: VolumeIndex, unit: number, x: number, y: number): number {
  const hull = index.hull;
  const from = index.hullStarts[unit];
  const n = index.hullStarts[unit + 1] - from;
  if (n === 0) return Infinity;
  if (n === 1) return Math.hypot(x - hull[from * 2], y - hull[from * 2 + 1]);
  let inside = n >= 3;
  let best = Infinity;
  for (let i = 0; i < n; i++) {
    const ax = hull[(from + i) * 2];
    const ay = hull[(from + i) * 2 + 1];
    const j = i + 1 === n ? 0 : i + 1;
    const bx = hull[(from + j) * 2];
    const by = hull[(from + j) * 2 + 1];
    const ex = bx - ax;
    const ey = by - ay;
    const px = x - ax;
    const py = y - ay;
    if (ex * py - ey * px < 0) inside = false;
    const length2 = ex * ex + ey * ey;
    const t = length2 > 0 ? Math.max(0, Math.min(1, (px * ex + py * ey) / length2)) : 0;
    const d = Math.hypot(px - t * ex, py - t * ey);
    if (d < best) best = d;
  }
  return inside ? 0 : best;
}

/** The camera rule's clearance around a prism (`clearance.ts`). */
export interface Clearance {
  /** Metres kept above every roof and beside every wall. */
  marginM: number;
  /**
   * Metres the required height falls per metre past the margin: the ramp that
   * makes the rule continuous (`clearance.ts` → `CAMERA_CLEARANCE.slope`).
   * `Infinity`: no ramp — only the prisms (and their margin) themselves.
   */
  slope: number;
}

/**
 * What a prism asks of an eye `d` metres from its footprint: its top plus the
 * margin within the margin, falling by the slope beyond it.
 */
export function prismRequirement(top: number, d: number, clearance: Clearance): number {
  const past = d - clearance.marginM;
  if (past <= 0) return top + clearance.marginM;
  if (clearance.slope === Infinity) return -Infinity;
  return top + clearance.marginM - clearance.slope * past;
}

/** One query against one index. */
export interface VolumeQuery {
  /** The point, in the index's stored units. */
  x: number;
  y: number;
  /** Metres per stored unit here (the index's own, times a model's scale). */
  unitM: number;
  /** Multiplies every top (a model's scale; 1 for a tile). */
  topScale: number;
  /** The ground a unit stands on, metres (its anchor on terrain; 0 on a flat map). */
  anchorOf(unit: number): number;
  /** No unit's ground is higher than this. */
  anchorMax: number;
}

/**
 * The height (metres, absolute) an eye at the query's point must reach to
 * clear every prism of the index, or `floor` if none asks more. Units that
 * cannot beat `floor` are not looked at: the grid's cell tops and the units'
 * boxes rule them out before any footprint is measured.
 */
export function requiredHeight(
  index: VolumeIndex,
  query: VolumeQuery,
  clearance: Clearance,
  floor: number,
): number {
  const { x, y, unitM, topScale, anchorMax } = query;
  const reachTop = anchorMax + index.maxTop * topScale + clearance.marginM;
  if (reachTop <= floor) return floor;
  const reachM =
    clearance.slope === Infinity
      ? clearance.marginM
      : clearance.marginM + (reachTop - floor) / clearance.slope;
  const reach = reachM / unitM;
  if (x < -reach || y < -reach || x > SPAN + reach || y > SPAN + reach) return floor;
  const cx0 = Math.max(0, Math.floor((x - reach) / CELL));
  const cy0 = Math.max(0, Math.floor((y - reach) / CELL));
  const cx1 = Math.min(GRID - 1, Math.floor((x + reach) / CELL));
  const cy1 = Math.min(GRID - 1, Math.floor((y + reach) / CELL));
  let best = floor;
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * GRID + cx;
      const from = index.cellStarts[c];
      const to = index.cellStarts[c + 1];
      if (from === to) continue;
      // Nothing in this cell can ask more than its tallest unit from its
      // nearest edge.
      const dx = Math.max(cx * CELL - x, 0, x - (cx + 1) * CELL);
      const dy = Math.max(cy * CELL - y, 0, y - (cy + 1) * CELL);
      const cellBound =
        anchorMax +
        prismRequirement(index.cellTop[c] * topScale, Math.hypot(dx, dy) * unitM, clearance);
      if (cellBound <= best) continue;
      for (let i = from; i < to; i++) {
        const u = index.cellUnits[i];
        const top = index.top[u] * topScale;
        const b = u * 4;
        const bx = Math.max(index.box[b] - x, 0, x - index.box[b + 2]);
        const by = Math.max(index.box[b + 1] - y, 0, y - index.box[b + 3]);
        if (anchorMax + prismRequirement(top, Math.hypot(bx, by) * unitM, clearance) <= best)
          continue;
        const d = footprintDistance(index, u, x, y) * unitM;
        const required = query.anchorOf(u) + prismRequirement(top, d, clearance);
        if (required > best) best = required;
      }
    }
  }
  return best;
}

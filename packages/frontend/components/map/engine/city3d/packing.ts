/**
 * The compact vertex format every city-3D tile mesh is uploaded in.
 *
 * The mesher (`mesher.ts`) builds in float32 metres because that is what its
 * geometry is easiest to reason about in. What the GPU gets is quantised, as
 * the design note's Phase 2 format proposes (`docs/MAP_3D_CITY.md` → "Geometry"):
 *
 * | attribute  | type        | per vertex | meaning                                   |
 * | ---------- | ----------- | ---------: | ----------------------------------------- |
 * | `position` | `uint16 ×4` |        8 B | x, y in tile units; z in 1/32 m; w shade  |
 * | `normal`   | `int8 ×4`   |        4 B | unit normal ×127; w the per-building flags (GoWay city tiles, `VERTEX_FLAG_*`; 0 otherwise) |
 * | index      | `uint16`/`uint32` | 2/4 B | 16-bit while a tile has ≤ 65,536 vertices |
 * | `color`    | `uint8 ×4`  |        4 B | GoWay city tiles only, as `osmMesher` set it |
 * | `facade`   | `uint16 ×4` |        8 B | GoWay city tiles only, as `osmMesher` set it |
 *  *
 * against float32 positions (12 B), `int8 ×3` normals (3 B), `uint8 ×2` shade
 * (2 B) and `uint32` indices (4 B) before. Measured on the dense Barcelona tile
 * (`docs/MAP_3D_CITY.md` → "Budgets"), the full-detail mesh goes from 26.2 MB
 * to 17.0 MB with the same vertices and triangles.
 *
 * ## The units, and why they lose nothing visible
 *
 *  - **x, y**: `0…65535` across the tile's side, so one unit is the tile size
 *    / 65,535 — 2.8 cm in Barcelona, 3.7 cm at the equator. `y` is stored
 *    SOUTHWARD (it is `-y` of the ENU frame, which is `<= 0` inside a tile).
 *  - **z**: 1/32 m (3.1 cm), so 65,535 units reach 2,048 m — taller than any
 *    building on Earth.
 *  - **w (shade)**: the mesher's two shade bytes, `tone × 256 + cornerAo`
 *    (tone: the building's height in metres; cornerAo: 0–255). The shader
 *    splits them back with one `floor`, exactly, since float32 holds every
 *    integer below 2²⁴.
 *
 * The quantisation is undone by the MODEL MATRIX, not the shader
 * ({@link quantizedModelMatrix}): the GPU multiplies the raw integers by a
 * matrix that already contains the unit sizes, so the vertex shader is the
 * same three multiplications it always was.
 *
 * ## One draw per tile
 *
 * A tile's mesh is ONE chunk — one draw call — with 16-bit indices while it
 * has at most 65,536 vertices and 32-bit indices past that (WebGL2 and WebGPU
 * both draw them natively). It used to be split into chunks of ≤ 65,535
 * vertices so every index fit in 16 bits; that cost nothing to `WebGLRenderer`
 * but about 10 µs of CPU a draw to three's `WebGPURenderer`, which the TSL
 * materials draw with (`docs/MAP_NATIVE_3D.md` → Phase 2, step 3: measured
 * before and after). The dense tile's indices grow by 2 bytes each; the
 * duplicated vertices the cuts copied are gone.
 */
import type { TileMesh } from './mesher';

/** The most vertices a 16-bit index can address; past it a tile's indices are 32-bit. */
const MAX_UINT16_VERTICES = 65_536;

/** A mesh's triangles in the narrowest index type its vertex count allows. */
function indexFor(
  values: ArrayLike<number>,
  length: number,
  vertices: number,
): Uint16Array | Uint32Array {
  const index = vertices <= MAX_UINT16_VERTICES ? new Uint16Array(length) : new Uint32Array(length);
  for (let i = 0; i < length; i++) index[i] = values[i];
  return index;
}

/** Units per metre of the stored `z`. */
export const Z_UNITS_PER_METRE = 32;

/** Highest storable height, in metres. */
export const MAX_HEIGHT_M = 65_535 / Z_UNITS_PER_METRE;

/** A tile mesh's buffers: one draw call (see "One draw per tile" above). */
export interface PackedChunk {
  /** `uint16 ×4` per vertex: x, y (tile units, y southward), z (1/32 m), shade. */
  position: Uint16Array;
  /** `int8 ×4` per vertex: unit normal ×127, w unused. */
  normal: Int8Array;
  /** Triangles into this chunk's vertices: 16-bit while they fit, else 32-bit. */
  index: Uint16Array | Uint32Array;
  /**
   * GoWay city tiles only (`osmMesher.ts`), carried through unchanged:
   * `[r, g, b, weight]` and `[bays×256, base dm, storey cm, count]` per vertex.
   */
  color?: Uint8Array;
  facade?: Uint16Array;
}

/** A float mesh, with the GoWay city tiles' extra lanes when it has them (`OsmTileMesh`). */
export type SourceMesh = TileMesh & {
  colors?: Uint8Array;
  facade?: Uint16Array;
  flags?: Uint8Array;
};

function chunkBytes(chunk: PackedChunk): number {
  return (
    chunk.position.byteLength +
    chunk.normal.byteLength +
    chunk.index.byteLength +
    (chunk.color?.byteLength ?? 0) +
    (chunk.facade?.byteLength ?? 0)
  );
}

/** A finished, compact tile mesh, ready to transfer out of the worker. */
export interface PackedMesh {
  chunks: PackedChunk[];
  /** Metres per x/y unit (the tile's side / 65,535, or the mesh's span when larger). */
  unitM: number;
  /**
   * Local ENU metres of stored `(0, 0)`. `[0, 0]` (the tile's north-west
   * corner) for meshes clipped to their tile; a GoWay city tile keeps each
   * building WHOLE in the tile of its centre, so its coordinates run past the
   * tile on any side, and its origin and unit are taken from the mesh's own
   * extent — clamping them to the tile square collapsed every building that
   * crossed an edge (PR #126 review).
   */
  originM: [number, number];
  vertices: number;
  triangles: number;
  /** Total buffer bytes, what the GPU will hold. */
  bytes: number;
  /** Axis-aligned bounds in the STORED units, for the renderer's culling. */
  bounds: { min: [number, number, number]; max: [number, number, number] };
  /** How many polygons produced geometry. */
  polygons: number;
  /** First source vertex of each unit placed on terrain (see `TileMesh.polygonStarts`). */
  polygonStarts: Uint32Array;
  /** Each unit's footprint box in local metres: `minX, minY, maxX, maxY`. */
  polygonBoxes: Float32Array;
  /** Per unit, 1 when its height is the 5 m default (`TileMesh.polygonHeightDefault`). */
  polygonHeightDefault: Uint8Array;
}

/** The buffers a packed mesh transfers (no copy) out of the worker. */
export function packedTransferables(mesh: PackedMesh): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  for (const chunk of mesh.chunks) {
    out.push(
      chunk.position.buffer as ArrayBuffer,
      chunk.normal.buffer as ArrayBuffer,
      chunk.index.buffer as ArrayBuffer,
    );
    if (chunk.color) out.push(chunk.color.buffer as ArrayBuffer);
    if (chunk.facade) out.push(chunk.facade.buffer as ArrayBuffer);
  }
  out.push(
    mesh.polygonStarts.buffer as ArrayBuffer,
    mesh.polygonBoxes.buffer as ArrayBuffer,
    mesh.polygonHeightDefault.buffer as ArrayBuffer,
  );
  return out;
}

/** Metres per stored x/y unit for a tile of this side. */
export function unitMetres(tileSizeMetres: number): number {
  return tileSizeMetres / 65_535;
}

/**
 * `model × Q`, where `Q` turns stored units back into local ENU metres:
 * `origin.x + x·unitM`, `origin.y − y·unitM` (stored southward), `z / 32`.
 * Column-major, float64.
 *
 * `model` is {@link tileModelMatrix}'s metres → centre-relative mercator.
 */
export function quantizedModelMatrix(
  model: ArrayLike<number>,
  unitM: number,
  originM: readonly [number, number] = [0, 0],
): number[] {
  const sx = unitM;
  const sy = -unitM;
  const sz = 1 / Z_UNITS_PER_METRE;
  // Q is diagonal plus a translation to the origin, so model × Q scales
  // model's first three columns and moves its fourth by model × origin.
  const out = Array.from(model);
  for (let row = 0; row < 4; row++) {
    out[12 + row] = model[row] * originM[0] + model[4 + row] * originM[1] + model[12 + row];
    out[row] *= sx;
    out[4 + row] *= sy;
    out[8 + row] *= sz;
  }
  return out;
}

const clampUnit = (value: number) => Math.max(0, Math.min(65_535, Math.round(value)));

/**
 * Appends quantised vertices and triangles into one chunk. Used directly by
 * the far-field mesher; vertices are kept in the order written, which is the
 * order `polygonStarts` indexes.
 */
export class PackedBuilder {
  private position = new Uint16Array(4 * 4096);
  private normal = new Int8Array(4 * 4096);
  private index = new Uint32Array(6 * 4096);
  private vertexCount = 0;
  private indexCount = 0;
  private readonly polygonStarts: number[] = [];
  private readonly polygonBoxes: number[] = [];
  private readonly polygonHeightDefault: number[] = [];
  private readonly min: [number, number, number] = [65_535, 65_535, 65_535];
  private readonly max: [number, number, number] = [0, 0, 0];
  private readonly inverseUnit: number;

  constructor(readonly unitM: number) {
    this.inverseUnit = 1 / unitM;
  }

  /** Vertices written so far: the index the next vertex gets. */
  get vertices(): number {
    return this.vertexCount;
  }

  /**
   * Start a unit placed on terrain (one polygon of a far level): its vertices
   * run from here to the next unit's start, and stand on its footprint's box.
   */
  beginPolygon(box: readonly [number, number, number, number], heightDefault = false): void {
    this.polygonStarts.push(this.vertexCount);
    this.polygonBoxes.push(...box);
    this.polygonHeightDefault.push(heightDefault ? 1 : 0);
  }

  /** One vertex in local ENU metres (`y <= 0`). Returns its index. */
  vertex(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    ao: number,
    tone: number,
  ): number {
    if ((this.vertexCount + 1) * 4 > this.position.length) {
      this.position = grow(this.position);
      this.normal = grow(this.normal);
    }
    const v = this.vertexCount++;
    const p = v * 4;
    const qx = clampUnit(x * this.inverseUnit);
    const qy = clampUnit(-y * this.inverseUnit);
    const qz = clampUnit(z * Z_UNITS_PER_METRE);
    this.position[p] = qx;
    this.position[p + 1] = qy;
    this.position[p + 2] = qz;
    this.position[p + 3] = (tone & 255) * 256 + Math.round(Math.max(0, Math.min(1, ao)) * 255);
    this.normal[p] = Math.round(nx * 127);
    this.normal[p + 1] = Math.round(ny * 127);
    this.normal[p + 2] = Math.round(nz * 127);
    this.trackBounds(qx, qy, qz);
    return v;
  }

  triangle(a: number, b: number, c: number): void {
    if (this.indexCount + 3 > this.index.length) this.index = grow(this.index);
    this.index[this.indexCount++] = a;
    this.index[this.indexCount++] = b;
    this.index[this.indexCount++] = c;
  }

  /** A quad from two bottom and two top vertices, counter-clockwise seen from its front. */
  quad(b0: number, b1: number, t1: number, t0: number): void {
    this.triangle(b0, b1, t1);
    this.triangle(b0, t1, t0);
  }

  finish(polygons: number): PackedMesh | null {
    if (this.vertexCount === 0 || this.indexCount === 0) return null;
    const chunk: PackedChunk = {
      position: this.position.slice(0, this.vertexCount * 4),
      normal: this.normal.slice(0, this.vertexCount * 4),
      index: indexFor(this.index, this.indexCount, this.vertexCount),
    };
    return {
      chunks: [chunk],
      unitM: this.unitM,
      originM: [0, 0],
      vertices: this.vertexCount,
      triangles: this.indexCount / 3,
      bytes: chunkBytes(chunk),
      bounds: { min: [...this.min], max: [...this.max] },
      polygons,
      polygonStarts: Uint32Array.from(this.polygonStarts),
      polygonBoxes: Float32Array.from(this.polygonBoxes),
      polygonHeightDefault: Uint8Array.from(this.polygonHeightDefault),
    };
  }

  private trackBounds(x: number, y: number, z: number): void {
    if (x < this.min[0]) this.min[0] = x;
    if (y < this.min[1]) this.min[1] = y;
    if (z < this.min[2]) this.min[2] = z;
    if (x > this.max[0]) this.max[0] = x;
    if (y > this.max[1]) this.max[1] = y;
    if (z > this.max[2]) this.max[2] = z;
  }
}

function grow<T extends Uint16Array | Uint32Array | Int8Array>(array: T): T {
  const next = new (array.constructor as new (length: number) => T)(array.length * 2);
  next.set(array);
  return next;
}

/**
 * The stored frame for a float mesh: the tile's own (origin at its north-west
 * corner, 65,535 units across it) when the mesh stays inside the tile, else
 * stretched to the mesh's extent so nothing is clamped (whole buildings of
 * GoWay city tiles). Exported for the tests.
 */
export function frameFor(
  mesh: TileMesh,
  tileSizeMetres: number,
): { unitM: number; originM: [number, number] } {
  const { min, max } = mesh.bounds;
  const originX = Math.min(0, min[0]);
  const originY = Math.max(0, max[1]);
  const span = Math.max(tileSizeMetres, max[0] - originX, originY - min[1]);
  return { unitM: span / 65_535, originM: [originX, originY] };
}

/** Copy a float mesh's vertices into the compact lanes, and its bounds in stored units. */
function copyVertices(
  mesh: SourceMesh,
  unitM: number,
  originM: readonly [number, number],
): { chunk: Omit<PackedChunk, 'index'>; bounds: PackedMesh['bounds'] } {
  const { positions, normals, shade, colors, facade, flags } = mesh;
  const count = positions.length / 3;
  const inverseUnit = 1 / unitM;
  const position = new Uint16Array(count * 4);
  const normal = new Int8Array(count * 4);
  const min: [number, number, number] = [65_535, 65_535, 65_535];
  const max: [number, number, number] = [0, 0, 0];
  for (let v = 0; v < count; v++) {
    const p = v * 3;
    const q = v * 4;
    const x = clampUnit((positions[p] - originM[0]) * inverseUnit);
    const y = clampUnit((originM[1] - positions[p + 1]) * inverseUnit);
    const z = clampUnit(positions[p + 2] * Z_UNITS_PER_METRE);
    position[q] = x;
    position[q + 1] = y;
    position[q + 2] = z;
    position[q + 3] = shade[v * 2 + 1] * 256 + shade[v * 2];
    normal[q] = normals[p];
    normal[q + 1] = normals[p + 1];
    normal[q + 2] = normals[p + 2];
    // The normal's spare lane carries the building's flags (≤ 63): a separate
    // one-byte lane is not a vertex format WebGPU's three backend reads.
    if (flags) normal[q + 3] = flags[v];
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return {
    chunk: {
      position,
      normal,
      // The city tiles' lanes are already per vertex, in vertex order.
      ...(colors ? { color: colors.slice(0, count * 4) } : {}),
      ...(facade ? { facade: facade.slice(0, count * 4) } : {}),
    },
    bounds: { min, max },
  };
}

/**
 * Repack a full-detail float mesh (`mesher.ts`, or `osmMesher.ts` with its
 * colour and facade lanes) into the compact format: one chunk, its vertices
 * in the mesh's order (what `polygonStarts` indexes).
 */
export function packMesh(mesh: SourceMesh, tileSizeMetres: number): PackedMesh {
  const { unitM, originM } = frameFor(mesh, tileSizeMetres);
  const { chunk: lanes, bounds } = copyVertices(mesh, unitM, originM);
  const vertices = lanes.position.length / 4;
  const chunk: PackedChunk = {
    ...lanes,
    index: indexFor(mesh.indices, mesh.indices.length, vertices),
  };
  return {
    chunks: [chunk],
    unitM,
    originM,
    vertices,
    triangles: mesh.indices.length / 3,
    bytes: chunkBytes(chunk),
    bounds,
    polygons: mesh.polygons,
    polygonStarts: mesh.polygonStarts.slice(),
    polygonBoxes: mesh.polygonBoxes.slice(),
    polygonHeightDefault:
      mesh.polygonHeightDefault?.slice() ?? new Uint8Array(mesh.polygonStarts.length),
  };
}

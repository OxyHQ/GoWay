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
 * | `normal`   | `int8 ×4`   |        4 B | unit normal ×127, padded to 4 bytes       |
 * | index      | `uint16`    |        2 B | per chunk of ≤ 65,535 vertices            |
 * | `color`    | `uint8 ×4`  |        4 B | GoWay city tiles only, as `osmMesher` set it |
 * | `facade`   | `uint16 ×4` |        8 B | GoWay city tiles only, as `osmMesher` set it |
 *
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
 * ## Chunks
 *
 * A dense tile has more than 65,535 vertices, and WebGL2 has no base-vertex
 * draw, so a tile is split into chunks that each fit 16-bit indices. Chunks
 * are cut at polygon boundaries where possible; a polygon that would not fit
 * the current chunk starts the next one. Barcelona's full-detail tile is 17
 * chunks, i.e. 17 draw calls — negligible beside the 616 k triangles.
 */
import type { TileMesh } from './mesher';

/** The largest vertex count a chunk may hold (16-bit indices). */
export const MAX_CHUNK_VERTICES = 65_535;

/** Units per metre of the stored `z`. */
export const Z_UNITS_PER_METRE = 32;

/** Highest storable height, in metres. */
export const MAX_HEIGHT_M = 65_535 / Z_UNITS_PER_METRE;

/** One draw call's worth of a tile mesh. */
export interface PackedChunk {
  /** `uint16 ×4` per vertex: x, y (tile units, y southward), z (1/32 m), shade. */
  position: Uint16Array;
  /** `int8 ×4` per vertex: unit normal ×127, w unused. */
  normal: Int8Array;
  /** Triangles into this chunk's vertices. */
  index: Uint16Array;
  /**
   * GoWay city tiles only (`osmMesher.ts`), carried through unchanged:
   * `[r, g, b, weight]` and `[bays×256, base dm, storey cm, count]` per vertex.
   */
  color?: Uint8Array;
  facade?: Uint16Array;
  /**
   * Where this chunk's vertices come from, in the mesh's vertex order (what
   * `polygonStarts` indexes): vertex `i` is source vertex `sourceStart + i`,
   * or `sourceIds[i]` when the chunk was repacked out of order. Kept on the
   * CPU only, for placing buildings on terrain (`terrainGround.ts`).
   */
  sourceStart: number;
  sourceIds?: Uint32Array;
}

/** A float mesh, with the GoWay city tiles' extra lanes when it has them (`OsmTileMesh`). */
export type SourceMesh = TileMesh & { colors?: Uint8Array; facade?: Uint16Array };

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
    if (chunk.sourceIds) out.push(chunk.sourceIds.buffer as ArrayBuffer);
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
 * Appends quantised vertices and triangles chunk by chunk. Used directly by
 * the far-field mesher, and by {@link packMesh} to repack a full-detail mesh.
 */
export class PackedBuilder {
  private readonly chunks: PackedChunk[] = [];
  private position = new Uint16Array(4 * 4096);
  private normal = new Int8Array(4 * 4096);
  private index = new Uint16Array(6 * 4096);
  private vertexCount = 0;
  private indexCount = 0;
  private totalVertices = 0;
  private totalTriangles = 0;
  private readonly polygonStarts: number[] = [];
  private readonly polygonBoxes: number[] = [];
  private readonly polygonHeightDefault: number[] = [];
  private readonly min: [number, number, number] = [65_535, 65_535, 65_535];
  private readonly max: [number, number, number] = [0, 0, 0];
  private readonly inverseUnit: number;

  constructor(readonly unitM: number) {
    this.inverseUnit = 1 / unitM;
  }

  /** Vertices in the chunk being filled. */
  get chunkVertices(): number {
    return this.vertexCount;
  }

  /**
   * Start a unit placed on terrain (one polygon of a far level): its vertices
   * run from here to the next unit's start, and stand on its footprint's box.
   */
  beginPolygon(box: readonly [number, number, number, number], heightDefault = false): void {
    this.polygonStarts.push(this.totalVertices + this.vertexCount);
    this.polygonBoxes.push(...box);
    this.polygonHeightDefault.push(heightDefault ? 1 : 0);
  }

  /**
   * Make room for `count` more vertices in ONE chunk, closing the current
   * chunk if they would not fit. A request larger than a whole chunk is the
   * caller's to split (it gets `false`).
   */
  reserve(count: number): boolean {
    if (count > MAX_CHUNK_VERTICES) return false;
    if (this.vertexCount + count > MAX_CHUNK_VERTICES) this.closeChunk();
    return true;
  }

  /**
   * One vertex in local ENU metres (`y <= 0`). Returns its index WITHIN the
   * current chunk. The caller must have {@link reserve}d room.
   */
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
    this.ensureVertexRoom();
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
    this.totalTriangles++;
  }

  /** A quad from two bottom and two top vertices, counter-clockwise seen from its front. */
  quad(b0: number, b1: number, t1: number, t0: number): void {
    this.triangle(b0, b1, t1);
    this.triangle(b0, t1, t0);
  }

  /** Close the chunk being filled (no-op when it is empty). */
  closeChunk(): void {
    if (this.vertexCount === 0) return;
    if (this.indexCount > 0) {
      this.chunks.push({
        position: this.position.slice(0, this.vertexCount * 4),
        normal: this.normal.slice(0, this.vertexCount * 4),
        index: this.index.slice(0, this.indexCount),
        sourceStart: this.totalVertices,
      });
    }
    // Vertices of a chunk with no triangles still count, so polygon starts
    // (taken from this running total) stay aligned with `sourceStart`.
    this.totalVertices += this.vertexCount;
    this.vertexCount = 0;
    this.indexCount = 0;
  }

  finish(polygons: number): PackedMesh | null {
    this.closeChunk();
    if (this.chunks.length === 0) return null;
    let bytes = 0;
    for (const chunk of this.chunks) bytes += chunkBytes(chunk);
    let vertices = 0;
    for (const chunk of this.chunks) vertices += chunk.position.length / 4;
    return {
      chunks: this.chunks,
      unitM: this.unitM,
      originM: [0, 0],
      vertices,
      triangles: this.totalTriangles,
      bytes,
      bounds: { min: [...this.min], max: [...this.max] },
      polygons,
      polygonStarts: Uint32Array.from(this.polygonStarts),
      polygonBoxes: Float32Array.from(this.polygonBoxes),
      polygonHeightDefault: Uint8Array.from(this.polygonHeightDefault),
    };
  }

  private ensureVertexRoom(): void {
    if (this.vertexCount >= MAX_CHUNK_VERTICES) {
      throw new Error('PackedBuilder: chunk full; reserve() before writing vertices');
    }
    if ((this.vertexCount + 1) * 4 > this.position.length) {
      this.position = grow(this.position);
      this.normal = grow(this.normal);
    }
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

function grow<T extends Uint16Array | Int8Array>(array: T): T {
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

/** How far below a cut a new range starts; see {@link packMesh}. */
const CHUNK_BACKTRACK = 256;

/**
 * Copy source vertices `ids` (or the range `[start, start + count)`) into one
 * chunk's buffers, and grow `bounds` over them.
 */
function copyVertices(
  mesh: SourceMesh,
  unitM: number,
  originM: readonly [number, number],
  count: number,
  idOf: (i: number) => number,
  bounds: { min: [number, number, number]; max: [number, number, number] },
): Omit<PackedChunk, 'index' | 'sourceStart' | 'sourceIds'> {
  const { positions, normals, shade, colors, facade } = mesh;
  const inverseUnit = 1 / unitM;
  const position = new Uint16Array(count * 4);
  const normal = new Int8Array(count * 4);
  const color = colors ? new Uint8Array(count * 4) : undefined;
  const lanes = facade ? new Uint16Array(count * 4) : undefined;
  const { min, max } = bounds;
  for (let i = 0; i < count; i++) {
    const v = idOf(i);
    const p = v * 3;
    const q = i * 4;
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
    if (color && colors) {
      color[q] = colors[v * 4];
      color[q + 1] = colors[v * 4 + 1];
      color[q + 2] = colors[v * 4 + 2];
      color[q + 3] = colors[v * 4 + 3];
    }
    if (lanes && facade) {
      lanes[q] = facade[v * 4];
      lanes[q + 1] = facade[v * 4 + 1];
      lanes[q + 2] = facade[v * 4 + 2];
      lanes[q + 3] = facade[v * 4 + 3];
    }
    if (x < min[0]) min[0] = x;
    if (y < min[1]) min[1] = y;
    if (z < min[2]) min[2] = z;
    if (x > max[0]) max[0] = x;
    if (y > max[1]) max[1] = y;
    if (z > max[2]) max[2] = z;
  }
  return { position, normal, ...(color ? { color } : {}), ...(lanes ? { facade: lanes } : {}) };
}

function finishPacked(
  mesh: TileMesh,
  unitM: number,
  originM: [number, number],
  chunks: PackedChunk[],
  bounds: PackedMesh['bounds'],
): PackedMesh {
  let vertices = 0;
  let bytes = 0;
  for (const chunk of chunks) {
    vertices += chunk.position.length / 4;
    bytes += chunkBytes(chunk);
  }
  return {
    chunks,
    unitM,
    originM,
    vertices,
    triangles: mesh.indices.length / 3,
    bytes,
    bounds,
    polygons: mesh.polygons,
    polygonStarts: mesh.polygonStarts.slice(),
    polygonBoxes: mesh.polygonBoxes.slice(),
    polygonHeightDefault:
      mesh.polygonHeightDefault?.slice() ?? new Uint8Array(mesh.polygonStarts.length),
  };
}

/**
 * Repack a full-detail float mesh (`mesher.ts`, or `osmMesher.ts` with its
 * colour and facade lanes) into chunks of the compact format.
 *
 * The mesher emits each polygon's vertices and then the triangles that use
 * them, so the LOWEST index a triangle references barely moves backward along
 * the index buffer. That makes the fast path a range copy: a chunk is the
 * source vertex range its triangles touch, copied in one tight loop, its
 * indices offset by the range start. When the next triangle would reach past
 * {@link MAX_CHUNK_VERTICES} from the start, the chunk is closed and the next
 * starts a small margin below that triangle's lowest vertex (a polygon
 * straddling the cut has its shared vertices copied twice). A mesh that steps
 * back further than the margin falls back to {@link packMeshGeneral}.
 */
export function packMesh(mesh: SourceMesh, tileSizeMetres: number): PackedMesh {
  const { unitM, originM } = frameFor(mesh, tileSizeMetres);
  const { indices } = mesh;
  const ranges: { start: number; end: number; firstIndex: number; lastIndex: number }[] = [];
  let start = 0;
  let maxSeen = -1;
  let firstIndex = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t];
    const b = indices[t + 1];
    const c = indices[t + 2];
    const lo = Math.min(a, b, c);
    const hi = Math.max(a, b, c);
    if (lo < start) return packMeshGeneral(mesh, tileSizeMetres);
    if (hi - start >= MAX_CHUNK_VERTICES && maxSeen >= 0) {
      ranges.push({ start, end: maxSeen + 1, firstIndex, lastIndex: t });
      // A wall's quad reaches back one column and a polygon's later
      // triangles a little further, so the new range starts a margin below
      // this triangle (a few vertices copied twice, never a fallback).
      start = Math.max(0, lo - CHUNK_BACKTRACK);
      maxSeen = -1;
      firstIndex = t;
    }
    if (hi - start >= MAX_CHUNK_VERTICES) return packMeshGeneral(mesh, tileSizeMetres);
    if (hi > maxSeen) maxSeen = hi;
  }
  if (maxSeen >= 0) ranges.push({ start, end: maxSeen + 1, firstIndex, lastIndex: indices.length });

  const bounds: PackedMesh['bounds'] = { min: [65_535, 65_535, 65_535], max: [0, 0, 0] };
  const chunks = ranges.map((range) => {
    const vertices = copyVertices(
      mesh,
      unitM,
      originM,
      range.end - range.start,
      (i) => range.start + i,
      bounds,
    );
    const index = new Uint16Array(range.lastIndex - range.firstIndex);
    for (let i = range.firstIndex, j = 0; i < range.lastIndex; i++, j++) {
      index[j] = indices[i] - range.start;
    }
    return { ...vertices, index, sourceStart: range.start };
  });
  return finishPacked(mesh, unitM, originM, chunks, bounds);
}

/**
 * The general repack: walks the triangles and gives each vertex a slot in the
 * current chunk the first time a triangle there uses it, closing the chunk
 * when the next triangle would not fit. Any index order works.
 */
export function packMeshGeneral(mesh: SourceMesh, tileSizeMetres: number): PackedMesh {
  const { unitM, originM } = frameFor(mesh, tileSizeMetres);
  const { indices } = mesh;
  const vertexCount = mesh.positions.length / 3;
  // Per source vertex: the chunk it was given a slot in, and the slot.
  const generation = new Int32Array(vertexCount).fill(-1);
  const slot = new Int32Array(vertexCount);
  const bounds: PackedMesh['bounds'] = { min: [65_535, 65_535, 65_535], max: [0, 0, 0] };
  const chunks: PackedChunk[] = [];
  let ids: number[] = [];
  let index: number[] = [];
  const close = () => {
    if (index.length === 0) return;
    const chosen = ids;
    chunks.push({
      ...copyVertices(mesh, unitM, originM, chosen.length, (i) => chosen[i], bounds),
      index: Uint16Array.from(index),
      sourceStart: 0,
      sourceIds: Uint32Array.from(chosen),
    });
    ids = [];
    index = [];
  };
  const place = (v: number) => {
    if (generation[v] !== chunks.length) {
      generation[v] = chunks.length;
      slot[v] = ids.length;
      ids.push(v);
    }
    index.push(slot[v]);
  };
  for (let t = 0; t < indices.length; t += 3) {
    const tri = [indices[t], indices[t + 1], indices[t + 2]];
    const needed = new Set(tri.filter((v) => generation[v] !== chunks.length)).size;
    if (ids.length + needed > MAX_CHUNK_VERTICES) close();
    for (const v of tri) place(v);
  }
  close();
  return finishPacked(mesh, unitM, originM, chunks, bounds);
}

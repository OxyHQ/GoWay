/**
 * The street meshes' vertex formats and the growable buffers the mesher fills
 * (`streetMesher.ts`), shared with the renderer that uploads them
 * (`streetRenderer.ts`). Types and plain arrays only — no three.js — so the
 * worker bundle stays free of it.
 *
 * Two meshes per tile, two draw calls:
 *
 * - **Surfaces** (opaque, depth-written): asphalt, paving, sidewalk slabs and
 *   their kerb faces. `position` (3 × f32, tile-local metres, x east, y north,
 *   z above ground before grounding, absolute elevation after) and `attr`
 *   (4 × u8/u16: material, shade, category, bridge span).
 * - **Markings** (blended over the surfaces, no depth write): tints, lines,
 *   and SDF quads. `position` (3 × f32: a line's CENTRE point), `offset`
 *   (2 × f32: half the line's width across it, metres — the shader widens
 *   it to a pixel when it is thinner, trading width for alpha), `uv` (2 × f32:
 *   across-coordinate ±1 for a line, atlas texels for an SDF quad) and `attr`
 *   (4 × u8/u16: colour, mode, category, bridge span).
 *
 * Each index buffer holds the SIMPLE level first and the FULL level after it
 * (`simpleCount` indices): the renderer draws the first range only where the
 * street is between z16 and z17 on screen, both from z17 (`docs/MAP_STREETS.md`
 * → Levels of detail).
 */

export const SURFACE = { asphalt: 0, sidewalk: 1, kerb: 2, paving: 3 } as const;
export const PAINT = { white: 0, yellow: 1, bus: 2, cycle: 3, crossing: 4 } as const;
export const MODE = { flat: 0, line: 1, sdf: 2 } as const;
/** Surface categories retained in the mesh format (not clip-depth offsets). */
export const LAYER = { paving: 0, asphalt: 1, sidewalk: 2, tint: 3, paint: 4 } as const;

export interface PackedSurfaces {
  positions: Float32Array;
  attrs: Uint8Array | Uint16Array;
  indices: Uint32Array;
  simpleCount: number;
  /** Mapped bridge centrelines; attr.w is one-based, zero is ordinary ground. */
  bridges?: [number, number][][];
  /** Complete corridor and junction rings, before tile ownership clips them. */
  bridgeDomains?: [number, number][][][];
}

export interface PackedMarkings {
  positions: Float32Array;
  offsets: Float32Array;
  uvs: Float32Array;
  attrs: Uint8Array | Uint16Array;
  indices: Uint32Array;
  simpleCount: number;
}

/** Plain growable arrays for one level of one mesh. */
export class Buffers {
  positions: number[] = [];
  offsets: number[] = [];
  uvs: number[] = [];
  attrs: number[] = [];
  indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  vertex(
    x: number,
    y: number,
    z: number,
    attr: readonly number[],
    offset?: readonly number[],
    uv?: readonly number[],
  ): number {
    const index = this.vertexCount;
    this.positions.push(x, y, z);
    this.attrs.push(attr[0], attr[1], attr[2], attr[3] ?? 0);
    if (offset) this.offsets.push(offset[0], offset[1]);
    if (uv) this.uvs.push(uv[0], uv[1]);
    return index;
  }

  triangle(a: number, b: number, c: number): void {
    this.indices.push(a, b, c);
  }
}

/**
 * Bound every surface triangle in both horizontal directions. Subdividing
 * only a road's centreline leaves wide asphalt and entire junction polygons
 * as long chords through the terrain. Shared edge midpoints keep the mesh
 * connected; material and depth layer are constant within each triangle.
 */
export function subdivideSurfaces(buffer: Buffers, stepM: number): void {
  const indices: number[] = [];
  const midpoints = new Map<string, number>();
  const distance2 = (a: number, b: number) =>
    (buffer.positions[a * 3] - buffer.positions[b * 3]) ** 2 +
    (buffer.positions[a * 3 + 1] - buffer.positions[b * 3 + 1]) ** 2;
  const split = (a: number, b: number, c: number): void => {
    const ab = distance2(a, b);
    const bc = distance2(b, c);
    const ca = distance2(c, a);
    if (Math.max(ab, bc, ca) <= stepM * stepM) {
      indices.push(a, b, c);
      return;
    }
    if (bc > ab && bc >= ca) [a, b, c] = [b, c, a];
    else if (ca > ab && ca > bc) [a, b, c] = [c, a, b];
    const key = a < b ? `${a}/${b}` : `${b}/${a}`;
    let mid = midpoints.get(key);
    if (mid === undefined) {
      mid = buffer.vertex(
        (buffer.positions[a * 3] + buffer.positions[b * 3]) / 2,
        (buffer.positions[a * 3 + 1] + buffer.positions[b * 3 + 1]) / 2,
        (buffer.positions[a * 3 + 2] + buffer.positions[b * 3 + 2]) / 2,
        buffer.attrs.slice(a * 4, a * 4 + 4),
        buffer.offsets.length
          ? [
              (buffer.offsets[a * 2] + buffer.offsets[b * 2]) / 2,
              (buffer.offsets[a * 2 + 1] + buffer.offsets[b * 2 + 1]) / 2,
            ]
          : undefined,
        buffer.uvs.length
          ? [
              (buffer.uvs[a * 2] + buffer.uvs[b * 2]) / 2,
              (buffer.uvs[a * 2 + 1] + buffer.uvs[b * 2 + 1]) / 2,
            ]
          : undefined,
      );
      midpoints.set(key, mid);
    }
    split(a, mid, c);
    split(mid, b, c);
  };
  for (let i = 0; i < buffer.indices.length; i += 3) {
    split(buffer.indices[i], buffer.indices[i + 1], buffer.indices[i + 2]);
  }
  buffer.indices = indices;
}

/** Two levels of one mesh, packed: the simple level's indices first. */
function concat(simple: Buffers[], full: Buffers[]) {
  const all = [...simple, ...full];
  let vertices = 0;
  let indexCount = 0;
  for (const b of all) {
    vertices += b.vertexCount;
    indexCount += b.indices.length;
  }
  const positions = new Float32Array(vertices * 3);
  const offsets = new Float32Array(vertices * 2);
  const uvs = new Float32Array(vertices * 2);
  const AttrArray = all.some((b) => b.attrs.some((v) => v > 255)) ? Uint16Array : Uint8Array;
  const attrs = new AttrArray(vertices * 4);
  const indices = new Uint32Array(indexCount);
  let v = 0;
  let i = 0;
  let simpleCount = 0;
  for (const [n, b] of all.entries()) {
    positions.set(b.positions, v * 3);
    if (b.offsets.length) offsets.set(b.offsets, v * 2);
    if (b.uvs.length) uvs.set(b.uvs, v * 2);
    attrs.set(b.attrs, v * 4);
    for (const index of b.indices) indices[i++] = index + v;
    v += b.vertexCount;
    if (n === simple.length - 1) simpleCount = i;
  }
  if (simple.length === 0) simpleCount = 0;
  return { positions, offsets, uvs, attrs, indices, simpleCount };
}

export function packSurfaces(simple: Buffers[], full: Buffers[]): PackedSurfaces {
  const { positions, attrs, indices, simpleCount } = concat(simple, full);
  return { positions, attrs, indices, simpleCount };
}

export function packMarkings(simple: Buffers[], full: Buffers[]): PackedMarkings {
  return concat(simple, full);
}

/** Asphalt surface thickness above the common terrain, metres. */
export const STREET_LIFT_M = 0.06;
/** Half a line's drawn width never goes under this many device pixels. */
export const MIN_HALF_PX = 0.6;

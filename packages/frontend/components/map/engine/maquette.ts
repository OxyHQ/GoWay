/**
 * The maquette builders — rounded superellipsoid solids with smooth normals,
 * short wheels — shared by city life's simulated fleet
 * (`cityLife/agentModels.ts`) and GoWay Live's real vehicles
 * (`live3d/liveModels.ts`), so the two look like one model railway. Plain
 * arrays, no renderer. Moved here from `agentModels.ts` unchanged so neither
 * feature imports the other.
 */

/** The part id wheels are written with (`PART.tyre` in `agentModels.ts`). */
export const TYRE = 2;

export interface ModelGeometry {
  positions: Float32Array;
  normals: Float32Array;
  parts: Float32Array;
  indices: Uint16Array;
  /** Nominal length, metres (what a car's `length` style of 1 is scaled from). */
  length: number;
  /** Footprint half-extents for the contact shadow, metres. */
  halfLength: number;
  halfWidth: number;
}

export interface Builder {
  positions: number[];
  normals: number[];
  parts: number[];
  indices: number[];
}

export const builder = (): Builder => ({ positions: [], normals: [], parts: [], indices: [] });

/** `sign(t)·|t|^e`, the superellipse's signed power. */
const spow = (t: number, e: number) => Math.sign(t) * Math.abs(t) ** e;

export interface SuperellipsoidSpec {
  /** Centre, metres. */
  at: [number, number, number];
  /** Half-extents: length, width, height. */
  radii: [number, number, number];
  /** Roundness along the height (latitude) and around the plan (longitude): 0 box … 1 ellipsoid. */
  round: [number, number];
  /** Segments around the plan, and from bottom to top. */
  segments: [number, number];
  /** Narrows the top: at the top the plan is `(1 − taper)` of the bottom's. */
  taper?: number;
  /** Moves the top along x by this many metres (a raked windscreen leans back: negative). */
  lean?: number;
  /** The part of a vertex, from its position and (smooth) normal. */
  part: (p: [number, number, number], n: [number, number, number]) => number;
}

/**
 * A superellipsoid on a latitude–longitude grid, its seam shared and its two
 * poles single vertices, with smooth normals averaged from the final (tapered,
 * leaned) faces.
 */
export function superellipsoid(b: Builder, spec: SuperellipsoidSpec): void {
  const [nu, nv] = spec.segments;
  const [cx, cy, cz] = spec.at;
  const [rx, ry, rz] = spec.radii;
  const [e1, e2] = spec.round;
  const taper = spec.taper ?? 0;
  const lean = spec.lean ?? 0;
  const base = b.positions.length / 3;
  const points: [number, number, number][] = [];
  const index = (i: number, j: number) => {
    if (j === 0) return base;
    if (j === nv) return base + 1 + (nv - 1) * nu;
    return base + 1 + (j - 1) * nu + (i % nu);
  };
  const vertex = (u: number, v: number): [number, number, number] => {
    const cv = spow(Math.cos(v), e1);
    const sv = spow(Math.sin(v), e1);
    const up = (sv + 1) / 2; // 0 at the bottom, 1 at the top
    const shrink = 1 - taper * up;
    return [
      cx + rx * shrink * cv * spow(Math.cos(u), e2) + lean * up,
      cy + ry * shrink * cv * spow(Math.sin(u), e2),
      cz + rz * sv,
    ];
  };
  points.push(vertex(0, -Math.PI / 2));
  for (let j = 1; j < nv; j++) {
    const v = -Math.PI / 2 + (Math.PI * j) / nv;
    for (let i = 0; i < nu; i++) points.push(vertex((2 * Math.PI * i) / nu, v));
  }
  points.push(vertex(0, Math.PI / 2));

  const faces: [number, number, number][] = [];
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = index(i, j);
      const bb = index(i + 1, j);
      const c = index(i + 1, j + 1);
      const d = index(i, j + 1);
      // Counter-clockwise from outside: u runs anticlockwise seen from above,
      // v runs upwards. The bottom and top rows are fans around their pole.
      if (j === 0) faces.push([a, c, d]);
      else if (j === nv - 1) faces.push([a, bb, c]);
      else faces.push([a, bb, c], [a, c, d]);
    }
  }
  addSmooth(b, points, faces, base, spec.part);
}

/** A short cylinder along y (a wheel): smooth tread, flat faces. */
export function wheel(
  b: Builder,
  at: [number, number, number],
  radius: number,
  width: number,
  segments: number,
): void {
  const [cx, cy, cz] = at;
  const half = width / 2;
  // Tread: smooth normals around.
  const tread = b.positions.length / 3;
  for (let i = 0; i <= segments; i++) {
    const a = (2 * Math.PI * i) / segments;
    const x = Math.cos(a);
    const z = Math.sin(a);
    for (const side of [-1, 1]) {
      b.positions.push(cx + x * radius, cy + side * half, cz + z * radius);
      b.normals.push(x, 0, z);
      b.parts.push(TYRE);
    }
  }
  for (let i = 0; i < segments; i++) {
    const k = tread + i * 2;
    // Around +y the angle runs from x towards z: outward faces wind (k, k+2, k+3, k+1).
    b.indices.push(k, k + 1, k + 3, k, k + 3, k + 2);
  }
  // Two flat faces.
  for (const side of [-1, 1]) {
    const centre = b.positions.length / 3;
    b.positions.push(cx, cy + side * half, cz);
    b.normals.push(0, side, 0);
    b.parts.push(TYRE);
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      b.positions.push(cx + Math.cos(a) * radius, cy + side * half, cz + Math.sin(a) * radius);
      b.normals.push(0, side, 0);
      b.parts.push(TYRE);
    }
    for (let i = 0; i < segments; i++) {
      const p = centre + 1 + i;
      const q = centre + 1 + ((i + 1) % segments);
      if (side > 0) b.indices.push(centre, q, p);
      else b.indices.push(centre, p, q);
    }
  }
}

/** Append faces with per-vertex normals averaged (area-weighted) from them. */
function addSmooth(
  b: Builder,
  points: [number, number, number][],
  faces: [number, number, number][],
  base: number,
  partOf: SuperellipsoidSpec['part'],
): void {
  const normals = points.map(() => [0, 0, 0]);
  for (const [i, j, k] of faces) {
    const p = points[i - base];
    const q = points[j - base];
    const r = points[k - base];
    const ux = q[0] - p[0];
    const uy = q[1] - p[1];
    const uz = q[2] - p[2];
    const vx = r[0] - p[0];
    const vy = r[1] - p[1];
    const vz = r[2] - p[2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    for (const v of [i, j, k]) {
      const acc = normals[v - base];
      acc[0] += n[0];
      acc[1] += n[1];
      acc[2] += n[2];
    }
  }
  points.forEach((p, index) => {
    const n = normals[index];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    const unit: [number, number, number] = [n[0] / len, n[1] / len, n[2] / len];
    b.positions.push(...p);
    b.normals.push(...unit);
    b.parts.push(partOf(p, unit));
  });
  for (const face of faces) b.indices.push(...face);
}

export function finish(
  b: Builder,
  length: number,
  halfLength: number,
  halfWidth: number,
): ModelGeometry {
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    parts: Float32Array.from(b.parts),
    indices: Uint16Array.from(b.indices),
    length,
    halfLength,
    halfWidth,
  };
}

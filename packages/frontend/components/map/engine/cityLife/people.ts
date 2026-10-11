/**
 * City life's people: soft, rounded maquette walkers — two legs that swing,
 * a capsule body and a round head, each a superellipsoid (a shape between a
 * box and an ellipsoid, every edge rounded) with smooth normals. Built here
 * as plain arrays, uploaded once, instanced by `lifeRenderer.ts`.
 *
 * The people city life drew before the model library (#130), restored as its
 * pedestrians: the library's vehicles stay the kits' (`../vehicles/`), but
 * people read better at street zooms as these simple figures than as the
 * kit's big-headed characters. Generic forms only: no textures, no faces.
 *
 * The shader (`lifeShaders.ts`) reads {@link PERSON_PART}: legs swing about
 * the hip with the distance walked between two states, so a person waiting at
 * a kerb stands still (with a slight idle sway); clothes take the person's
 * colour and skin one of five tones, both per instance.
 *
 * Local metres, x FORWARD, y LEFT, z UP, origin on the ground at the person's
 * centre. Faces wind counter-clockwise seen from OUTSIDE; the engine's
 * mirrored model matrix makes three call those back faces, hence `BackSide`.
 */

/** What the shader colours (and moves) a vertex as. */
export const PERSON_PART = {
  legLeft: 3,
  legRight: 4,
  skin: 5,
  clothes: 6,
} as const;

/** Height of the hip the legs swing about, metres. */
export const PERSON_HIP_M = 0.88;

export interface PersonGeometry {
  positions: Float32Array;
  normals: Float32Array;
  parts: Float32Array;
  indices: Uint16Array;
}

interface Builder {
  positions: number[];
  normals: number[];
  parts: number[];
  indices: number[];
}

interface Superellipsoid {
  /** Centre, metres. */
  at: [number, number, number];
  /** Half-extents: length, width, height. */
  radii: [number, number, number];
  /** Roundness along the height and around the plan: 0 box … 1 ellipsoid. */
  round: [number, number];
  /** Segments around the plan, and from bottom to top. */
  segments: [number, number];
  /** The part of a vertex, from its position. */
  part: (p: [number, number, number]) => number;
}

/** `sign(t)·|t|^e`, the superellipse's signed power. */
const spow = (t: number, e: number) => Math.sign(t) * Math.abs(t) ** e;

/**
 * A superellipsoid on a latitude–longitude grid, its seam shared and its two
 * poles single vertices, with smooth normals averaged from its faces.
 */
function superellipsoid(b: Builder, spec: Superellipsoid): void {
  const [nu, nv] = spec.segments;
  const [cx, cy, cz] = spec.at;
  const [rx, ry, rz] = spec.radii;
  const [e1, e2] = spec.round;
  const base = b.positions.length / 3;
  const points: [number, number, number][] = [];
  const index = (i: number, j: number) => {
    if (j === 0) return base;
    if (j === nv) return base + 1 + (nv - 1) * nu;
    return base + 1 + (j - 1) * nu + (i % nu);
  };
  const vertex = (u: number, v: number): [number, number, number] => {
    const cv = spow(Math.cos(v), e1);
    return [
      cx + rx * cv * spow(Math.cos(u), e2),
      cy + ry * cv * spow(Math.sin(u), e2),
      cz + rz * spow(Math.sin(v), e1),
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
  // Smooth normals, area-weighted from the faces.
  const normals = points.map(() => [0, 0, 0]);
  for (const [i, j, k] of faces) {
    const p = points[i - base];
    const q = points[j - base];
    const r = points[k - base];
    const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]];
    const w = [r[0] - p[0], r[1] - p[1], r[2] - p[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    for (const vtx of [i, j, k]) {
      const acc = normals[vtx - base];
      acc[0] += n[0];
      acc[1] += n[1];
      acc[2] += n[2];
    }
  }
  points.forEach((p, i) => {
    const n = normals[i];
    const len = Math.hypot(n[0], n[1], n[2]) || 1;
    b.positions.push(...p);
    b.normals.push(n[0] / len, n[1] / len, n[2] / len);
    b.parts.push(spec.part(p));
  });
  for (const face of faces) b.indices.push(...face);
}

/** A person, ~1.72 m, facing +x: two rounded legs, a capsule body, a round head. */
export function person(detail: 'near' | 'far'): PersonGeometry {
  const b: Builder = { positions: [], normals: [], parts: [], indices: [] };
  if (detail === 'far') {
    superellipsoid(b, {
      at: [0, 0, 0.86],
      radii: [0.15, 0.2, 0.86],
      round: [0.8, 0.9],
      segments: [6, 4],
      part: (p) => (p[2] > 1.5 ? PERSON_PART.skin : PERSON_PART.clothes),
    });
  } else {
    for (const [y, part] of [
      [0.085, PERSON_PART.legLeft],
      [-0.085, PERSON_PART.legRight],
    ] as const) {
      superellipsoid(b, {
        at: [0, y, 0.45],
        radii: [0.075, 0.07, 0.46],
        round: [0.7, 1],
        segments: [6, 4],
        part: () => part,
      });
    }
    superellipsoid(b, {
      at: [0, 0, 1.15],
      radii: [0.13, 0.2, 0.33],
      round: [0.75, 0.9],
      segments: [10, 6],
      part: () => PERSON_PART.clothes,
    });
    superellipsoid(b, {
      at: [0.01, 0, 1.6],
      radii: [0.1, 0.09, 0.115],
      round: [1, 1],
      segments: [8, 6],
      part: () => PERSON_PART.skin,
    });
  }
  return {
    positions: Float32Array.from(b.positions),
    normals: Float32Array.from(b.normals),
    parts: Float32Array.from(b.parts),
    indices: Uint16Array.from(b.indices),
  };
}

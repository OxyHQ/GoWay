/**
 * Soft, rounded maquette vehicles and people — built here as plain arrays,
 * uploaded once, and instanced by `lifeRenderer.ts` hundreds of times per draw.
 *
 * ## The look
 *
 * Toy cars, not CAD: every body and cabin is a SUPERELLIPSOID — the shape
 * `|x/a|^(2/e₂) + |y/b|^(2/e₂)` lofted against `|z/c|^(2/e₁)` — whose exponents
 * sit between a box (0) and an ellipsoid (1). At ~0.3–0.5 that is a box with
 * every edge and corner rounded, with no point anywhere: the ends of a car are
 * a soft rounded face, not the tapered wedge the first fleet had. The cabin is
 * a second, narrower one standing on the body (so its tinted glass sits inset
 * from the body's flanks), with a painted roof; wheels are short cylinders set
 * into the body's underside. Normals are SMOOTH — each vertex the average of
 * the faces around it — so nothing reads as faceted.
 *
 * Generic forms only: no third-party models, no textures, badges or lettering
 * (`docs/MAP_CITY_LIFE.md`).
 *
 * ## Two levels of detail
 *
 * Near the camera a car is ~300–800 triangles; past it ({@link LOD} in the
 * shader) the same instance draws a ≤150-triangle version — the same two
 * shapes at a quarter of the subdivision, no wheels — which at that distance
 * is a few pixels and looks the same.
 *
 * ## Frame
 *
 * Local metres, x FORWARD, y LEFT, z UP, origin on the ground at the model's
 * centre. Faces wind counter-clockwise seen from OUTSIDE; the engine's
 * mirrored model matrix makes three call those back faces, which is why the
 * materials draw `BackSide`, exactly as the buildings do (`cityEngine.ts`).
 */

/** What the shader colours a vertex as. */
export const PART = {
  paint: 0,
  glass: 1,
  tyre: 2,
  legLeft: 3,
  legRight: 4,
  skin: 5,
  clothes: 6,
  /** A taxi's roof light. */
  sign: 7,
  /** Underbody and bumper shadow line: a darker paint. */
  trim: 8,
} as const;

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

/** Near and far versions of one model. */
export interface ModelLods {
  near: ModelGeometry;
  far: ModelGeometry;
}

interface Builder {
  positions: number[];
  normals: number[];
  parts: number[];
  indices: number[];
}

const builder = (): Builder => ({ positions: [], normals: [], parts: [], indices: [] });

/** `sign(t)·|t|^e`, the superellipse's signed power. */
const spow = (t: number, e: number) => Math.sign(t) * Math.abs(t) ** e;

interface SuperellipsoidSpec {
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
function superellipsoid(b: Builder, spec: SuperellipsoidSpec): void {
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
function wheel(
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
      b.parts.push(PART.tyre);
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
    b.parts.push(PART.tyre);
    for (let i = 0; i < segments; i++) {
      const a = (2 * Math.PI * i) / segments;
      b.positions.push(cx + Math.cos(a) * radius, cy + side * half, cz + Math.sin(a) * radius);
      b.normals.push(0, side, 0);
      b.parts.push(PART.tyre);
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

function finish(b: Builder, length: number, halfLength: number, halfWidth: number): ModelGeometry {
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

interface CarShape {
  length: number;
  width: number;
  /** Body: bottom and top heights. */
  body: [number, number];
  /** Cabin: centre x, half-length, top height. */
  cabin: [number, number, number];
  /** Cabin plan narrower than the body by this many metres each side. */
  inset: number;
  /** Wheel radius and axle positions (x). */
  wheels: [number, number[]];
  /** A taxi roof light. */
  sign?: boolean;
}

const bodyPart = (z0: number) => (p: [number, number, number]) =>
  p[2] < z0 + 0.08 ? PART.trim : PART.paint;

function car(shape: CarShape, detail: 'near' | 'far'): ModelGeometry {
  const b = builder();
  const near = detail === 'near';
  const halfL = shape.length / 2;
  const halfW = shape.width / 2;
  const [z0, z1] = shape.body;
  superellipsoid(b, {
    at: [0, 0, (z0 + z1) / 2],
    radii: [halfL, halfW, (z1 - z0) / 2],
    round: [0.42, 0.32],
    segments: near ? [20, 10] : [8, 4],
    part: bodyPart(z0),
  });
  const [cxc, chalf, ctop] = shape.cabin;
  const cBottom = z1 - 0.12; // stands into the body: no seam
  superellipsoid(b, {
    at: [cxc, 0, (cBottom + ctop) / 2],
    radii: [chalf, halfW - shape.inset, (ctop - cBottom) / 2],
    round: [0.5, 0.42],
    segments: near ? [16, 8] : [8, 4],
    taper: 0.22,
    lean: -0.1,
    // Glass all round, the roof painted.
    part: (_p, n) => (n[2] > 0.72 ? PART.paint : PART.glass),
  });
  if (shape.sign && near) {
    superellipsoid(b, {
      at: [cxc, 0, ctop + 0.05],
      radii: [0.22, 0.14, 0.07],
      round: [0.5, 0.5],
      segments: [8, 4],
      part: () => PART.sign,
    });
  }
  if (near) {
    const [radius, axles] = shape.wheels;
    for (const x of axles) {
      for (const side of [-1, 1]) {
        wheel(b, [x, side * (halfW - 0.14), radius], radius, 0.24, 10);
      }
    }
  }
  return finish(b, shape.length, halfL, halfW);
}

/** A hatchback: short, the cabin back to the rear. */
export const hatchback = (detail: 'near' | 'far') =>
  car(
    {
      length: 4.0,
      width: 1.76,
      body: [0.24, 0.92],
      cabin: [-0.35, 1.25, 1.48],
      inset: 0.1,
      wheels: [0.31, [-1.28, 1.26]],
    },
    detail,
  );

/** A saloon: longer, the cabin central, a boot behind it. */
export const sedan = (detail: 'near' | 'far') =>
  car(
    {
      length: 4.6,
      width: 1.82,
      body: [0.24, 0.9],
      cabin: [-0.15, 1.25, 1.44],
      inset: 0.1,
      wheels: [0.32, [-1.42, 1.42]],
    },
    detail,
  );

/** A taxi: the saloon with a roof light (its livery is paint, `sim/liveries.ts`). */
export const taxi = (detail: 'near' | 'far') =>
  car(
    {
      length: 4.6,
      width: 1.82,
      body: [0.24, 0.9],
      cabin: [-0.15, 1.25, 1.44],
      inset: 0.1,
      wheels: [0.32, [-1.42, 1.42]],
      sign: true,
    },
    detail,
  );

/** A van: a tall rounded box over a short bonnet, glass only ahead. */
export function van(detail: 'near' | 'far'): ModelGeometry {
  const b = builder();
  const near = detail === 'near';
  superellipsoid(b, {
    at: [0, 0, 0.7],
    radii: [2.6, 0.98, 0.42],
    round: [0.38, 0.3],
    segments: near ? [20, 10] : [8, 4],
    part: bodyPart(0.28),
  });
  superellipsoid(b, {
    at: [-0.35, 0, 1.45],
    radii: [2.15, 0.95, 0.62],
    round: [0.32, 0.28],
    segments: near ? [18, 8] : [8, 4],
    taper: 0.06,
    // The windscreen: front-facing and above the bonnet.
    part: (p, n) => (n[0] > 0.55 && p[2] > 1.15 ? PART.glass : PART.paint),
  });
  if (near) {
    for (const x of [-1.75, 1.75]) {
      for (const side of [-1, 1]) wheel(b, [x, side * 0.86, 0.34], 0.34, 0.26, 10);
    }
  }
  return finish(b, 5.2, 2.6, 0.98);
}

/**
 * A bus: a long rounded box in three bands — painted skirt, a continuous
 * glass band wrapping the front, a painted roof — each its own
 * superellipsoid, so the band has crisp edges instead of a colour smeared
 * between two rings of vertices.
 */
export function bus(detail: 'near' | 'far'): ModelGeometry {
  const b = builder();
  const near = detail === 'near';
  const segments: [number, number] = near ? [20, 6] : [8, 2];
  superellipsoid(b, {
    at: [0, 0, 1.0],
    radii: [6, 1.26, 0.7],
    round: [0.3, 0.2],
    segments,
    part: (p) => (p[2] < 0.48 ? PART.trim : PART.paint),
  });
  superellipsoid(b, {
    at: [0.02, 0, 2.08],
    radii: [5.97, 1.23, 0.5],
    round: [0.25, 0.2],
    segments,
    part: () => PART.glass,
  });
  superellipsoid(b, {
    at: [0, 0, 2.78],
    radii: [5.9, 1.24, 0.34],
    round: [0.45, 0.2],
    segments,
    part: () => PART.paint,
  });
  if (near) {
    for (const x of [-3.7, 4.0]) {
      for (const side of [-1, 1]) wheel(b, [x, side * 1.1, 0.48], 0.48, 0.32, 10);
    }
  }
  return finish(b, 12, 6, 1.26);
}

/**
 * A person, ~1.72 m: two rounded legs (which swing), a capsule body, a round
 * head. Faces +x.
 */
export function person(detail: 'near' | 'far'): ModelGeometry {
  const b = builder();
  if (detail === 'far') {
    superellipsoid(b, {
      at: [0, 0, 0.86],
      radii: [0.15, 0.2, 0.86],
      round: [0.8, 0.9],
      segments: [6, 4],
      part: (p) => (p[2] > 1.5 ? PART.skin : PART.clothes),
    });
    return finish(b, 0.3, 0.2, 0.22);
  }
  for (const [y, part] of [
    [0.085, PART.legLeft],
    [-0.085, PART.legRight],
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
    part: () => PART.clothes,
  });
  superellipsoid(b, {
    at: [0.01, 0, 1.6],
    radii: [0.1, 0.09, 0.115],
    round: [1, 1],
    segments: [8, 6],
    part: () => PART.skin,
  });
  return finish(b, 0.3, 0.2, 0.22);
}

/** Every vehicle model, in the simulation's model order (`CAR_MODELS`). */
export const VEHICLE_MODELS = { hatchback, sedan, taxi, van, bus } as const;

/**
 * The contact shadow: one quad, `x, y` in `[−1, 1]`, scaled per model by its
 * footprint and shaded as a soft radial blob in the shader.
 */
export function shadowQuad(): { positions: Float32Array; indices: Uint16Array } {
  return {
    positions: Float32Array.from([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]),
    // Counter-clockwise seen from above, i.e. from outside.
    indices: Uint16Array.from([0, 1, 2, 0, 2, 3]),
  };
}

/**
 * The stylised tree shapes every instanced tree is drawn from, built once and
 * shared by every tile. Renderer-free: plain arrays the engine wraps in
 * three.js buffers (`cityMeshes.ts`), so the triangle budget is a test.
 *
 * The look is a maquette's, not a botanist's: a soft round canopy on a short
 * trunk ("lollipop") for broadleaf trees, a two-tier cone for conifers, matte,
 * each standing on a faint contact shadow that grounds it on the map. A unit
 * tree is 1 tall, standing on the origin; the vertex shader scales it by each
 * tree's height and turns it by its seed (`tsl/treeMaterial.ts`).
 *
 * | shape                     | canopy                             | trunk         | shadow | triangles |
 * | ------------------------- | ---------------------------------- | ------------- | ------ | --------: |
 * | broadleaf ×3, near        | bumpy icosphere (80), smooth       | 5-sided prism | 8-gon  |        98 |
 * | broadleaf, far            | icosahedron (20), smooth           | —             | —      |        20 |
 * | conifer, near             | two 8-sided cones, smooth          | 5-sided prism | 8-gon  |        34 |
 * | conifer, far              | one 6-sided cone                   | —             | —      |         6 |
 * | palm, near                | 7 drooping V-section fronds        | 5-sided prism | 8-gon  |        74 |
 * | palm, far                 | 5 flat fronds                      | 5-sided prism | —      |        30 |
 *
 * The three broadleaf canopies are the same icosphere pushed out by a few
 * soft lobes in different places ({@link bumpyCanopy}) — not spheres: an
 * irregular, cloud-like crown is what makes a maquette tree read as a tree.
 * Each is drawn for a third of the broadleaf trees, picked by the tree's seed.
 *
 * `part` tells the shader what a vertex is: 0 trunk, 1 canopy, 2 shadow.
 * Nothing about the shape is data (see `trees.ts`).
 */

export interface TreeShape {
  /** Unit-tree positions, xyz. */
  positions: Float32Array;
  /** Unit normals, xyz. */
  normals: Float32Array;
  /** Per vertex: 0 trunk, 1 canopy, 2 contact shadow. */
  part: Float32Array;
  indices: Uint16Array;
}

export const TRUNK = 0;
export const CANOPY = 1;
export const SHADOW = 2;

/** Broadleaf canopy: centre height and radii, as fractions of the tree's height. */
export const CROWN = { centre: 0.6, radius: 0.33, halfHeight: 0.4 } as const;
/** Trunk: radius and top, as fractions of the tree's height. */
export const STEM = { radius: 0.045, top: 0.36 } as const;
/** Conifer tiers: `[base, top, radius]` as fractions of the tree's height. */
export const CONIFER_TIERS = [
  [0.18, 0.72, 0.25],
  [0.48, 1.0, 0.17],
] as const;
/** Contact shadow radius, as a fraction of the height (a little past the canopy). */
export const SHADOW_RADIUS = 0.38;

type V3 = [number, number, number];

function builder() {
  const positions: number[] = [];
  const normals: number[] = [];
  const part: number[] = [];
  const indices: number[] = [];
  return {
    vertex(p: V3, n: V3, kind: number): number {
      positions.push(...p);
      const length = Math.hypot(...n) || 1;
      normals.push(n[0] / length, n[1] / length, n[2] / length);
      part.push(kind);
      return positions.length / 3 - 1;
    },
    triangle(a: number, b: number, c: number) {
      indices.push(a, b, c);
    },
    finish(): TreeShape {
      return {
        positions: new Float32Array(positions),
        normals: new Float32Array(normals),
        part: new Float32Array(part),
        indices: new Uint16Array(indices),
      };
    },
  };
}

type Builder = ReturnType<typeof builder>;

const PHI = (1 + Math.sqrt(5)) / 2;
const ICOSAHEDRON_VERTICES: V3[] = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
].map(([x, y, z]) => {
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l] as V3;
});
const ICOSAHEDRON_FACES = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

/** The unit icosphere: the icosahedron, each face split in four `levels` times. */
export function icosphere(levels: number): { vertices: V3[]; faces: number[][] } {
  let vertices = ICOSAHEDRON_VERTICES.slice();
  let faces = ICOSAHEDRON_FACES.map((f) => f.slice());
  for (let level = 0; level < levels; level++) {
    const midpoints = new Map<string, number>();
    const mid = (a: number, b: number) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      const known = midpoints.get(key);
      if (known !== undefined) return known;
      const [pa, pb] = [vertices[a], vertices[b]];
      const m: V3 = [(pa[0] + pb[0]) / 2, (pa[1] + pb[1]) / 2, (pa[2] + pb[2]) / 2];
      const l = Math.hypot(...m);
      vertices = [...vertices, [m[0] / l, m[1] / l, m[2] / l]];
      midpoints.set(key, vertices.length - 1);
      return vertices.length - 1;
    };
    faces = faces.flatMap(([a, b, c]) => {
      const ab = mid(a, b);
      const bc = mid(b, c);
      const ca = mid(c, a);
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ];
    });
  }
  return { vertices, faces };
}

/** A smooth ellipsoid canopy, every face counter-clockwise seen from outside. */
function canopy(b: Builder, sphere: { vertices: V3[]; faces: number[][] }): void {
  const { centre, radius, halfHeight } = CROWN;
  const ids = sphere.vertices.map((u) =>
    // The normal of an ellipsoid at a point is the point scaled by 1/r².
    b.vertex(
      [u[0] * radius, u[1] * radius, centre + u[2] * halfHeight],
      [u[0] / radius, u[1] / radius, u[2] / halfHeight],
      CANOPY,
    ),
  );
  for (const [p, q, r] of sphere.faces) {
    const [a, c, d] = [sphere.vertices[p], sphere.vertices[q], sphere.vertices[r]];
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const out =
      n[0] * (a[0] + c[0] + d[0]) + n[1] * (a[1] + c[1] + d[1]) + n[2] * (a[2] + c[2] + d[2]);
    if (out >= 0) b.triangle(ids[p], ids[q], ids[r]);
    else b.triangle(ids[p], ids[r], ids[q]);
  }
}

/** A cone's side, `sides` facets, smooth normals, counter-clockwise from outside. */
function cone(b: Builder, base: number, top: number, radius: number, sides: number): void {
  const slope = radius / (top - base);
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const am = (a0 + a1) / 2;
    const n = (a: number): V3 => [Math.cos(a), Math.sin(a), slope];
    const p0 = b.vertex([radius * Math.cos(a0), radius * Math.sin(a0), base], n(a0), CANOPY);
    const p1 = b.vertex([radius * Math.cos(a1), radius * Math.sin(a1), base], n(a1), CANOPY);
    const apex = b.vertex([0, 0, top], n(am), CANOPY);
    b.triangle(p0, p1, apex);
  }
}

/** A five-sided trunk from the ground to `top`. */
function trunk(b: Builder, top: number): void {
  const sides = 5;
  const r = STEM.radius;
  for (let i = 0; i < sides; i++) {
    const a0 = (i / sides) * Math.PI * 2;
    const a1 = ((i + 1) / sides) * Math.PI * 2;
    const n0: V3 = [Math.cos(a0), Math.sin(a0), 0];
    const n1: V3 = [Math.cos(a1), Math.sin(a1), 0];
    const p0 = b.vertex([r * n0[0], r * n0[1], 0], n0, TRUNK);
    const p1 = b.vertex([r * n1[0], r * n1[1], 0], n1, TRUNK);
    const q1 = b.vertex([r * n1[0], r * n1[1], top], n1, TRUNK);
    const q0 = b.vertex([r * n0[0], r * n0[1], top], n0, TRUNK);
    b.triangle(p0, p1, q1);
    b.triangle(p0, q1, q0);
  }
}

/**
 * The contact shadow: a flat 8-gon just above the ground, facing up, its
 * centre vertex in the middle so the shader's radial falloff (distance from
 * the centre over {@link SHADOW_RADIUS}) interpolates exactly.
 */
function shadow(b: Builder): void {
  const sides = 8;
  const centre = b.vertex([0, 0, 0.004], [0, 0, 1], SHADOW);
  const rim: number[] = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    rim.push(
      b.vertex(
        [SHADOW_RADIUS * Math.cos(a), SHADOW_RADIUS * Math.sin(a), 0.004],
        [0, 0, 1],
        SHADOW,
      ),
    );
  }
  for (let i = 0; i < sides; i++) b.triangle(centre, rim[i], rim[(i + 1) % sides]);
}

/** A deterministic pseudo-random number in [0, 1) from two integers. */
function random(a: number, b: number): number {
  let x = (Math.imul(a + 1, 0x27d4eb2d) ^ Math.imul(b + 7, 0x165667b1)) >>> 0;
  x ^= x >>> 15;
  x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13;
  return (x >>> 0) / 4_294_967_296;
}

/**
 * A unit sphere pushed out by `lobes` soft bumps around seeded directions, as
 * an icosphere of `levels`: radius `1 + Σ amplitude · exp(-angle² / width²)`,
 * normalised so the canopy keeps its overall size. Normals are the averaged
 * normals of the faces around each vertex, so the bumps shade softly.
 */
export function bumpyCanopy(variant: number, levels = 1, lobes = 5) {
  const sphere = icosphere(levels);
  const centres: { dir: V3; amplitude: number }[] = [];
  for (let i = 0; i < lobes; i++) {
    const z = random(variant, i * 3) * 1.4 - 0.4; // mostly upper and sides
    const angle = random(variant, i * 3 + 1) * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - z * z));
    centres.push({
      dir: [r * Math.cos(angle), r * Math.sin(angle), z],
      amplitude: 0.1 + 0.12 * random(variant, i * 3 + 2),
    });
  }
  const radii = sphere.vertices.map((v) => {
    let radius = 1;
    for (const { dir, amplitude } of centres) {
      const cos = v[0] * dir[0] + v[1] * dir[1] + v[2] * dir[2];
      const angle = Math.acos(Math.max(-1, Math.min(1, cos)));
      radius += amplitude * Math.exp(-(angle * angle) / 0.35);
    }
    return radius;
  });
  const largest = Math.max(...radii);
  const vertices = sphere.vertices.map((v, i): V3 => {
    const r = radii[i] / largest;
    return [v[0] * r, v[1] * r, v[2] * r];
  });
  return { vertices, faces: sphere.faces };
}

/** A canopy from arbitrary unit-ish vertices: face-averaged smooth normals, outward winding. */
function bumpy(b: Builder, shape: { vertices: V3[]; faces: number[][] }): void {
  const { centre, radius, halfHeight } = CROWN;
  const placed = shape.vertices.map(
    (u): V3 => [u[0] * radius, u[1] * radius, centre + u[2] * halfHeight],
  );
  const normals = placed.map((): V3 => [0, 0, 0]);
  const faces = shape.faces.map(([p, q, r]) => {
    const [a, c, d] = [placed[p], placed[q], placed[r]];
    const u = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const v = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
    let n: V3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const m = [
      (a[0] + c[0] + d[0]) / 3,
      (a[1] + c[1] + d[1]) / 3,
      (a[2] + c[2] + d[2]) / 3 - centre,
    ];
    let face = [p, q, r];
    if (n[0] * m[0] + n[1] * m[1] + n[2] * m[2] < 0) {
      face = [p, r, q];
      n = [-n[0], -n[1], -n[2]];
    }
    for (const i of face) {
      normals[i][0] += n[0];
      normals[i][1] += n[1];
      normals[i][2] += n[2];
    }
    return face;
  });
  const ids = placed.map((p, i) => b.vertex(p, normals[i], CANOPY));
  for (const [p, q, r] of faces) b.triangle(ids[p], ids[q], ids[r]);
}

/** How many broadleaf canopy variants there are. */
export const BROADLEAF_VARIANTS = 3;

/** Broadleaf, near: a bumpy canopy (variant 0–2), trunk, shadow (98 triangles). */
export function nearTreeShape(variant = 0): TreeShape {
  const b = builder();
  shadow(b);
  trunk(b, STEM.top);
  bumpy(b, bumpyCanopy(variant));
  return b.finish();
}

/** Broadleaf, far: an icosahedron canopy alone (20 triangles). */
export function farTreeShape(): TreeShape {
  const b = builder();
  canopy(b, icosphere(0));
  return b.finish();
}

/** Conifer, near: two smooth cones on a trunk, shadow (42 triangles). */
export function nearConiferShape(): TreeShape {
  const b = builder();
  shadow(b);
  trunk(b, CONIFER_TIERS[0][0] + 0.02);
  for (const [base, top, radius] of CONIFER_TIERS) cone(b, base, top, radius, 8);
  return b.finish();
}

/** Conifer, far: one six-sided cone (6 triangles). */
export function farConiferShape(): TreeShape {
  const b = builder();
  cone(b, CONIFER_TIERS[0][0], 1, CONIFER_TIERS[0][2], 6);
  return b.finish();
}

/** Palm: trunk top and frond reach, as fractions of the height. */
export const PALM = { top: 0.86, reach: 0.34, droop: 0.2 } as const;

/**
 * Fronds radiating from the trunk's top and drooping. Each is two segments; a
 * near frond is a shallow V in section (two faces each side of its rib), so it
 * has an upper surface from every side, a far one is flat.
 */
function fronds(b: Builder, count: number, vSection: boolean): void {
  const { top, reach, droop } = PALM;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + (i % 2) * 0.2;
    const dir: [number, number] = [Math.cos(angle), Math.sin(angle)];
    const side: [number, number] = [-dir[1], dir[0]];
    // The rib: base, middle (highest), tip (drooped).
    const rib: V3[] = [
      [0, 0, top],
      [dir[0] * reach * 0.5, dir[1] * reach * 0.5, top + droop * 0.15],
      [dir[0] * reach, dir[1] * reach, top - droop],
    ];
    const widths = [0.015, 0.075, 0.02];
    const keel = vSection ? 0.03 : 0;
    const edges = rib.map((p, k): [V3, V3, V3] => [
      [p[0] + side[0] * widths[k], p[1] + side[1] * widths[k], p[2]],
      [p[0], p[1], p[2] - keel],
      [p[0] - side[0] * widths[k], p[1] - side[1] * widths[k], p[2]],
    ]);
    for (let k = 0; k < 2; k++) {
      const [l0, c0, r0] = edges[k];
      const [l1, c1, r1] = edges[k + 1];
      const up: V3 = [0, 0, 1];
      if (vSection) {
        // Two faces, rib in the middle; counter-clockwise seen from above.
        const a = [
          b.vertex(l0, up, CANOPY),
          b.vertex(c0, up, CANOPY),
          b.vertex(c1, up, CANOPY),
          b.vertex(l1, up, CANOPY),
        ];
        b.triangle(a[0], a[1], a[2]);
        b.triangle(a[0], a[2], a[3]);
        const c = [
          b.vertex(c0, up, CANOPY),
          b.vertex(r0, up, CANOPY),
          b.vertex(r1, up, CANOPY),
          b.vertex(c1, up, CANOPY),
        ];
        b.triangle(c[0], c[1], c[2]);
        b.triangle(c[0], c[2], c[3]);
      } else {
        const a = [
          b.vertex(l0, up, CANOPY),
          b.vertex(r0, up, CANOPY),
          b.vertex(r1, up, CANOPY),
          b.vertex(l1, up, CANOPY),
        ];
        b.triangle(a[0], a[1], a[2]);
        b.triangle(a[0], a[2], a[3]);
      }
    }
  }
}

/** Palm, near: a tall trunk and seven V-section fronds, shadow (74 triangles). */
export function nearPalmShape(): TreeShape {
  const b = builder();
  shadow(b);
  trunk(b, PALM.top);
  fronds(b, 7, true);
  return b.finish();
}

/** Palm, far: the trunk and five flat fronds (30 triangles). */
export function farPalmShape(): TreeShape {
  const b = builder();
  trunk(b, PALM.top);
  fronds(b, 5, false);
  return b.finish();
}

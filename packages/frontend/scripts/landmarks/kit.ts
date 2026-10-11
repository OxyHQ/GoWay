/**
 * The landmark modelling kit: the few geometry builders every procedural
 * landmark is made of (`docs/MAP_LANDMARKS.md` → "Modelling workflow").
 *
 * Build-time only. It runs in Bun under `scripts/build-landmarks.ts`, uses
 * three.js for its GEOMETRY classes (pure arithmetic, no DOM, no WebGL) and
 * never reaches the app bundle — `components/__tests__/engine3dChunk.test.ts`
 * scans `app/`, `components/`, `features/` and `lib/`, and this is none of them.
 *
 * ## Frames
 *
 * glTF's, as `docs/SDK_MAP_MODELS.md` fixes them: metres, +Y up, the model's
 * FRONT facing +Z, the origin at the base centre of the anchor. A plan point
 * is `[x, z]` in that frame (x to the model's left as seen from the front —
 * glTF's +X — and z toward the front).
 *
 * ## Style rules the builders encode
 *
 *  - **Chamfers, not sharp boxes.** Every prism can carry a small 45° bevel;
 *    the chamfer catches the light and is most of what makes a massing read as
 *    a crafted maquette rather than a `fill-extrusion`.
 *  - **Flat where it is flat, smooth where it turns.** Prisms and lofts are
 *    flat-shaded (one normal per face), lathes are smooth around and crisp at
 *    profile corners.
 *  - **Windows are separate geometry** in two materials, lit and unlit, chosen
 *    by a seeded hash, so the night pattern is deterministic and the GLB is
 *    byte-for-byte reproducible.
 */
import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export type V2 = readonly [number, number];
export type V3 = readonly [number, number, number];

export const TAU = Math.PI * 2;
export const DEG = Math.PI / 180;

/** A deterministic hash of integers to [0, 1). */
export function hash01(...values: number[]): number {
  let h = 2166136261;
  for (const v of values) {
    h ^= Math.floor(v * 1000) & 0xffffffff;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
    h = Math.imul(h, 0x5bd1e995);
    h ^= h >>> 15;
  }
  return (h >>> 0) / 4294967296;
}

/** Strip a geometry to what a landmark GLB carries: position + normal, non-indexed. */
function normalise(geometry: THREE.BufferGeometry, flat: boolean): THREE.BufferGeometry {
  let g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position' && name !== 'normal') g.deleteAttribute(name);
  }
  g.morphAttributes = {};
  g.clearGroups();
  if (flat || !g.attributes.normal) {
    g.deleteAttribute('normal');
    g.computeVertexNormals();
  }
  // Non-indexed `computeVertexNormals` is per face: exactly the flat normals.
  g = g.index ? g.toNonIndexed() : g;
  return g;
}

/** Collects geometry per material; `scripts/landmarks/glb.ts` writes it out. */
export class Builder {
  readonly buckets = new Map<string, THREE.BufferGeometry[]>();

  constructor(readonly materials: ReadonlySet<string>) {}

  /** Add `geometry` (consumed) in `material`, optionally transformed. Flat-shaded unless `smooth`. */
  add(
    material: string,
    geometry: THREE.BufferGeometry,
    transform?: THREE.Matrix4,
    options: { smooth?: boolean } = {},
  ): void {
    if (!this.materials.has(material)) throw new Error(`unknown material "${material}"`);
    const g = normalise(geometry, !options.smooth);
    if (transform) g.applyMatrix4(transform);
    const list = this.buckets.get(material) ?? [];
    list.push(g);
    this.buckets.set(material, list);
  }

  /** One welded, indexed geometry per material, in insertion order of first use. */
  merged(): Map<string, THREE.BufferGeometry> {
    const out = new Map<string, THREE.BufferGeometry>();
    for (const [material, list] of this.buckets) {
      const merged = mergeGeometries(list, false);
      if (!merged) throw new Error(`could not merge "${material}"`);
      out.set(material, mergeVertices(merged, 1e-4));
    }
    return out;
  }

  triangles(): number {
    let n = 0;
    for (const list of this.buckets.values())
      for (const g of list) n += g.attributes.position.count / 3;
    return n;
  }
}

// ---------------------------------------------------------------------------
// Transforms

export function at(x: number, y: number, z: number, rotationY = 0, scale = 1): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY),
    new THREE.Vector3(scale, scale, scale),
  );
}

export function compose(
  position: V3,
  rotation: { x?: number; y?: number; z?: number } = {},
  scale: V3 = [1, 1, 1],
): THREE.Matrix4 {
  return new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(
      new THREE.Euler(rotation.x ?? 0, rotation.y ?? 0, rotation.z ?? 0, 'YXZ'),
    ),
    new THREE.Vector3(...scale),
  );
}

// ---------------------------------------------------------------------------
// Plan shapes

export function rect(w: number, d: number, cx = 0, cz = 0): V2[] {
  const x = w / 2;
  const z = d / 2;
  return [
    [cx - x, cz - z],
    [cx + x, cz - z],
    [cx + x, cz + z],
    [cx - x, cz + z],
  ];
}

export function circle(r: number, segments: number, cx = 0, cz = 0, phase = 0): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = phase + (i / segments) * TAU;
    out.push([cx + Math.cos(a) * r, cz + Math.sin(a) * r]);
  }
  return out;
}

/** A rectangle with every corner cut by `c` (an octagon when c is large). */
export function chamferedRect(w: number, d: number, c: number, cx = 0, cz = 0): V2[] {
  const x = w / 2;
  const z = d / 2;
  return [
    [cx - x + c, cz - z],
    [cx + x - c, cz - z],
    [cx + x, cz - z + c],
    [cx + x, cz + z - c],
    [cx + x - c, cz + z],
    [cx - x + c, cz + z],
    [cx - x, cz + z - c],
    [cx - x, cz - z + c],
  ];
}

/** Signed area in the x–z plane (positive: counter-clockwise seen from +Y down… see `ccwFromAbove`). */
function signedArea(points: readonly V2[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x0, z0] = points[i];
    const [x1, z1] = points[(i + 1) % points.length];
    a += x0 * z1 - x1 * z0;
  }
  return a / 2;
}

/** Offset a convex-or-mild polygon outward by `d` (negative: inward), miter joins. */
export function offset(points: readonly V2[], d: number): V2[] {
  const n = points.length;
  const sign = signedArea(points) > 0 ? -1 : 1;
  const out: V2[] = [];
  for (let i = 0; i < n; i++) {
    const p0 = points[(i - 1 + n) % n];
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const e0 = norm2([p1[0] - p0[0], p1[1] - p0[1]]);
    const e1 = norm2([p2[0] - p1[0], p2[1] - p1[1]]);
    const n0: V2 = [-e0[1] * sign, e0[0] * sign];
    const n1: V2 = [-e1[1] * sign, e1[0] * sign];
    const m = norm2([n0[0] + n1[0], n0[1] + n1[1]]);
    const cos = m[0] * n1[0] + m[1] * n1[1];
    const k = d / Math.max(0.25, cos);
    out.push([p1[0] + m[0] * k, p1[1] + m[1] * k]);
  }
  return out;
}

function norm2(v: V2): V2 {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}

// ---------------------------------------------------------------------------
// Solids

/**
 * A vertical prism over `plan` from `y0` to `y1`, with an optional chamfer of
 * `bevel` metres on every top and bottom edge (the footprint stays exact).
 */
export function prism(
  plan: readonly V2[],
  y0: number,
  y1: number,
  bevel = 0,
  options: { top?: boolean; bottom?: boolean } = {},
): THREE.BufferGeometry {
  const h = y1 - y0;
  const b = Math.min(bevel, h / 3);
  if (b > 0.001 && options.top !== false && options.bottom !== false) {
    const shape = new THREE.Shape(plan.map(([x, z]) => new THREE.Vector2(x, -z)));
    const g = new THREE.ExtrudeGeometry(shape, {
      depth: h - 2 * b,
      bevelEnabled: true,
      bevelThickness: b,
      bevelSize: b,
      bevelOffset: -b,
      bevelSegments: 1,
      curveSegments: 1,
      steps: 1,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0 + b, 0);
    return g;
  }
  return loft(
    [
      { y: y0, plan },
      { y: y1, plan },
    ],
    { bottom: options.bottom !== false, top: options.top !== false },
  );
}

/**
 * Side walls between successive rings (equal point counts), plus caps.
 * Rings may differ in shape and size: tapers, twists, setbacks with sloped
 * transitions. Wound so faces point away from each ring's centroid.
 */
export function loft(
  rings: ReadonlyArray<{ y: number; plan: readonly V2[] }>,
  options: { bottom?: boolean; top?: boolean } = {},
): THREE.BufferGeometry {
  const n = rings[0].plan.length;
  for (const ring of rings) if (ring.plan.length !== n) throw new Error('loft: ring sizes differ');
  const ccw = signedArea(rings[0].plan) > 0;
  const positions: number[] = [];
  const tri = (a: V3, b: V3, c: V3) => positions.push(...a, ...b, ...c);
  for (let r = 0; r < rings.length - 1; r++) {
    const A = rings[r];
    const B = rings[r + 1];
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a0: V3 = [A.plan[i][0], A.y, A.plan[i][1]];
      const a1: V3 = [A.plan[j][0], A.y, A.plan[j][1]];
      const b0: V3 = [B.plan[i][0], B.y, B.plan[i][1]];
      const b1: V3 = [B.plan[j][0], B.y, B.plan[j][1]];
      if (ccw) {
        tri(a0, b1, a1);
        tri(a0, b0, b1);
      } else {
        tri(a0, a1, b1);
        tri(a0, b1, b0);
      }
    }
  }
  const cap = (ring: { y: number; plan: readonly V2[] }, up: boolean) => {
    const contour = ring.plan.map(([x, z]) => new THREE.Vector2(x, z));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    for (const [a, b, c] of faces) {
      const pa: V3 = [ring.plan[a][0], ring.y, ring.plan[a][1]];
      const pb: V3 = [ring.plan[b][0], ring.y, ring.plan[b][1]];
      const pc: V3 = [ring.plan[c][0], ring.y, ring.plan[c][1]];
      // Normal y of (pa, pb, pc) is (b−a) × (c−a) · ŷ = dz₁·dx₂ − dx₁·dz₂.
      const ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
      if (ny > 0 === up) tri(pa, pb, pc);
      else tri(pa, pc, pb);
    }
  };
  if (options.bottom !== false) cap(rings[0], false);
  if (options.top !== false) cap(rings[rings.length - 1], true);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

/** A pyramid/spire from `plan` at `y0` up to an apex. */
export function spire(plan: readonly V2[], y0: number, apex: V3): THREE.BufferGeometry {
  const positions: number[] = [];
  const n = plan.length;
  const ccw = signedArea(plan) > 0;
  for (let i = 0; i < n; i++) {
    const a: V3 = [plan[i][0], y0, plan[i][1]];
    const b: V3 = [plan[(i + 1) % n][0], y0, plan[(i + 1) % n][1]];
    if (ccw) positions.push(...a, ...apex, ...b);
    else positions.push(...a, ...b, ...apex);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A surface of revolution about +Y from a profile of `[radius, y]`, bottom to
 * top. Smooth around; `crease` profile indices get a hard edge (duplicated).
 */
export function lathe(
  profile: readonly V2[],
  segments: number,
  options: { phase?: number; arc?: number; capBottom?: boolean; capTop?: boolean } = {},
): THREE.BufferGeometry {
  const points = profile.map(([r, y]) => new THREE.Vector2(Math.max(0, r), y));
  const g = new THREE.LatheGeometry(points, segments, options.phase ?? 0, options.arc ?? TAU);
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  const parts: THREE.BufferGeometry[] = [g];
  const ring = (y: number, r: number, up: boolean) => {
    if (r <= 0.001) return;
    const c = new THREE.CircleGeometry(r, segments, options.phase ?? 0, options.arc ?? TAU);
    c.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
    c.translate(0, y, 0);
    parts.push(c);
  };
  if (options.capBottom) ring(profile[0][1], profile[0][0], false);
  if (options.capTop) ring(profile[profile.length - 1][1], profile[profile.length - 1][0], true);
  if (parts.length === 1) return g;
  for (const p of parts) {
    p.deleteAttribute('uv');
  }
  return mergeGeometries(
    parts.map((p) => (p.index ? p.toNonIndexed() : p)),
    false,
  ) as THREE.BufferGeometry;
}

/** A cylinder (or cone frustum) between two heights. */
export function cylinder(
  r0: number,
  r1: number,
  y0: number,
  y1: number,
  segments = 24,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, segments, 1, false);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

export function sphere(r: number, segments = 24, rings = 12): THREE.BufferGeometry {
  return new THREE.SphereGeometry(r, segments, rings);
}

/** A tube along a polyline, round section. */
export function tube(points: readonly V3[], radius: number, segments = 8): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)));
  return new THREE.TubeGeometry(curve, Math.max(2, points.length * 4), radius, segments, false);
}

/** An axis-aligned box from min to max corner, optional chamfer. */
export function box(min: V3, max: V3, bevel = 0): THREE.BufferGeometry {
  const plan: V2[] = [
    [min[0], min[2]],
    [max[0], min[2]],
    [max[0], max[2]],
    [min[0], max[2]],
  ];
  return prism(plan, min[1], max[1], bevel);
}

/**
 * A pointed (lancet) or round arch opening outline in a facade's (u, v) plane:
 * width `w`, spring height `h`, crown rise `rise`. Points bottom-left first.
 */
export function archOutline(w: number, h: number, rise: number, pointed: boolean, steps = 8): V2[] {
  const out: V2[] = [
    [-w / 2, 0],
    [w / 2, 0],
  ];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    if (pointed) {
      // Two arcs meeting at the crown.
      const side = t < 0.5 ? 1 : -1;
      const s = t < 0.5 ? t * 2 : (1 - t) * 2;
      const a = (s * Math.PI) / 2;
      const x = side * (w / 2) * Math.cos(a) * (1 - 0.0 * s);
      out.push([x * (1 - 0.15 * Math.sin(a)), h + rise * Math.sin(a)]);
    } else {
      const a = t * Math.PI;
      out.push([(w / 2) * Math.cos(a), h + rise * Math.sin(a)]);
    }
  }
  return out;
}

/**
 * A flat panel (slab) in a facade: outline in (u, v) metres, extruded `depth`
 * along the facade normal. `frame` maps (u, v, n) to model space.
 */
export function panel(
  outline: readonly V2[],
  depth: number,
  frame: { origin: V3; u: V3; v: V3; n: V3 },
): THREE.BufferGeometry {
  const shape = new THREE.Shape(outline.map(([u, v]) => new THREE.Vector2(u, v)));
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false, curveSegments: 4 });
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(...frame.u),
    new THREE.Vector3(...frame.v),
    new THREE.Vector3(...frame.n),
  );
  m.setPosition(new THREE.Vector3(...frame.origin));
  g.applyMatrix4(m);
  // A left-handed frame (u × v = −n) mirrors the extrusion: re-wind it.
  return m.determinant() < 0 ? flipWinding(g) : g;
}

/** Reverse every triangle's winding (and recompute normals). */
export function flipWinding(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position.array as Float32Array;
  for (let i = 0; i < pos.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const t = pos[i + 3 + k];
      pos[i + 3 + k] = pos[i + 6 + k];
      pos[i + 6 + k] = t;
    }
  }
  g.deleteAttribute('normal');
  g.computeVertexNormals();
  return g;
}

/** A facade frame for a straight wall from `a` to `b` (plan points), facing outward (right of a→b when ccw). */
export function wallFrame(a: V2, b: V2, y: number, outward: 1 | -1 = 1) {
  const du = norm2([b[0] - a[0], b[1] - a[1]]);
  const u: V3 = [du[0], 0, du[1]];
  const n: V3 = [du[1] * outward, 0, -du[0] * outward];
  return {
    origin: [a[0], y, a[1]] as V3,
    u,
    v: [0, 1, 0] as V3,
    n,
    length: Math.hypot(b[0] - a[0], b[1] - a[1]),
  };
}

/**
 * A grid of window panes on a facade frame. Each pane is a thin slab `depth`
 * proud of the wall, in `lit` or `dark` by a seeded hash (`litRatio` lit).
 */
export function windowGrid(
  b: Builder,
  frame: { origin: V3; u: V3; v: V3; n: V3 },
  grid: {
    width: number;
    height: number;
    cols: number;
    rows: number;
    /** Pane size as a fraction of its bay, [u, v]. */
    fill?: V2;
    depth?: number;
    lit: string;
    dark: string;
    litRatio?: number;
    seed?: number;
    /** Skip bays (e.g. a door), by (col, row). */
    skip?: (col: number, row: number) => boolean;
  },
): void {
  const [fu, fv] = grid.fill ?? [0.6, 0.55];
  const bu = grid.width / grid.cols;
  const bv = grid.height / grid.rows;
  const pw = bu * fu;
  const ph = bv * fv;
  const depth = grid.depth ?? 0.15;
  const lit: THREE.BufferGeometry[] = [];
  const dark: THREE.BufferGeometry[] = [];
  for (let c = 0; c < grid.cols; c++) {
    for (let r = 0; r < grid.rows; r++) {
      if (grid.skip?.(c, r)) continue;
      const u0 = c * bu + (bu - pw) / 2;
      const v0 = r * bv + (bv - ph) / 2;
      const g = panel(
        [
          [u0, v0],
          [u0 + pw, v0],
          [u0 + pw, v0 + ph],
          [u0, v0 + ph],
        ],
        depth,
        frame,
      );
      const on = hash01(grid.seed ?? 1, c, r) < (grid.litRatio ?? 0.55);
      (on ? lit : dark).push(g);
    }
  }
  if (lit.length) b.add(grid.lit, mergeAll(lit));
  if (dark.length) b.add(grid.dark, mergeAll(dark));
}

/** Merge geometries of mixed index-ness into one non-indexed geometry. */
export function mergeAll(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const prepared = list.map((g) => {
    const n = g.index ? g.toNonIndexed() : g;
    for (const name of Object.keys(n.attributes)) {
      if (name !== 'position' && name !== 'normal') n.deleteAttribute(name);
    }
    if (!n.attributes.normal) n.computeVertexNormals();
    return n;
  });
  const merged = mergeGeometries(prepared, false);
  if (!merged) throw new Error('mergeAll failed');
  return merged;
}

/** Repeat a geometry around the Y axis `count` times (consumes `g`). */
export function radial(g: THREE.BufferGeometry, count: number, phase = 0): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const c = g.clone();
    c.applyMatrix4(at(0, 0, 0, phase + (i / count) * TAU));
    parts.push(c);
  }
  return mergeAll(parts);
}

/** Mirror a geometry across x = 0 (keeps winding outward). */
export function mirrorX(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const m = (g.index ? g.toNonIndexed() : g.clone()) as THREE.BufferGeometry;
  m.applyMatrix4(new THREE.Matrix4().makeScale(-1, 1, 1));
  const pos = m.attributes.position.array as Float32Array;
  for (let i = 0; i < pos.length; i += 9) {
    for (let k = 0; k < 3; k++) {
      const t = pos[i + 3 + k];
      pos[i + 3 + k] = pos[i + 6 + k];
      pos[i + 6 + k] = t;
    }
  }
  m.deleteAttribute('normal');
  m.computeVertexNormals();
  return m;
}

export { THREE };

/**
 * Window panes as single quads `offset` proud of a facade, one column at a
 * time, with vertically adjacent panes of the same state merged into one
 * strip: a lit night pattern of runs (a lit floor here, three there) at a
 * fraction of the triangles of a pane-per-floor grid.
 */
export function facadeWindows(
  b: Builder,
  frame: { origin: V3; u: V3; v: V3; n: V3 },
  grid: {
    width: number;
    height: number;
    cols: number;
    rows: number;
    /** Pane size as a fraction of its bay, [u, v]; v < 1 leaves spandrels between floors. */
    fill?: V2;
    offset?: number;
    lit: string;
    dark: string;
    litRatio?: number;
    seed?: number;
    /** Merge vertically adjacent panes of one state into strips (needs fill v = 1 to read as one). */
    runs?: boolean;
    skip?: (col: number, row: number) => boolean;
  },
): void {
  const [fu, fv] = grid.fill ?? [0.55, 0.6];
  const bu = grid.width / grid.cols;
  const bv = grid.height / grid.rows;
  const pw = bu * fu;
  const off = grid.offset ?? 0.12;
  const ratio = grid.litRatio ?? 0.5;
  const positions: Record<'lit' | 'dark', number[]> = { lit: [], dark: [] };
  const P = (u: number, v: number): V3 => [
    frame.origin[0] + frame.u[0] * u + frame.v[0] * v + frame.n[0] * off,
    frame.origin[1] + frame.u[1] * u + frame.v[1] * v + frame.n[1] * off,
    frame.origin[2] + frame.u[2] * u + frame.v[2] * v + frame.n[2] * off,
  ];
  // Winding: (u, v, n) right-handed means u × v = n, so (0,0)→(1,0)→(1,1) faces +n.
  const cross: V3 = [
    frame.u[1] * frame.v[2] - frame.u[2] * frame.v[1],
    frame.u[2] * frame.v[0] - frame.u[0] * frame.v[2],
    frame.u[0] * frame.v[1] - frame.u[1] * frame.v[0],
  ];
  const facesN = cross[0] * frame.n[0] + cross[1] * frame.n[1] + cross[2] * frame.n[2] > 0;
  const quad = (state: 'lit' | 'dark', u0: number, v0: number, u1: number, v1: number) => {
    const a = P(u0, v0);
    const bb = P(u1, v0);
    const c = P(u1, v1);
    const d = P(u0, v1);
    const out = positions[state];
    if (facesN) out.push(...a, ...bb, ...c, ...a, ...c, ...d);
    else out.push(...a, ...c, ...bb, ...a, ...d, ...c);
  };
  for (let col = 0; col < grid.cols; col++) {
    const u0 = col * bu + (bu - pw) / 2;
    let row = 0;
    while (row < grid.rows) {
      if (grid.skip?.(col, row)) {
        row++;
        continue;
      }
      // Runs of 1–4 floors share a state, so the pattern reads as rooms, not noise.
      const state: 'lit' | 'dark' = hash01(grid.seed ?? 7, col, row) < ratio ? 'lit' : 'dark';
      const runLength = grid.runs ? 1 + Math.floor(hash01(grid.seed ?? 7, col, row, 3) * 4) : 1;
      let end = row;
      while (end < grid.rows && end - row < runLength && !grid.skip?.(col, end)) end++;
      if (grid.runs) {
        const v0 = row * bv + (bv * (1 - fv)) / 2;
        const v1 = end * bv - (bv * (1 - fv)) / 2;
        quad(state, u0, v0, u0 + pw, v1);
      } else {
        for (let r = row; r < end; r++) {
          const v0 = r * bv + (bv * (1 - fv)) / 2;
          quad(state, u0, v0, u0 + pw, v0 + bv * fv);
        }
      }
      row = end;
    }
  }
  for (const state of ['lit', 'dark'] as const) {
    if (positions[state].length === 0) continue;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(positions[state], 3));
    b.add(state === 'lit' ? grid.lit : grid.dark, g);
  }
}

/** Facade frames for every edge of a convex plan, wound so normals face out. */
export function planFrames(plan: readonly V2[], y: number) {
  const ccw = signedArea(plan) > 0;
  return plan.map((a, i) => {
    const bPt = plan[(i + 1) % plan.length];
    return wallFrame(a, bPt, y, ccw ? 1 : -1);
  });
}

/** Vertical piers (thin chamfer-less boxes) standing proud of a wall frame. */
export function piers(
  frame: { origin: V3; u: V3; v: V3; n: V3; length: number },
  count: number,
  y0: number,
  y1: number,
  width: number,
  depth: number,
  options: { ends?: boolean } = {},
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  const first = options.ends ? 0 : 1;
  const last = options.ends ? count : count - 1;
  for (let i = first; i <= last; i++) {
    const u = (i / count) * frame.length;
    const outline: V2[] = [
      [u - width / 2, y0 - frame.origin[1]],
      [u + width / 2, y0 - frame.origin[1]],
      [u + width / 2, y1 - frame.origin[1]],
      [u - width / 2, y1 - frame.origin[1]],
    ];
    parts.push(panel(outline, depth, frame));
  }
  return mergeAll(parts);
}

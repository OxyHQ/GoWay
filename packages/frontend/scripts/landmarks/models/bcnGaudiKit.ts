/**
 * Shared helpers for the Barcelona landmarks whose surfaces are not prisms —
 * Casa Batlló, Casa Milà and the Palau Nacional: parametric surfaces, paths
 * along a facade, and stone bands that follow them.
 *
 * Build-time only, like `../kit.ts` (which these extend without changing).
 */
import { type Builder, THREE, type V2, type V3 } from '../kit';

/**
 * A smooth surface from a (u, v) grid: `f(i / nu, j / nv)` gives each vertex.
 * Wound so that, for `f` increasing u along +X and v along +Y on a plane, the
 * face points +Z (u × v); flip with `flip`.
 */
export function surfaceGrid(
  nu: number,
  nv: number,
  f: (u: number, v: number) => V3,
  options: { flip?: boolean } = {},
): THREE.BufferGeometry {
  const positions: number[] = [];
  for (let j = 0; j <= nv; j++) {
    for (let i = 0; i <= nu; i++) positions.push(...f(i / nu, j / nv));
  }
  const index: number[] = [];
  const at = (i: number, j: number) => j * (nu + 1) + i;
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) {
      const a = at(i, j);
      const b = at(i + 1, j);
      const c = at(i + 1, j + 1);
      const d = at(i, j + 1);
      if (options.flip) index.push(a, c, b, a, d, c);
      else index.push(a, b, c, a, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** Add a surface smooth-shaded. */
export function addSmooth(b: Builder, material: string, g: THREE.BufferGeometry): void {
  b.add(material, g, undefined, { smooth: true });
}

/** A polyline resampled every `step` metres (ends kept). */
export function resample(path: readonly V2[], step: number): V2[] {
  const out: V2[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const [x0, z0] = path[i - 1];
    const [x1, z1] = path[i];
    const len = Math.hypot(x1 - x0, z1 - z0);
    let t = step - carry;
    while (t < len) {
      out.push([x0 + ((x1 - x0) * t) / len, z0 + ((z1 - z0) * t) / len]);
      t += step;
    }
    carry = len - (t - step);
  }
  const last = path[path.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > step * 0.3) out.push(last);
  return out;
}

/** Moving-average smoothing over `radius` samples each side (ends pinned). */
export function smoothPath(path: readonly V2[], radius: number): V2[] {
  return path.map((p, i) => {
    if (i === 0 || i === path.length - 1) return p;
    let x = 0;
    let z = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const q = path[Math.max(0, Math.min(path.length - 1, i + k))];
      x += q[0];
      z += q[1];
      n++;
    }
    return [x / n, z / n] as V2;
  });
}

/** Arc length at each sample. */
export function arcLengths(path: readonly V2[]): number[] {
  const out = [0];
  for (let i = 1; i < path.length; i++) {
    out.push(out[i - 1] + Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]));
  }
  return out;
}

/**
 * Unit normals of a path in the plan, on the side `side` (+1: right of the
 * direction of travel, i.e. (dz, −dx); −1: left).
 */
export function pathNormals(path: readonly V2[], side: 1 | -1): V2[] {
  return path.map((_, i) => {
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const dx = b[0] - a[0];
    const dz = b[1] - a[1];
    const l = Math.hypot(dx, dz) || 1;
    return [(dz / l) * side, (-dx / l) * side] as V2;
  });
}

/**
 * A stone band along a facade path: a rounded slab whose cross-section runs
 * from the wall (n = 0) out to `out(s)` and back, between `bottom(s)` and
 * `top(s)`. `s` is metres along the path. Smooth-shaded: soft stone.
 */
export function band(
  path: readonly V2[],
  normals: readonly V2[],
  bottom: (s: number) => number,
  top: (s: number) => number,
  out: (s: number) => number,
  options: { profile?: number; back?: number } = {},
): THREE.BufferGeometry {
  const s = arcLengths(path);
  const steps = options.profile ?? 6;
  const back = options.back ?? -0.05;
  // Cross-section in (n, t∈[0,1] of the height): a half-pill from the wall out and back.
  const section: Array<[number, number]> = [];
  for (let k = 0; k <= steps; k++) {
    const a = -Math.PI / 2 + (k / steps) * Math.PI;
    section.push([Math.cos(a), (Math.sin(a) + 1) / 2]);
  }
  const prof: Array<[number, number]> = [[back, 0], ...section, [back, 1]];
  const nu = path.length - 1;
  const nv = prof.length - 1;
  return surfaceGrid(nu, nv, (u, v) => {
    const i = Math.round(u * nu);
    const k = Math.round(v * nv);
    const [pn, pt] = prof[k];
    const y0 = bottom(s[i]);
    const y1 = top(s[i]);
    const reach = pn <= 0 ? pn : pn * out(s[i]);
    const p = path[i];
    const nrm = normals[i];
    return [p[0] + nrm[0] * reach, y0 + (y1 - y0) * pt, p[1] + nrm[1] * reach];
  });
}

/** A ribbon (wall strip) along a path between two heights, offset `off(s)` outward. */
export function ribbon(
  path: readonly V2[],
  normals: readonly V2[],
  bottom: (s: number) => number,
  top: (s: number) => number,
  off: (s: number) => number = () => 0,
  rows = 1,
): THREE.BufferGeometry {
  const s = arcLengths(path);
  const nu = path.length - 1;
  return surfaceGrid(nu, rows, (u, v) => {
    const i = Math.round(u * nu);
    const p = path[i];
    const nrm = normals[i];
    const o = off(s[i]);
    const y0 = bottom(s[i]);
    const y1 = top(s[i]);
    return [p[0] + nrm[0] * o, y0 + (y1 - y0) * v, p[1] + nrm[1] * o];
  });
}

/**
 * A prism with holes (courtyards, light wells): `outer` and `holes` in plan
 * (x, z), from `y0` to `y1`. Flat-shaded.
 */
export function prismWithHoles(
  outer: readonly V2[],
  holes: ReadonlyArray<readonly V2[]>,
  y0: number,
  y1: number,
): THREE.BufferGeometry {
  const shape = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, -z)));
  for (const hole of holes)
    shape.holes.push(new THREE.Path(hole.map(([x, z]) => new THREE.Vector2(x, -z))));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: y1 - y0,
    bevelEnabled: false,
    curveSegments: 1,
  });
  g.rotateX(-Math.PI / 2);
  g.translate(0, y0, 0);
  return g;
}

/** A flattened ellipsoid "shell" (a cup, opening along −Z), centred at the origin. */
export function shell(rx: number, ry: number, rz: number, seg = 10): THREE.BufferGeometry {
  return surfaceGrid(seg, seg, (u, v) => {
    const th = u * Math.PI; // around the opening, from left to right through the bottom
    const ph = (v * Math.PI) / 2; // from rim to the deepest point
    return [
      -Math.cos(th) * rx * Math.cos(ph),
      -Math.sin(th) * ry * Math.cos(ph),
      rz * Math.sin(ph),
    ];
  });
}

/** Transform helper: geometry → translated/rotated copy. */
export function placed(
  g: THREE.BufferGeometry,
  position: V3,
  rotationY = 0,
  scale: V3 = [1, 1, 1],
): THREE.BufferGeometry {
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rotationY),
    new THREE.Vector3(...scale),
  );
  g.applyMatrix4(m);
  return g;
}

/** Parse a compact "x,z x,z …" string (OSM outlines embedded in model files). */
export function ring(text: string): V2[] {
  return text
    .trim()
    .split(/\s+/)
    .map((pair) => pair.split(',').map(Number) as unknown as V2);
}

/**
 * Builders shared by the New York skyscrapers (Chrysler, Flatiron, One World
 * Trade Center) that the common kit does not have: a cloister-vaulted tier
 * (the Chrysler crown), sunburst triangle windows, flat triangle lists, and
 * a facade tier with windows. Same frames and rules as `../kit.ts`.
 */
import {
  type Builder,
  facadeWindows,
  hash01,
  loft,
  planFrames,
  prism,
  rect,
  THREE,
  type V2,
  type V3,
} from '../kit';

/** Rotate a plan by 180° (a model authored in the opposite heading). */
export function turn(points: readonly V2[]): V2[] {
  return points.map(([x, z]) => [-x, -z] as V2);
}

/** A geometry from loose triangles, each re-wound to face away from `inside` (or along `facing`). */
export function triangles(
  list: ReadonlyArray<readonly [V3, V3, V3]>,
  orient: { inside?: V3; facing?: V3 },
): THREE.BufferGeometry {
  const positions: number[] = [];
  for (const [a, b, c] of list) {
    const ab = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const ac = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    const n = ab.cross(ac);
    let out: THREE.Vector3;
    if (orient.facing) out = new THREE.Vector3(...orient.facing);
    else {
      const inside = orient.inside ?? [0, 0, 0];
      out = new THREE.Vector3(
        (a[0] + b[0] + c[0]) / 3 - inside[0],
        (a[1] + b[1] + c[1]) / 3 - inside[1],
        (a[2] + b[2] + c[2]) / 3 - inside[2],
      );
    }
    if (n.dot(out) >= 0) positions.push(...a, ...b, ...c);
    else positions.push(...a, ...c, ...b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.computeVertexNormals();
  return g;
}

/**
 * A square tier of half-size `s` around (cx, cz): walls from `y0` to the
 * spring `ys`, then a cloister vault whose four faces each show a
 * semicircular arch — the shape of one Chrysler crown terrace.
 */
export function cloisterTier(s: number, y0: number, ys: number, steps = 9): THREE.BufferGeometry {
  const rings: Array<{ y: number; plan: V2[] }> = [
    { y: y0, plan: rect(2 * s, 2 * s) },
    { y: ys, plan: rect(2 * s, 2 * s) },
  ];
  for (let i = 1; i <= steps; i++) {
    const phi = (i / steps) * (Math.PI / 2) * 0.985;
    const half = Math.max(0.04, s * Math.cos(phi));
    rings.push({ y: ys + s * Math.sin(phi), plan: rect(2 * half, 2 * half) });
  }
  return loft(rings);
}

/**
 * Sunburst triangle windows on the four arch faces of a cloister tier: `n`
 * triangles fanned under each arch, pointing at the spring centre.
 */
export function sunburst(
  s: number,
  ys: number,
  n: number,
  rIn = 0.5,
  rOut = 0.93,
): THREE.BufferGeometry {
  const list: Array<[V3, V3, V3]> = [];
  const off = 0.08;
  for (let face = 0; face < 4; face++) {
    // face frame: outward normal and the horizontal axis along the face
    const nrm: V3 = [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 0, 1],
      [0, 0, -1],
    ][face] as unknown as V3;
    const u: V3 = [Math.abs(nrm[2]), 0, Math.abs(nrm[0])] as unknown as V3;
    const p = (r: number, th: number): V3 => {
      const uu = r * Math.cos(th);
      const v = ys + r * Math.sin(th);
      return [nrm[0] * (s + off) + u[0] * uu, v, nrm[2] * (s + off) + u[2] * uu];
    };
    const half = (0.36 * Math.PI) / n;
    for (let j = 0; j < n; j++) {
      const th = (Math.PI * (j + 0.5)) / n;
      list.push([p(s * rOut, th - half), p(s * rOut, th + half), p(s * rIn, th)]);
    }
  }
  // Each triangle faces along its face normal: orient by centroid from the axis.
  const out: Array<readonly [V3, V3, V3]> = list;
  return triangles(out, { inside: [0, ys, 0] });
}

/**
 * A stone tier with window columns (lit/dark runs), like Empire State's.
 * `bay` is the column pitch; `floor` the storey height.
 */
export function windowTier(
  b: Builder,
  plan: readonly V2[],
  y0: number,
  y1: number,
  options: {
    material: string;
    lit: string;
    dark: string;
    seed: number;
    bay?: number;
    floor?: number;
    fill?: V2;
    litRatio?: number;
    bevel?: number;
    minEdge?: number;
    margin?: number;
  },
): void {
  b.add(options.material, prism(plan, y0, y1, options.bevel ?? 0.3));
  const floor = options.floor ?? 3.7;
  const margin = options.margin ?? 0.6;
  const rows = Math.max(1, Math.floor((y1 - y0 - 2 * margin) / floor));
  const height = rows * floor;
  const bay = options.bay ?? 3;
  planFrames(plan, y0 + margin).forEach((frame, i) => {
    if (frame.length < (options.minEdge ?? 3.5)) return;
    const cols = Math.max(1, Math.round(frame.length / bay));
    facadeWindows(b, frame, {
      width: frame.length,
      height,
      cols,
      rows,
      fill: options.fill ?? [0.4, 0.72],
      offset: 0.06,
      lit: options.lit,
      dark: options.dark,
      litRatio: options.litRatio ?? 0.42,
      seed: options.seed * 37 + i,
      runs: true,
    });
  });
}

/** Deterministic choice. */
export function pick(seed: number, i: number, ratio: number): boolean {
  return hash01(seed, i) < ratio;
}

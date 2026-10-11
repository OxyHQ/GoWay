/**
 * Statue of Liberty, Liberty Island, New York — procedural, stylised.
 *
 * Fort Wood's eleven-point star, the granite plinths and the flanking steps
 * are OpenStreetMap's own outlines (way 32965412, ways 229651143–229651147 and
 * relations 3079001–3079016, read from the New York extract of 2026-10-09 and
 * rounded to 0.1 m), so the model stands exactly on what it replaces. The
 * pedestal's loggias, quoins and gallery, and the whole figure — robe, arms,
 * torch, tablet and crown — are authored here, in proportion to the
 * published dimensions (pedestal 46.9 m, statue 46 m to the torch).
 *
 * Frame: +Z is the way she faces (bearing 147°, south-east toward the
 * Narrows), +X her left (the tablet), −X her right (the torch). Origin: the
 * pedestal's centre on the ground.
 */
import {
  type Builder,
  box,
  compose,
  cylinder,
  lathe,
  prism,
  rect,
  spire,
  THREE,
  type V2,
  type V3,
} from '../kit';
import { PALETTE, WINDOW_WARM } from '../palette';
import type { LandmarkModel } from './types';

// ---------------------------------------------------------------------------
// OSM outlines in the model frame

/** Fort Wood, the star (way 32965412), top 10 m. */
const STAR: V2[] = [
  [-35.3, -18.7],
  [-35.2, -35.1],
  [-18.5, -34.2],
  [-13.2, -46.2],
  [-12.5, -47.6],
  [-4.4, -39.4],
  [1.4, -39.4],
  [9.2, -48.1],
  [16.1, -34.7],
  [33, -34.6],
  [32.4, -18.2],
  [45.3, -12.8],
  [34.5, -1.2],
  [46.5, 9.9],
  [32.9, 17.2],
  [33.3, 36.9],
  [17.4, 33.6],
  [15.9, 35],
  [-0.6, 52.1],
  [-19.2, 33.3],
  [-35.5, 36.5],
  [-35.6, 17],
  [-49.3, 10.3],
  [-37.9, -0.7],
  [-49.2, -12.7],
];

/** Steps beside the plinths: [half-width x, half-depth z, top]. */
const LOW_STEPS: Array<[number, number, number]> = [
  [13.7, 22.3, 10.5],
  [12.5, 22.3, 11],
  [11.2, 22.3, 11.5],
  [9.9, 22.3, 12],
  [8.5, 22.3, 12.5],
  [7.1, 22.3, 13],
  [5.8, 22.3, 13.5],
  [4.5, 22.3, 14],
];
const HIGH_STEPS: Array<[number, number, number]> = [
  [9.1, 14.7, 14.5],
  [8.3, 14.7, 15],
  [7.3, 14.7, 15.5],
  [6.5, 14.7, 16],
  [5.6, 14.7, 16.5],
  [4.7, 14.7, 17],
  [4, 14.7, 17.5],
  [3.2, 14.7, 18],
];

/** Pedestal top: where the statue stands. */
const TOP = 46.9;

// ---------------------------------------------------------------------------
// Materials

const MATERIALS = {
  fort: { color: '#c7c2bb', roughness: 0.9, uplight: true },
  deck: { color: '#ddd8cf', roughness: 0.95 },
  lawn: { ...PALETTE.greenery },
  pedestal: { color: '#d8c8b2', roughness: 0.85, uplight: true },
  pedestalDark: { color: '#b9a891', roughness: 0.85, uplight: true },
  glass: PALETTE.glass,
  windowLit: { ...PALETTE.windowLit, night: { color: WINDOW_WARM, strength: 1.5 } },
  copper: {
    color: '#84c4ad',
    roughness: 0.6,
    metallic: 0.12,
    uplight: true,
    // Floodlit from the fort at night: a soft, cool glow over the whole figure.
    night: { color: '#c8e9f2', strength: 0.32 },
  },
  copperDeep: {
    color: '#6faf98',
    roughness: 0.65,
    metallic: 0.12,
    night: { color: '#b4dde6', strength: 0.24 },
  },
  crownLit: { color: '#84c4ad', roughness: 0.6, night: { color: '#ffe0a0', strength: 1.4 } },
  gold: { ...PALETTE.gold, night: { color: '#ffb83d', strength: 2.2 } },
  lamp: PALETTE.lamp,
} as const;

// ---------------------------------------------------------------------------
// Local geometry helpers (smooth sweeps for the figure)

/**
 * Indexed, smooth-shaded surface through closed rings of equal size, oriented
 * outward; optional fan caps at either end.
 */
function sweep(
  rings: V3[][],
  options: { capStart?: boolean; capEnd?: boolean } = {},
): THREE.BufferGeometry {
  const n = rings[0].length;
  const positions: number[] = [];
  for (const ring of rings) for (const p of ring) positions.push(...p);
  const index: number[] = [];
  for (let r = 0; r < rings.length - 1; r++) {
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const a = r * n + i;
      const b = r * n + j;
      const c = (r + 1) * n + j;
      const d = (r + 1) * n + i;
      index.push(a, b, c, a, c, d);
    }
  }
  const centre = (ring: V3[]): V3 => {
    const c: [number, number, number] = [0, 0, 0];
    for (const p of ring) for (let k = 0; k < 3; k++) c[k] += p[k] / ring.length;
    return c;
  };
  const fan = (r: number) => {
    const c = centre(rings[r]);
    const ci = positions.length / 3;
    positions.push(...c);
    for (let i = 0; i < n; i++) index.push(ci, r * n + ((i + 1) % n), r * n + i);
  };
  if (options.capStart) fan(0);
  if (options.capEnd) fan(rings.length - 1);
  // Orient outward: the majority of side faces must point away from their ring's centre.
  let vote = 0;
  const v = (i: number) =>
    new THREE.Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  for (let r = 0; r < rings.length - 1; r++) {
    const c = new THREE.Vector3(...centre(rings[r]));
    for (let i = 0; i < n; i++) {
      const t = (r * n + i) * 6;
      const [a, b, cc] = [v(index[t]), v(index[t + 1]), v(index[t + 2])];
      const normal = b.clone().sub(a).cross(cc.clone().sub(a));
      vote += Math.sign(normal.dot(a.clone().sub(c)));
    }
  }
  const sideCount = (rings.length - 1) * n * 6;
  if (vote < 0) {
    for (let t = 0; t < sideCount; t += 3) {
      const x = index[t + 1];
      index[t + 1] = index[t + 2];
      index[t + 2] = x;
    }
  } else {
    // Caps were written assuming the reversed convention; keep them consistent.
    for (let t = sideCount; t < index.length; t += 3) {
      const x = index[t + 1];
      index[t + 1] = index[t + 2];
      index[t + 2] = x;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}

/** A horizontal ring, elliptical, with optional vertical folds (drapery). */
function ring(
  y: number,
  rx: number,
  rz: number,
  n: number,
  fold: { amp: number; count: number; phase: number } = { amp: 0, count: 0, phase: 0 },
  cx = 0,
  cz = 0,
): V3[] {
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Folds hang mostly at the front and sides; the back is plainer.
    const front = 0.55 + 0.45 * Math.cos(a - Math.PI / 2);
    const k = 1 + fold.amp * front * Math.sin(fold.count * a + fold.phase);
    out.push([cx + Math.sin(a) * rx * k, y, cz + Math.cos(a) * rz * k]);
  }
  return out;
}

/** A tube through `path` with a radius per point, parallel-transported rings. */
function tube(path: V3[], radii: number[], n: number, caps = true): THREE.BufferGeometry {
  const P = path.map((p) => new THREE.Vector3(...p));
  const rings: V3[][] = [];
  let normal: THREE.Vector3 | null = null;
  for (let k = 0; k < P.length; k++) {
    const t = P[Math.min(k + 1, P.length - 1)]
      .clone()
      .sub(P[Math.max(k - 1, 0)])
      .normalize();
    if (!normal) {
      const ref = Math.abs(t.y) < 0.9 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(1, 0, 0);
      normal = ref.clone().cross(t).normalize();
    } else {
      normal = normal
        .clone()
        .sub(t.clone().multiplyScalar(normal.dot(t)))
        .normalize();
    }
    const binormal = t.clone().cross(normal).normalize();
    const r: V3[] = [];
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const q = P[k]
        .clone()
        .addScaledVector(normal, Math.cos(a) * radii[k])
        .addScaledVector(binormal, Math.sin(a) * radii[k]);
      r.push([q.x, q.y, q.z]);
    }
    rings.push(r);
  }
  return sweep(rings, { capStart: caps, capEnd: caps });
}

/** An ellipsoid at `c` with radii `r`, rotated (YXZ Euler, radians). */
function ellipsoid(
  b: Builder,
  material: string,
  c: V3,
  r: V3,
  rotation: { x?: number; y?: number; z?: number } = {},
  segments = 16,
): void {
  b.add(
    material,
    new THREE.SphereGeometry(1, segments, Math.max(6, segments / 2)),
    compose(c, rotation, r),
    {
      smooth: true,
    },
  );
}

// ---------------------------------------------------------------------------
// Parts

function fort(b: Builder): void {
  // The star's walls, with a slight batter (the fort's sloped granite).
  b.add('fort', prism(STAR, 0, 9.2, 0.3));
  // A paved deck on top, and a parapet lip along every edge.
  b.add('deck', prism(STAR, 9.2, 9.35));
  const centre: V2 = [0, 0];
  for (let i = 0; i < STAR.length; i++) {
    const a = STAR[i];
    const c = STAR[(i + 1) % STAR.length];
    const dx = c[0] - a[0];
    const dz = c[1] - a[1];
    const len = Math.hypot(dx, dz);
    // Inward normal: toward the star's centre.
    let nx = -dz / len;
    let nz = dx / len;
    const mx = (a[0] + c[0]) / 2;
    const mz = (a[1] + c[1]) / 2;
    if ((centre[0] - mx) * nx + (centre[1] - mz) * nz < 0) {
      nx = -nx;
      nz = -nz;
    }
    const t = 0.8;
    b.add(
      'fort',
      prism(
        [
          [a[0], a[1]],
          [c[0], c[1]],
          [c[0] + nx * t, c[1] + nz * t],
          [a[0] + nx * t, a[1] + nz * t],
        ],
        9.2,
        10.2,
      ),
    );
    // Dark embrasures in the long walls.
    if (len > 14) {
      const count = Math.floor(len / 7);
      for (let k = 1; k <= count; k++) {
        const s = k / (count + 1);
        const px = a[0] + dx * s - nx * 0.06;
        const pz = a[1] + dz * s - nz * 0.06;
        const ux = dx / len;
        const uz = dz / len;
        const w = 0.7;
        b.add(
          k % 3 === 0 ? 'windowLit' : 'glass',
          prism(
            [
              [px - ux * w, pz - uz * w],
              [px + ux * w, pz + uz * w],
              [px + ux * w + nx * 0.1, pz + uz * w + nz * 0.1],
              [px - ux * w + nx * 0.1, pz - uz * w + nz * 0.1],
            ],
            3.2,
            5.4,
          ),
        );
      }
    }
  }
  // Lawns inside the star's points are the island's; the court is paved.
}

function plinths(b: Builder): void {
  // Granite plinth on the fort (way 229651147) and the upper terrace (…143).
  b.add('pedestal', prism(rect(40, 40), 10, 14, 0.3));
  b.add('pedestal', prism(rect(25.4, 25.4), 14, 18, 0.3));
  // The OSM steps, front and back, each a slab from the fort deck up.
  for (const [hx, hz, top] of LOW_STEPS) b.add('deck', prism(rect(hx * 2, hz * 2), 10, top));
  for (const [hx, hz, top] of HIGH_STEPS) b.add('deck', prism(rect(hx * 2, hz * 2), 14, top));
}

function pedestal(b: Builder): void {
  // The die (way 229651144): a squat granite block with three arched doors a side.
  b.add('pedestal', prism(rect(18, 19), 18, 26, 0.35));
  b.add('pedestal', prism(rect(19, 20), 25.2, 26.4, 0.2));
  // The shaft (way 229651145), 15 × 16 m.
  const W = 15;
  const D = 16;
  b.add('pedestalDark', prism(rect(W - 1.2, D - 1.2), 26, 45, 0));
  // Corner quoins and the side bays stand proud, so each face's middle bay
  // reads as a recess with its loggia.
  const bay = 7.2;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const xs = [(sx * bay) / 2, (sx * W) / 2];
      const zs = [(sz * bay) / 2, (sz * D) / 2];
      b.add(
        'pedestal',
        box([Math.min(...xs), 26, Math.min(...zs)], [Math.max(...xs), 45, Math.max(...zs)], 0.2),
      );
    }
  }
  // Loggias: on every face, three tall lit openings between four columns, a
  // balcony slab below and a lintel above; rosettes beneath.
  const faces: Array<{ n: V3; u: V3; half: number }> = [
    { n: [0, 0, 1], u: [1, 0, 0], half: D / 2 - 0.6 },
    { n: [0, 0, -1], u: [-1, 0, 0], half: D / 2 - 0.6 },
    { n: [1, 0, 0], u: [0, 0, -1], half: W / 2 - 0.6 },
    { n: [-1, 0, 0], u: [0, 0, 1], half: W / 2 - 0.6 },
  ];
  for (const { n, u, half } of faces) {
    const at = (s: number, y: number, out: number): V3 => [
      n[0] * (half + out) + u[0] * s,
      y,
      n[2] * (half + out) + u[2] * s,
    ];
    const slab = (
      material: string,
      s0: number,
      s1: number,
      y0: number,
      y1: number,
      o0: number,
      o1: number,
    ) => {
      const a = at(s0, 0, o0);
      const c = at(s1, 0, o1);
      b.add(
        material,
        box(
          [Math.min(a[0], c[0]), y0, Math.min(a[2], c[2])],
          [Math.max(a[0], c[0]), y1, Math.max(a[2], c[2])],
        ),
      );
    };
    // Openings (the lit loggia windows).
    for (const s of [-2.15, 0, 2.15]) slab('windowLit', s - 0.75, s + 0.75, 33.6, 40.2, 0.02, 0.08);
    // Columns.
    for (const s of [-3.2, -1.07, 1.07, 3.2]) {
      const p = at(s, 0, 0.55);
      b.add('pedestal', cylinder(0.32, 0.28, 33.4, 40.6, 10).translate(p[0], 0, p[2]), undefined, {
        smooth: true,
      });
    }
    slab('pedestal', -3.7, 3.7, 32.8, 33.4, -0.1, 1.0); // balcony
    slab('pedestal', -3.7, 3.7, 40.6, 41.6, -0.1, 0.8); // lintel
    // Rosette discs.
    for (const s of [-2.4, -0.8, 0.8, 2.4]) {
      const p = at(s, 0, 0.05);
      const disc = new THREE.CylinderGeometry(0.42, 0.42, 0.25, 12);
      disc.rotateX(Math.PI / 2);
      const m = new THREE.Matrix4().lookAt(
        new THREE.Vector3(),
        new THREE.Vector3(...n),
        new THREE.Vector3(0, 1, 0),
      );
      disc.applyMatrix4(m);
      disc.translate(p[0], 29.6, p[2]);
      b.add('pedestal', disc);
    }
    // Arched doors in the die.
    for (const s of [-3, 0, 3]) {
      const dHalf = (n[2] !== 0 ? 19 : 18) / 2;
      const p: V3 = [n[0] * (dHalf + 0.02) + u[0] * s, 0, n[2] * (dHalf + 0.02) + u[2] * s];
      const w = 0.9;
      const a: V3 = [p[0] - u[0] * w, 0, p[2] - u[2] * w];
      const c: V3 = [p[0] + u[0] * w + n[0] * 0.06, 0, p[2] + u[2] * w + n[2] * 0.06];
      b.add(
        s === 0 ? 'windowLit' : 'glass',
        box(
          [Math.min(a[0], c[0]), 19.4, Math.min(a[2], c[2])],
          [Math.max(a[0], c[0]), 23.4, Math.max(a[2], c[2])],
        ),
      );
    }
  }
  // String course and the cornice (way 229651146).
  b.add('pedestal', prism(rect(W + 0.5, D + 0.5), 42.4, 43, 0.1));
  b.add('pedestal', prism(rect(W, D), 43, 45, 0));
  b.add('pedestal', prism(rect(16.6, 17.4), 45, TOP, 0.35));
  // The gallery parapet with crenellations and small lit openings.
  const pw = 16.2;
  const pd = 17;
  const t = 0.5;
  for (const [x0, z0, x1, z1] of [
    [-pw / 2, pd / 2 - t, pw / 2, pd / 2],
    [-pw / 2, -pd / 2, pw / 2, -pd / 2 + t],
    [pw / 2 - t, -pd / 2, pw / 2, pd / 2],
    [-pw / 2, -pd / 2, -pw / 2 + t, pd / 2],
  ] as const) {
    b.add('pedestal', box([x0, TOP, z0], [x1, TOP + 0.9, z1]));
    const along = x1 - x0 > z1 - z0;
    const len = along ? x1 - x0 : z1 - z0;
    const count = Math.round(len / 1.6);
    for (let k = 0; k < count; k++) {
      if (k % 2 === 1) continue;
      const s0 = (k / count) * len;
      const s1 = ((k + 1) / count) * len;
      b.add(
        'pedestal',
        along
          ? box([x0 + s0, TOP + 0.9, z0], [x0 + s1, TOP + 1.6, z1])
          : box([x0, TOP + 0.9, z0 + s0], [x1, TOP + 1.6, z0 + s1]),
      );
    }
  }
  // Small lit openings in the frieze under the cornice.
  for (const [nx, nz] of [
    [0, 1],
    [0, -1],
    [1, 0],
    [-1, 0],
  ] as const) {
    const half = nz !== 0 ? D / 2 : W / 2;
    for (let k = -2; k <= 2; k++) {
      const s = k * 2.4;
      const cx = nx * (half + 0.02) + (nz !== 0 ? s : 0);
      const cz = nz * (half + 0.02) + (nx !== 0 ? s : 0);
      const hw = 0.45;
      b.add(
        'windowLit',
        box(
          [cx - (nz !== 0 ? hw : 0.05), 43.6, cz - (nx !== 0 ? hw : 0.05)],
          [cx + (nz !== 0 ? hw : 0.05), 44.6, cz + (nx !== 0 ? hw : 0.05)],
        ),
      );
    }
  }
}

function figure(b: Builder): void {
  const y0 = TOP;
  // A low plinth under the robe's hem.
  b.add('pedestal', prism(rect(10.5, 9.5), y0, y0 + 0.7, 0.2));
  const base = y0 + 0.7;

  // The robe: elliptical rings from hem to shoulders, folds strongest at the hem.
  const rows: Array<[number, number, number, number]> = [
    // [height above base, rx, rz, fold amplitude]
    [0, 4.85, 4.6, 0.11],
    [1.2, 4.6, 4.4, 0.11],
    [4, 4.15, 3.95, 0.09],
    [8, 3.85, 3.6, 0.08],
    [12, 3.7, 3.4, 0.07],
    [15.5, 3.6, 3.2, 0.06],
    [18, 3.4, 3.0, 0.045],
    [21, 3.6, 3.1, 0.035],
    [23.5, 3.95, 3.0, 0.03],
    [25.4, 4.15, 2.7, 0.02],
    [26.6, 3.7, 2.3, 0.0],
    [27.4, 2.6, 1.9, 0.0],
    [27.9, 1.25, 1.2, 0.0],
  ];
  // Resample the control rows every ~0.7 m, so the folds run smoothly.
  const N = 56;
  const dense: Array<[number, number, number, number]> = [];
  for (let r = 0; r < rows.length - 1; r++) {
    const [h0, x0, z0, a0] = rows[r];
    const [h1, x1, z1, a1] = rows[r + 1];
    const steps = Math.max(1, Math.round((h1 - h0) / 0.7));
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      const e = t * t * (3 - 2 * t);
      dense.push([h0 + (h1 - h0) * t, x0 + (x1 - x0) * e, z0 + (z1 - z0) * e, a0 + (a1 - a0) * t]);
    }
  }
  dense.push(rows[rows.length - 1]);
  b.add(
    'copper',
    sweep(
      dense.map(([h, rx, rz, amp]) =>
        ring(
          base + h,
          rx,
          rz,
          N,
          // Eleven folds that wander a little as they rise.
          { amp, count: 11, phase: 0.4 + h * 0.045 },
          0,
          0.3 * Math.max(0, 1 - h / 6),
        ),
      ),
      { capStart: true },
    ),
    undefined,
    { smooth: true },
  );
  // The toga's diagonal fold, right hip to left shoulder.
  b.add(
    'copperDeep',
    tube(
      [
        [-3.4, base + 13, 2.1],
        [-1.6, base + 17, 2.75],
        [0.6, base + 21, 2.85],
        [2.4, base + 24.2, 2.4],
        [3.3, base + 26.3, 1.2],
      ],
      [0.55, 0.62, 0.6, 0.55, 0.45],
      10,
    ),
    undefined,
    { smooth: true },
  );
  // Hem fold over the feet, front.
  ellipsoid(b, 'copperDeep', [0.8, base + 0.5, 3.6], [2.2, 0.6, 0.9]);

  // Neck and head (5.3 m chin to crown), facing +Z.
  const neckTop = base + 29;
  b.add('copper', cylinder(1.15, 1.05, base + 27.4, neckTop + 0.4, 14), undefined, {
    smooth: true,
  });
  const head: V3 = [0, neckTop + 2.35, 0.25];
  ellipsoid(b, 'copper', head, [1.9, 2.55, 2.15], {}, 28);
  // Hair gathered at the back, and the nose/brow line.
  ellipsoid(b, 'copperDeep', [0, head[1] - 0.8, -1.55], [1.0, 0.95, 0.75]);
  ellipsoid(b, 'copper', [0, head[1] - 0.2, 2.25], [0.3, 0.75, 0.35], {}, 8);

  // The crown: a band with its lit windows, and seven rays.
  const crownY = head[1] + 1.15;
  b.add(
    'copper',
    lathe(
      [
        [2.05, crownY - 0.7],
        [2.3, crownY - 0.4],
        [2.3, crownY + 0.55],
        [2.0, crownY + 0.85],
      ],
      24,
      { capTop: true },
    ).translate(0, 0, 0.25),
    undefined,
    { smooth: true },
  );
  for (let k = 0; k < 9; k++) {
    const a = ((k - 4) / 4) * 1.15;
    const px = Math.sin(a) * 2.32;
    const pz = Math.cos(a) * 2.32 + 0.25;
    b.add(
      'crownLit',
      box([-0.17, -0.22, -0.04], [0.17, 0.22, 0.04]),
      compose([px, crownY + 0.05, pz], { y: a }),
    );
  }
  for (let k = 0; k < 7; k++) {
    const phi = (((k - 3) / 3) * (95 * Math.PI)) / 180;
    const elev = ((14 + 30 * Math.cos(phi)) * Math.PI) / 180;
    const length = 3.1;
    const ray = spire(rect(0.62, 0.3), 0, [0, length, 0]);
    b.add(
      'copper',
      ray,
      compose([Math.sin(phi) * 2.05, crownY + 0.55, Math.cos(phi) * 2.05 + 0.25], {
        y: phi,
        x: Math.PI / 2 - elev,
      }),
    );
  }

  // The raised right arm (−X), sleeve falling back from it.
  const shoulderR: V3 = [-3.55, base + 25.6, 0.1];
  const elbowR: V3 = [-4.35, base + 31.6, 0.7];
  const wristR: V3 = [-4.3, base + 37.2, 1.0];
  b.add(
    'copper',
    tube(
      [shoulderR, [-4.0, base + 28.6, 0.4], elbowR, [-4.4, base + 34.4, 0.9], wristR],
      [1.35, 1.2, 1.05, 0.9, 0.75],
      20,
    ),
    undefined,
    { smooth: true },
  );
  // The sleeve: a loose cone of cloth from the elbow to the shoulder, hanging behind.
  b.add(
    'copperDeep',
    tube(
      [
        [-4.1, base + 30.5, 0.3],
        [-3.9, base + 28.2, -0.2],
        [-3.5, base + 25.6, -0.6],
        [-3.0, base + 23.4, -0.9],
      ],
      [1.05, 1.35, 1.45, 1.15],
      14,
    ),
    undefined,
    { smooth: true },
  );
  // Hand round the torch.
  ellipsoid(b, 'copper', [-4.3, base + 37.9, 1.0], [0.9, 1.0, 0.85], {}, 12);
  // The torch: handle, cup, gallery, flame.
  const tx = -4.3;
  const tz = 1.0;
  b.add(
    'copper',
    lathe(
      [
        [0.45, base + 37.3],
        [0.55, base + 39.5],
        [0.75, base + 40.2],
        [1.25, base + 40.9],
        [1.35, base + 41.2],
      ],
      14,
      { capTop: true },
    ).translate(tx, 0, tz),
    undefined,
    { smooth: true },
  );
  // Gallery ring around the flame.
  b.add('gold', cylinder(1.7, 1.7, base + 41.15, base + 41.4, 18).translate(tx, 0, tz), undefined, {
    smooth: true,
  });
  b.add(
    'gold',
    lathe(
      [
        [0.0, base + 41.2],
        [0.95, base + 41.45],
        [1.25, base + 42.1],
        [1.2, base + 42.9],
        [0.85, base + 43.7],
        [0.4, base + 44.35],
        [0.0, base + 44.7],
      ],
      14,
    ).translate(tx, 0, tz),
    undefined,
    { smooth: true },
  );

  // Tongues of flame licking up around the core.
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2 + 0.3;
    ellipsoid(
      b,
      'gold',
      [tx + Math.sin(a) * 0.75, base + 43.1 + (k % 2) * 0.35, tz + Math.cos(a) * 0.75],
      [0.32, 0.95, 0.32],
      { y: a, x: 0.42 },
      8,
    );
  }

  // The left arm (+X), bent, cradling the tablet against her side.
  const shoulderL: V3 = [3.75, base + 25.3, 0];
  b.add(
    'copper',
    tube(
      [
        shoulderL,
        [4.35, base + 22.4, 0.3],
        [4.55, base + 19.6, 0.9],
        [4.05, base + 18.9, 2.2],
        [3.3, base + 19.4, 3.0],
      ],
      [1.3, 1.15, 1.0, 0.85, 0.7],
      12,
    ),
    undefined,
    { smooth: true },
  );
  // The tablet: 7.2 × 4.1 × 0.6 m, upright, held at its foot, top against the shoulder.
  const tablet = new THREE.Matrix4().compose(
    new THREE.Vector3(4.9, base + 21.6, 1.7),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.18, 0.95, 0.12, 'YXZ')),
    new THREE.Vector3(1, 1, 1),
  );
  b.add('copper', box([-2.05, -3.6, -0.3], [2.05, 3.6, 0.3], 0.12), tablet);
  b.add('copperDeep', box([-1.75, -3.25, 0.28], [1.75, 3.25, 0.36]), tablet);
}

export const statueOfLiberty: LandmarkModel = {
  id: 'statue-of-liberty',
  materials: MATERIALS,
  build(b) {
    fort(b);
    plinths(b);
    pedestal(b);
    figure(b);
  },
};

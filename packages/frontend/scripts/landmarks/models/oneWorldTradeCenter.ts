/**
 * One World Trade Center, New York — procedural, stylised.
 *
 * Massing: OpenStreetMap's own parts for the tower (way 713565776's parts,
 * read from the city tiles' ODbL extract of 2026-10-09): the 65 m base square,
 * the 46 m top square turned 45° above it at 417 m (its corners stand over the
 * base's edge midpoints), the round spire platform and the 541 m spire. The
 * shaft between the two squares is the tower's signature: eight tall
 * isosceles glass triangles, four standing on the base's edges and four on
 * their points at its corners, so the plan turns from square to octagon to a
 * square at 45°. Authored here: the finned podium, the glass banding (lit by
 * floors at night), the corner seams, the parapet and the spire's rings.
 *
 * Frame: +Z faces West Street (bearing 297°); +X faces bearing 207°.
 */
import {
  cylinder,
  hash01,
  loft,
  piers,
  planFrames,
  prism,
  rect,
  THREE,
  tube,
  type V2,
  type V3,
} from '../kit';
import { PALETTE } from '../palette';
import type { LandmarkModel } from './types';

const A = 32.6; // base half-side
const B = 32.6; // top square half-diagonal
const Y0 = 56; // top of the podium
const Y1 = 417; // roof
const BAND = 4.1; // one storey per band

const lerp3 = (p: V3, q: V3, t: number): V3 => [
  p[0] + (q[0] - p[0]) * t,
  p[1] + (q[1] - p[1]) * t,
  p[2] + (q[2] - p[2]) * t,
];

/** One glass facet, cut into storey bands and ~8 m panels, each lit or dark. */
function facet(
  lit: number[],
  dark: number[],
  lines: number[],
  left: [V3, V3],
  right: [V3, V3],
  outward: V3,
  seed: number,
): void {
  const bands = Math.round((Y1 - Y0) / BAND);
  for (let i = 0; i < bands; i++) {
    const t0 = i / bands;
    const t1 = (i + 1) / bands;
    const l0 = lerp3(left[0], left[1], t0);
    const l1 = lerp3(left[0], left[1], t1);
    const r0 = lerp3(right[0], right[1], t0);
    const r1 = lerp3(right[0], right[1], t1);
    const width = Math.max(
      Math.hypot(r0[0] - l0[0], r0[2] - l0[2]),
      Math.hypot(r1[0] - l1[0], r1[2] - l1[2]),
    );
    const pieces = Math.max(1, Math.round(width / 5));
    for (let k = 0; k < pieces; k++) {
      const s0 = k / pieces;
      const s1 = (k + 1) / pieces;
      const a = lerp3(l0, r0, s0);
      const b = lerp3(l0, r0, s1);
      const c = lerp3(l1, r1, s1);
      const d = lerp3(l1, r1, s0);
      // Offices light whole floors: a floor is mostly on or mostly off.
      const floorOn = hash01(seed, i) < 0.58;
      const on = floorOn ? hash01(seed, i, k, 2) > 0.16 : hash01(seed, i, k, 3) < 0.1;
      const out = on ? lit : dark;
      const tri = (p: V3, q: V3, r: V3) => {
        const n = new THREE.Vector3(q[0] - p[0], q[1] - p[1], q[2] - p[2]).cross(
          new THREE.Vector3(r[0] - p[0], r[1] - p[1], r[2] - p[2]),
        );
        if (n.lengthSq() < 1e-8) return;
        if (n.dot(new THREE.Vector3(...outward)) >= 0) out.push(...p, ...q, ...r);
        else out.push(...p, ...r, ...q);
      };
      tri(a, b, c);
      tri(a, c, d);
    }
    // A thin spandrel line every second storey, a hair proud of the glass.
    if (i % 2 === 1) {
      const n = new THREE.Vector3(r0[0] - l0[0], r0[1] - l0[1], r0[2] - l0[2])
        .cross(new THREE.Vector3(l1[0] - l0[0], l1[1] - l0[1], l1[2] - l0[2]))
        .normalize();
      if (n.dot(new THREE.Vector3(...outward)) < 0) n.negate();
      const o = (p: V3, dy: number): V3 => [p[0] + n.x * 0.1, p[1] + dy, p[2] + n.z * 0.1];
      const p0 = o(l1, -0.2);
      const p1 = o(r1, -0.2);
      const p2 = o(r1, 0.2);
      const p3 = o(l1, 0.2);
      const m = new THREE.Vector3(p1[0] - p0[0], 0, p1[2] - p0[2]).cross(
        new THREE.Vector3(0, 1, 0),
      );
      if (m.dot(n) < 0) lines.push(...p0, ...p1, ...p2, ...p0, ...p2, ...p3);
      else lines.push(...p0, ...p2, ...p1, ...p0, ...p3, ...p2);
    }
  }
}

export const oneWorldTradeCenter: LandmarkModel = {
  id: 'one-world-trade-center',
  materials: {
    glass: {
      color: '#a3b9cc',
      metallic: 0.3,
      roughness: 0.14,
      night: { color: '#aebfe8', strength: 0.24 },
    },
    glassLit: {
      color: '#a3b9cc',
      metallic: 0.3,
      roughness: 0.14,
      night: { color: '#e3ebff', strength: 0.46 },
    },
    mullion: { color: '#dde3e8', metallic: 0.25, roughness: 0.3 },
    podium: { color: '#c7cfd6', metallic: 0.25, roughness: 0.3, uplight: true },
    fin: { color: '#e3e8ec', metallic: 0.3, roughness: 0.25 },
    lobby: {
      color: '#5e7184',
      metallic: 0.2,
      roughness: 0.2,
      night: { color: '#ffe0b0', strength: 1.2 },
    },
    steel: PALETTE.steel,
    parapet: {
      color: '#dfe5ea',
      metallic: 0.3,
      roughness: 0.3,
      night: { color: '#f2f6ff', strength: 0.9 },
    },
    spireLit: {
      color: '#d3d8de',
      metallic: 0.25,
      roughness: 0.35,
      night: { color: '#ffffff', strength: 0.75 },
    },
    beacon: { color: '#f0f4ff', roughness: 0.4, night: { color: '#ffffff', strength: 2 } },
  },
  build(b) {
    // The podium: 56 m of vertical glass fins over a lit, glazed lobby.
    const base = rect(2 * A, 2 * A);
    b.add('lobby', prism(rect(2 * A - 1.6, 2 * A - 1.6), 0, 12));
    b.add('podium', prism(base, 12, Y0, 0.3));
    planFrames(base, 0).forEach((frame) => {
      b.add('fin', piers(frame, 44, 12.4, Y0 - 0.6, 0.36, 0.55));
      // Lobby mullions.
      b.add('fin', piers(frame, 14, 0, 12, 0.3, 0.9));
    });
    b.add('podium', prism(base, 11.4, 12.6, 0.1));

    // The shaft: eight glass triangles between the base square and the top
    // square turned 45° (corners over the base's edge midpoints).
    const lit: number[] = [];
    const dark: number[] = [];
    const lines: number[] = [];
    const corners: V3[] = [
      [A, Y0, A],
      [-A, Y0, A],
      [-A, Y0, -A],
      [A, Y0, -A],
    ];
    const tops: V3[] = [
      [0, Y1, B],
      [-B, Y1, 0],
      [0, Y1, -B],
      [B, Y1, 0],
    ];
    for (let i = 0; i < 4; i++) {
      const c0 = corners[i];
      const c1 = corners[(i + 1) % 4];
      const apex = tops[i]; // over the midpoint of c0–c1
      const mid: V3 = [(c0[0] + c1[0]) / 2, 0, (c0[2] + c1[2]) / 2];
      // Standing triangle on the base edge.
      facet(lit, dark, lines, [c0, apex], [c1, apex], mid, i * 11 + 1);
      // Inverted triangle on corner c1, between this apex and the next.
      const next = tops[(i + 1) % 4];
      facet(lit, dark, lines, [c1, apex], [c1, next], [c1[0], 0, c1[2]], i * 11 + 5);
      // The seams: steel up each edge of the triangles.
      b.add('steel', tube([c0, apex], 0.35, 4));
      b.add('steel', tube([c1, apex], 0.35, 4));
    }
    for (const [name, list] of [
      ['glassLit', lit],
      ['glass', dark],
      ['mullion', lines],
    ] as const) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(list, 3));
      b.add(name, g);
    }

    // Parapet, roof and the round spire platform.
    const top: V2[] = [
      [0, B + 0.4],
      [-B - 0.4, 0],
      [0, -B - 0.4],
      [B + 0.4, 0],
    ];
    b.add('parapet', prism(top, Y1 - 4.5, Y1 + 1.5, 0.2));
    b.add('steel', cylinder(17.8, 17.8, Y1 + 1.5, 420.5, 32));
    b.add(
      'steel',
      loft([
        { y: 420.5, plan: rect(9, 9) },
        { y: 438, plan: rect(4.4, 4.4) },
      ]),
    );
    b.add('spireLit', cylinder(2.3, 0.85, 438, 536, 12));
    for (const y of [455, 478, 501]) b.add('spireLit', cylinder(3.6, 3.6, y, y + 0.9, 16));
    b.add('beacon', cylinder(0.55, 0.3, 536, 541, 8));
  },
};

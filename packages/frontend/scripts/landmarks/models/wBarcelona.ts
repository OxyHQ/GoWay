/**
 * W Barcelona (Hotel Vela; Ricard Bofill, 2009) — procedural, stylised.
 *
 * Plan and heights are OpenStreetMap's own outline and `building:part`s for
 * the hotel (relation 21282017 and its parts, read from the city tiles' ODbL
 * extract of 2026-10-08, rounded to 0.1 m): the lens-shaped sail on its
 * podium, 98.8 m at its tall western end stepping down to 73.2 m at the
 * seaward eastern end, whose facade leans OUT over the first ~44 m (the parts
 * there start higher the further east they reach). The roof here is that
 * stepped line smoothed into one curve; the mirrored curtain wall, its floor
 * bands, the lit rooms and the lit crown line are authored.
 *
 * Frame: heading 180° — +Z faces south (the sea), +X faces east, so a model
 * point is (x, z) = (east, −north) of the anchor.
 */
import { facadeWindows, planFrames, prism, THREE, type V2, type V3 } from '../kit';
import { PALETTE } from '../palette';
import { smoothstep, TrisByMaterial } from './bcnModernKit';
import type { LandmarkModel } from './types';

/** The sail's plan above the lean (east, north), clockwise from the west end along the north side. */
const SAIL_EN: ReadonlyArray<readonly [number, number]> = [
  [-28.6, 7.8],
  [-25.3, 8.9],
  [-21.9, 10.0],
  [-18.8, 10.5],
  [-15.9, 10.7],
  [-11.5, 11.0],
  [-7.1, 11.2],
  [-3.6, 11.0],
  [-0.2, 10.7],
  [2.7, 10.3],
  [6.5, 9.6],
  [9.9, 8.9],
  [13.0, 8.0],
  [15.7, 7.1],
  [18.0, 6.5],
  [20.0, 5.8],
  [22.3, 4.8],
  [24.5, 3.8],
  [28.3, 2.0],
  [27.6, -1.0],
  [27.1, -4.0],
  [26.8, -8.4],
  [26.5, -12.8],
  [22.9, -13.5],
  [18.0, -13.9],
  [12.6, -14.2],
  [6.5, -13.9],
  [1.2, -13.5],
  [-2.2, -13.0],
  [-5.6, -12.4],
  [-9.6, -11.3],
  [-12.3, -10.6],
  [-17.0, -9.0],
  [-20.1, -7.7],
  [-23.3, -6.3],
  [-25.7, -5.0],
  [-28.2, -3.2],
  [-30.0, -1.6],
  [-29.4, 0.4],
  [-27.5, 2.4],
  [-28.0, 5.1],
];

/** The podium wrapped round the sail's land end (east, north). */
const PODIUM_EN: ReadonlyArray<readonly [number, number]> = [
  [-18.8, -9.9],
  [-16.1, -11.0],
  [-17.0, -18.6],
  [-53.3, -13.9],
  [-51.3, 1.1],
  [-47.9, 26.0],
  [-11.8, 21.0],
  [-13.0, 12.5],
  [-15.7, 12.3],
  [-15.9, 10.7],
  [-18.8, 10.5],
  [-21.9, 10.0],
  [-25.3, 8.9],
  [-28.6, 7.8],
  [-28.0, 5.1],
  [-27.5, 2.4],
  [-29.4, 0.4],
  [-30.0, -1.6],
  [-28.2, -3.2],
  [-25.7, -5.0],
  [-23.3, -6.3],
  [-20.1, -7.7],
];

const toModel = ([e, n]: readonly [number, number]): V2 => [e, -n];
const SAIL: V2[] = SAIL_EN.map(toModel);
const PODIUM: V2[] = PODIUM_EN.map(toModel);

const FLOOR = 3.66;
const PODIUM_TOP = 25.6;

/** Roof height over a point `x` metres east: 98.8 m at the land end, 73.2 m seaward. */
function roof(x: number): number {
  return 73.2 + 25.6 * (1 - smoothstep(1, 20, x));
}

/** The seaward end leans out: at the ground it stands ~4 m further west. */
function lean(x: number, y: number): number {
  return -4 * Math.max(0, 1 - y / 44) * smoothstep(14, 26, x);
}

function at(p: V2, y: number): V3 {
  return [p[0] + lean(p[0], y), y, p[1]];
}

/** Split long edges so the wall has bays (and the night pattern has rooms). */
function densify(plan: readonly V2[], step: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i < plan.length; i++) {
    const a = plan[i];
    const b = plan[(i + 1) % plan.length];
    const n = Math.max(1, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
    for (let k = 0; k < n; k++)
      out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

function hash(...v: number[]): number {
  let h = 2166136261;
  for (const x of v) {
    h ^= Math.floor(x * 1000) & 0xffffffff;
    h = Math.imul(h, 16777619);
    h ^= h >>> 13;
  }
  return (h >>> 0) / 4294967296;
}

export const wBarcelona: LandmarkModel = {
  id: 'w-barcelona',
  materials: {
    // Mirrored glass: silver-blue by day; at night a faint cool glow of the
    // whole skin, with the lit rooms warmer and brighter.
    mirror: {
      color: '#b2c7d8',
      metallic: 0.15,
      roughness: 0.12,
      night: { color: '#7fa6d6', strength: 0.22 },
    },
    mirrorLit: {
      color: '#b2c7d8',
      metallic: 0.15,
      roughness: 0.12,
      night: { color: '#ffd9a6', strength: 0.5 },
    },
    band: { color: '#dfe5ea', metallic: 0.2, roughness: 0.35 },
    crown: { color: '#e9edf0', roughness: 0.4, night: { color: '#eaf4ff', strength: 1.1 } },
    roof: { color: '#a4a9ae', roughness: 0.85 },
    podium: PALETTE.white,
    glass: { color: '#7f97ab', metallic: 0.15, roughness: 0.2 },
    windowLit: PALETTE.windowLit,
  },
  build(b) {
    const plan = densify(SAIL, 2.4);
    // The plan is clockwise seen from above in (x, z) = (east, south)… check
    // by its signed area and wind every wall to face out.
    let area = 0;
    for (let i = 0; i < plan.length; i++) {
      const [x0, z0] = plan[i];
      const [x1, z1] = plan[(i + 1) % plan.length];
      area += x0 * z1 - x1 * z0;
    }
    const outward = area > 0 ? 1 : -1;
    const tris = new TrisByMaterial();

    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const q = plan[(i + 1) % plan.length];
      const hp = roof(p[0]);
      const hq = roof(q[0]);
      const top = Math.min(hp, hq);
      // Edge normal in plan, for the floor bands.
      const ex = q[0] - p[0];
      const ez = q[1] - p[1];
      const len = Math.hypot(ex, ez) || 1;
      const nx = (ez / len) * outward;
      const nz = (-ex / len) * outward;
      const wall = (a: V3, bb: V3, c: V3, d: V3, material: string) => {
        // a,b bottom (p,q), c,d top (q,p): wind so the face points along (nx, nz).
        const u = new THREE.Vector3(bb[0] - a[0], bb[1] - a[1], bb[2] - a[2]);
        const v = new THREE.Vector3(d[0] - a[0], d[1] - a[1], d[2] - a[2]);
        const f = u.cross(v);
        if (f.x * nx + f.z * nz < 0) tris.get(material).quad(a, d, c, bb);
        else tris.get(material).quad(a, bb, c, d);
      };
      let y = 0;
      let floor = 0;
      while (y < top - 0.01) {
        const y1 = Math.min(top, y + FLOOR);
        const lit = hash(7, i, floor) < 0.36 && floor > 0;
        wall(
          at(p, y),
          at(q, y),
          at(q, y1),
          at(p, y1),
          y1 - y < 1.5 ? 'crown' : lit ? 'mirrorLit' : 'mirror',
        );
        // A floor band standing a little proud.
        if (floor > 0) {
          const o = 0.18;
          const off = (pt: V2, yy: number): V3 => {
            const base = at(pt, yy);
            return [base[0] + nx * o, yy, base[2] + nz * o];
          };
          wall(off(p, y - 0.22), off(q, y - 0.22), off(q, y + 0.22), off(p, y + 0.22), 'band');
        }
        y = y1;
        floor++;
      }
      // The sloped top of this bay, and the crown line along the roof edge.
      if (Math.abs(hp - hq) > 0.01) {
        const pTop = at(p, top);
        const qTop = at(q, top);
        const pRoof = at(p, hp);
        const qRoof = at(q, hq);
        tris.get('crown').tri(...orient([pTop, qTop, hp > hq ? pRoof : qRoof], nx, nz));
      }
      const cy = Math.max(hp, hq);
      wall(at(p, hp), at(q, hq), at(q, Math.min(hq + 1.1, cy + 1.1)), at(p, hp + 1.1), 'crown');
    }

    // The roof: the plan lifted to its curve, a parapet's height under the crown.
    const contour = plan.map(([x, z]) => new THREE.Vector2(x, z));
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, [])) {
      const pa: V3 = [plan[i][0], roof(plan[i][0]) + 0.3, plan[i][1]];
      const pb: V3 = [plan[j][0], roof(plan[j][0]) + 0.3, plan[j][1]];
      const pc: V3 = [plan[k][0], roof(plan[k][0]) + 0.3, plan[k][1]];
      const ny = (pb[2] - pa[2]) * (pc[0] - pa[0]) - (pb[0] - pa[0]) * (pc[2] - pa[2]);
      if (ny > 0) tris.get('roof').tri(pa, pb, pc);
      else tris.get('roof').tri(pa, pc, pb);
    }

    for (const [material, t] of tris.map) b.add(material, t.geometry());

    // A roof plant box on the tall end.
    b.add(
      'roof',
      prism(
        [
          [-20, -6],
          [-6, -7],
          [-6, 6],
          [-20, 5],
        ] as V2[],
        roof(-10),
        roof(-10) + 3.2,
        0.3,
      ),
    );

    // The podium: white, glazed in bands, round the sail's land end.
    b.add('podium', prism(PODIUM, 0, PODIUM_TOP, 0.4));
    for (const [i, frame] of planFrames(PODIUM, 1.2).entries()) {
      if (frame.length < 5) continue;
      const cols = Math.max(1, Math.round(frame.length / 3.4));
      facadeWindows(b, frame, {
        width: frame.length,
        height: 22.5,
        cols,
        rows: 6,
        fill: [0.86, 0.62],
        offset: 0.06,
        lit: 'windowLit',
        dark: 'glass',
        litRatio: 0.55,
        seed: 40 + i,
      });
    }
  },
};

/** Wind a triangle to face (nx, nz) horizontally. */
function orient(t: [V3, V3, V3], nx: number, nz: number): [V3, V3, V3] {
  const [a, b, c] = t;
  const u = new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const v = new THREE.Vector3(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
  const f = u.cross(v);
  return f.x * nx + f.z * nz < 0 ? [a, c, b] : [a, b, c];
}

/**
 * Torre Glòries (Jean Nouvel, 2005), Barcelona — procedural, stylised.
 *
 * The footprint is OpenStreetMap's own outline for the tower (way 44213122,
 * read from the city tiles' ODbL extract of 2026-10-08): an ellipse of
 * ~40.1 × 37.0 m whose long axis runs east–west, and its 144.4 m height. The
 * bullet profile, the colour-graded facade and the night colours are
 * authored here.
 *
 * The look the model is after: the concrete shell's thousands of coloured
 * panels — reds and oranges at the foot, through sand to blues, pale at the
 * crown — seen through the louvred glass skin, which reads as fine horizontal
 * lines. It is drawn as a mosaic of coloured cells (dithered between
 * neighbouring bands, as the real panels are) under thin louvre rings, and the
 * glass dome on top. At night every cell glows in its band's LED colour: a
 * warm-to-cool gradient up the tower.
 *
 * Frame: +X along the long axis (bearing 274.7°, west), +Z north (heading 4.7°).
 */
import type { LandmarkMaterial } from '../glb';
import { hash01, lathe, TAU, THREE, type V3 } from '../kit';
import { PALETTE } from '../palette';
import { TrisByMaterial } from './bcnModernKit';
import type { LandmarkModel } from './types';

/** Semi-axes of the elliptical plan (OSM outline), metres. */
const A = 20.05;
const B = 18.5;
const HEIGHT = 144.4;
/** Where the shaft turns into the dome. */
const SHOULDER = 98;

/** Day colour → night LED colour, foot to crown. */
const BANDS: ReadonlyArray<readonly [string, string]> = [
  ['#b5413a', '#ff3b55'],
  ['#c95a3c', '#ff5a3c'],
  ['#d97f48', '#ff8a3a'],
  ['#d9a56a', '#ffbe4d'],
  ['#b9ab98', '#e7a6ff'],
  ['#8199b8', '#9b7dff'],
  ['#5f86b6', '#4f78ff'],
  ['#78a6d2', '#3fa6ff'],
  ['#a7c7e3', '#57d2ff'],
  ['#cfe2ef', '#a6ecff'],
];

const bandMaterials: Record<string, LandmarkMaterial> = Object.fromEntries(
  BANDS.map(([day, night], i) => [
    `panel${i}`,
    { color: day, roughness: 0.55, metallic: 0.05, night: { color: night, strength: 0.85 } },
  ]),
);

/** Radius factor of the profile at height y (1 = the footprint). */
function profile(y: number): number {
  if (y <= SHOULDER) return 1 - 0.035 * (y / SHOULDER);
  const t = Math.min(1, (y - SHOULDER) / (HEIGHT - SHOULDER));
  return 0.965 * Math.sqrt(Math.max(0, 1 - t ** 2.15));
}

function surface(theta: number, y: number, inflate = 0): V3 {
  const r = profile(y);
  return [(A * r + inflate) * Math.cos(theta), y, (B * r + inflate) * Math.sin(theta)];
}

/** Outward normal by finite differences on the surface. */
function normalAt(theta: number, y: number): V3 {
  const e = 1e-3;
  const p = new THREE.Vector3(...surface(theta, y));
  const pt = new THREE.Vector3(...surface(theta + e, y)).sub(p);
  const py = new THREE.Vector3(...surface(theta, Math.min(HEIGHT - 0.01, y + e))).sub(p);
  const n = py.cross(pt).normalize();
  // Outward: same side as the horizontal radius.
  if (n.x * Math.cos(theta) + n.z * Math.sin(theta) < 0 && y < HEIGHT - 1) n.negate();
  return [n.x, n.y, n.z];
}

export const torreGlories: LandmarkModel = {
  id: 'torre-glories',
  materials: {
    ...bandMaterials,
    louvre: { color: '#c9d6df', metallic: 0.3, roughness: 0.2 },
    dome: {
      color: '#d6e4ee',
      metallic: 0.15,
      roughness: 0.15,
      night: { color: '#b8f0ff', strength: 0.75 },
    },
    lobby: PALETTE.windowLit,
    plinth: PALETTE.granite,
    cap: PALETTE.steel,
  },
  build(b) {
    const SEG = 72;
    const tris = new TrisByMaterial();

    // Rows: one per ~3.6 m storey up the shaft, finer on the dome.
    const rows: number[] = [4.5];
    for (let y = 4.5; y < SHOULDER; ) {
      y = Math.min(SHOULDER, y + 3.65);
      rows.push(y);
    }
    for (let y = SHOULDER; y < HEIGHT - 2; ) {
      y = Math.min(HEIGHT - 2, y + 3.3);
      rows.push(y);
    }

    for (let r = 0; r < rows.length - 1; r++) {
      const y0 = rows[r];
      const y1 = rows[r + 1];
      const mid = (y0 + y1) / 2;
      const onDome = mid > SHOULDER + 4;
      for (let s = 0; s < SEG; s++) {
        const t0 = (s / SEG) * TAU;
        const t1 = ((s + 1) / SEG) * TAU;
        let material: string;
        if (onDome) {
          // The glass dome: pale cells, with the top band's panels showing through low on it.
          material = hash01(9, s, r) < 0.25 * (1 - (mid - SHOULDER) / 30) ? 'panel9' : 'dome';
        } else {
          const f = Math.max(0, mid - 4) / (SHOULDER - 4);
          const dither = (hash01(3, s, r) - 0.5) * 1.6;
          const band = Math.max(
            0,
            Math.min(BANDS.length - 1, Math.floor(f * BANDS.length + dither)),
          );
          material = `panel${band}`;
        }
        // Clockwise in (θ, y) from outside: a(θ0,y0) b(θ0,y1) c(θ1,y1) d(θ1,y0).
        const a = surface(t0, y0);
        const bb = surface(t0, y1);
        const c = surface(t1, y1);
        const d = surface(t1, y0);
        tris
          .get(material)
          .quad(a, bb, c, d, [
            normalAt(t0, y0),
            normalAt(t0, y1),
            normalAt(t1, y1),
            normalAt(t1, y0),
          ]);
      }
    }

    // Louvre rings: the glass skin's horizontal blades, standing proud of the
    // panels on every storey of the shaft.
    for (let y = 8; y < SHOULDER - 1; y += 3.65) {
      for (let s = 0; s < SEG; s++) {
        const t0 = (s / SEG) * TAU;
        const t1 = ((s + 1) / SEG) * TAU;
        const h = 0.32;
        const a = surface(t0, y, 0.35);
        const bb = surface(t0, y + h, 0.35);
        const c = surface(t1, y + h, 0.35);
        const d = surface(t1, y, 0.35);
        tris.get('louvre').quad(a, bb, c, d);
        // Its top face, so the blade reads from above as a line too.
        const ai = surface(t0, y + h, 0);
        const di = surface(t1, y + h, 0);
        tris.get('louvre').quad(ai, di, c, bb);
      }
    }

    for (const [material, t] of tris.map)
      b.add(material, t.geometry(), undefined, { smooth: true });

    // The crown's small cap, and the lit lobby ring at the foot.
    const ellipse = (g: THREE.BufferGeometry) =>
      g.applyMatrix4(new THREE.Matrix4().makeScale(A, 1, B));
    const capR = profile(HEIGHT - 2);
    b.add(
      'cap',
      ellipse(
        lathe(
          [
            [capR, HEIGHT - 2],
            [capR * 0.7, HEIGHT - 0.6],
            [0, HEIGHT],
          ],
          SEG,
        ),
      ),
      undefined,
      { smooth: true },
    );
    b.add(
      'lobby',
      ellipse(
        lathe(
          [
            [0.955, 0],
            [0.955, 4.5],
          ],
          SEG,
        ),
      ),
      undefined,
      { smooth: true },
    );
    // A soffit closing the gap between the recessed lobby and the shell.
    b.add(
      'plinth',
      ellipse(
        lathe(
          [
            [0.955, 4.5],
            [1, 4.5],
          ],
          SEG,
        ),
      ),
    );
    // Columns of the arcade around the lobby.
    for (let i = 0; i < 24; i++) {
      const t = (i / 24) * TAU;
      const [x, , z] = surface(t, 0, -0.4);
      const col = new THREE.CylinderGeometry(0.35, 0.35, 4.5, 8);
      col.translate(x, 2.25, z);
      b.add('plinth', col);
    }
    // A low plinth step the tower stands on.
    b.add(
      'plinth',
      ellipse(
        lathe(
          [
            [1.07, 0],
            [1.07, 0.4],
            [0.955, 0.4],
          ],
          SEG,
        ),
      ),
      undefined,
      {
        smooth: true,
      },
    );
  },
};

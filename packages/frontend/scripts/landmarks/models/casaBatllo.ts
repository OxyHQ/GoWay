/**
 * Casa Batlló, Barcelona (Antoni Gaudí, 1904–1906) — procedural, stylised.
 *
 * Plan: OpenStreetMap's outline of relation/9427554 and its `building:part`s
 * (ODbL, Catalonia extract of 2026-10-08), simplified to a few vertices and
 * rounded to 0.1 m, so the model fills exactly the narrow Passeig de Gràcia
 * plot it replaces and leaves its neighbours (Casa Amatller and the rest of
 * the block) to the city tiles. Everything that makes it Casa Batlló is
 * authored here: the bone-like stone of the lower floors, the rippled
 * blue-green mosaic wall with its mask balconies, the dragon-back roof of
 * iridescent scales with its spine, and the turret with the four-armed cross.
 *
 * Frame: +Z faces Passeig de Gràcia (bearing 47°); the facade plane is
 * z = 25.5 and spans x = −6.4 … 8.2. The turret stands at the facade's left
 * as seen from the street (−X).
 */
import {
  box,
  cylinder,
  facadeWindows,
  hash01,
  lathe,
  prism,
  sphere,
  THREE,
  type V2,
  type V3,
} from '../kit';
import { PALETTE } from '../palette';
import { addSmooth, placed, shell, surfaceGrid } from './bcnGaudiKit';
import type { LandmarkModel } from './types';

const FZ = 25.5;
const FX0 = -6.4;
const FX1 = 8.2;

const FRONT_BLOCK: V2[] = [
  [-6.6, 16.5],
  [7.9, 16.5],
  [8.2, FZ],
  [FX0, FZ],
];
const MAIN_BODY: V2[] = [
  [-7.7, -9.4],
  [7.0, -9.4],
  [7.5, 6.5],
  [7.9, 16.5],
  [-6.6, 16.5],
  [-7.2, 2.4],
];
const REAR: V2[] = [
  [-8.1, -23],
  [-5, -26.8],
  [3.3, -27],
  [6.8, -22.8],
  [7.0, -9.4],
  [-7.7, -9.4],
];
/** The two light wells (OSM inner rings), drawn as dark openings in the roof. */
const WELLS: V2[][] = [
  [
    [-2.4, 1.9],
    [-0.1, -0.8],
    [2.8, 1.8],
    [2.9, 6.0],
    [-2.2, 6.2],
  ],
  [
    [-2.0, 10.2],
    [3.4, 10.1],
    [3.6, 14.4],
    [1.5, 16.8],
    [0.5, 16.7],
    [-1.7, 14.4],
  ],
];

/** The roof's scales shift colour along the dragon's back: green, blue, violet, ochre. */
const ROOF_STOPS: Array<[number, [number, number, number]]> = [
  [0, [0x4f, 0x95, 0x7c]],
  [0.3, [0x3f, 0x7f, 0xa8]],
  [0.55, [0x6a, 0x6a, 0xae]],
  [0.75, [0xae, 0x7f, 0x96]],
  [1, [0xc4, 0x9a, 0x4c]],
];
const ROOF_SEGMENTS = 10;
function roofColour(t: number): string {
  let i = 0;
  while (i < ROOF_STOPS.length - 2 && t > ROOF_STOPS[i + 1][0]) i++;
  const [t0, c0] = ROOF_STOPS[i];
  const [t1, c1] = ROOF_STOPS[i + 1];
  const k = Math.max(0, Math.min(1, (t - t0) / (t1 - t0)));
  return `#${c0
    .map((c, j) =>
      Math.round(c + (c1[j] - c) * k)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}
const ROOF_TILES = Array.from({ length: ROOF_SEGMENTS }, (_, i) => `tile${i}`);
const ROOF_MATERIALS = Object.fromEntries(
  ROOF_TILES.map((name, i) => [
    name,
    { color: roofColour((i + 0.5) / ROOF_SEGMENTS), roughness: 0.3, metallic: 0.25 },
  ]),
);

export const casaBatllo: LandmarkModel = {
  id: 'casa-batllo',
  materials: {
    stucco: { color: '#e6dccb', roughness: 0.9, uplight: true },
    bone: { color: '#eadfc6', roughness: 0.7, uplight: true },
    // The mosaic keeps its blue at night: a faint cool glint instead of the warm wash.
    mosaic: {
      color: '#5b9db4',
      roughness: 0.4,
      metallic: 0.1,
      night: { color: '#4f93b8', strength: 0.22 },
    },
    mosaicDeep: { color: '#3f7f9e', roughness: 0.4, metallic: 0.1, uplight: true },
    mask: { color: '#f4efe4', roughness: 0.5, uplight: true },
    discOchre: { color: '#d9b36a', roughness: 0.35 },
    discPink: { color: '#d7a5ad', roughness: 0.35 },
    discGreen: { color: '#8fc7b4', roughness: 0.35 },
    ...ROOF_MATERIALS,
    bulb: { color: '#c99a45', roughness: 0.3, metallic: 0.25 },
    spine: { color: '#f1e5c6', roughness: 0.5 },
    cross: {
      color: '#e2bf5e',
      roughness: 0.35,
      metallic: 0.2,
      night: { color: '#ffd38f', strength: 0.6 },
    },
    roofTerrace: { color: '#d8ccb8', roughness: 0.95 },
    well: { color: '#3b3d44', roughness: 1 },
    glass: PALETTE.glass,
    windowLit: { ...PALETTE.windowLit, night: { color: '#ffcf8a', strength: 1.3 } },
  },
  build(b) {
    // --- Massing ----------------------------------------------------------
    b.add('stucco', prism(REAR, 0, 3.7, 0.15));
    b.add('stucco', prism(MAIN_BODY, 0, 21, 0.2));
    b.add('stucco', prism(FRONT_BLOCK, 0, 22.6, 0.2));
    for (const well of WELLS) b.add('well', prism(well, 21, 21.06));
    b.add('roofTerrace', prism(REAR, 3.7, 3.85));
    // Rear facade over the garden terrace: plain windows.
    facadeWindows(
      b,
      { origin: [7.0, 4.5, -9.4], u: [-1, 0, 0], v: [0, 1, 0], n: [0, 0, -1] },
      {
        width: 14.7,
        height: 15.6,
        cols: 4,
        rows: 5,
        fill: [0.5, 0.6],
        offset: 0.05,
        lit: 'windowLit',
        dark: 'glass',
        litRatio: 0.5,
        seed: 41,
      },
    );
    // Roof-terrace chimneys: small mosaic-clad stacks.
    for (const [x, z, h] of [
      [-4.5, -6, 2.4],
      [4.8, -4, 2.0],
      [5.5, 9.5, 2.6],
    ] as const) {
      b.add('mosaicDeep', placed(cylinder(0.45, 0.35, 21, 21 + h, 10), [x, 0, z]), undefined, {
        smooth: true,
      });
      b.add(
        'spine',
        placed(
          lathe(
            [
              [0.5, 21 + h],
              [0.6, 21 + h + 0.25],
              [0.15, 21 + h + 0.7],
            ],
            10,
          ),
          [x, 0, z],
        ),
        undefined,
        {
          smooth: true,
        },
      );
    }

    // --- Lower floors: the "bone" facade ------------------------------------
    const front = (x: number, y: number, dz: number): V3 => [x, y, FZ + dz];
    // Stone skin of the ground and principal floors, rippling gently.
    addSmooth(
      b,
      'bone',
      surfaceGrid(28, 10, (u, v) => {
        const x = FX0 + (FX1 - FX0) * u;
        const y = 8.6 * v;
        const dz = 0.45 + 0.18 * Math.sin(u * 9.4) * Math.sin(v * 3.1);
        return front(x, y, dz);
      }),
    );
    // Openings: ground floor arches and the principal floor's long gallery.
    const openings: Array<[number, number, number, number]> = [
      [-5.0, -2.2, 0.3, 3.6],
      [-1.1, 2.9, 0.3, 3.6],
      [4.0, 7.0, 0.3, 3.6],
      [-5.6, 7.4, 4.6, 7.9],
    ];
    for (const [x0, x1, y0, y1] of openings) {
      b.add('windowLit', box([x0, y0, FZ + 0.62], [x1, y1, FZ + 0.72]));
    }
    // Bone columns across the gallery, swelling at mid-height like vertebrae.
    for (let i = 0; i <= 6; i++) {
      const x = -5.6 + (13 * i) / 6;
      b.add(
        'bone',
        placed(
          lathe(
            [
              [0.32, 4.4],
              [0.22, 5.2],
              [0.3, 6.3],
              [0.2, 7.2],
              [0.38, 8.0],
            ],
            8,
          ),
          [x, 0, FZ + 0.85],
        ),
        undefined,
        { smooth: true },
      );
    }
    // A thick, wavy lintel over the gallery.
    addSmooth(
      b,
      'bone',
      surfaceGrid(26, 4, (u, v) => {
        const x = FX0 + (FX1 - FX0) * u;
        const y = 7.9 + 0.8 * v + 0.25 * Math.sin(u * 12.6);
        return front(x, y, 1.0 - 0.15 * v);
      }),
    );
    // Columns between the ground-floor arches.
    for (const x of [-5.8, -1.7, 3.4, 7.6]) {
      b.add(
        'bone',
        placed(
          lathe(
            [
              [0.45, 0],
              [0.35, 1.8],
              [0.5, 3.8],
              [0.3, 4.6],
            ],
            8,
          ),
          [x, 0, FZ + 0.6],
        ),
        undefined,
        {
          smooth: true,
        },
      );
    }

    // --- Upper floors: the rippled mosaic wall with mask balconies -----------
    addSmooth(
      b,
      'mosaic',
      surfaceGrid(36, 30, (u, v) => {
        const x = FX0 + (FX1 - FX0) * u;
        const y = 8.6 + (22.6 - 8.6) * v;
        const dz = 0.32 + 0.16 * Math.sin(u * 23 + v * 6) + 0.1 * Math.sin(v * 31 - u * 7);
        return front(x, y, dz);
      }),
    );
    // Ceramic discs scattered over the mosaic (the "confetti" of the facade).
    const discMaterials = ['discOchre', 'discPink', 'discGreen'] as const;
    for (let i = 0; i < 70; i++) {
      const u = hash01(i, 1);
      const v = hash01(i, 2);
      const x = FX0 + 0.5 + (FX1 - FX0 - 1) * u;
      const y = 9 + 12.8 * v;
      const r = 0.14 + 0.12 * hash01(i, 3);
      const disc = new THREE.CylinderGeometry(r, r, 0.12, 10);
      disc.rotateX(Math.PI / 2);
      b.add(discMaterials[i % 3], placed(disc, [x, y, FZ + 0.62]));
    }
    // Windows and their masks: four floors of three bays.
    const bays = [-3.6, 0.9, 5.4];
    const floors = [9.6, 12.7, 15.8, 18.9];
    floors.forEach((y, row) => {
      bays.forEach((x, col) => {
        const lit = hash01(7, row, col) < 0.6;
        b.add(
          lit ? 'windowLit' : 'glass',
          box([x - 0.7, y, FZ + 0.4], [x + 0.7, y + 2.3, FZ + 0.55]),
        );
        // The balcony "mask": a shallow cream shell under the window.
        const mask = shell(0.95, 0.7, 0.55, 10);
        b.add('mask', placed(mask, [x, y + 0.4, FZ + 0.5]), undefined, { smooth: true });
        // Its eyes: two dark holes.
        for (const e of [-0.35, 0.35]) {
          b.add('glass', placed(sphere(0.14, 8, 6), [x + e, y + 0.75, FZ + 0.95]), undefined, {
            smooth: true,
          });
        }
      });
    });
    // Top floor: a cream band with small round windows.
    addSmooth(
      b,
      'bone',
      surfaceGrid(24, 3, (u, v) => {
        const x = FX0 + (FX1 - FX0) * u;
        return front(x, 21.6 + 1.0 * v, 0.6 - 0.1 * v);
      }),
    );
    for (let i = 0; i < 7; i++) {
      const x = -3.0 + i * 1.6;
      const w = new THREE.CylinderGeometry(0.32, 0.32, 0.1, 10);
      w.rotateX(Math.PI / 2);
      b.add(i % 2 ? 'windowLit' : 'glass', placed(w, [x, 22.1, FZ + 0.68]));
    }

    // --- The dragon-back roof ---------------------------------------------------
    // A vault running along the facade, rising from the turret to its hump on
    // the right, scaled like a reptile and changing colour along its length.
    const xa = -3.9;
    const xb = 8.2;
    const za = 15.2;
    const zb = FZ + 0.4;
    const eave = 22.6;
    const ridgeAt = (t: number) =>
      eave + 1.6 + 2.8 * Math.sin(Math.PI * Math.min(1, t * 1.15)) ** 1.3;
    const vault = (u: number, v: number): V3 => {
      const x = xa + (xb - xa) * u;
      const ridge = ridgeAt(u);
      const ang = Math.PI * v; // 0 front eave → π back eave
      const z = (za + zb) / 2 + ((zb - za) / 2) * Math.cos(ang);
      const scale =
        0.09 *
        Math.abs(Math.sin(u * 60)) *
        Math.abs(Math.sin(v * 22 + (Math.floor(u * 19) % 2) * 1.5));
      const y = eave + (ridge - eave + scale) * Math.sin(ang) + scale * 0.5;
      return [x, y, z + scale * Math.cos(ang)];
    };
    const segments = ROOF_TILES.length;
    for (let s = 0; s < segments; s++) {
      const u0 = s / segments;
      const u1 = (s + 1) / segments;
      addSmooth(
        b,
        ROOF_TILES[s],
        surfaceGrid(26, 22, (u, v) => vault(u0 + (u1 - u0) * u, v)),
      );
    }
    // End walls of the vault.
    for (const u of [0, 1]) {
      const pts: number[] = [];
      const n = 22;
      for (let k = 0; k < n; k++) {
        const p0 = vault(u, k / n);
        const p1 = vault(u, (k + 1) / n);
        const c: V3 = [p0[0], eave, (za + zb) / 2];
        if (u === 0) pts.push(...c, ...p1, ...p0);
        else pts.push(...c, ...p0, ...p1);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
      b.add(u === 0 ? ROOF_TILES[0] : ROOF_TILES[ROOF_SEGMENTS - 1], g);
    }
    // The spine: a row of cream knobs along the ridge.
    for (let i = 0; i <= 22; i++) {
      const u = i / 22;
      const top = vault(u, 0.5);
      const r = 0.28 + 0.14 * Math.sin(u * Math.PI);
      b.add('spine', placed(sphere(r, 8, 6), [top[0], top[1] + r * 0.4, top[2]]), undefined, {
        smooth: true,
      });
    }

    // --- The turret with the four-armed cross -----------------------------------
    const tx = -5.0;
    const tz = 22.4;
    b.add(
      'bone',
      placed(
        lathe(
          [
            [0.95, 22.6],
            [0.95, 28.0],
            [0.85, 28.6],
          ],
          16,
        ),
        [tx, 0, tz],
      ),
      undefined,
      {
        smooth: true,
      },
    );
    for (let i = 0; i < 4; i++) {
      b.add(
        'windowLit',
        box([tx - 0.25, 24 + i * 1.0, tz + 1.05], [tx + 0.25, 24.5 + i * 1.0, tz + 1.2]),
      );
    }
    // The garlic-bulb dome.
    b.add(
      'bulb',
      placed(
        lathe(
          [
            [0.85, 28.6],
            [1.15, 29.3],
            [1.05, 30.1],
            [0.7, 30.8],
            [0.25, 31.2],
          ],
          16,
        ),
        [tx, 0, tz],
      ),
      undefined,
      { smooth: true },
    );
    // The cross: arms toward the four points, and up.
    b.add('cross', box([tx - 0.2, 31.1, tz - 0.2], [tx + 0.2, 33.6, tz + 0.2], 0.05));
    b.add('cross', box([tx - 0.9, 32.2, tz - 0.18], [tx + 0.9, 32.6, tz + 0.18], 0.05));
    b.add('cross', box([tx - 0.18, 32.2, tz - 0.9], [tx + 0.18, 32.6, tz + 0.9], 0.05));
    b.add('cross', placed(sphere(0.3, 10, 8), [tx, 33.7, tz]), undefined, { smooth: true });
  },
};

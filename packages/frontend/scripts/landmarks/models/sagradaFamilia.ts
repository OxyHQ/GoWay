/**
 * Basílica de la Sagrada Família, Barcelona — procedural, stylised, as it
 * stands in 2026: the Jesus Christ tower crowned with its cross, the four
 * Evangelists, the Mary tower with its star over the apse, the Nativity (NE)
 * and Passion (SW) facades with their four bell towers each, and the Glory
 * facade (SE) still without its towers.
 *
 * Plan: the crossing's stepped roofs are OpenStreetMap's own
 * `building:part`s of relation 9194723 (ODbL, rounded to 0.1 m), and every
 * tower stands where OSM's part for it stands; the body (nave, transept,
 * apse — absent from the city tiles), the profiles, the openings, the
 * pinnacles, the facades and the lights are authored here.
 *
 * Frame: origin at the centre of the crossing (under the Jesus tower). +Z
 * faces the Glory facade on Carrer de Mallorca (bearing 134°), +X faces the
 * Nativity facade on Carrer de la Marina (bearing 44°).
 */
import {
  type Builder,
  box,
  cylinder,
  lathe,
  loft,
  mergeAll,
  panel,
  prism,
  rect,
  sphere,
  spire,
  THREE,
  TAU,
  type V2,
  type V3,
  at,
  archOutline,
  hash01,
} from '../kit';
import type { LandmarkMaterial } from '../glb';
import { PALETTE } from '../palette';
import type { LandmarkModel } from './types';

const MATERIALS: Record<string, LandmarkMaterial> = {
  /** The nave, transept and apse: warm Montjuïc-like sandstone. */
  nave: { color: '#dcc8a5', roughness: 0.9, uplight: true },
  /** The newer crossing towers: pale grey granite. */
  central: { color: '#d6cfc2', roughness: 0.88, uplight: true },
  /** The Nativity facade and its towers: weathered, darker stone. */
  nativity: { color: '#ae9c82', roughness: 0.92, uplight: true },
  /** The Passion facade and its towers: smooth pale stone. */
  passion: { color: '#d3cbbd', roughness: 0.88, uplight: true },
  /** Openings in the bell towers and recesses. */
  shadow: { color: '#4b4239', roughness: 0.95 },
  /** Doors and portals: dark by day, warm at night. */
  portal: { color: '#544a40', roughness: 0.9, night: { color: '#ffc27a', strength: 0.9 } },
  /** Stained glass seen from outside: dull by day, glowing at night. */
  glassWarm: { color: '#6f6a64', roughness: 0.4, night: { color: '#ffae4a', strength: 1.3 } },
  glassCool: { color: '#5f6870', roughness: 0.4, night: { color: '#6fb0ff', strength: 1.2 } },
  glassRed: { color: '#6d5f5c', roughness: 0.4, night: { color: '#ff5f45', strength: 1.1 } },
  /** The ceramic top of the Jesus tower: white tile, lit at night. */
  tile: { color: '#f3f1ec', roughness: 0.45, night: { color: '#fff3dc', strength: 0.55 } },
  /** The cross and the star: lit glass at night. */
  beacon: { color: '#f6f4ee', roughness: 0.35, night: { color: '#fff6e2', strength: 2.2 } },
  /** Mosaic pinnacles. */
  mosaicRed: { color: '#c8452f', roughness: 0.5 },
  mosaicGold: { color: '#e2b23c', roughness: 0.45, night: { color: '#ffc75a', strength: 0.45 } },
  mosaicWhite: { color: '#f4f1ea', roughness: 0.5 },
  mosaicGreen: { color: '#4f8f5a', roughness: 0.6 },
  /** The cypress of the Nativity facade. */
  cypress: { color: '#4a8a55', roughness: 0.8 },
  roofDark: PALETTE.roofDark,
};

// ---------------------------------------------------------------------------
// Where things stand (metres, model frame; OSM parts, crossing-relative).

/** Nativity bell towers (+X): z and total height (outer 98 m, inner 107 m). */
const NATIVITY_X = 34.2;
const NATIVITY: ReadonlyArray<[number, number]> = [
  [15.8, 98],
  [8.6, 107],
  [-6.8, 107],
  [-14.4, 98],
];
/** Passion bell towers (−X): outer 107 m, inner 112 m. */
const PASSION_X = -36.4;
const PASSION: ReadonlyArray<[number, number]> = [
  [13.9, 107],
  [6.7, 112],
  [-7.3, 112],
  [-14.6, 107],
];
/** Evangelist towers at the crossing's corners, 135 m. */
const EVANGELISTS: ReadonlyArray<V2> = [
  [10.9, -10.9],
  [10.8, 11.0],
  [-11.1, 10.6],
  [-10.6, -11.2],
];
const MARY: V2 = [0, -23.3];

/** The crossing's roof and lantern terrace (OSM parts 359084987, 359084975). */
// biome-ignore format: an OSM outline reads as rows of points.
const CROSSING_60: V2[] = [
  [15.8, 7.6], [17.1, 8.9], [16.8, 14.1], [13.6, 17.2], [8.4, 17.3], [7.1, 16.0], [2.3, 20.7],
  [-2.8, 20.6], [-7.7, 15.4], [-9.2, 16.8], [-14.1, 16.6], [-17.4, 13.2], [-17.1, 8.3],
  [-15.8, 7.0], [-20.7, 2.1], [-20.6, -3.0], [-15.6, -7.8], [-17.0, -9.0], [-16.7, -14.2],
  [-13.3, -17.5], [-8.1, -17.5], [-6.9, -16.2], [-4.8, -18.3], [6.0, -17.4], [7.7, -15.7],
  [9.0, -16.9], [14.0, -16.8], [17.1, -13.3], [17.1, -8.5], [15.8, -7.3], [20.9, -1.7],
  [20.7, 2.9],
];
// biome-ignore format: an OSM outline reads as rows of points.
const CROSSING_80: V2[] = [
  [14.3, 7.6], [16.0, 9.4], [15.7, 13.6], [13.1, 16.1], [8.9, 16.2], [7.2, 14.4], [1.8, 19.6],
  [-2.3, 19.5], [-7.7, 13.8], [-9.5, 15.6], [-13.6, 15.5], [-16.3, 12.7], [-16.0, 8.8],
  [-14.2, 7.1], [-19.5, 1.6], [-19.3, -2.7], [-14.0, -7.8], [-15.7, -9.6], [-15.6, -13.7],
  [-12.9, -16.3], [-8.8, -16.3], [-7.1, -14.5], [-4.5, -17.0], [-1.8, -16.8], [2.2, -16.5],
  [5.5, -16.3], [7.5, -13.9], [9.4, -15.8], [13.4, -15.6], [15.9, -13.0], [16.0, -9.0],
  [14.0, -7.2], [19.8, -1.2], [19.6, 2.4],
];

// ---------------------------------------------------------------------------
// Pieces

const add = (b: Builder, material: string, g: THREE.BufferGeometry, smooth = false) =>
  b.add(material, g, undefined, { smooth });

/** Small dark quads on a surface of revolution: the spiralling openings of a bell tower. */
function slots(
  cx: number,
  cz: number,
  radiusAt: (y: number) => number,
  y0: number,
  y1: number,
  options: { rowGap: number; perRow: number; w: number; h: number; twist: number },
): THREE.BufferGeometry {
  const positions: number[] = [];
  let row = 0;
  for (let y = y0; y <= y1; y += options.rowGap, row++) {
    const r = radiusAt(y) + 0.06;
    for (let i = 0; i < options.perRow; i++) {
      const a = (i / options.perRow) * TAU + row * options.twist;
      const n: V3 = [Math.cos(a), 0, Math.sin(a)];
      const u: V3 = [-Math.sin(a), 0, Math.cos(a)];
      const w = Math.min(options.w, ((TAU * r) / options.perRow) * 0.55);
      const p = (su: number, sv: number): V3 => [
        cx + n[0] * r + (u[0] * w * su) / 2,
        y + (options.h * sv) / 2,
        cz + n[2] * r + (u[2] * w * su) / 2,
      ];
      const a0 = p(-1, -1);
      const b0 = p(1, -1);
      const c0 = p(1, 1);
      const d0 = p(-1, 1);
      positions.push(...a0, ...c0, ...b0, ...a0, ...d0, ...c0);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return g;
}

/**
 * A Gaudí bell tower: a round shaft that turns parabolic, pierced by
 * spiralling openings, crowned by a mosaic bishop's-mitre pinnacle with its
 * ring of white balls and a small cross.
 */
function bellTower(
  b: Builder,
  cx: number,
  cz: number,
  r: number,
  h: number,
  stone: string,
  seed: number,
): void {
  const base = h * 0.3; // the facade's own height around it
  const turn = h * 0.52; // where the shaft starts to close in
  const top = h * 0.8; // the pinnacle's foot
  const rTop = r * 0.3;
  const radiusAt = (y: number) => {
    if (y <= turn) return r;
    const t = (y - turn) / (top - turn);
    return r - (r - rTop) * t ** 1.6;
  };
  const profile: V2[] = [
    [r * 1.12, 0],
    [r * 1.12, base],
    [r, base + 1.2],
  ];
  for (let i = 0; i <= 10; i++) {
    const y = base + 1.2 + ((top - base - 1.2) * i) / 10;
    profile.push([radiusAt(y), y]);
  }
  add(b, stone, placeAt(lathe(profile, 20), cx, cz), true);
  add(
    b,
    'shadow',
    slots(cx, cz, radiusAt, base + 4, top - 4, {
      rowGap: 2.6,
      perRow: 9,
      w: 0.9,
      h: 1.5,
      twist: 0.31 + hash01(seed) * 0.05,
    }),
  );

  // The pinnacle: neck, a mitre in mosaic bands, a ring of white balls, the cross.
  const p = h - top; // ~20% of the tower
  const y0 = top;
  const mitre = (
    from: number,
    to: number,
    f: (t: number) => number,
    material: string,
    steps = 4,
  ) => {
    const prof: V2[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = from + ((to - from) * i) / steps;
      prof.push([f(t), y0 + t * p]);
    }
    add(b, material, placeAt(lathe(prof, 12), cx, cz), true);
  };
  const width = (t: number) => {
    // neck → bulge → taper to the cross
    if (t < 0.15) return rTop * (1 - t * 1.2);
    if (t < 0.7) return rTop * 0.82 + Math.sin(((t - 0.15) / 0.55) * Math.PI) * r * 0.36;
    return Math.max(0.15, rTop * 0.82 * (1 - (t - 0.7) / 0.32));
  };
  mitre(0, 0.15, width, 'mosaicGold', 2);
  mitre(0.15, 0.34, width, 'mosaicRed');
  mitre(0.34, 0.5, width, 'mosaicGold');
  mitre(0.5, 0.7, width, seed % 2 ? 'mosaicRed' : 'mosaicWhite');
  mitre(0.7, 0.9, width, 'mosaicGold', 3);
  const ringY = y0 + 0.42 * p;
  const ringR = width(0.42) + 0.25;
  const balls: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * TAU;
    const s = sphere(Math.max(0.35, r * 0.13), 6, 4);
    s.applyMatrix4(at(cx + Math.cos(a) * ringR, ringY, cz + Math.sin(a) * ringR));
    balls.push(s);
  }
  add(b, 'mosaicWhite', mergeAll(balls), true);
  const crossY = y0 + 0.9 * p;
  const cw = Math.max(0.25, r * 0.08);
  add(b, 'mosaicWhite', box([cx - cw, crossY, cz - cw], [cx + cw, h, cz + cw]));
  add(
    b,
    'mosaicWhite',
    box([cx - cw * 4, h - p * 0.07 - cw, cz - cw], [cx + cw * 4, h - p * 0.07 + cw, cz + cw]),
  );
  add(
    b,
    'mosaicWhite',
    box([cx - cw, h - p * 0.07 - cw, cz - cw * 4], [cx + cw, h - p * 0.07 + cw, cz + cw * 4]),
  );
}

function placeAt(g: THREE.BufferGeometry, x: number, z: number): THREE.BufferGeometry {
  g.applyMatrix4(at(x, 0, z));
  return g;
}

/** Vertical ribs standing proud of a tower's profile (`[radius, y]`, bottom to top). */
function ribs(
  cx: number,
  cz: number,
  profile: readonly V2[],
  count: number,
  depth: number,
  width: number,
  phase = 0,
): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < count; i++) {
    const a = phase + (i / count) * TAU;
    const n: V2 = [Math.cos(a), Math.sin(a)];
    const u: V2 = [-Math.sin(a), Math.cos(a)];
    const rings = profile.map(([r, y]) => {
      const inner = r - 0.15;
      const outer = r + depth * Math.min(1, r / 3);
      const w = (width * Math.min(1, r / 3)) / 2;
      const plan: V2[] = [
        [cx + n[0] * inner - u[0] * w, cz + n[1] * inner - u[1] * w],
        [cx + n[0] * outer - u[0] * w, cz + n[1] * outer - u[1] * w],
        [cx + n[0] * outer + u[0] * w, cz + n[1] * outer + u[1] * w],
        [cx + n[0] * inner + u[0] * w, cz + n[1] * inner + u[1] * w],
      ];
      return { y, plan };
    });
    parts.push(loft(rings));
  }
  return mergeAll(parts);
}

/** A row of steep pyramids — the jagged roofline of the nave's lanterns. */
function peakRow(
  b: Builder,
  material: string,
  along: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  step: number,
  y0: number,
  height: number,
  w: number,
  d: number,
): void {
  const parts: THREE.BufferGeometry[] = [];
  for (let s = from; s <= to + 0.01; s += step) {
    const [x, z] = along === 'z' ? [fixed, s] : [s, fixed];
    const plan = along === 'z' ? rect(w, d, x, z) : rect(d, w, x, z);
    parts.push(spire(plan, y0, [x, y0 + height, z]));
  }
  add(b, material, mergeAll(parts));
}

/** A slender pinnacle carrying a cluster of coloured "fruit" (the buttress finials). */
function fruitPinnacle(
  x: number,
  z: number,
  y0: number,
  h: number,
  seed: number,
): {
  stone: THREE.BufferGeometry;
  fruit: Record<string, THREE.BufferGeometry[]>;
} {
  const stone = cylinder(0.9, 0.25, y0, y0 + h, 6);
  stone.applyMatrix4(at(x, 0, z));
  const colours = ['mosaicRed', 'mosaicGold', 'mosaicWhite', 'mosaicGreen'];
  const fruit: Record<string, THREE.BufferGeometry[]> = {};
  const top = y0 + h;
  const cluster: Array<[number, number, number, number]> = [
    [0, 0.9, 0, 0.95],
    [0.55, 0.35, 0.3, 0.6],
    [-0.5, 0.4, -0.3, 0.6],
  ];
  cluster.forEach(([dx, dy, dz, r], i) => {
    const s = sphere(r, 7, 5);
    s.applyMatrix4(at(x + dx, top + dy, z + dz));
    const key = colours[Math.floor(hash01(seed, i) * colours.length)];
    if (!fruit[key]) fruit[key] = [];
    fruit[key].push(s);
  });
  return { stone, fruit };
}

/** Lancet windows on a straight wall: a frame (origin, u along the wall, n outward). */
function lancets(
  b: Builder,
  frame: { origin: V3; u: V3; v: V3; n: V3 },
  from: number,
  to: number,
  step: number,
  y: number,
  w: number,
  h: number,
  seed: number,
): void {
  const glass = ['glassWarm', 'glassCool', 'glassRed'];
  for (let u = from; u <= to + 0.01; u += step) {
    const outline = archOutline(w, h, w * 0.9, true, 6).map(([x, v]) => [x + u, v + y] as V2);
    const key = glass[Math.floor(hash01(seed, u) * glass.length)];
    add(b, key, panel(outline, 0.18, frame));
  }
}

const frameX = (x: number, sign: 1 | -1): { origin: V3; u: V3; v: V3; n: V3 } => ({
  origin: [x, 0, 0],
  u: [0, 0, 1],
  v: [0, 1, 0],
  n: [sign, 0, 0],
});
const frameZ = (z: number, sign: 1 | -1): { origin: V3; u: V3; v: V3; n: V3 } => ({
  origin: [0, 0, z],
  u: [1, 0, 0],
  v: [0, 1, 0],
  n: [0, 0, sign],
});

// ---------------------------------------------------------------------------

export const sagradaFamilia: LandmarkModel = {
  id: 'sagrada-familia',
  materials: MATERIALS,
  build(b) {
    // ---- Body: nave (+Z), transept arms (±X), apse (−Z) ------------------
    const AISLE = 30; // outer walls
    const NAVE = 45; // central vaults
    // Nave: five aisles, from the crossing to the Glory facade.
    add(b, 'nave', prism(rect(42, 34, 0, 33), 0, AISLE, 0.6));
    add(b, 'nave', prism(rect(18, 34, 0, 33), AISLE, NAVE, 0.4));
    peakRow(b, 'nave', 'z', 0, 19, 47, 7, NAVE, 15, 9, 6);
    peakRow(b, 'nave', 'z', -14, 19, 47, 7, AISLE, 9, 5, 5);
    peakRow(b, 'nave', 'z', 14, 19, 47, 7, AISLE, 9, 5, 5);
    // Transept arms: three aisles each side of the crossing.
    add(b, 'nave', prism(rect(16, 30, 23, 0.5), 0, AISLE, 0.6));
    add(b, 'nave', prism(rect(16, 14, 23, 0.5), AISLE, NAVE, 0.4));
    add(b, 'nave', prism(rect(18, 30, -25, 0.5), 0, AISLE, 0.6));
    add(b, 'nave', prism(rect(18, 14, -25, 0.5), AISLE, NAVE, 0.4));
    peakRow(b, 'nave', 'x', 0.5, 19, 28, 7, NAVE, 13, 8, 6);
    peakRow(b, 'nave', 'x', 0.5, -33, -19, 7, NAVE, 13, 8, 6);
    // Apse: a half-round of chapels behind the crossing, under the Mary tower.
    const apse: V2[] = [];
    for (let i = 0; i <= 14; i++) {
      const a = Math.PI + (i / 14) * Math.PI;
      apse.push([Math.cos(a) * 19, -12 + Math.sin(a) * 21]);
    }
    add(b, 'nave', prism(apse, 0, 34, 0.6));
    const apseRoof: V2[] = apse.map(([x, z]) => [x * 0.55, -12 + (z + 12) * 0.62]);
    add(
      b,
      'nave',
      loft([
        { y: 34, plan: apse },
        { y: 46, plan: apseRoof },
      ]),
    );
    // The apse chapels' spires.
    const spires: THREE.BufferGeometry[] = [];
    for (let i = 0; i <= 6; i++) {
      const a = Math.PI + 0.25 + (i / 6) * (Math.PI - 0.5);
      const x = Math.cos(a) * 20;
      const z = -12 + Math.sin(a) * 22;
      spires.push(
        placeAt(
          lathe(
            [
              [1.6, 30],
              [1.4, 40],
              [0.5, 50],
              [0.05, 54],
            ],
            8,
          ),
          x,
          z,
        ),
      );
    }
    add(b, 'nave', mergeAll(spires), true);

    // ---- Stained glass along the walls -----------------------------------
    lancets(b, frameX(21, 1), 19, 47, 7, 7, 3.4, 15, 1);
    lancets(b, frameX(-21, -1), 19, 47, 7, 7, 3.4, 15, 2);
    lancets(b, frameX(9, 1), 19, 47, 7, 31, 3, 10, 3);
    lancets(b, frameX(-9, -1), 19, 47, 7, 31, 3, 10, 4);
    // Transept walls (facing ±Z): u runs along x.
    lancets(b, frameZ(15.5, 1), 18, 28, 7, 7, 3.4, 15, 5);
    lancets(b, frameZ(-14.5, -1), 18, 28, 7, 7, 3.4, 15, 6);
    lancets(b, frameZ(15.5, 1), -32, -18, 7, 7, 3.4, 15, 7);
    lancets(b, frameZ(-14.5, -1), -32, -18, 7, 7, 3.4, 15, 8);

    // ---- Buttress pinnacles with fruit ------------------------------------
    const stones: THREE.BufferGeometry[] = [];
    const fruit: Record<string, THREE.BufferGeometry[]> = {};
    const plant = (x: number, z: number, y0: number, h: number, seed: number) => {
      const p = fruitPinnacle(x, z, y0, h, seed);
      stones.push(p.stone);
      for (const [k, list] of Object.entries(p.fruit)) {
        if (!fruit[k]) fruit[k] = [];
        fruit[k].push(...list);
      }
    };
    let seed = 0;
    for (let z = 19.5; z <= 47; z += 7) {
      plant(21, z, AISLE, 7, seed++);
      plant(-21, z, AISLE, 7, seed++);
      plant(9, z, NAVE, 6, seed++);
      plant(-9, z, NAVE, 6, seed++);
    }
    for (const x of [19.5, 26.5, -19.5, -26.5, -33]) {
      plant(x, 15.5, AISLE, 7, seed++);
      plant(x, -14.5, AISLE, 7, seed++);
    }
    add(b, 'nave', mergeAll(stones));
    for (const [k, list] of Object.entries(fruit)) add(b, k, mergeAll(list), true);

    // ---- The crossing: stepped roofs (OSM), then the Jesus tower ----------
    add(b, 'nave', prism(CROSSING_60, 0, 60, 0.5));
    // The crossing's lantern terrace (OSM's lower stepped part, kept low).
    add(b, 'central', prism(CROSSING_80, 60, 64, 0.4));
    const jesus: V2[] = [
      [9.8, 64],
      [9.5, 82],
      [9.0, 100],
      [8.3, 120],
      [7.6, 130],
      [6.6, 140],
    ];
    add(b, 'central', lathe(jesus, 16));
    add(b, 'central', ribs(0, 0, jesus, 16, 0.7, 1.0, TAU / 32));
    add(
      b,
      'tile',
      lathe(
        [
          [6.6, 140],
          [5.5, 148],
          [4.2, 154],
          [2.6, 158],
          [1.2, 160],
        ],
        16,
        { capTop: true },
      ),
    );
    add(
      b,
      'shadow',
      slots(0, 0, (y) => (y < 100 ? 9.6 : 9.0 - ((y - 100) / 40) * 2.4), 70, 137, {
        rowGap: 3.4,
        perRow: 16,
        w: 1.1,
        h: 2.2,
        twist: 0.2,
      }),
    );
    // The four-armed cross, 13 m, lit at night.
    add(b, 'beacon', box([-1.1, 159.5, -1.1], [1.1, 172.5, 1.1], 0.1));
    add(b, 'beacon', box([-4.8, 165.6, -1.0], [4.8, 167.6, 1.0], 0.1));
    add(b, 'beacon', box([-1.0, 165.6, -4.8], [1.0, 167.6, 4.8], 0.1));
    add(b, 'beacon', sphere(1.9, 10, 8).applyMatrix4(at(0, 166.6, 0)), true);

    // ---- The Evangelists ----------------------------------------------------
    EVANGELISTS.forEach(([x, z]) => {
      const profile: V2[] = [
        [3.8, 60],
        [3.6, 90],
        [3.2, 108],
        [2.5, 118],
        [1.6, 123],
      ];
      add(b, 'central', placeAt(lathe(profile, 12), x, z));
      add(b, 'central', ribs(x, z, profile, 8, 0.5, 0.6));
      add(
        b,
        'shadow',
        slots(x, z, (y) => 3.8 - ((y - 62) / 56) * 1.3, 66, 114, {
          rowGap: 3.2,
          perRow: 8,
          w: 0.8,
          h: 1.6,
          twist: 0.35,
        }),
      );
      // The symbol on top: a white-and-gold crown (winged man, lion, ox, eagle).
      add(
        b,
        'tile',
        placeAt(
          lathe(
            [
              [1.6, 123],
              [2.6, 126],
              [2.4, 129],
              [1.4, 131.5],
              [0.2, 133],
            ],
            10,
            { capTop: true },
          ),
          x,
          z,
        ),
        true,
      );
      add(b, 'mosaicGold', sphere(1.0, 8, 6).applyMatrix4(at(x, 133.8, z)), true);
      add(b, 'mosaicGold', box([x - 0.25, 134.5, z - 0.25], [x + 0.25, 135, z + 0.25]));
    });

    // ---- The Mary tower and its star ---------------------------------------
    const [mx, mz] = MARY;
    const maryProfile: V2[] = [
      [8.6, 40],
      [8.3, 70],
      [7.4, 95],
      [6.0, 112],
      [4.2, 123],
    ];
    add(b, 'central', placeAt(lathe(maryProfile, 16), mx, mz));
    add(b, 'central', ribs(mx, mz, maryProfile, 12, 0.6, 0.9, TAU / 24));
    add(
      b,
      'tile',
      placeAt(
        lathe(
          [
            [4.2, 123],
            [2.6, 128],
            [1.2, 130.5],
          ],
          16,
          { capTop: true },
        ),
        mx,
        mz,
      ),
    );
    add(
      b,
      'shadow',
      slots(mx, mz, (y) => 8.6 - ((y - 40) / 83) * 4.4, 50, 118, {
        rowGap: 3.4,
        perRow: 14,
        w: 1.1,
        h: 2.0,
        twist: 0.22,
      }),
    );
    // A twelve-pointed star of glass, 7.5 m across.
    const star: THREE.BufferGeometry[] = [sphere(1.5, 10, 8)];
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * TAU;
      const ray = new THREE.ConeGeometry(0.75, 3.2, 6);
      ray.translate(0, 2.4, 0);
      ray.applyMatrix4(new THREE.Matrix4().makeRotationZ(a));
      star.push(ray);
    }
    const starG = mergeAll(star);
    // Face it along the nave (its rays in the x–y plane, seen from the Glory facade).
    starG.applyMatrix4(at(mx, 135, mz));
    add(b, 'beacon', starG, true);

    // ---- The Nativity facade (+X) ------------------------------------------
    const NX = 30; // facade face
    add(b, 'nativity', prism(rect(8, 36, NX + 3, 0.6), 0, 32, 0.4));
    // Gables: tall pointed central gable crowned by the cypress, lower side gables.
    add(b, 'nativity', spire(rect(6, 14, NX + 3.5, 0.9), 32, [NX + 3.5, 54, 0.9]));
    add(b, 'nativity', spire(rect(5, 6, NX + 3.5, 12.2), 30, [NX + 3.5, 42, 12.2]));
    add(b, 'nativity', spire(rect(5, 6, NX + 3.5, -10.6), 30, [NX + 3.5, 42, -10.6]));
    add(
      b,
      'cypress',
      placeAt(
        lathe(
          [
            [0.4, 50],
            [2.6, 53],
            [2.2, 58],
            [1.2, 62],
            [0.05, 65],
          ],
          10,
        ),
        NX + 3.6,
        0.9,
      ),
      true,
    );
    // Three portals, deep and dark, warm at night.
    const nativityFront = frameX(NX + 7.05, 1);
    for (const [zc, w, h] of [
      [0.9, 8, 17],
      [12.2, 4, 12],
      [-10.6, 4, 12],
    ] as const) {
      add(
        b,
        'portal',
        panel(
          archOutline(w, h, w * 0.9, true, 6).map(([x, v]) => [x + zc, v] as V2),
          0.15,
          nativityFront,
        ),
      );
    }
    // The facade's sculpted surface: clustered organic forms.
    const sculpt: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 70; i++) {
      const z = -17 + hash01(11, i) * 36;
      const y = 14 + hash01(12, i) * 26;
      const r = 0.5 + hash01(13, i) * 0.8;
      const s = sphere(r, 6, 4);
      s.applyMatrix4(at(NX + 7.0 + r * 0.3, y, z));
      sculpt.push(s);
    }
    add(b, 'nativity', mergeAll(sculpt), true);
    NATIVITY.forEach(([z, h], i) => {
      bellTower(b, NATIVITY_X, z, 3.5, h, 'nativity', 10 + i);
    });

    // ---- The Passion facade (−X) -------------------------------------------
    const PX = -34; // facade face
    add(b, 'passion', prism(rect(8, 36, PX - 3, -0.5), 0, 34, 0.4));
    add(b, 'passion', spire(rect(6, 14, PX - 3.5, -0.5), 34, [PX - 3.5, 50, -0.5]));
    // The portico: six inclined, bone-like columns under a heavy pediment.
    const columns: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 6; i++) {
      const z = -12.5 + i * 5;
      const g = new THREE.CylinderGeometry(0.9, 1.4, 19, 8);
      g.applyMatrix4(new THREE.Matrix4().makeRotationZ(-0.22));
      g.translate(PX - 12.2, 9.6, z);
      columns.push(g);
    }
    add(b, 'passion', mergeAll(columns), true);
    add(b, 'passion', prism(rect(10, 31, PX - 11.5, -0.5), 18.5, 24, 0.5));
    // The frieze on top: a row of small columns.
    const frieze: THREE.BufferGeometry[] = [];
    for (let i = 0; i < 16; i++) {
      frieze.push(placeAt(cylinder(0.45, 0.45, 24, 30, 6), PX - 15.5, -14 + i * 1.8));
    }
    add(b, 'passion', mergeAll(frieze));
    add(b, 'passion', prism(rect(3, 31, PX - 15.5, -0.5), 30, 31.5, 0.3));
    const passionFront = frameX(PX - 7.05, -1);
    for (const [zc, w, h] of [
      [-0.5, 9, 15],
      [11.5, 4, 11],
      [-12.5, 4, 11],
    ] as const) {
      add(
        b,
        'portal',
        panel(
          archOutline(w, h, w * 0.6, true, 6).map(([x, v]) => [x + zc, v] as V2),
          0.15,
          passionFront,
        ),
      );
    }
    PASSION.forEach(([z, h], i) => {
      bellTower(b, PASSION_X, z, 4.3, h, 'passion', 20 + i);
    });

    // ---- The Glory facade (+Z), still without its towers --------------------
    const GZ = 50;
    add(b, 'nave', prism(rect(46, 6, 0, GZ + 3), 0, 38, 0.5));
    add(b, 'nave', spire(rect(16, 6, 0, GZ + 3), 38, [0, 48, GZ + 3]));
    const gloryFront = frameZ(GZ + 6.05, 1);
    for (const [xc, w, h] of [
      [0, 6, 14],
      [-8, 4, 11],
      [8, 4, 11],
      [-16, 3.4, 9],
      [16, 3.4, 9],
    ] as const) {
      add(
        b,
        'portal',
        panel(
          archOutline(w, h, w * 0.7, true, 6).map(([x, v]) => [x + xc, v] as V2),
          0.15,
          gloryFront,
        ),
      );
    }
    // Upper rose-like windows of the Glory facade.
    lancets(b, gloryFront, -12, 12, 6, 20, 3, 11, 9);

    // ---- The west sacristy: a ribbed dome on a square, crowned by a pinnacle
    const sx = -29.8;
    const sz = -43.1;
    add(b, 'nave', prism(rect(20, 20, sx, sz), 0, 20, 0.5));
    add(
      b,
      'nave',
      loft([
        { y: 20, plan: rect(20, 20, sx, sz) },
        { y: 30, plan: rect(13, 13, sx, sz) },
      ]),
    );
    add(b, 'nave', spire(rect(13, 13, sx, sz), 30, [sx, 38, sz]));
    add(
      b,
      'mosaicGold',
      placeAt(
        lathe(
          [
            [0.9, 38],
            [1.2, 40],
            [0.3, 43],
            [0.05, 44],
          ],
          8,
        ),
        sx,
        sz,
      ),
      true,
    );
  },
};

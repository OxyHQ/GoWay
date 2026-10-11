/**
 * Casa Milà — "La Pedrera", Barcelona (Antoni Gaudí, 1906–1912) —
 * procedural, stylised.
 *
 * Plan: OpenStreetMap's outline of relation/8974896 with its two courtyards
 * (ODbL, Catalonia extract of 2026-10-08), in the model frame and rounded to
 * 0.1 m — its wavy street edge is OSM's own survey of the facade. Everything
 * else is authored here: the undulating cream-stone strata of the facade,
 * the wrought-iron seaweed balconies, the wavy attic wall, and the roof's
 * stair towers and "warrior" chimneys.
 *
 * Frame: +Z faces the chamfered corner of Passeig de Gràcia and Carrer de
 * Provença (bearing 180°); the street facade runs from the Provença end
 * (+X) round the chamfer to the Passeig de Gràcia end (−X). The two straight
 * edges at −Z are party walls.
 */
import { box, hash01, lathe, prism, THREE, type V2, type V3 } from '../kit';
import { PALETTE } from '../palette';
import {
  addSmooth,
  arcLengths,
  band,
  pathNormals,
  placed,
  prismWithHoles,
  resample,
  ribbon,
  ring,
  smoothPath,
  surfaceGrid,
} from './bcnGaudiKit';
import type { LandmarkModel } from './types';

const OUTLINE = ring(`
  -26.4,1.3 -24.2,-0.8 -23.9,-1.1 -21.1,-3.7 -18.2,-6.4 -18,-6.6 -16.9,-7.6 -9.7,-14.4 -9.2,-14.8
  -8.7,-14.2 -8.5,-13.5 -8.4,-12.2 -8.2,-11.5 -7.9,-11.1 -7.4,-10.8 -7.1,-10.8 -6.7,-10.9
  -6.4,-11.1 -5.7,-11.9 -5,-12.5 -4.1,-13.2 -3.2,-13.7 -2.4,-14 -1.6,-14.6 -0.9,-15.4 -0.6,-16
  -0.4,-16.4 0.2,-17.4 0.7,-18.2 1.3,-18.8 2.5,-19.8 6.1,-22.3 8.7,-25 10.1,-27.5 11.5,-28.8
  14.7,-25.6 17.7,-22.6 19,-21.3 20.3,-20 22.9,-17.4 23.3,-16.9 24.8,-15.5 25.1,-15.2 27.8,-12.4
  30.8,-9.4 32,-8.3 31.8,-8.1 31.4,-8.1 30.8,-7.6 30.9,-7.2 30.8,-6.9 30.7,-6.8 30.5,-6.8
  30.1,-6.8 29.9,-6.8 29,-6.3 29,-6 29,-5.9 28.9,-5.6 28.6,-5.4 28.4,-5.4 28.3,-5.4 28.2,-5.3
  28,-5.1 28.2,-4.9 28.2,-4.6 28.2,-4.4 28,-4.1 27.8,-4 27.6,-4 27.3,-4.2 26.6,-3.8 26.6,-3.5
  26.5,-3.4 26.4,-3.1 26.3,-3.1 25.6,-2.9 24.7,-2 24.7,-1.9 24.8,-1.2 24.7,-1.1 24.5,-0.7
  24.1,-0.4 23.9,-0.4 23.6,-0.4 23.4,-0.4 23.2,-0.3 23.1,-0.3 22.1,0.6 22.2,0.9 22.2,1.2 22.1,1.4
  21.9,1.6 21.3,1.7 21,2.3 20.7,2.9 20.9,3.4 20.9,3.5 20.6,3.9 20.5,4.1 20.3,4.1 19.9,4.1 19.7,4.1
  19.4,3.9 18.1,4.9 18.1,5.3 17.3,6.1 17.5,6.8 17.2,7 17.1,7.1 16.8,7 16.7,6.9 16.6,6.8 16.6,6.6
  16.7,6.4 16.7,6.3 16.6,6.1 16.5,6 16.4,6 16,6.1 15.8,6.1 15.6,6 15.5,5.8 14.2,7.1 13.1,8.3
  13.2,8.6 13.2,8.8 13.2,8.9 13,9.2 13,9.3 13.9,9.4 14.1,9.6 14.1,9.7 14.1,9.9 14,10 13.6,10.1
  13.1,10.1 12.5,10.7 12.3,10.7 11.4,11.6 11.4,11.8 11.5,11.9 11.5,12.1 11.4,12.3 11.2,12.5
  10.4,12.6 9.2,13.8 9.4,14.3 9.3,14.6 9,14.8 8.5,14.8 8.3,14.7 7,15.7 7.1,16 7,16.2 6.9,16.4
  6.6,16.4 6.3,16.3 4.8,17.5 4.9,17.9 4.8,18.2 5,18.2 5.2,18.5 5.3,18.7 5.3,18.8 5.1,19.2 4.9,19.3
  4.8,19.4 4.6,19.4 4.3,19.4 3.9,19.9 3.1,20.5 3.2,20.6 3.2,21 3.2,21.2 3.1,21.3 3,21.5 2.8,21.5
  2.7,21.5 2.6,21.5 2.4,21.5 2.3,21.7 1.9,22 1.7,22.3 1.8,22.7 1.7,23 1.5,23.1 1.3,23.2 1.2,23.1
  0.9,23 0.8,22.9 0.6,22.8 0.3,22.9 -0,23 -0.5,22.9 -0.6,23 -0.7,23.4 -0.9,23.6 -1.1,23.7
  -1.4,23.6 -1.6,23.4 -1.7,23 -2,22.9 -3.9,22.5 -4.4,22.8 -5.2,22.8 -5.7,23.3 -5.9,23.3 -6.1,23.3
  -6.4,23.2 -6.5,23.1 -6.6,22.7 -6.6,22.4 -6.4,22.1 -6.1,21.8 -6.1,21.6 -6.2,21.4 -6.5,21.2
  -6.6,21.1 -6.8,20.8 -6.7,20.4 -8.2,20.5 -10.5,20.6 -10.6,21 -11,21.3 -11.1,21.4 -11.1,21.7
  -11,22.1 -11,22.2 -10.8,22.4 -10.6,22.8 -10.6,22.9 -10.7,23.1 -10.8,23.3 -10.9,23.4 -11.1,23.5
  -11.4,23.5 -11.6,23.4 -11.7,23.3 -11.8,23 -11.8,22.9 -11.6,22.5 -11.7,22.4 -11.8,22.3 -11.9,22.2
  -15,22.1 -15.4,22.6 -15.6,22.6 -15.9,22.6 -16.3,22.2 -16.3,22.1 -17.9,22.4 -17.9,22.4 -18.1,22.6
  -18.3,22.8 -18.6,22.8 -18.9,22.6 -19,22.2 -19,22.1 -18.9,21.8 -19.5,20.6 -19.9,20.6 -20.1,20.6
  -20.2,20.4 -20.2,20.2 -20.1,20.1 -20.1,19.9 -20.9,19.2 -21.1,19.2 -21.3,19.3 -21.5,19.2
  -21.6,19.1 -21.7,18.9 -21.6,18.6 -21.6,18.5 -23.2,16.8 -23.4,16.7 -23.7,16.7 -24,16.6 -24,16.5
  -24,16.1 -24,16 -25.8,13.4 -28.4,10.7 -28.7,10.7 -29.2,10.1 -29.4,10.1 -29.6,10.3 -29.8,10.3
  -30,10.1 -30,10 -29.9,9.6 -30.6,8.8 -30.9,8.9 -31.1,8.9 -31.2,8.8 -31.3,8.6 -31.2,8.4 -31.2,8.2
  -31.3,8.1 -31.5,7.8 -32,7.9 -32.1,7.7 -32.1,7.6 -32.1,7.4 -32.1,7.3 -32.2,7.2 -32.5,7.1 -32.6,7
  -29.5,4.1
`);
const COURT_A = ring(`
  -17.4,7.8 -13.4,8.5 -11.9,8.8 -10.3,9.5 -9.4,9.7 -6.6,7.8 -6.5,7.1 -6.7,6.4 -6.9,5.5 -7.1,5
  -7.6,3.8 -8,3.2 -8.6,2.7 -9.7,2.1 -10.3,1.7 -10.8,1.5 -11.4,1.4 -13.1,1.7 -13.9,2 -14.6,2.3
  -15.5,2.9 -16.2,3.5 -16.9,5 -17.2,5.9 -17.4,6.5 -17.5,7 -17.5,7.5
`);
const COURT_B = ring(`
  10.4,-0.2 10.4,-2 11.7,-3.1 12.6,-3.9 13.5,-5 14.2,-6.1 16.1,-6.1 16.6,-6.9 16.8,-7.7 17.1,-8.7
  17.3,-9.7 17.2,-10.4 17.1,-11 15.7,-12.6 14.6,-13.4 14,-13.8 13.5,-13.7 12.5,-13.5 11.7,-13.3
  10.9,-13.1 9.9,-12.4 9.3,-11.8 6.3,-8.9 5.8,-8.1 5.2,-7.4 4.2,-6.6 3.5,-5.7 2.9,-4.6 2.6,-3.6
  2.3,-2.2 2.4,-1.5 2.7,-0.7 3.1,0.1 3.6,0.4 4.6,0.8 6.5,1.4 7,1.4 7.5,1.4 8.7,1 9.4,0.6
`);

/** Where the street facade starts in OUTLINE (it runs to the end and back to 0). */
const FACADE_START = 45;
/** Floor lines (the top of each stone stratum), metres. */
const FLOORS = [4.7, 7.9, 11.2, 14.5, 17.8, 21.1];
const ATTIC_TOP = 24.9;
const ROOF = 22.7;

/** The street facade as a smooth path, and its outward normals. */
function facadePath(): { path: V2[]; normals: V2[]; s: number[] } {
  const raw = [...OUTLINE.slice(FACADE_START), OUTLINE[0]];
  const path = smoothPath(resample(raw, 0.7), 4);
  const normals = pathNormals(path, 1);
  return { path, normals, s: arcLengths(path) };
}

/** A twisted column (a chimney "warrior"): `radius(t)` over t ∈ [0, 1] of its height. */
function twisted(
  radius: (t: number) => number,
  y0: number,
  height: number,
  twist: number,
  sides = 6,
): THREE.BufferGeometry {
  return surfaceGrid(sides, 8, (u, v) => {
    const a = u * Math.PI * 2 + twist * v;
    // A faceted section: radius bulges at the corners for the twisted-rope read.
    const r = radius(v) * (1 + 0.12 * Math.cos(sides * (u * Math.PI * 2)));
    return [Math.cos(a) * r, y0 + height * v, -Math.sin(a) * r];
  });
}

export const casaMila: LandmarkModel = {
  id: 'casa-mila',
  materials: {
    stone: { color: '#ebe1cc', roughness: 0.85, uplight: true },
    stoneShade: { color: '#d8ccb3', roughness: 0.9, uplight: true },
    stucco: { color: '#e2d8c6', roughness: 0.9, uplight: true },
    iron: { color: '#36403b', roughness: 0.6, metallic: 0.3 },
    roof: { color: '#ddd3c0', roughness: 0.95 },
    trencadis: { color: '#f1eee6', roughness: 0.5, uplight: true },
    helmet: { color: '#bfb7a6', roughness: 0.7 },
    court: { color: '#5b5e66', roughness: 1 },
    glass: PALETTE.glass,
    windowLit: { ...PALETTE.windowLit, night: { color: '#ffcf8a', strength: 1.25 } },
  },
  build(b) {
    const { path, normals, s } = facadePath();
    const length = s[s.length - 1];

    // --- Body: the block with its two courtyards, set just behind the facade ---
    const inset = path.map(
      (p, i) => [p[0] - normals[i][0] * 0.35, p[1] - normals[i][1] * 0.35] as V2,
    );
    // The party walls (OUTLINE 0…FACADE_START), then the facade back to the start.
    const body: V2[] = [...OUTLINE.slice(0, FACADE_START + 1), ...inset.slice(1, -1)];
    b.add('stucco', prismWithHoles(body, [COURT_A, COURT_B], 0, ROOF));
    // The courtyards' floors, dark, so they read as holes from above.
    b.add('court', prism(COURT_A, 0, 0.1));
    b.add('court', prism(COURT_B, 0, 0.1));
    // Windows round the courtyards.
    for (const court of [COURT_A, COURT_B]) {
      const loop = resample([...court, court[0]], 0.5);
      windowStrips(
        b,
        loop,
        normalsToward(loop, true),
        arcLengths(loop),
        [3.6, ...FLOORS.slice(1)],
        0.06,
        7,
      );
    }

    // --- The facade: undulating stone strata -------------------------------
    const wave = (si: number, i: number) => 0.5 * Math.sin((2 * Math.PI * si) / 9.5 + 0.9 * i);
    // Behind the strata, the recessed wall that carries the windows.
    addSmooth(
      b,
      'stoneShade',
      ribbon(
        path,
        normals,
        () => 0,
        () => ATTIC_TOP - 0.6,
        () => -0.05,
        2,
      ),
    );
    FLOORS.forEach((y, i) => {
      const half = i === 0 ? 0.75 : 0.55;
      addSmooth(
        b,
        'stone',
        band(
          path,
          normals,
          (si) => y - half + wave(si, i),
          (si) => y + half + wave(si, i),
          (si) => 0.7 + 0.6 * Math.sin((2 * Math.PI * si) / 12.5 + 1.7 * i) ** 2,
          { profile: 4 },
        ),
      );
    });
    // Ground floor: thick stone piers between wide openings.
    for (let si = 2; si < length - 1; si += 4.4) {
      const i = s.findIndex((v) => v >= si);
      const p = path[i];
      const n = normals[i];
      const pier = lathe(
        [
          [0.85, 0],
          [0.7, 1.6],
          [0.95, 3.4],
          [1.15, 4.4],
        ],
        8,
      );
      pier.scale(1, 1, 0.7);
      const angle = Math.atan2(n[0], n[1]);
      b.add('stone', placed(pier, [p[0] + n[0] * 0.25, 0, p[1] + n[1] * 0.25], angle), undefined, {
        smooth: true,
      });
    }
    // Windows between the strata.
    windowStrips(b, path, normals, s, FLOORS, 0.12, 1, wave);
    // Wrought-iron balconies: a tangle of seaweed on each window of the upper strata.
    for (let f = 1; f < FLOORS.length - 1; f++) {
      for (let si = 1.6; si < length - 1; si += 3.3) {
        const i = s.findIndex((v) => v >= si);
        const n = normals[i];
        const t: V2 = [-n[1], n[0]];
        const base = FLOORS[f] + 0.55 + wave(si, f);
        const out = 0.7 + 0.6 * Math.sin((2 * Math.PI * si) / 12.5 + 1.7 * f) ** 2 + 0.1;
        const pts: THREE.Vector3[] = [];
        for (let k = 0; k <= 12; k++) {
          const a = (k / 12) * 2 - 1;
          const y = base + 0.45 + 0.4 * Math.sin(k * 1.9 + f + si) * (1 - a * a * 0.3);
          const o = out + 0.15 * Math.cos(k * 2.3 + si);
          pts.push(
            new THREE.Vector3(
              path[i][0] + t[0] * a * 1.0 + n[0] * o,
              y,
              path[i][1] + t[1] * a * 1.0 + n[1] * o,
            ),
          );
        }
        const curve = new THREE.CatmullRomCurve3(pts);
        b.add('iron', new THREE.TubeGeometry(curve, 18, 0.12, 3, false), undefined, {
          smooth: true,
        });
      }
    }
    // The attic: a wavy stone parapet with small windows, the crest of the facade.
    const crest = (si: number) => ATTIC_TOP + 0.8 * Math.sin((2 * Math.PI * si) / 13 + 0.5);
    addSmooth(
      b,
      'stone',
      band(
        path,
        normals,
        (si) => 21.1 + wave(si, 5),
        crest,
        () => 0.35,
        { profile: 4 },
      ),
    );
    for (let si = 1; si < length - 1; si += 1.7) {
      const i = s.findIndex((v) => v >= si);
      const p = path[i];
      const n = normals[i];
      const y = 22.4 + 0.3 * Math.sin(si);
      const w = new THREE.PlaneGeometry(0.55, 0.65);
      const angle = Math.atan2(n[0], n[1]);
      b.add(
        hash01(si, 9) < 0.5 ? 'windowLit' : 'glass',
        placed(w, [p[0] + n[0] * 0.72, y, p[1] + n[1] * 0.72], angle),
      );
    }

    // --- The roof: terrace, stair towers and warrior chimneys ----------------
    b.add('roof', prismWithHoles(body, [COURT_A, COURT_B], ROOF, ROOF + 0.4));
    // A low parapet round each courtyard's rim.
    for (const court of [COURT_A, COURT_B]) {
      const loop = resample([...court, court[0]], 0.6);
      const away = normalsToward(loop, false);
      addSmooth(
        b,
        'roof',
        band(
          loop,
          away,
          () => ROOF + 0.3,
          (si) => ROOF + 1.2 + 0.25 * Math.sin(si * 0.8),
          () => 0.35,
          {
            profile: 3,
            back: -0.35,
          },
        ),
      );
    }
    // Stair towers: tall rounded cones crowned by a four-armed cross.
    const towers: V2[] = [
      [-21, 9.5],
      [-6, 2],
      [-4, 16],
      [9, 8],
      [22, -3],
      [16, -18],
    ];
    towers.forEach(([x, z], i) => {
      const h = 4.6 + (i % 3) * 0.7;
      b.add(
        'trencadis',
        placed(
          lathe(
            [
              [1.5, 0],
              [1.25, h * 0.4],
              [0.75, h * 0.8],
              [0.4, h],
            ],
            12,
            { capTop: true },
          ),
          [x, ROOF + 0.4, z],
        ),
        undefined,
        { smooth: true },
      );
      const top = ROOF + 0.4 + h;
      b.add('trencadis', box([x - 0.12, top, z - 0.12], [x + 0.12, top + 1.2, z + 0.12]));
      b.add('trencadis', box([x - 0.5, top + 0.6, z - 0.1], [x + 0.5, top + 0.85, z + 0.1]));
      b.add('trencadis', box([x - 0.1, top + 0.6, z - 0.5], [x + 0.1, top + 0.85, z + 0.5]));
    });
    // The warriors: clusters of twisted chimneys under helmets.
    const clusters: V2[] = [
      [-16, 1],
      [-13, 14],
      [-1, -4],
      [3, 13],
      [14, 4],
      [19, -11],
      [7, -16],
      [-24, 4],
    ];
    clusters.forEach(([cx, cz], c) => {
      const count = 2 + (c % 3);
      for (let k = 0; k < count; k++) {
        const a = (k / count) * Math.PI * 2 + c;
        const x = cx + Math.cos(a) * 0.9;
        const z = cz + Math.sin(a) * 0.9;
        const h = 2.4 + hash01(c, k) * 1.2;
        b.add(
          'trencadis',
          placed(
            twisted((t) => 0.42 - 0.12 * t, 0, h, 1.6 + k, 6),
            [x, ROOF + 0.4, z],
          ),
          undefined,
          { smooth: true },
        );
        b.add(
          'helmet',
          placed(
            lathe(
              [
                [0.5, 0],
                [0.55, 0.25],
                [0.3, 0.6],
                [0.05, 0.75],
              ],
              8,
              { capBottom: true },
            ),
            [x, ROOF + 0.4 + h, z],
          ),
          undefined,
          { smooth: true },
        );
      }
    });
  },
};

/** Plan normals of a closed loop, pointing toward (or away from) its centre. */
function normalsToward(loop: readonly V2[], toward: boolean): V2[] {
  const c = loop.reduce(
    (acc, p) => [acc[0] + p[0] / loop.length, acc[1] + p[1] / loop.length],
    [0, 0],
  );
  const right = pathNormals(loop, 1);
  const i = Math.floor(loop.length / 4);
  const toCentre = (c[0] - loop[i][0]) * right[i][0] + (c[1] - loop[i][1]) * right[i][1] > 0;
  return toCentre === toward ? right : pathNormals(loop, -1);
}

/**
 * Window panes between strata, following a path: panes `pane` metres wide
 * with stone between, offset `off` outward, lit by hash.
 */
function windowStrips(
  b: Parameters<LandmarkModel['build']>[0],
  path: readonly V2[],
  normals: readonly V2[],
  s: readonly number[],
  floors: readonly number[],
  off: number,
  seed: number,
  wave: (si: number, i: number) => number = () => 0,
): void {
  const length = s[s.length - 1];
  const pitch = 3.3;
  for (let f = 0; f < floors.length - 1; f++) {
    for (let si = 0.8; si + 1.7 < length; si += pitch) {
      const lit = hash01(seed, f, Math.round(si)) < 0.5;
      const positions: number[] = [];
      let prev: V3 | null = null;
      let prevTop: V3 | null = null;
      for (let k = 0; k <= 4; k++) {
        const sk = si + (1.7 * k) / 4;
        const i = Math.min(
          path.length - 1,
          s.findIndex((v) => v >= sk),
        );
        const p = path[i];
        const n = normals[i];
        const y0 = floors[f] + 0.75 + wave(sk, f);
        const y1 = floors[f + 1] - 0.6 + wave(sk, f + 1);
        const lo: V3 = [p[0] + n[0] * off, y0, p[1] + n[1] * off];
        const hi: V3 = [p[0] + n[0] * off, y1, p[1] + n[1] * off];
        if (prev && prevTop) {
          // Face the pane along `n` whichever way the path runs.
          const e1 = [lo[0] - prev[0], lo[2] - prev[2]];
          // (prev, lo, hi) faces e1 × up = (−e1.z, e1.x) in the plan.
          const outward = -e1[1] * n[0] + e1[0] * n[1] > 0;
          if (outward) positions.push(...prev, ...lo, ...hi, ...prev, ...hi, ...prevTop);
          else positions.push(...prev, ...hi, ...lo, ...prev, ...prevTop, ...hi);
        }
        prev = lo;
        prevTop = hi;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      b.add(lit ? 'windowLit' : 'glass', g);
    }
  }
}

/**
 * Arc de Triomf, Barcelona (Josep Vilaseca, 1888) — procedural, stylised.
 *
 * Footprint and height are OpenStreetMap's own (way 377875377's parts: the
 * two piers with their corner turrets and the span over the arch, read from
 * the city tiles' ODbL extract of 2026-10-08): 28 m across, ~12.6 m deep,
 * 29 m to the top, a 9.6 m opening. The Neo-Mudéjar brickwork — the octagonal
 * corner turrets with their little domes, the lozenge brick panels, the cream
 * stone bands, the arch ring, the sculpted frieze over the arch and the crest
 * with its crown — is authored here as stylised massing; no sculpture is
 * modelled figure by figure.
 *
 * Frame: +Z faces north-west, up Passeig de Lluís Companys toward Passeig de
 * Sant Joan (the "Barcelona rep les nacions" frieze side; heading 314.2°); +X
 * runs along the arch toward the south-west pier.
 */
import {
  box,
  circle,
  cylinder,
  lathe,
  panel,
  prism,
  sphere,
  THREE,
  type V2,
  type V3,
} from '../kit';
import { PALETTE } from '../palette';
import type { LandmarkModel } from './types';

const HALF_OPEN = 4.8;
const PIER_OUT = 13.6;
const DEPTH = 4.8;
const SPRING = 15.2;
const BODY_TOP = 24;

/** The arch's front/back frame on z = ±DEPTH, facing out. */
function face(side: 1 | -1) {
  return {
    origin: [0, 0, side * DEPTH] as V3,
    u: [side, 0, 0] as V3,
    v: [0, 1, 0] as V3,
    n: [0, 0, side] as V3,
  };
}

/** A semicircular arch outline (u, v) from the left impost over the top, `steps` per half. */
function semicircle(r: number, cy: number, steps = 12): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= steps * 2; i++) {
    const a = Math.PI - (i / (steps * 2)) * Math.PI;
    out.push([Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return out;
}

export const arcDeTriomf: LandmarkModel = {
  id: 'arc-de-triomf',
  materials: {
    brick: { color: '#b9654a', roughness: 0.9, uplight: true },
    brickDark: { color: '#97503a', roughness: 0.9, uplight: true },
    stone: { color: '#e8dcc3', roughness: 0.85, uplight: true },
    gold: PALETTE.gold,
    lamp: PALETTE.lamp,
  },
  build(b) {
    for (const s of [-1, 1] as const) {
      // A pier: brick body between the arch and its outer face.
      const x0 = s * HALF_OPEN;
      const x1 = s * PIER_OUT;
      const lo = Math.min(x0, x1);
      const hi = Math.max(x0, x1);
      b.add('brick', box([lo, 0, -DEPTH], [hi, BODY_TOP, DEPTH], 0.12));
      // Plinth and impost bands in stone, a little proud.
      b.add(
        'stone',
        box(
          [lo - 0.2 * (s > 0 ? 0 : 1), 0, -DEPTH - 0.25],
          [hi + 0.2 * (s > 0 ? 1 : 0), 1.8, DEPTH + 0.25],
          0.08,
        ),
      );
      b.add('stone', box([lo, SPRING - 0.5, -DEPTH - 0.2], [hi, SPRING + 0.3, DEPTH + 0.2], 0.06));
      b.add('stone', box([lo, 19.6, -DEPTH - 0.15], [hi, 20.2, DEPTH + 0.15], 0.05));

      // Corner turrets: octagonal shafts at the four corners of the pier,
      // ringed with stone, capped with a tiled dome and a gold finial.
      for (const tx of [s * 7.45, s * 13.4]) {
        for (const tz of [-5.35, 5.35]) {
          const oct = circle(1.15, 8, tx, tz, Math.PI / 8);
          b.add('brick', prism(oct, 0, 25.6, 0.08));
          for (const [y, h] of [
            [0, 1.9],
            [SPRING - 0.5, 0.8],
            [19.5, 0.7],
            [25.6, 0.5],
          ] as const) {
            b.add('stone', prism(circle(1.32, 8, tx, tz, Math.PI / 8), y, y + h, 0.05));
          }
          b.add(
            'stone',
            lathe(
              [
                [1.1, 26.1],
                [1.05, 26.9],
                [0.8, 27.7],
                [0.35, 28.2],
                [0, 28.35],
              ],
              16,
            ).translate(tx, 0, tz),
            undefined,
            { smooth: true },
          );
          b.add('gold', sphere(0.28, 10, 6).translate(tx, 28.55, tz), undefined, { smooth: true });
          b.add('gold', cylinder(0.08, 0.02, 28.7, 29.6, 6).translate(tx, 0, tz));
        }
      }

      // Lozenge brick panels on every face of the pier (Neo-Mudéjar lattice).
      const facePanel = (frame: { origin: V3; u: V3; v: V3; n: V3 }, width: number) => {
        const cols = Math.max(2, Math.round(width / 1.6));
        const du = width / cols;
        const parts: THREE.BufferGeometry[] = [];
        for (let c = 0; c < cols; c++) {
          for (let r = 0; r < 6; r++) {
            const cu = du * (c + 0.5);
            const cv = 3.6 + r * 1.75;
            const w = du * 0.42;
            const h = 0.78;
            parts.push(
              panel(
                [
                  [cu, cv - h],
                  [cu + w, cv],
                  [cu, cv + h],
                  [cu - w, cv],
                ],
                0.14,
                frame,
              ),
            );
          }
        }
        for (const p of parts) b.add('brickDark', p);
      };
      // Front and back faces of the pier, between its turrets.
      for (const side of [-1, 1] as const) {
        const start = s > 0 ? 8.6 : -12.25;
        facePanel(
          {
            origin: [side > 0 ? start : start + 3.65, 0, side * DEPTH],
            u: [side > 0 ? 1 : -1, 0, 0],
            v: [0, 1, 0],
            n: [0, 0, side],
          },
          3.65,
        );
      }
      // The outer face.
      facePanel(
        {
          origin: [x1, 0, s > 0 ? -4.2 : 4.2],
          u: [0, 0, s > 0 ? 1 : -1],
          v: [0, 1, 0],
          n: [s, 0, 0],
        },
        8.4,
      );
      // Shields on the upper pier faces.
      for (const side of [-1, 1] as const) {
        const cx = s * 10.5;
        b.add(
          'stone',
          panel(
            [
              [-1.2, 16.4],
              [1.2, 16.4],
              [1.2, 18.4],
              [0, 19.2],
              [-1.2, 18.4],
            ],
            0.25,
            { origin: [cx, 0, side * DEPTH], u: [side, 0, 0], v: [0, 1, 0], n: [0, 0, side] },
          ),
        );
      }
    }

    // The span over the arch: a barrel vault block from the springing to the top.
    const vault: V2[] = [
      [-HALF_OPEN, BODY_TOP],
      [HALF_OPEN, BODY_TOP],
      [HALF_OPEN, SPRING],
      ...semicircle(HALF_OPEN, SPRING).reverse().slice(1),
    ];
    b.add(
      'brick',
      panel(vault, DEPTH * 2, { origin: [0, 0, -DEPTH], u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] }),
    );

    // The arch ring (archivolt) in stone on both faces, and its jambs.
    for (const side of [-1, 1] as const) {
      const outer = semicircle(HALF_OPEN + 0.9, SPRING);
      const inner = semicircle(HALF_OPEN, SPRING).reverse();
      b.add('stone', panel([...outer, ...inner], 0.3, face(side)));
      // The frieze over the arch: a cream relief band with figures in it.
      const frame = face(side);
      b.add(
        'stone',
        panel(
          [
            [-6.3, 20.6],
            [6.3, 20.6],
            [6.3, 23.7],
            [-6.3, 23.7],
          ],
          0.32,
          frame,
        ),
      );
      for (let i = 0; i < 11; i++) {
        const u = -5.6 + i * 1.12;
        const g = cylinder(0.26, 0.22, 20.9, 23.1 - (i % 3) * 0.25, 6);
        const head = sphere(0.24, 8, 5).translate(0, 23.35 - (i % 3) * 0.25, 0);
        const m = new THREE.Matrix4().makeTranslation(u * side, 0, side * (DEPTH + 0.55));
        b.add('stone', g.applyMatrix4(m));
        b.add('stone', head.applyMatrix4(m), undefined, { smooth: true });
      }
    }

    // Attic, cornice and the stepped crest with the city's crown.
    b.add('brick', box([-PIER_OUT, BODY_TOP, -DEPTH], [PIER_OUT, 26.3, DEPTH], 0.1));
    b.add(
      'stone',
      box([-PIER_OUT - 0.3, 26.3, -DEPTH - 0.35], [PIER_OUT + 0.3, 26.9, DEPTH + 0.35], 0.06),
    );
    // The roof inside the parapet is brick, not stone.
    b.add('brickDark', box([-13.1, 26.9, -4.3], [13.1, 27.0, 4.3]));
    // Merlons along the parapet: the Mudéjar stepped crenellation.
    for (const z of [-DEPTH + 0.2, DEPTH - 0.6]) {
      for (let i = 0; i < 12; i++) {
        const x = -11.9 + i * 2.17;
        if (Math.abs(x) < 4) continue;
        b.add('brick', box([x - 0.45, 26.9, z], [x + 0.45, 27.9, z + 0.4], 0.05));
      }
    }
    b.add('brick', box([-4, 26.9, -2.6], [4, 28.1, 2.6], 0.08));
    b.add('stone', box([-3.2, 28.1, -2], [3.2, 28.5, 2], 0.05));
    // The crest: a shield on each face and the crown above.
    for (const side of [-1, 1] as const) {
      b.add(
        'stone',
        panel(
          [
            [-1.3, 24.3],
            [1.3, 24.3],
            [1.3, 26.4],
            [0, 27.6],
            [-1.3, 26.4],
          ],
          0.3,
          face(side),
        ),
      );
    }
    b.add('gold', cylinder(1.1, 1.25, 28.5, 29.3, 12));
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      b.add(
        'gold',
        sphere(0.22, 8, 5).translate(Math.cos(a) * 1.15, 29.5, Math.sin(a) * 1.15),
        undefined,
        {
          smooth: true,
        },
      );
    }
    b.add('gold', sphere(0.45, 10, 6).translate(0, 29.7, 0), undefined, { smooth: true });

    // Lanterns in the arch's jambs, lit at night.
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        b.add(
          'lamp',
          box([sx * 4.55 - 0.15, 5.2, sz * 3.6 - 0.35], [sx * 4.55 + 0.15, 6.6, sz * 3.6 + 0.35]),
        );
      }
    }
  },
};

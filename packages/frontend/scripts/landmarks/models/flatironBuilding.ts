/**
 * Flatiron Building, New York — procedural, stylised.
 *
 * Plan: OpenStreetMap's outline of the building (way 264768896's part
 * 764237515, read from the city tiles' ODbL extract of 2026-10-09, rounded to
 * 0.1 m), with the narrow prow rounded as built. Everything above the plan is
 * authored: the rusticated limestone base, the window rhythm, the oriel bays
 * on the long sides, the belt courses, the deep cornice, the attic and the
 * one-storey glazed "cowcatcher" at the prow.
 *
 * Frame: +Z faces up the prow (bearing 29.5°, toward Madison Square); +X
 * faces Fifth Avenue (bearing 299.5°), the straight long side.
 */
import { box, facadeWindows, loft, offset, planFrames, prism, type V2 } from '../kit';
import { PALETTE } from '../palette';
import type { LandmarkModel } from './types';

/** The wedge, prow rounded: Fifth Avenue (x ≈ 1), Broadway (the slant), 22nd Street (z ≈ −21). */
const PLAN: V2[] = [
  [-19.2, -20.7],
  [0.9, -20.9],
  [1.3, 21.0],
  [0.95, 21.55],
  [0.35, 21.8],
  [-0.2, 21.65],
  [-0.6, 21.3],
];

const FLOOR = 3.62;

function windows(
  b: import('../kit').Builder,
  plan: readonly V2[],
  y0: number,
  rows: number,
  options: { seed: number; fill?: V2; bay?: number; litRatio?: number; floor?: number },
) {
  const floor = options.floor ?? FLOOR;
  planFrames(plan, y0).forEach((frame, i) => {
    if (frame.length < 3.5) return;
    facadeWindows(b, frame, {
      width: frame.length,
      height: rows * floor,
      cols: Math.max(1, Math.round(frame.length / (options.bay ?? 2.45))),
      rows,
      fill: options.fill ?? [0.36, 0.58],
      offset: 0.06,
      lit: 'windowLit',
      dark: 'glass',
      litRatio: options.litRatio ?? 0.45,
      seed: options.seed * 13 + i,
      runs: false,
    });
  });
}

export const flatironBuilding: LandmarkModel = {
  id: 'flatiron-building',
  materials: {
    limestone: { color: '#e2d6bf', roughness: 0.88, uplight: true },
    rusticated: { color: '#d4c7ae', roughness: 0.9, uplight: true },
    cornice: { color: '#cfc2a8', roughness: 0.85, uplight: true },
    roof: PALETTE.roofDark,
    glass: PALETTE.glass,
    windowLit: PALETTE.windowLit,
    shop: {
      color: '#56697c',
      metallic: 0.2,
      roughness: 0.2,
      night: { color: '#ffd9a0', strength: 1.3 },
    },
  },
  build(b) {
    // Rusticated base: four storeys of stone courses with a groove between each.
    b.add('rusticated', prism(PLAN, 0, 17.5, 0.2));
    for (let y = 4.4; y < 17; y += 1.32) {
      b.add(
        'rusticated',
        loft([
          { y, plan: offset(PLAN, 0.22) },
          { y: y + 1.08, plan: offset(PLAN, 0.22) },
        ]),
      );
    }
    // Shop fronts and the lobby door on the ground floor.
    windows(b, offset(PLAN, 0.22), 0.6, 1, {
      seed: 1,
      fill: [0.7, 0.9],
      bay: 4,
      litRatio: 0.8,
      floor: 3.6,
    });
    windows(b, offset(PLAN, 0.22), 6.2, 3, {
      seed: 2,
      fill: [0.38, 0.55],
      litRatio: 0.5,
      floor: 3.7,
    });
    // The "cowcatcher": a one-storey glazed shop wrapped round the prow.
    const cow: V2[] = [
      [1.5, 18.6],
      [1.6, 21.2],
      [1.1, 22.3],
      [0.3, 22.8],
      [-0.6, 22.5],
      [-1.4, 21.4],
      [-2.2, 18.6],
    ];
    b.add('shop', prism(cow, 0, 4.2));
    b.add('rusticated', prism(offset(cow, 0.15), 4.2, 4.8, 0.1));

    // Shaft: storeys 5–19 in cream terracotta, with the oriel bays.
    b.add(
      'rusticated',
      loft([
        { y: 17.5, plan: offset(PLAN, 0.4) },
        { y: 18.5, plan: offset(PLAN, 0.4) },
      ]),
    );
    b.add('limestone', prism(PLAN, 17.5, 75, 0.2));
    windows(b, PLAN, 18.8, 15, { seed: 3 });
    // Oriels: three shallow bays up each long side, floors 6–18.
    const frames = planFrames(PLAN, 0);
    const bays = (edge: number, ts: number[]) => {
      const f = frames[edge];
      const p = (u: number, d: number): V2 => [
        f.origin[0] + f.u[0] * u + f.n[0] * d,
        f.origin[2] + f.u[2] * u + f.n[2] * d,
      ];
      ts.forEach((t, k) => {
        const u0 = t * f.length - 2.3;
        const u1 = t * f.length + 2.3;
        b.add(
          'limestone',
          prism([p(u0, -0.2), p(u1, -0.2), p(u1 - 0.7, 0.8), p(u0 + 0.7, 0.8)], 22, 66, 0.1),
        );
        const a = p(u0 + 0.7, 0.8);
        facadeWindows(
          b,
          { origin: [a[0], 22.4, a[1]], u: f.u, v: [0, 1, 0], n: f.n },
          {
            width: u1 - u0 - 1.4,
            height: 12 * FLOOR,
            cols: 1,
            rows: 12,
            fill: [0.6, 0.58],
            offset: 0.06,
            lit: 'windowLit',
            dark: 'glass',
            litRatio: 0.5,
            seed: 40 + edge * 5 + k,
            runs: false,
          },
        );
      });
    };
    bays(1, [0.3, 0.55, 0.8]);
    bays(6, [0.2, 0.45, 0.7]);

    // Belt course, the arcaded top storeys, the deep cornice and the attic.
    b.add(
      'cornice',
      loft([
        { y: 74.6, plan: offset(PLAN, 0.35) },
        { y: 75.8, plan: offset(PLAN, 0.35) },
      ]),
    );
    b.add('limestone', prism(PLAN, 75.8, 82, 0.15));
    windows(b, PLAN, 76.4, 1, { seed: 4, fill: [0.5, 0.8], floor: 4.8 });
    b.add(
      'cornice',
      loft([
        { y: 81.6, plan: offset(PLAN, 0.5) },
        { y: 82.3, plan: offset(PLAN, 0.9) },
        { y: 83.2, plan: offset(PLAN, 1.45) },
        { y: 83.8, plan: offset(PLAN, 1.45) },
      ]),
    );
    b.add('limestone', prism(offset(PLAN, -0.1), 83.8, 87.4, 0.15));
    windows(b, offset(PLAN, -0.1), 84.3, 1, { seed: 5, fill: [0.36, 0.6], floor: 2.8 });
    b.add('cornice', prism(offset(PLAN, 0.15), 87.4, 88, 0.1));
    // The rooftop penthouse at the wide end.
    b.add('roof', box([-14, 88, -20], [-2, 91, -14], 0.2));
  },
};

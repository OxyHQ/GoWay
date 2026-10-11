/**
 * Chrysler Building, New York — procedural, stylised.
 *
 * Massing: the base wings, the 70/80/90 m setbacks and the shaft are
 * OpenStreetMap's own `building:part`s for the building (the parts around
 * way 42500770, read from the city tiles' ODbL extract of 2026-10-09 and
 * rounded to 0.1 m). The crown is authored: seven terraced cloister-vaulted
 * tiers whose four faces each show a semicircular stainless-steel arch,
 * with sunburst triangle windows under every arch (lit white at night — the
 * building's signature), the needle spire, and the corner eagles.
 *
 * Frame: +Z faces Lexington Avenue (the main entrance, bearing 299°), +X
 * faces bearing 209° (toward 42nd Street).
 */
import { box, cylinder, loft, rect, spire, type V2 } from '../kit';
import { PALETTE } from '../palette';
import { cloisterTier, sunburst, turn, windowTier } from './nycKit';
import type { LandmarkModel } from './types';

/** Plans read in the opposite heading (119°) and turned to face Lexington. */
const box2 = (x0: number, x1: number, z0: number, z1: number): V2[] =>
  turn([
    [x0, z0],
    [x1, z0],
    [x1, z1],
    [x0, z1],
  ]);

/** The shaft above 185 m: a rectangle with its four corners notched. */
const NOTCHED: V2[] = turn([
  [17.5, -9.6],
  [17.5, 9.4],
  [12.6, 9.4],
  [9.7, 12.5],
  [9.7, 14.2],
  [-9.8, 14.2],
  [-9.8, 12.5],
  [-12.6, 9.4],
  [-17.6, 9.4],
  [-17.6, -9.6],
  [-12.6, -9.7],
  [-9.6, -12.8],
  [-9.6, -14.5],
  [9.8, -14.5],
  [9.8, -12.8],
  [12.5, -9.8],
]);

/** Crown terraces: half-size and spring height of each arch tier. */
const TIERS = Array.from({ length: 8 }, (_, k) => ({ s: 11.2 - 1.22 * k, ys: 206 + 7.6 * k }));

export const chryslerBuilding: LandmarkModel = {
  id: 'chrysler-building',
  materials: {
    brick: { color: '#e9e6df', roughness: 0.85, uplight: true },
    brickDark: { color: '#8f949a', roughness: 0.8, uplight: true },
    glass: PALETTE.glass,
    windowLit: PALETTE.windowLit,
    crown: {
      color: '#e6eaef',
      metallic: 0.3,
      roughness: 0.24,
      night: { color: '#dfe8ff', strength: 0.22 },
    },
    crownWindow: {
      color: '#3e4a58',
      metallic: 0.2,
      roughness: 0.25,
      night: { color: '#f2f6ff', strength: 1.7 },
    },
    steel: PALETTE.steel,
    lamp: PALETTE.lamp,
    beacon: PALETTE.beacon,
  },
  build(b) {
    const w = { lit: 'windowLit', dark: 'glass' } as const;
    // Base: the two 50 m wings on 43rd and 42nd Streets, the low lobby blocks
    // between them, then the 70 and 80 m setbacks.
    windowTier(b, box2(12, 30.7, -32.6, 31.3), 0, 50, { material: 'brick', ...w, seed: 1 });
    windowTier(b, box2(-32.4, -13.4, -32.4, 20.9), 0, 50, { material: 'brick', ...w, seed: 2 });
    windowTier(b, box2(-13.5, 12.2, 14, 28.7), 0, 15, {
      material: 'brick',
      ...w,
      seed: 3,
      floor: 4.6,
    });
    windowTier(b, box2(-13.5, 12.2, -32.4, -14.4), 0, 15, {
      material: 'brick',
      ...w,
      seed: 4,
      floor: 4.6,
    });
    windowTier(b, box2(12, 25.1, -26.9, 25.6), 50, 70, { material: 'brick', ...w, seed: 5 });
    windowTier(b, box2(-26, -13.5, -26.6, 20.9), 50, 70, { material: 'brick', ...w, seed: 6 });
    windowTier(b, box2(12, 22.2, -23.9, 22.9), 70, 80, { material: 'brick', ...w, seed: 7 });
    windowTier(b, box2(-23.4, -13.3, -23.8, 22.2), 70, 80, { material: 'brick', ...w, seed: 8 });
    // The lit Lexington Avenue entrance: a tall portal in the front lobby block.
    b.add('lamp', box([-4, 0, 28.8], [4, 11, 29.1]));
    b.add('brickDark', box([-5.5, 11, 28.6], [5.5, 13, 29.6], 0.15));

    // The shaft to the 90 m setback, then on up to 185 m.
    windowTier(b, box2(-19.3, 19.3, -14.6, 14.2), 0, 90, {
      material: 'brick',
      ...w,
      seed: 9,
      bay: 2.8,
    });
    // The dark brick band and the steel "radiator cap" wings at the 31st floor.
    b.add(
      'brickDark',
      loft([
        { y: 87.5, plan: box2(-19.6, 19.6, -14.9, 14.5) },
        { y: 90.6, plan: box2(-19.6, 19.6, -14.9, 14.5) },
      ]),
    );
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const cx = -sx * 19.3;
      const cz = -sz * 14.4;
      b.add(
        'steel',
        loft([
          { y: 88, plan: rect(1.6, 1.6, cx, cz) },
          { y: 90.4, plan: rect(1.6, 1.6, cx + -sx * 2.8, cz + -sz * 2.8) },
          { y: 91, plan: rect(0.4, 0.4, cx + -sx * 4, cz + -sz * 4) },
        ]),
      );
    }
    windowTier(b, box2(-17.6, 17.5, -14.5, 14.2), 90, 185, {
      material: 'brick',
      ...w,
      seed: 10,
      bay: 2.8,
      litRatio: 0.38,
    });
    // 185–199: the notched top of the shaft, dark-banded, with the eagles.
    windowTier(b, NOTCHED, 185, 199, { material: 'brick', ...w, seed: 11, bay: 2.6 });
    b.add(
      'brickDark',
      loft([
        { y: 196.5, plan: NOTCHED },
        { y: 199.2, plan: NOTCHED },
      ]),
    );
    // Eagles: one steel gargoyle leaning out of every notched corner.
    for (const [sx, sz] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ]) {
      const cx = sx * 11.2;
      const cz = sz * 11.0;
      b.add(
        'steel',
        loft([
          { y: 197.2, plan: rect(1.4, 1.4, cx, cz) },
          { y: 197.9, plan: rect(1.1, 1.1, cx + sx * 2.4, cz + sz * 2.4) },
          { y: 197.4, plan: rect(0.3, 0.3, cx + sx * 4.6, cz + sz * 4.6) },
        ]),
      );
    }

    // The crown: terraced arches in stainless steel, triangle windows under
    // each, then the square spire and the needle.
    b.add(
      'crown',
      loft([
        { y: 199, plan: rect(22.6, 22.6) },
        { y: 200.5, plan: rect(22.6, 22.6) },
      ]),
    );
    TIERS.forEach(({ s, ys }, k) => {
      b.add('crown', cloisterTier(s, 199, ys));
      const n = s > 8 ? 9 : s > 5 ? 7 : s > 3 ? 5 : 3;
      b.add('crownWindow', sunburst(s, ys, n, k < 5 ? 0.5 : 0.3, 0.9));
    });
    const top = TIERS[TIERS.length - 1];
    b.add(
      'crown',
      loft([
        { y: top.ys, plan: rect(top.s * 1.3, top.s * 1.3) },
        { y: top.ys + top.s + 2, plan: rect(1.6, 1.6) },
        { y: 282, plan: rect(0.8, 0.8) },
      ]),
    );
    b.add('steel', spire(rect(0.8, 0.8), 282, [0, 318.5, 0]));
    b.add('beacon', cylinder(0.12, 0.12, 318.5, 319.2, 6));
  },
};

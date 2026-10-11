/**
 * Empire State Building, New York — procedural, stylised.
 *
 * Massing: the setback tiers and their plans are OpenStreetMap's own
 * `building:part`s for the building (way 34633854's parts, read from the
 * city tiles' ODbL extract of 2026-10-09 and rounded to 0.1 m), so the model
 * stands exactly on the footprint it replaces. Everything else — the window
 * rhythm, the piers, the mast's fins and the lights — is authored here.
 *
 * Frame: +Z faces Fifth Avenue — the building stands on its WEST side, so
 * the main entrance faces bearing 119° — and +X faces bearing 29° (toward
 * 34th Street). The plans below were read in the frame turned the other way
 * (heading 299°), so the whole model is turned 180° as it is built.
 */
import {
  at,
  type Builder,
  box,
  cylinder,
  facadeWindows,
  lathe,
  loft,
  piers,
  planFrames,
  prism,
  type THREE,
  type V2,
} from '../kit';
import { PALETTE } from '../palette';
import type { LandmarkModel } from './types';

/** OSM part plans in the model frame (x, z), metres. */
const PODIUM: V2[] = [
  [-30.1, -64.7],
  [29.7, -64.7],
  [29.7, 64.8],
  [-30.1, 64.8],
];
const LOWER: V2[] = [
  [-18.2, -47.4],
  [23, -47.2],
  [23.1, -35.4],
  [27.8, -35.4],
  [27.8, -13.9],
  [23, -14.1],
  [23, 14.1],
  [27.7, 14.3],
  [27.5, 35.6],
  [22.7, 35.7],
  [22.7, 46.9],
  [-18.6, 46.7],
  [-18.5, 35.5],
  [-23, 35.4],
  [-22.9, 14.2],
  [-18.5, 14.1],
  [-18.3, -14],
  [-22.8, -14.1],
  [-22.8, -35.6],
  [-18.3, -35.5],
];
/** The shaft (floors ~30–72): a rectangle with the long sides' light courts. */
function shaft(
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  court: number,
  courtZ: number,
): V2[] {
  return [
    [x0, z0],
    [x1, z0],
    [x1, -courtZ],
    [x1 - court, -courtZ],
    [x1 - court, courtZ],
    [x1, courtZ],
    [x1, z1],
    [x0, z1],
    [x0, courtZ],
    [x0 + court, courtZ],
    [x0 + court, -courtZ],
    [x0, -courtZ],
  ];
}

function chamfer(x0: number, x1: number, z0: number, z1: number, c: number): V2[] {
  return [
    [x0 + c, z0],
    [x1 - c, z0],
    [x1, z0 + c],
    [x1, z1 - c],
    [x1 - c, z1],
    [x0 + c, z1],
    [x0, z1 - c],
    [x0, z0 + c],
  ];
}

const FLOOR = 3.75;

/** Stone tier + its window columns and piers. */
function tier(
  b: Builder,
  plan: V2[],
  y0: number,
  y1: number,
  options: { bay?: number; litRatio?: number; seed: number; bevel?: number },
): void {
  b.add('limestone', prism(plan, y0, y1, options.bevel ?? 0.35));
  const rows = Math.max(1, Math.round((y1 - y0 - 1.2) / FLOOR));
  const height = rows * FLOOR;
  const bay = options.bay ?? 3.1;
  planFrames(plan, y0 + 0.6).forEach((frame, i) => {
    if (frame.length < 3.5) return;
    const cols = Math.max(1, Math.round(frame.length / bay));
    facadeWindows(b, frame, {
      width: frame.length,
      height,
      cols,
      rows,
      fill: [0.36, 0.8],
      offset: 0.06,
      lit: 'windowLit',
      dark: 'glass',
      litRatio: options.litRatio ?? 0.42,
      seed: options.seed * 31 + i,
      runs: true,
    });
    if (frame.length > 8) {
      b.add('limestone', piers(frame, cols, y0 + 0.4, y0 + height + 0.4, 0.55, 0.32));
    }
  });
}

export const empireState: LandmarkModel = {
  id: 'empire-state-building',
  materials: {
    limestone: PALETTE.limestone,
    granite: PALETTE.granite,
    // Lighter than the shared glass: from a few hundred metres the shaft must
    // read as limestone with a vertical rhythm, not as a barcode.
    glass: { ...PALETTE.glass, color: '#97a3b0' },
    windowLit: { ...PALETTE.windowLit, color: '#97a3b0' },
    steel: PALETTE.steel,
    steelLit: PALETTE.steelLit,
    lamp: PALETTE.lamp,
    beacon: PALETTE.beacon,
  },
  build(target) {
    const b = turned(target, Math.PI);
    // Podium: five floors of granite-faced base along 34th Street.
    b.add('granite', prism(PODIUM, 0, 17, 0.4));
    planFrames(PODIUM, 2).forEach((frame, i) => {
      const cols = Math.round(frame.length / 4.2);
      facadeWindows(b, frame, {
        width: frame.length,
        height: 13.5,
        cols,
        rows: 3,
        fill: [0.62, 0.62],
        offset: 0.06,
        lit: 'windowLit',
        dark: 'glass',
        litRatio: 0.7,
        seed: 100 + i,
        // The Fifth Avenue portal is the middle bays of the front.
        skip: (c, r) => i === 2 && r === 0 && Math.abs(c - (cols - 1) / 2) < 2,
      });
    });
    // The Fifth Avenue entrance: a recessed, lit portal with a canopy.
    b.add('lamp', box([-5.5, 0, 64.8], [5.5, 8.5, 65.1]));
    b.add('granite', box([-7.5, 8.5, 64.6], [7.5, 11, 66.2], 0.15));

    tier(b, LOWER, 17, 75, { seed: 1 });
    // The 72nd-floor-style ledges are thin chamfered courses between tiers.
    const t2: V2[] = [
      [-23, -35.6],
      [27.8, -35.4],
      [27.8, 35.6],
      [-23, 35.4],
    ];
    tier(b, t2, 75, 90, { seed: 2 });
    tier(b, shaft(-18.5, 23, -34, 34.2, 6.3, 9), 90, 115, { seed: 3 });
    tier(b, shaft(-18.5, 23, -27.8, 28.1, 6.3, 9), 115, 255, { seed: 4, litRatio: 0.38 });
    tier(b, shaft(-16.4, 21, -25.8, 26.2, 4.2, 11), 255, 290, { seed: 5 });
    tier(b, chamfer(-12.2, 16.8, -22.7, 22.5, 2.2), 290, 310, { seed: 6 });
    tier(b, chamfer(-11.2, 15.8, -21.8, 21.5, 2.2), 310, 320, { seed: 7 });
    // 86th floor: the open-air observatory, a parapet and the lit crown base.
    const deck = chamfer(-8.2, 12.9, -18.8, 18.5, 1.6);
    b.add('limestone', prism(deck, 320, 326.5, 0.3));
    facadeWindows(b, planFrames(deck, 321)[0], {
      width: planFrames(deck, 321)[0].length,
      height: 4,
      cols: 6,
      rows: 1,
      lit: 'windowLit',
      dark: 'glass',
      litRatio: 1,
      fill: [0.7, 0.8],
      offset: 0.05,
    });

    // The mast: art-deco crown of stepped, finned tiers in aluminium, floodlit
    // at night — the building's signature.
    const cx = 2.35;
    const cz = -0.5;
    const mastTier = (y0: number, y1: number, w: number, d: number, c: number) =>
      b.add(
        'steelLit',
        prism(chamfer(cx - w / 2, cx + w / 2, cz - d / 2, cz + d / 2, c), y0, y1, 0.15),
      );
    mastTier(326.5, 334, 15.5, 15.5, 4.2);
    mastTier(334, 346, 13, 13, 3.6);
    // Fins: four buttresses per side sweeping up the crown.
    for (const [dx, dz, rot] of [
      [1, 0, 0],
      [-1, 0, 0],
      [0, 1, 1],
      [0, -1, 1],
    ] as const) {
      for (const s of [-1, 1]) {
        const along = s * 3.2;
        const px = cx + dx * 6.8 + (rot ? along : 0);
        const pz = cz + dz * 6.8 + (rot ? 0 : along);
        b.add(
          'steel',
          loft([
            { y: 330, plan: finPlan(px, pz, dx, dz, 1.6) },
            { y: 362, plan: finPlan(px - dx * 1.8, pz - dz * 1.8, dx, dz, 0.4) },
          ]),
        );
      }
    }
    mastTier(346, 358, 10.5, 10.5, 3);
    mastTier(358, 366, 8.2, 8.2, 2.4);
    // The 102nd-floor drum and its lantern.
    b.add(
      'steelLit',
      lathe(
        [
          [4.2, 366],
          [4.2, 371],
          [3.4, 372.5],
          [2.6, 373.5],
        ],
        20,
        { capTop: true },
      ),
      undefined,
      { smooth: true },
    );
    b.add('lamp', cylinder(2.3, 2.1, 368, 371.5, 16));
    // The antenna to 443 m.
    b.add('steel', cylinder(1.2, 0.6, 373.5, 400, 10));
    b.add('steel', cylinder(0.6, 0.18, 400, 441, 8));
    b.add('beacon', cylinder(0.35, 0.35, 441, 443.2, 8));
  },
};

/** A builder that turns everything added to it about +Y by `angle`. */
function turned(target: Builder, angle: number): Builder {
  const turn = at(0, 0, 0, angle);
  return Object.assign(Object.create(target), {
    add: (
      material: string,
      geometry: Parameters<Builder['add']>[1],
      transform?: THREE.Matrix4,
      options?: { smooth?: boolean },
    ) =>
      target.add(material, geometry, transform ? turn.clone().multiply(transform) : turn, options),
  });
}

/** A fin's footprint: a thin slab pointing outward along (dx, dz). */
function finPlan(px: number, pz: number, dx: number, dz: number, depth: number): V2[] {
  const t = 0.35;
  if (dx !== 0) {
    return [
      [px - (dx * depth) / 2, pz - t],
      [px + (dx * depth) / 2, pz - t],
      [px + (dx * depth) / 2, pz + t],
      [px - (dx * depth) / 2, pz + t],
    ].map(([x, z]) => [x, z] as V2) as V2[];
  }
  return [
    [px - t, pz - (dz * depth) / 2],
    [px + t, pz - (dz * depth) / 2],
    [px + t, pz + (dz * depth) / 2],
    [px - t, pz + (dz * depth) / 2],
  ];
}

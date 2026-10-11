/**
 * Palau Nacional — the Museu Nacional d'Art de Catalunya, Montjuïc,
 * Barcelona (Eugenio Cendoya and Enric Catà, 1929) — procedural, stylised.
 *
 * Plan: OpenStreetMap's outline of relation/21195792 (ODbL, Catalonia
 * extract of 2026-10-08) and the positions of its domes and towers, read
 * from its `building:part`s, in the model frame and rounded to 0.1 m.
 * Heights, the drum and dome profiles, the portico, the towers and the front
 * terraces are authored here (OSM records the parts' footprints but few of
 * their heights).
 *
 * Frame: +Z faces Plaça d'Espanya down the hill (bearing 333°); the
 * building is symmetric about x = 0. On a flat map the terraces that step
 * down Montjuïc are drawn as a low stepped forecourt.
 */
import {
  box,
  cylinder,
  facadeWindows,
  lathe,
  planFrames,
  prism,
  rect,
  sphere,
  type V2,
} from '../kit';
import { PALETTE } from '../palette';
import { placed, ring } from './bcnGaudiKit';
import type { LandmarkModel } from './types';

const OUTLINE = ring(`
  79.6,73.8 65.1,74 65,67.6 22.2,67.8 22.2,76.3 11.4,76.1 11.6,72.8 8.5,72.7 -7.4,72.8 -10.5,72.9
  -10.5,76 -21,76 -20.9,67.9 -64.5,67.8 -64.3,74.4 -78.4,74.3 -78.4,69.6 -77.4,69.5 -77.2,53.4
  -83.6,53.3 -83.6,47.6 -83.5,39.9 -83.5,35 -77.4,35.1 -77.2,16 -78.4,16 -78.4,14 -63.7,14.3
  -63.7,16.1 -64.8,16.2 -64.9,21.3 -49.1,21.3 -48.1,21.3 -47.9,-0.1 -51.7,0.1 -52,-16 -47.7,-16
  -48.2,-35.7 -49.6,-35.7 -49.8,-47.9 -37.3,-48.1 -37.3,-46.9 -14.2,-46.5 -14.6,-58.2 -16.4,-58.2
  -16.1,-70.3 -15.6,-71 -4.8,-71 -4.1,-70.1 5.6,-70.1 6.5,-71 17.6,-70.9 18.3,-70.2 18.3,-58.3
  16.7,-58.3 16.6,-48.7 37.7,-48.8 37.9,-49.1 50.5,-49.2 50.5,-37.1 50.2,-36.8 50.3,-17 54.6,-17
  54.6,-11.7 53.8,-11.7 53.6,-4.1 54.6,-4.1 54.4,0.8 50.3,0.7 50.1,20.4 65.4,20.4 65.5,19.6
  65.1,19.6 65.3,14 79.8,14.1 79.8,19.4 79.3,19.5 79.3,34.3 84.7,34.3 84.8,39 84.5,39 84.4,48.7
  84.7,48.7 84.7,53.4 78.9,53.4 79,68.6 79.5,68.6
`);

/** The main dome over the Sala Oval, and the four towers round it (OSM part positions). */
const DOME = { x: 0, z: -6 };
const TOWERS: V2[] = [
  [-44, 27],
  [44, 27],
  [-44, -42],
  [44, -42],
];

export const palauNacional: LandmarkModel = {
  id: 'palau-nacional',
  materials: {
    stone: { color: '#e2cea5', roughness: 0.85, uplight: true },
    stoneLight: { color: '#e8dbbe', roughness: 0.8, uplight: true },
    dome: {
      color: '#cfc5b0',
      roughness: 0.7,
      uplight: true,
      night: { color: '#ffcf8a', strength: 0.32 },
    },
    roof: { color: '#b9ab92', roughness: 0.9 },
    belfry: { color: '#e8dbbe', roughness: 0.8, night: { color: '#ffd08f', strength: 0.9 } },
    terrace: { color: '#d6c8aa', roughness: 0.95, uplight: true },
    water: { ...PALETTE.water, night: { color: '#9fd6ff', strength: 0.5 } },
    glass: PALETTE.glass,
    windowLit: { ...PALETTE.windowLit, night: { color: '#ffd08f', strength: 1.2 } },
  },
  build(b) {
    // --- The palace block --------------------------------------------------
    b.add('stone', prism(OUTLINE, 0, 17.5, 0.3));
    // Cornice: a projecting band all round.
    b.add('stoneLight', prism(OUTLINE, 17.5, 18.6, 0.2));
    // The raised central body behind the front wing.
    const centre: V2[] = rect(100, 70, 0, -14);
    b.add('stone', prism(centre, 18.6, 23, 0.3));
    b.add('stone', prism(rect(54, 54, 0, -6), 23, 26.5, 0.4));
    // End pavilions of the front wing, a storey higher, with small domes.
    for (const sx of [-1, 1]) {
      b.add('stone', prism(rect(19, 40, sx * 72.5, 44), 18.6, 23, 0.3));
      b.add(
        'dome',
        placed(lathe(dome(6.2, 4.2, 1.2), 24, { capBottom: true }), [sx * 72.1, 23, 43.8]),
        undefined,
        { smooth: true },
      );
    }
    // Windows: two floors along the front and the sides.
    planFrames(OUTLINE, 3.5).forEach((frame, i) => {
      if (frame.length < 7) return;
      const cols = Math.max(1, Math.round(frame.length / 4.6));
      facadeWindows(b, frame, {
        width: frame.length,
        height: 12,
        cols,
        rows: 2,
        fill: [0.45, 0.55],
        offset: 0.08,
        lit: 'windowLit',
        dark: 'glass',
        litRatio: 0.55,
        seed: 300 + i,
      });
    });

    // --- The portico: a colonnade under an attic, at the top of the stairs ----
    const pz = 76.6;
    b.add('stoneLight', box([-21, 0, 74], [21, 1.4, pz + 3]));
    for (let i = 0; i < 8; i++) {
      const x = -17.5 + i * 5;
      b.add('stoneLight', placed(cylinder(0.95, 0.8, 1.4, 15.5, 12), [x, 0, pz + 1.6]), undefined, {
        smooth: true,
      });
    }
    b.add('stoneLight', box([-21.5, 15.5, 72], [21.5, 19.5, pz + 2.8], 0.25));
    b.add('windowLit', box([-14, 1.4, 75.9], [14, 12, 76.1]));
    // The front dome over the entrance hall.
    b.add('stone', placed(lathe(drum(10.5, 7), 32, { capTop: false }), [0, 18.6, 44]), undefined, {
      smooth: true,
    });
    b.add('dome', placed(lathe(dome(10.5, 8.5, 2), 32), [0, 25.6, 44]), undefined, {
      smooth: true,
    });

    // --- The great dome over the Sala Oval --------------------------------------
    b.add('stone', placed(lathe(drum(19, 10), 48), [DOME.x, 26.5, DOME.z]), undefined, {
      smooth: true,
    });
    // A ring of pilasters round the drum, with lit windows between them.
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const x = DOME.x + Math.cos(a) * 19.25;
      const z = DOME.z + Math.sin(a) * 19.25;
      b.add('stoneLight', placed(box([-0.6, 0, -0.6], [0.6, 9.4, 0.6]), [x, 26.8, z], -a));
      const wa = a + Math.PI / 24;
      b.add(
        i % 3 === 0 ? 'glass' : 'windowLit',
        placed(
          box([-0.9, 0, -0.1], [0.9, 4.2, 0.1]),
          [DOME.x + Math.cos(wa) * 19.05, 29.5, DOME.z + Math.sin(wa) * 19.05],
          Math.PI / 2 - wa,
        ),
      );
    }
    b.add(
      'stoneLight',
      placed(
        lathe(
          [
            [19.8, 36.5],
            [20.2, 37.4],
            [18.6, 38],
          ],
          48,
        ),
        [DOME.x, 0, DOME.z],
      ),
      undefined,
      {
        smooth: true,
      },
    );
    b.add('dome', placed(lathe(dome(18.6, 17, 3.5), 48), [DOME.x, 38, DOME.z]), undefined, {
      smooth: true,
    });
    // Ribs on the dome.
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const pts = dome(18.85, 17.2, 3.5).slice(0, -1);
      for (let k = 0; k < pts.length - 1; k++) {
        const [r0, y0] = pts[k];
        const [r1, y1] = pts[k + 1];
        const g = box([-0.35, 0, -0.2], [0.35, Math.hypot(r1 - r0, y1 - y0), 0.2]);
        g.rotateX(-Math.atan2(r0 - r1, y1 - y0));
        b.add(
          'stoneLight',
          placed(
            g,
            [DOME.x + Math.cos(a) * r0, 38 + y0, DOME.z + Math.sin(a) * r0],
            Math.PI / 2 - a,
          ),
        );
      }
    }
    // The lantern.
    b.add('belfry', cylinder(3.3, 3.3, 55, 59.5, 16), undefined, { smooth: true });
    b.add('dome', placed(lathe(dome(3.6, 3.2, 0.6), 16), [DOME.x, 59.5, DOME.z]), undefined, {
      smooth: true,
    });
    b.add('stoneLight', cylinder(0.35, 0.1, 63.2, 66, 8));

    // --- The four towers -----------------------------------------------------------
    for (const [x, z] of TOWERS) {
      b.add('stone', prism(rect(9, 9, x, z), 0, 42, 0.25));
      b.add('stoneLight', prism(rect(10, 10, x, z), 42, 43.2, 0.2));
      // Belfry: open arches on every face, lit at night.
      b.add('stone', prism(rect(8, 8, x, z), 43.2, 50, 0.2));
      for (const [dx, dz, rot] of [
        [0, 4.05, 0],
        [0, -4.05, 0],
        [4.05, 0, Math.PI / 2],
        [-4.05, 0, Math.PI / 2],
      ] as const) {
        b.add('belfry', placed(box([-2.4, 0, -0.1], [2.4, 5, 0.1]), [x + dx, 44.2, z + dz], rot));
      }
      b.add('stoneLight', prism(rect(8.8, 8.8, x, z), 50, 51, 0.2));
      b.add(
        'stone',
        placed(
          lathe(
            [
              [3.4, 51],
              [3.4, 54],
              [2.6, 54.6],
            ],
            8,
          ),
          [x, 0, z],
        ),
      );
      b.add('dome', placed(lathe(dome(2.8, 3.4, 0.5), 16), [x, 54.6, z]), undefined, {
        smooth: true,
      });
      b.add('stoneLight', placed(sphere(0.45, 8, 6), [x, 59, z]), undefined, { smooth: true });
    }

    // --- The forecourt: terraces stepping down toward Plaça d'Espanya ---------------
    const steps = [
      { z0: 76, z1: 88, w: 150, h: 2.2 },
      { z0: 88, z1: 100, w: 120, h: 1.4 },
      { z0: 100, z1: 112, w: 90, h: 0.7 },
    ];
    for (const s of steps) {
      b.add('terrace', prism(rect(s.w, s.z1 - s.z0, 0, (s.z0 + s.z1) / 2), 0, s.h, 0.15));
      // A balustrade along each terrace edge.
      b.add('stoneLight', box([-s.w / 2, s.h, s.z1 - 0.5], [-14, s.h + 0.9, s.z1 - 0.2]));
      b.add('stoneLight', box([14, s.h, s.z1 - 0.5], [s.w / 2, s.h + 0.9, s.z1 - 0.2]));
    }
    // The central stair and the cascade beside it.
    for (let i = 0; i < 9; i++) {
      const z = 76 + i * 4;
      b.add('stoneLight', box([-12, 0, z], [12, 2.4 - i * 0.26, z + 4]));
    }
    b.add('water', box([-4, 0.05, 84], [4, 0.9, 112]));
  },
};

/** A drum: a cylinder of radius `r` and height `h`, from y = 0. */
function drum(r: number, h: number): V2[] {
  return [
    [r, 0],
    [r, h],
  ];
}

/** A dome profile from its springing (y = 0): radius `r`, rise `h`, an oculus of radius `top`. */
function dome(r: number, h: number, top: number): V2[] {
  const out: V2[] = [];
  for (let i = 0; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    const rr = Math.max(top, r * Math.cos(a));
    out.push([rr, h * Math.sin(a)]);
  }
  out.push([0, h]);
  return out;
}

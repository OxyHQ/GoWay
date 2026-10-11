/**
 * Roof geometry (`engine/city3d/roofs.ts`): the frame a roof is laid out in,
 * the planes whose minimum is the roof, where walls must bend to meet it, and
 * the patches each plane covers.
 */
import { describe, expect, test } from 'bun:test';

import type { Point2 } from '@/components/map/engine/city3d/mesher';
import { signedArea } from '@/components/map/engine/city3d/mesher';
import {
  clipRingByLine,
  convexHull,
  edgeBreaks,
  isStarShaped,
  PLANAR_ROOF_SHAPES,
  planeAt,
  revolutionProfile,
  ringCentroid,
  roofFrame,
  roofHeightAt,
  roofPatch,
  roofPlanes,
} from '@/components/map/engine/city3d/roofs';
import { ROOF_SHAPES } from '@/lib/map/cityTiles';

/** A 20 m (east) × 10 m (north) house, counter-clockwise, centred at (10, 5). */
const HOUSE: Point2[] = [
  [0, 0],
  [20, 0],
  [20, 10],
  [0, 10],
];

function rotate(points: Point2[], degrees: number): Point2[] {
  const r = (degrees * Math.PI) / 180;
  return points.map(([x, y]) => [
    x * Math.cos(r) - y * Math.sin(r),
    x * Math.sin(r) + y * Math.cos(r),
  ]);
}

describe('roofFrame', () => {
  test('the ridge runs along the longer side, through the middle', () => {
    const frame = roofFrame(HOUSE);
    expect(frame).not.toBeNull();
    expect(Math.abs(frame?.ux ?? 0)).toBeCloseTo(1, 6);
    expect(frame?.halfLength).toBeCloseTo(10, 6);
    expect(frame?.halfWidth).toBeCloseTo(5, 6);
    expect(frame?.cx).toBeCloseTo(10, 6);
    expect(frame?.cy).toBeCloseTo(5, 6);
  });

  test('the minimum-area rectangle finds a rotated footprint', () => {
    const frame = roofFrame(rotate(HOUSE, 33));
    expect(frame?.halfLength).toBeCloseTo(10, 6);
    expect(frame?.halfWidth).toBeCloseTo(5, 6);
    const angle = (Math.atan2(frame?.uy ?? 0, frame?.ux ?? 0) * 180) / Math.PI;
    expect(((angle % 180) + 180) % 180).toBeCloseTo(33, 4);
  });

  test('across puts the ridge on the shorter side', () => {
    const frame = roofFrame(HOUSE, { across: true });
    expect(Math.abs(frame?.uy ?? 0)).toBeCloseTo(1, 6);
    expect(frame?.halfLength).toBeCloseTo(5, 6);
    expect(frame?.halfWidth).toBeCloseTo(10, 6);
  });

  test('a tagged direction is the way the slope faces; the ridge is perpendicular', () => {
    // Facing east (90°): the ridge runs north–south and v points east.
    const frame = roofFrame(HOUSE, { direction: 90 });
    expect(Math.abs(frame?.ux ?? 1)).toBeCloseTo(0, 6);
    const vx = -(frame?.uy ?? 0);
    expect(vx).toBeCloseTo(1, 6);
    expect(frame?.halfWidth).toBeCloseTo(10, 6);
  });

  test('no area, no frame', () => {
    expect(
      roofFrame([
        [0, 0],
        [1, 1],
        [2, 2],
      ]),
    ).toBeNull();
    expect(convexHull([[0, 0]])).toHaveLength(1);
  });
});

describe('roofPlanes', () => {
  const frame = roofFrame(HOUSE);
  if (!frame) throw new Error('frame');
  const H = 4;

  test('gabled: the ridge at full height, the eaves at zero', () => {
    const planes = roofPlanes('gabled', frame, H);
    expect(roofHeightAt(planes, 10, 5)).toBeCloseTo(H, 6);
    expect(roofHeightAt(planes, 3, 5)).toBeCloseTo(H, 6); // anywhere on the ridge
    expect(roofHeightAt(planes, 10, 0)).toBeCloseTo(0, 6);
    expect(roofHeightAt(planes, 10, 10)).toBeCloseTo(0, 6);
    expect(roofHeightAt(planes, 10, 2.5)).toBeCloseTo(H / 2, 6);
  });

  test('hipped: the ends slope too, at the same pitch', () => {
    const planes = roofPlanes('hipped', frame, H);
    expect(roofHeightAt(planes, 10, 5)).toBeCloseTo(H, 6);
    expect(roofHeightAt(planes, 0, 5)).toBeCloseTo(0, 6);
    expect(roofHeightAt(planes, 20, 5)).toBeCloseTo(0, 6);
    expect(roofHeightAt(planes, 2.5, 5)).toBeCloseTo(H / 2, 6);
  });

  test('pyramidal: one apex, every edge at the eaves', () => {
    const planes = roofPlanes('pyramidal', frame, H);
    expect(roofHeightAt(planes, 10, 5)).toBeCloseTo(H, 6);
    expect(roofHeightAt(planes, 15, 5)).toBeCloseTo(H / 2, 6);
    for (const [x, y] of HOUSE) expect(roofHeightAt(planes, x, y)).toBeCloseTo(0, 6);
  });

  test('skillion: one plane from full height to the eaves across the width', () => {
    const planes = roofPlanes('skillion', frame, H);
    expect(planes).toHaveLength(1);
    const values = [roofHeightAt(planes, 10, 0), roofHeightAt(planes, 10, 10)].sort();
    expect(values[0]).toBeCloseTo(0, 6);
    expect(values[1]).toBeCloseTo(H, 6);
  });

  test('a tagged skillion slopes down toward its direction', () => {
    const south = roofFrame(HOUSE, { direction: 180 });
    if (!south) throw new Error('frame');
    const planes = roofPlanes('skillion', south, H);
    expect(roofHeightAt(planes, 10, 0)).toBeCloseTo(0, 6); // the south edge is low
    expect(roofHeightAt(planes, 10, 10)).toBeCloseTo(H, 6);
  });

  test('gambrel and mansard: steeper below the break than above it', () => {
    for (const shape of ['gambrel', 'mansard'] as const) {
      const planes = roofPlanes(shape, frame, H);
      expect(roofHeightAt(planes, 10, 5)).toBeCloseTo(H, 6);
      const lower = roofHeightAt(planes, 10, 1.25) - roofHeightAt(planes, 10, 0);
      const upper = roofHeightAt(planes, 10, 5) - roofHeightAt(planes, 10, 3.75);
      expect(lower).toBeGreaterThan(upper);
    }
  });

  test('round: a barrel, close to a circle arc', () => {
    const planes = roofPlanes('round', frame, H);
    expect(roofHeightAt(planes, 10, 5)).toBeCloseTo(H, 6);
    const u = 0.5;
    expect(roofHeightAt(planes, 10, 5 + u * 5)).toBeCloseTo(H * Math.sqrt(1 - u * u), 0);
  });

  test('round: the barrel meets the eaves at the edge, and rises continuously to the crown', () => {
    const planes = roofPlanes('round', frame, H);
    // Both eave edges (t = ±W) are at the eaves — no step for the walls to climb.
    expect(roofHeightAt(planes, 10, 0)).toBeCloseTo(0, 6);
    expect(roofHeightAt(planes, 10, 10)).toBeCloseTo(0, 6);
    // Sampled across the width: monotone up to the crown, no jump, symmetric.
    const samples: number[] = [];
    for (let k = 0; k <= 200; k++) samples.push(roofHeightAt(planes, 10, (k / 200) * 10));
    for (let k = 1; k <= 100; k++) expect(samples[k]).toBeGreaterThanOrEqual(samples[k - 1] - 1e-9);
    for (let k = 1; k < samples.length; k++) {
      // A circle is vertical at its edge, so the last facet is steep: bound the
      // step per 5 cm sample at a tenth of the roof, which no gap would meet.
      expect(Math.abs(samples[k] - samples[k - 1])).toBeLessThan(0.1 * H);
      expect(samples[k]).toBeCloseTo(samples[200 - k], 6);
    }
  });

  test('every planar shape is the roof everywhere over its footprint, between 0 and H', () => {
    for (const shape of ROOF_SHAPES) {
      if (!PLANAR_ROOF_SHAPES.has(shape)) {
        expect(roofPlanes(shape, frame, H)).toEqual([]);
        continue;
      }
      const planes = roofPlanes(shape, frame, H);
      for (let x = 0; x <= 20; x += 2.5) {
        for (let y = 0; y <= 10; y += 2.5) {
          const z = roofHeightAt(planes, x, y);
          expect(z).toBeGreaterThanOrEqual(0);
          expect(z).toBeLessThanOrEqual(H + 1e-9);
        }
      }
    }
  });
});

describe('edgeBreaks', () => {
  const frame = roofFrame(HOUSE);
  if (!frame) throw new Error('frame');

  test('a gable end bends once, under the ridge; an eave not at all', () => {
    const planes = roofPlanes('gabled', frame, 4);
    expect(edgeBreaks([20, 0], [20, 10], planes)).toEqual([0.5]);
    expect(edgeBreaks([0, 0], [20, 0], planes)).toEqual([]);
  });

  test('a hipped eave bends where the hips meet it... which is at its ends', () => {
    const planes = roofPlanes('hipped', frame, 4);
    expect(edgeBreaks([0, 0], [20, 0], planes)).toEqual([]);
  });

  test('only the LOWEST planes bend the wall', () => {
    const planes = roofPlanes('round', frame, 4);
    const breaks = edgeBreaks([20, 0], [20, 10], planes);
    // One bend per facet edge (11 tangents + 2 edge chords = 13 facets),
    // symmetric about the middle.
    expect(breaks.length).toBe(12);
    breaks.forEach((t, i) => {
      expect(t).toBeCloseTo(1 - breaks[breaks.length - 1 - i], 6);
    });
  });
});

describe('roof patches', () => {
  const frame = roofFrame(HOUSE);
  if (!frame) throw new Error('frame');

  test('clipping a ring by a line keeps the half it should', () => {
    const left = clipRingByLine(HOUSE, -1, 0, 10); // x <= 10
    expect(Math.abs(signedArea(left))).toBeCloseTo(100, 6);
    expect(signedArea(left)).toBeGreaterThan(0); // orientation kept
  });

  // "Exactly" up to the clip's tolerance, which deliberately keeps a sub-
  // millimetre sliver of overlap along each crease (a crack would show; an
  // overlap at the same height does not): measured ≤ 0.05% of the area.
  test('the patches of every planar shape tile the footprint, holes included', () => {
    const courtyard: Point2[] = [
      [8, 3],
      [8, 7],
      [12, 7],
      [12, 3],
    ];
    const polygon = [HOUSE, courtyard];
    const footprint = signedArea(HOUSE) + signedArea(courtyard);
    for (const shape of PLANAR_ROOF_SHAPES) {
      const planes = roofPlanes(shape, frame, 4);
      let total = 0;
      for (let i = 0; i < planes.length; i++) {
        for (const ring of roofPatch(polygon, planes, i)) total += signedArea(ring);
      }
      expect(total).toBeGreaterThanOrEqual(footprint - 1e-6);
      expect((total - footprint) / footprint).toBeLessThan(1e-3);
    }
  });

  test('inside its patch a plane IS the roof', () => {
    const planes = roofPlanes('hipped', frame, 4);
    for (let i = 0; i < planes.length; i++) {
      for (const ring of roofPatch([HOUSE], planes, i)) {
        const [x, y] = ringCentroid(ring);
        expect(planeAt(planes[i], x, y)).toBeCloseTo(roofHeightAt(planes, x, y), 3);
      }
    }
  });
});

describe('surfaces of revolution', () => {
  test('profiles run from the eaves at full radius to the top at none', () => {
    for (const shape of ['dome', 'onion', 'cone'] as const) {
      const profile = revolutionProfile(shape);
      expect(profile[0]).toEqual([0, 1]);
      expect(profile[profile.length - 1][0]).toBeCloseTo(1, 9);
      expect(profile[profile.length - 1][1]).toBeCloseTo(0, 9);
    }
    // The onion bulges past its base; the dome never does.
    expect(Math.max(...revolutionProfile('onion').map(([, r]) => r))).toBeGreaterThan(1);
    expect(Math.max(...revolutionProfile('dome').map(([, r]) => r))).toBe(1);
  });

  test('star-shaped about the centroid: convex yes, a deep U no', () => {
    expect(isStarShaped(HOUSE, ringCentroid(HOUSE))).toBe(true);
    const u: Point2[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [8, 10],
      [8, 1],
      [2, 1],
      [2, 10],
      [0, 10],
    ];
    expect(isStarShaped(u, ringCentroid(u))).toBe(false);
  });
});

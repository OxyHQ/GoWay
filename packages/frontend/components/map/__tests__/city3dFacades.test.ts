/**
 * The facade relief (`engine/city3d/tsl/detailedMaterial.ts` → `facadeOf`,
 * its tables in `materials.ts`) and the per-building class and era it reads
 * (`osmMesher.ts` → `buildingFlagsOf`).
 *
 * What can be pinned without a GPU: the flag byte round-trips through the
 * shader's decode, the per-class tables keep every opening inside its bay and
 * storey and are the shader's own, and the analytic slope is smoothstep's
 * derivative. How it looks is in the visibility gate and the side-by-sides
 * (`docs/MAP_3D_CITY.md` → Art direction, "Facades").
 */
import { describe, expect, test } from 'bun:test';

import { FACADE_STYLES } from '@/components/map/engine/city3d/materials';
import {
  FACADE_TABLES,
  stepD as shaderStepD,
} from '@/components/map/engine/city3d/tsl/detailedMaterial';
import { float } from 'three/tsl';
import {
  buildingFlagsOf,
  VERTEX_ERA_SHIFT,
  VERTEX_FLAG_FLOODLIT,
  VERTEX_USE_SHIFT,
} from '@/components/map/engine/city3d/osmMesher';
import { BUILDING_ERAS, BUILDING_USES } from '@/lib/map/cityTiles';

import { constantsOf } from './tslGraph';

/** The shader's decode (`gowayFacade`), in JS. */
const decode = (flags: number) => ({
  floodlit: flags % 2 === 1, // the sky reads `mod(flags, 2)`
  use: Math.min((flags >> 1) & 7, FACADE_STYLES.length - 1),
  era: (flags >> 4) & 3,
});

describe('the flag byte', () => {
  test('class and era round-trip through the shader decode, beside floodlit', () => {
    for (const floodlit of [false, true]) {
      for (const [u, use] of [undefined, ...BUILDING_USES].entries()) {
        for (const [e, era] of [undefined, ...BUILDING_ERAS].entries()) {
          const flags = buildingFlagsOf({ floodlit, use, era });
          expect(flags).toBeLessThan(256);
          expect(decode(flags)).toEqual({ floodlit, use: u, era: e });
        }
      }
    }
  });

  test('the bits do not overlap', () => {
    expect(VERTEX_FLAG_FLOODLIT).toBe(1);
    expect(VERTEX_USE_SHIFT).toBe(1);
    expect(VERTEX_ERA_SHIFT).toBeGreaterThanOrEqual(VERTEX_USE_SHIFT + 3);
  });
});

describe('the per-class styles', () => {
  test('one row per class, unknown first, in the tile vocabulary’s order', () => {
    expect(FACADE_STYLES.map((s) => s.use)).toEqual(['unknown', ...BUILDING_USES]);
  });

  test('every opening sits inside its bay and storey, with room for a frame', () => {
    for (const { use, opening } of FACADE_STYLES) {
      const [half, sill, head, pier] = opening;
      expect(half, use).toBeGreaterThan(0.1);
      expect(half + 0.06, use).toBeLessThan(0.5); // the frame stays inside the bay
      expect(sill, use).toBeGreaterThan(0.07); // and above the floor
      expect(head, use).toBeGreaterThan(sill + 0.2);
      expect(head + 0.06, use).toBeLessThan(1);
      expect(pier).toBeGreaterThanOrEqual(0);
      expect(pier).toBeLessThan(0.4); // relief, not new massing
    }
  });

  test('depths stay sub-metre: styling on the wall, never a different building', () => {
    for (const { relief } of FACADE_STYLES) {
      for (const depth of [relief[0], relief[1], relief[3]]) expect(depth).toBeLessThanOrEqual(0.6);
    }
  });

  test('the shader’s tables are generated from them', () => {
    const openings = constantsOf(FACADE_TABLES.openings);
    const reliefs = constantsOf(FACADE_TABLES.reliefs);
    expect(openings).toEqual(FACADE_STYLES.flatMap((f) => [...f.opening]));
    expect(reliefs).toEqual(FACADE_STYLES.flatMap((f) => [...f.relief]));
  });
});

describe('the analytic slope', () => {
  // The shader's smoothstep and the derivative `stepD` uses, in JS.
  const step = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return t * t * (3 - 2 * t);
  };
  const stepD = (e0: number, e1: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return (6 * t * (1 - t)) / (e1 - e0);
  };

  test('stepD is smoothstep’s derivative (central differences)', () => {
    for (const [e0, e1] of [
      [0.3, 0.6],
      [-0.32, -0.22],
      [0.2, 0.25],
    ]) {
      for (let x = e0 - 0.1; x <= e1 + 0.1; x += 0.013) {
        const h = 1e-6;
        expect(stepD(e0, e1, x)).toBeCloseTo(
          (step(e0, e1, x + h) - step(e0, e1, x - h)) / (2 * h),
          4,
        );
      }
    }
    // The shader's is the same expression: 6·t·(1 − t) / (e1 − e0).
    expect(constantsOf(shaderStepD(0.3, 0.6, float(0.4)))).toEqual(
      expect.arrayContaining([6, 1, 0.3, 0.6]),
    );
  });
});

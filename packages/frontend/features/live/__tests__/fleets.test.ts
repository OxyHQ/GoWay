/**
 * The fleet registry: which simplified vehicle each live entity is drawn as,
 * and the triangle budget of every model it can name.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import type { LiveEntity } from '@goway.to/sdk/live';

import { readLibrary } from '@/components/map/__tests__/libraryFromDisk';
import {
  buildLiveModel,
  LIVE_LIBRARY_KEYS,
  liveLibraryKey,
} from '@/components/map/engine/live3d/liveModels';
import type { LibraryModel } from '@/components/map/engine/vehicles/library';
import type { MapLiveModel } from '@/components/map/types';

import { FLEETS, fleetLength, fleetOf } from '../fleets';

function transit(sourceId: string, line: string | null, mode: 'bus' | 'rail' = 'rail'): LiveEntity {
  return {
    kind: 'transit',
    id: `${sourceId}:1`,
    sourceId,
    position: { latitude: 41.4, longitude: 2.1 },
    headingDegrees: null,
    speedMetersPerSecond: null,
    observedAt: '2026-10-11T12:00:00Z',
    mode,
    operator: 'x',
    line,
    headsign: null,
    vehicleLabel: null,
    lineColor: null,
    lineTextColor: null,
    track: null,
    trackStatus: 'unknown',
    positionBasis: 'reported',
  };
}

describe('the fleet registry', () => {
  test('maps each operator and line to its fleet, falling back to generic', () => {
    expect(fleetOf(transit('renfe-cercanias', 'R2N'))).toBe('rodalies-civia');
    expect(fleetOf(transit('renfe-cercanias', 'C4'))).toBe('cercanias-civia');
    // Regional and long-distance trains from Renfe's second feed.
    expect(fleetOf(transit('renfe-cercanias', 'REGIONAL'))).toBe('generic-train');
    expect(fleetOf(transit('renfe-cercanias', 'AVE'))).toBe('generic-train');
    expect(fleetOf(transit('renfe-cercanias', 'R11'))).toBe('rodalies-civia');
    expect(fleetOf(transit('fgc-geotren', 'S1'))).toBe('fgc-bv');
    expect(fleetOf(transit('fgc-geotren', 'R5'))).toBe('fgc-lla');
    expect(fleetOf(transit('mta-lirr', null))).toBe('lirr-emu');
    expect(fleetOf(transit('mta-mnr', null))).toBe('mnr-emu');
    expect(fleetOf(transit('mta-bus', 'M15+', 'bus'))).toBe('mta-bus-articulated');
    expect(fleetOf(transit('mta-bus', 'SIM1C', 'bus'))).toBe('mta-double-deck');
    expect(fleetOf(transit('mta-bus', 'BXM2', 'bus'))).toBe('mta-coach');
    expect(fleetOf(transit('mta-bus', 'M50', 'bus'))).toBe('mta-bus');
    expect(fleetOf(transit('mta-subway', '6'))).toBe('mta-subway-a');
    expect(fleetOf(transit('mta-subway', '7X'))).toBe('mta-subway-a');
    expect(fleetOf(transit('mta-subway', 'A'))).toBe('mta-subway-b');
    expect(fleetOf(transit('amb-bus', 'V3', 'bus'))).toBe('amb-bus');
    expect(fleetOf(transit('somewhere', 'X', 'bus'))).toBe('generic-bus');
    expect(fleetOf(transit('somewhere', 'X'))).toBe('generic-train');
  });

  test('every fleet is real-sized and a train is longer than a bus', () => {
    expect(fleetLength('rodalies-civia')).toBeGreaterThan(95);
    expect(fleetLength('mta-bus')).toBeCloseTo(12.2, 3);
    expect(fleetLength('mta-bus-articulated')).toBeGreaterThan(18);
  });

  let library: Map<string, LibraryModel>;
  beforeAll(async () => {
    library = await readLibrary(LIVE_LIBRARY_KEYS);
  });
  const build = (model: MapLiveModel, detail: 'near' | 'far') =>
    buildLiveModel(model, detail, library.get(liveLibraryKey(model.form)) as LibraryModel);

  test('every model is a shared-library model within its triangle budget, near and far', () => {
    for (const [key, model] of Object.entries(FLEETS)) {
      const near = build(model, 'near');
      const far = build(model, 'far');
      expect({ key, near: near.triangles <= 1500 }).toEqual({ key, near: true });
      expect({ key, far: far.triangles <= 200 }).toEqual({ key, far: true });
      expect(near.triangles).toBeGreaterThan(far.triangles);
      expect(near.colors.length).toBe(near.positions.length);
    }
  });

  test('the livery paints the body: only the body colour and the library’s own colours', () => {
    const model = FLEETS['rodalies-civia'];
    const source = library.get(liveLibraryKey(model.form)) as LibraryModel;
    const geometry = build(model, 'near');
    const paint = source.near.geometry.getAttribute('paint');
    const body = [1, 3, 5].map((i) => Number.parseInt(model.livery.body.slice(i, i + 2), 16) / 255);
    let painted = 0;
    for (let i = 0; i < paint.count; i++) {
      if (paint.getX(i) < 0.5) continue;
      painted++;
      // The body colour, shaded by the kit's ramp: never brighter, never another hue.
      for (let k = 0; k < 3; k++)
        expect(geometry.colors[i * 3 + k]).toBeLessThanOrEqual((body[k] ?? 0) + 1e-6);
    }
    expect(painted).toBeGreaterThan(0);
  });

  test('every ground vehicle is built nose towards +y, on the ground, at its real size', () => {
    // The 3D pass draws trains and buses at scale 1 (`livePass.ts`), and the
    // anchor turns a metre into mercator with MapLibre's own factor at the
    // vehicle's latitude (`liveAnchor.test.ts`, Madrid): so a car's bounds ARE
    // its size — one unit, one metre.
    for (const [key, model] of Object.entries(FLEETS)) {
      if (model.form === 'aircraft' || model.form === 'vessel') continue;
      const { positions } = build(model, 'near');
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < positions.length; i += 3) {
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis] as number, positions[i + axis] as number);
          max[axis] = Math.max(max[axis] as number, positions[i + axis] as number);
        }
      }
      const size = (axis: number) => (max[axis] as number) - (min[axis] as number);
      const near = (actual: number, expected: number) => Math.abs(actual / expected - 1) <= 0.06;
      // Its length runs along y, its width along x, up is z from the ground.
      expect({ key, length: near(size(1), model.carLength) }).toEqual({ key, length: true });
      expect({ key, width: near(size(0), model.width) }).toEqual({ key, width: true });
      expect({ key, height: near(max[2] as number, model.height) }).toEqual({ key, height: true });
      expect({ key, grounded: (min[2] as number) >= -0.01 }).toEqual({ key, grounded: true });
    }
  });
});

/**
 * The fleet registry: which simplified vehicle each live entity is drawn as,
 * and the triangle budget of every model it can name.
 */
import { describe, expect, test } from 'bun:test';
import type { LiveEntity } from '@goway.to/sdk/live';

import { buildLiveModel } from '@/components/map/engine/live3d/liveModels';

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
  };
}

describe('the fleet registry', () => {
  test('maps each operator and line to its fleet, falling back to generic', () => {
    expect(fleetOf(transit('renfe-cercanias', 'R2N'))).toBe('rodalies-civia');
    expect(fleetOf(transit('renfe-cercanias', 'C4'))).toBe('cercanias-civia');
    expect(fleetOf(transit('fgc-geotren', 'S1'))).toBe('fgc-bv');
    expect(fleetOf(transit('fgc-geotren', 'R5'))).toBe('fgc-lla');
    expect(fleetOf(transit('mta-lirr', null))).toBe('lirr-emu');
    expect(fleetOf(transit('mta-mnr', null))).toBe('mnr-emu');
    expect(fleetOf(transit('mta-bus', 'M15+', 'bus'))).toBe('mta-bus-articulated');
    expect(fleetOf(transit('mta-bus', 'SIM1C', 'bus'))).toBe('mta-double-deck');
    expect(fleetOf(transit('mta-bus', 'BXM2', 'bus'))).toBe('mta-coach');
    expect(fleetOf(transit('mta-bus', 'M50', 'bus'))).toBe('mta-bus');
    expect(fleetOf(transit('somewhere', 'X', 'bus'))).toBe('generic-bus');
    expect(fleetOf(transit('somewhere', 'X'))).toBe('generic-train');
  });

  test('every fleet is real-sized and a train is longer than a bus', () => {
    expect(fleetLength('rodalies-civia')).toBeGreaterThan(95);
    expect(fleetLength('mta-bus')).toBeCloseTo(12.2, 3);
    expect(fleetLength('mta-bus-articulated')).toBeGreaterThan(18);
  });

  test('every model stays within its triangle budget, near and far', () => {
    for (const [key, model] of Object.entries(FLEETS)) {
      const near = buildLiveModel(model, 'near');
      const far = buildLiveModel(model, 'far');
      expect({ key, near: near.triangles <= 1500 }).toEqual({ key, near: true });
      expect({ key, far: far.triangles <= 200 }).toEqual({ key, far: true });
      expect(near.triangles).toBeGreaterThan(far.triangles);
      expect(near.colors.length).toBe(near.positions.length);
    }
  });

  test('the livery is flat colour bands: every vertex is one of the palette colours', () => {
    const model = FLEETS['rodalies-civia'];
    const geometry = buildLiveModel(model, 'near');
    const hex = (c: string) => [1, 3, 5].map((i) => Number.parseInt(c.slice(i, i + 2), 16) / 255);
    const palette = [...Object.values(model.livery).map(hex), [0.16, 0.17, 0.18]];
    for (let i = 0; i < geometry.colors.length; i += 3) {
      const c = [geometry.colors[i], geometry.colors[i + 1], geometry.colors[i + 2]];
      expect(palette.some((p) => p.every((v, k) => Math.abs(v - (c[k] ?? 0)) < 1e-6))).toBe(true);
    }
  });

  test('models are built nose towards +y, on the ground', () => {
    const geometry = buildLiveModel(FLEETS['mta-bus'], 'near');
    let minY = 0;
    let maxY = 0;
    let minZ = 9;
    for (let i = 0; i < geometry.positions.length; i += 3) {
      minY = Math.min(minY, geometry.positions[i + 1] ?? 0);
      maxY = Math.max(maxY, geometry.positions[i + 1] ?? 0);
      minZ = Math.min(minZ, geometry.positions[i + 2] ?? 9);
    }
    expect(maxY - minY).toBeGreaterThan(11.5); // its length runs along y
    expect(minZ).toBeGreaterThanOrEqual(-0.01);
  });
});

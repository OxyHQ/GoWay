/**
 * The city engine's frame bookkeeping (`engine/city3d/frameSelection.ts`),
 * pinned against the three defects the review of #125 found:
 *
 *  1. the sky's offscreen pass was skipped while buildings were faded out, so
 *     its shadow target was never allocated and the sky (z12–15.5) vanished;
 *  2. the shadow map's key ignored the terrain lift, so shadows stayed where
 *     the buildings had been;
 *  3. the shadow pass ran on the PREVIOUS frame's tile selection, so after a
 *     pan it drew the old view's buildings.
 */
import { describe, expect, test } from 'bun:test';

import {
  buildingOpacity,
  castersKey,
  FrameSchedule,
  runsSkyOffscreenPass,
} from '@/components/map/engine/city3d/frameSelection';
import { castsInto, shadowFrame } from '@/components/map/engine/city3d/shadows';
import { mercatorXFromLng, mercatorYFromLat } from '@/components/map/engine/city3d/tileMath';

const FADE = { start: 15.5, end: 16.5 };

describe('the sky offscreen pass', () => {
  test('runs whenever the sky is on — also below the buildings’ fade', () => {
    expect(buildingOpacity(13.5, FADE)).toBe(0);
    expect(runsSkyOffscreenPass({ sky: true, buildings: true })).toBe(true);
    expect(runsSkyOffscreenPass({ sky: false, buildings: true })).toBe(false);
    expect(runsSkyOffscreenPass({ sky: true, buildings: false })).toBe(false);
  });

  test('the engine does not gate it on opacity', async () => {
    // The literal defect: `if (opacity <= 0) return;` before `sky.prerender`.
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const engine = readFileSync(
      join(import.meta.dir, '..', 'engine', 'city3d', 'cityEngine.ts'),
      'utf8',
    );
    const body = engine.slice(
      engine.indexOf('    prerender(view) {'),
      engine.indexOf('    render(view) {'),
    );
    expect(body).toContain('sky.prerender(');
    expect(body).not.toMatch(/opacity\s*<=\s*0/);
  });
});

describe('FrameSchedule', () => {
  test('with an offscreen pass, the frame is selected there and reused by the main pass', () => {
    const schedule = new FrameSchedule();
    for (let frame = 0; frame < 3; frame++) {
      expect(schedule.prerender()).toBe(true);
      expect(schedule.render()).toBe(false);
    }
  });

  test('without one (no sky), the main pass selects, every frame', () => {
    const schedule = new FrameSchedule();
    expect(schedule.render()).toBe(true);
    expect(schedule.render()).toBe(true);
  });

  test('a frame whose main pass never came does not leak into the next frame’s render', () => {
    const schedule = new FrameSchedule();
    schedule.prerender();
    schedule.render();
    // Next frame: the sky was switched off between frames.
    expect(schedule.render()).toBe(true);
  });
});

describe('castersKey', () => {
  const tiles = [
    { key: '14/8290/6119', tile: { z: 14, x: 8290, y: 6119 }, wrap: 0, groundRevision: 0 },
    { key: '14/8291/6119', tile: { z: 14, x: 8291, y: 6119 }, wrap: 0, groundRevision: 0 },
  ];

  test('changes with a tile’s terrain lift, and with terrain switching on or off', () => {
    const base = castersKey(tiles, 0);
    const lifted = castersKey([tiles[0], { ...tiles[1], groundRevision: 1 }], 0);
    expect(lifted).not.toBe(base);
    expect(castersKey(tiles, 1)).not.toBe(base);
    expect(castersKey(tiles, 0)).toBe(base);
  });

  test('changes with the drawn set and the world copy', () => {
    const base = castersKey(tiles, 0);
    expect(castersKey(tiles.slice(0, 1), 0)).not.toBe(base);
    expect(castersKey([{ ...tiles[0], wrap: 1 }, tiles[1]], 0)).not.toBe(base);
  });

  test('is a set: the same tiles in another order are the same key', () => {
    // The engine lists tiles nearest first, and an orbit reorders them every
    // frame; an ordered key redrew the shadow map on every frame of an orbit
    // (measured: docs/MAP_PERFORMANCE.md → hotspots).
    expect(castersKey([tiles[1], tiles[0]], 0)).toBe(castersKey(tiles, 0));
  });
});

describe('castsInto', () => {
  // Barcelona, the sun high in the south-west; a 1 km box round the centre.
  const center = { lng: 2.164, lat: 41.3925 };
  const frame = shadowFrame({
    sun: { azimuthDeg: 220, altitudeDeg: 45 },
    center,
    radiusM: 1000,
  });
  if (!frame) throw new Error('no shadow frame for a sun at 45°');
  const z15 = (lng: number, lat: number) => {
    const n = 2 ** 15;
    return {
      z: 15,
      x: Math.floor(mercatorXFromLng(lng) * n),
      y: Math.floor(mercatorYFromLat(lat) * n),
    };
  };

  test('the tile under the centre casts; one 10 km away does not', () => {
    expect(castsInto(frame, z15(center.lng, center.lat), 0, 0)).toBe(true);
    expect(castsInto(frame, z15(center.lng + 0.12, center.lat), 0, 0)).toBe(false);
    expect(castsInto(frame, z15(center.lng, center.lat + 0.09), 0, 0)).toBe(false);
  });

  test('another world copy of the centre tile does not', () => {
    expect(castsInto(frame, z15(center.lng, center.lat), 1, 0)).toBe(false);
  });
});

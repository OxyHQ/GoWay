/**
 * Published guided navigation: what a worker reports about where cameras stood
 * is reduced before it is stored, so no capture path survives publication.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  decimateViewpoints,
  MAX_PUBLISHED_VIEWPOINTS,
  MIN_VIEWPOINT_SPACING_METERS,
  publishedNavigation,
} from '../navigation';
import { sceneReconstructResultSchema, type SceneResultViewpoint } from '../workerContract';

const FIXTURE = resolve(__dirname, '../../../../reconstruction-worker/contract/fixtures/result.scene_reconstruct.json');
const result = () => sceneReconstructResultSchema.parse(JSON.parse(readFileSync(FIXTURE, 'utf8')));

function walk(count: number, step: number, x = 0): SceneResultViewpoint[] {
  return Array.from({ length: count }, (_, index) => ({ position: [x, index * step, 1.6], forward: [0, 3, 0] }));
}

function minimumSpacing(points: { position: [number, number, number] }[]): number {
  let minimum = Number.POSITIVE_INFINITY;
  for (const [i, a] of points.entries()) {
    for (const b of points.slice(i + 1)) {
      minimum = Math.min(minimum, Math.hypot(a.position[0] - b.position[0], a.position[1] - b.position[1], a.position[2] - b.position[2]));
    }
  }
  return minimum;
}

describe('viewpoint decimation', () => {
  it('keeps no two viewpoints closer than the minimum spacing', () => {
    const kept = decimateViewpoints(walk(41, 0.25));
    expect(kept.map((viewpoint) => viewpoint.position[1])).toEqual([0, 1.5, 3, 4.5, 6, 7.5, 9]);
    expect(minimumSpacing(kept)).toBeGreaterThanOrEqual(MIN_VIEWPOINT_SPACING_METERS);
  });

  it('rounds positions to centimetres and directions to unit length', () => {
    const [only] = decimateViewpoints([{ position: [1.23456, -0.004, 1.6049], forward: [0, 3, 4] }]);
    expect(only).toEqual({ position: [1.23, 0, 1.6], forward: [0, 0.6, 0.8] });
    expect(Object.is(only!.position[1], -0)).toBe(false);
  });

  it('depends on the set, not on the order it was reported in', () => {
    // Two contributors' interleaved walks, in capture order and in three other orders.
    const reported = [...walk(30, 0.4, 0), ...walk(30, 0.4, 3.2)];
    const expected = decimateViewpoints(reported);
    for (const order of [[...reported].reverse(), [...reported.slice(23), ...reported.slice(0, 23)], reported.filter((_, i) => i % 2).concat(reported.filter((_, i) => !(i % 2)))]) {
      expect(decimateViewpoints(order)).toEqual(expected);
    }
    const sorted = [...expected].sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1] || a.position[2] - b.position[2]);
    expect(expected).toEqual(sorted);
  });

  it('drops a viewpoint with no usable direction', () => {
    expect(decimateViewpoints([{ position: [0, 0, 0], forward: [0, 0, 0] }])).toEqual([]);
  });

  it('keeps at most the published cap, spread across the scene', () => {
    const grid: SceneResultViewpoint[] = [];
    for (let x = 0; x < 40; x += 1) for (let y = 0; y < 40; y += 1) grid.push({ position: [x * 2, y * 2, 0], forward: [1, 0, 0] });
    const kept = decimateViewpoints(grid);
    expect(kept).toHaveLength(MAX_PUBLISHED_VIEWPOINTS);
    expect(kept[0]!.position).toEqual([0, 0, 0]);
    expect(Math.max(...kept.map((viewpoint) => viewpoint.position[0]))).toBeGreaterThanOrEqual(76);
  });
});

describe('published navigation', () => {
  it('carries the fixture viewpoints and field of view, and nothing else', () => {
    const navigation = publishedNavigation(result());
    expect(Object.keys(navigation!).sort()).toEqual(['fieldOfView', 'viewpoints']);
    expect(navigation!.fieldOfView).toEqual({ horizontalDegrees: 66, verticalDegrees: 50 });
    expect(navigation!.viewpoints.length).toBeGreaterThan(1);
    expect(minimumSpacing(navigation!.viewpoints)).toBeGreaterThanOrEqual(MIN_VIEWPOINT_SPACING_METERS);
  });

  it('is absent for a worker that reported none', () => {
    const older = { ...result(), viewpoints: undefined, captureFieldOfView: undefined };
    expect(publishedNavigation(older)).toBeNull();
  });
});

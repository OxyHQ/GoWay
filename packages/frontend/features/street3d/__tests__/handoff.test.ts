import { describe, expect, test } from 'bun:test';
import type { StreetSceneSummary } from '@goway.to/sdk';

import {
  rememberSceneSummary,
  sceneSummary,
  setReturnBounds,
  takeReturnBounds,
  viewportForBounds,
} from '../handoff';

const summary = (id: string) => ({ id }) as StreetSceneSummary;

describe('handoff', () => {
  test('return bounds are consumed exactly once', () => {
    const bounds = { west: 2.17, south: 41.38, east: 2.18, north: 41.39 };
    setReturnBounds(bounds);
    expect(takeReturnBounds()).toEqual(bounds);
    expect(takeReturnBounds()).toBeNull();
  });

  test('summaries are remembered and bounded', () => {
    for (let index = 0; index < 60; index += 1) rememberSceneSummary(summary(`s${index}`));
    expect(sceneSummary('s59')?.id).toBe('s59');
    expect(sceneSummary('s0')).toBeUndefined();
  });
});

describe('viewportForBounds', () => {
  test('centres on the box', () => {
    const viewport = viewportForBounds(
      { west: 2, south: 41, east: 2.004, north: 41.003 },
      800,
      600,
    );
    expect(viewport.latitude).toBeCloseTo(41.0015, 6);
    expect(viewport.longitude).toBeCloseTo(2.002, 6);
  });

  test('a street-sized box opens at street zoom, and a tiny one is clamped', () => {
    const street = viewportForBounds(
      { west: 2.1705, south: 41.3797, east: 2.1745, north: 41.3825 },
      1280,
      800,
    );
    expect(street.zoom).toBeGreaterThan(15);
    expect(street.zoom).toBeLessThan(18);
    const tiny = viewportForBounds(
      { west: 2, south: 41, east: 2.000001, north: 41.000001 },
      1280,
      800,
    );
    expect(tiny.zoom).toBe(18);
  });

  test('a wider window fits a wider box at the same zoom', () => {
    const box = { west: 0, south: 0, east: 0.02, north: 0.005 };
    expect(viewportForBounds(box, 2000, 800).zoom).toBeGreaterThan(
      viewportForBounds(box, 600, 800).zoom,
    );
  });
});

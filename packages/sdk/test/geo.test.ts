import { describe, expect, it } from 'vitest';
import {
  boundsCenter,
  boundsOf,
  distanceMeters,
  isDegenerateBounds,
  isValidCoordinate,
  metersToPixels,
  projectToPixels,
  unwrappedEast,
} from '../src/geo';

describe('@goway.to/sdk/geo', () => {
  it('boxes the valid coordinates and ignores the rest', () => {
    expect(boundsOf([])).toBeNull();
    expect(
      boundsOf([
        { latitude: 41.38, longitude: 2.17 },
        { latitude: Number.NaN, longitude: 0 },
        { latitude: 41.4, longitude: 2.1 },
      ]),
    ).toEqual({ west: 2.1, south: 41.38, east: 2.17, north: 41.4 });
  });

  it('treats a box that crosses the antimeridian as the strip it describes', () => {
    const pacific = { west: 170, south: -20, east: -170, north: -10 };
    expect(unwrappedEast(pacific)).toBe(190);
    expect(boundsCenter(pacific)).toEqual({ latitude: -15, longitude: 180 });
    expect(isDegenerateBounds(pacific)).toBe(false);
    expect(boundsCenter({ west: 0, south: 0, east: 10, north: 10 })).toEqual({
      latitude: 5,
      longitude: 5,
    });
  });

  it('calls a box with no area degenerate, and a line of points not', () => {
    expect(isDegenerateBounds({ west: 2, south: 41, east: 2, north: 41 })).toBe(true);
    expect(isDegenerateBounds({ west: 2, south: 41, east: 3, north: 41 })).toBe(false);
  });

  it('rejects coordinates no engine can draw', () => {
    expect(isValidCoordinate({ latitude: 0, longitude: 0 })).toBe(true);
    expect(isValidCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 0, longitude: Number.POSITIVE_INFINITY })).toBe(false);
    expect(isValidCoordinate(null)).toBe(false);
  });

  it('measures on the sphere and projects onto the world pixel grid', () => {
    const bcn = { latitude: 41.3874, longitude: 2.1686 };
    const mad = { latitude: 40.4168, longitude: -3.7038 };
    expect(Math.round(distanceMeters(bcn, mad) / 1000)).toBe(505);
    expect(projectToPixels({ latitude: 0, longitude: 0 }, 0)).toEqual({ x: 256, y: 256 });
    expect(metersToPixels(0, 41, 12)).toBe(0);
  });
});

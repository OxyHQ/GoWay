import { describe, expect, test } from 'bun:test';
import type { Camera } from '@goway.to/sdk';

import {
  CAMERAS_MIN_ZOOM,
  cameraCredits,
  cameraIdOfMarker,
  cameraMarkers,
  centreOf,
  frameAgeSeconds,
  nearestCameras,
  shouldFetchCameras,
  snapshotSource,
} from '../cameraStyle';

const camera = (id: string, latitude: number, longitude: number, provider = 'a'): Camera => ({
  id,
  providerId: provider,
  name: `Camera ${id}`,
  kind: 'traffic',
  position: { latitude, longitude },
  heading: null,
  roadName: null,
  media: { kind: 'snapshot', refreshSeconds: 60, width: null, height: null },
  status: 'live',
  lastFrameAt: '2026-10-22T12:00:00.000Z',
  attribution: { label: `Source: ${provider}`, href: `https://${provider}.example/credit` },
  licence: { label: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
});

describe('shouldFetchCameras', () => {
  test('only at street scale, and never for a missing or non-finite zoom', () => {
    expect(shouldFetchCameras(CAMERAS_MIN_ZOOM)).toBe(true);
    expect(shouldFetchCameras(CAMERAS_MIN_ZOOM - 0.1)).toBe(false);
    expect(shouldFetchCameras(null)).toBe(false);
    expect(shouldFetchCameras(undefined)).toBe(false);
    expect(shouldFetchCameras(Number.NaN)).toBe(false);
  });
});

describe('centreOf', () => {
  test('is the middle of a box, and of one that crosses the antimeridian', () => {
    expect(centreOf({ west: 1, south: 40, east: 3, north: 42 })).toEqual({
      latitude: 41,
      longitude: 2,
    });
    expect(centreOf({ west: 170, south: -20, east: -170, north: -10 })).toEqual({
      latitude: -15,
      longitude: 180,
    });
  });
});

describe('nearestCameras', () => {
  const near = camera('near', 41.0, 2.0);
  const mid = camera('mid', 41.1, 2.1);
  const far = camera('far', 42.0, 3.0);

  test('spends the budget nearest the centre, nearest first, not on what sorts first by id', () => {
    const picked = nearestCameras([far, mid, near], { latitude: 41, longitude: 2 }, 2);
    expect(picked.map((c) => c.id)).toEqual(['near', 'mid']);
  });

  test('measures longitude by its true width: a degree is shorter far from the equator', () => {
    const north = { latitude: 70, longitude: 0 };
    const lonStep = camera('lon', 70, 1); // 1° of longitude at 70° N ≈ 38 km
    const latStep = camera('lat', 70.5, 0); // 0.5° of latitude ≈ 55 km
    expect(nearestCameras([latStep, lonStep], north, 1)[0]?.id).toBe('lon');
  });

  test('wraps across the antimeridian and never mutates its input', () => {
    const list = [camera('west', 0, -179.9), camera('east', 0, 179.9), camera('mid', 0, 0)];
    const before = list.map((c) => c.id);
    expect(
      nearestCameras(list, { latitude: 0, longitude: 180 }, 2)
        .map((c) => c.id)
        .sort(),
    ).toEqual(['east', 'west']);
    expect(list.map((c) => c.id)).toEqual(before);
  });

  test('a budget of zero draws nothing', () => {
    expect(nearestCameras([near], { latitude: 41, longitude: 2 }, 0)).toEqual([]);
  });
});

describe('markers', () => {
  test('a pin per camera, never clustered with places, with an accessible name', () => {
    const [marker] = cameraMarkers([camera('c1', 41, 2)], (c) => `Open ${c.name}`);
    expect(marker).toEqual({
      id: 'camera:c1',
      coordinate: { latitude: 41, longitude: 2 },
      kind: 'camera',
      accessibilityLabel: 'Open Camera c1',
    });
    expect(marker?.clustered).toBeUndefined();
  });

  test('reads the camera id back from its own marker only', () => {
    expect(cameraIdOfMarker({ id: 'camera:open-roads.cam-1', kind: 'camera' })).toBe(
      'open-roads.cam-1',
    );
    expect(cameraIdOfMarker({ id: 'camera:', kind: 'camera' })).toBeNull();
    expect(cameraIdOfMarker({ id: 'camera:x', kind: 'place' })).toBeNull();
    expect(cameraIdOfMarker({ id: 'place:x', kind: 'camera' })).toBeNull();
  });
});

describe('cameraCredits', () => {
  test('credits each provider once, with its licence, in first-seen order', () => {
    const credits = cameraCredits([
      camera('1', 0, 0, 'fintraffic'),
      camera('2', 0, 0, 'toronto'),
      camera('3', 0, 0, 'fintraffic'),
    ]);
    expect(credits).toEqual([
      { label: 'Source: fintraffic (CC BY 4.0)', href: 'https://fintraffic.example/credit' },
      { label: 'Source: toronto (CC BY 4.0)', href: 'https://toronto.example/credit' },
    ]);
  });

  test('owes nothing when nothing is drawn', () => {
    expect(cameraCredits([])).toEqual([]);
  });
});

describe('frameAgeSeconds', () => {
  const now = Date.parse('2026-10-22T12:03:00Z');

  test('is the age of the newest frame, never negative', () => {
    expect(frameAgeSeconds({ lastFrameAt: '2026-10-22T12:00:00.000Z' }, now)).toBe(180);
    expect(frameAgeSeconds({ lastFrameAt: '2026-10-22T12:05:00.000Z' }, now)).toBe(0);
  });

  test('is null when no frame has been seen, rather than a made-up age', () => {
    expect(frameAgeSeconds({ lastFrameAt: null }, now)).toBeNull();
    expect(frameAgeSeconds({ lastFrameAt: 'not a date' }, now)).toBeNull();
  });
});

describe('snapshotSource', () => {
  const base = 'https://api.goway.to/api/v1/cameras/c1/snapshot';

  test('changes address on the camera’s own beat, and not before', () => {
    const t0 = Date.parse('2026-10-22T12:00:00Z');
    expect(snapshotSource(base, 60, t0)).toBe(snapshotSource(base, 60, t0 + 59_000));
    expect(snapshotSource(base, 60, t0)).not.toBe(snapshotSource(base, 60, t0 + 60_000));
  });

  test('never beats faster than every five seconds', () => {
    const t0 = Date.parse('2026-10-22T12:00:00Z');
    expect(snapshotSource(base, 1, t0)).toBe(snapshotSource(base, 1, t0 + 4_000));
  });
});

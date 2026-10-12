/**
 * A map that has loaded has a settled camera, and the canvas reports it.
 *
 * goway.to's explore list sat on its row skeletons until the reader panned:
 * `useExplore` queries the first SETTLED camera, and the canvas reported a
 * settled camera only on `moveend`. The camera a map opens at fires its
 * `moveend` inside `new Map()`, before any listener, so the first report came
 * from whatever moved the camera next — in practice a container resize
 * (MapLibre's `resize()` fires `moveend`), which a window whose layout had
 * already settled never has. Headless Chromium on goway.to: no
 * `places/bounds` request in 45 s; one at once after a drag or a resize.
 *
 * Run against a fake engine that fires the events MapLibre fires, because the
 * real one needs WebGL. The rule itself (`loadedCamera.ts`) is the one the
 * native fork applies to MapLibre Native's view state.
 */
import { describe, expect, test } from 'bun:test';

import {
  attachCameraReports,
  type CameraEngine,
  MOVE_THROTTLE_MS,
  PROGRAMMATIC,
  PROGRAMMATIC_TRANSIENT,
} from '@/components/map/cameraReports.web';
import { loadedCameraChange } from '@/components/map/loadedCamera';
import type { MapViewportChange } from '@/components/map/types';

const BARCELONA = { lat: 41.4036, lng: 2.1744 };

function fakeEngine() {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const camera = { ...BARCELONA, zoom: 16.5, bearing: 30, pitch: 60 };
  let moving = false;
  const engine = {
    camera,
    setMoving(next: boolean) {
      moving = next;
    },
    fire(type: string, event: object = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ type, ...event });
    },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    on(type: string, listener: (event: unknown) => void) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)?.add(listener);
      return engine;
    },
    off(type: string, listener: (event: unknown) => void) {
      listeners.get(type)?.delete(listener);
      return engine;
    },
    getCenter: () => ({ lat: camera.lat, lng: camera.lng }),
    getBounds: () => ({
      getWest: () => 2.16,
      getSouth: () => 41.39,
      getEast: () => 2.19,
      getNorth: () => 41.41,
    }),
    getZoom: () => camera.zoom,
    getBearing: () => camera.bearing,
    getPitch: () => camera.pitch,
    isMoving: () => moving,
  };
  return engine;
}

function attach(engine: ReturnType<typeof fakeEngine>, withListener = true) {
  const changes: MapViewportChange[] = [];
  let clock = 0;
  const detach = attachCameraReports(
    engine as unknown as CameraEngine,
    () => (withListener ? (change: MapViewportChange) => changes.push(change) : undefined),
    () => clock,
  );
  return {
    changes,
    detach,
    advance(ms: number) {
      clock += ms;
    },
  };
}

describe('the web canvas reports the camera a loaded map opened at', () => {
  test('load, with no move at all, is a settled programmatic camera', () => {
    const engine = fakeEngine();
    const { changes } = attach(engine);

    engine.fire('load');

    expect(changes).toEqual([
      {
        viewport: { latitude: 41.4036, longitude: 2.1744, zoom: 16.5, bearing: 30, pitch: 60 },
        bounds: { west: 2.16, south: 41.39, east: 2.19, north: 41.41 },
        source: 'programmatic',
        isFinal: true,
      },
    ]);
  });

  test('a camera still moving at load is reported when it settles, not before', () => {
    const engine = fakeEngine();
    const { changes } = attach(engine);

    engine.setMoving(true);
    engine.fire('load');
    expect(changes.filter((change) => change.isFinal)).toEqual([]);

    engine.setMoving(false);
    engine.camera.lat = 41.39;
    engine.fire('moveend', PROGRAMMATIC);
    expect(changes.filter((change) => change.isFinal)).toHaveLength(1);
    expect(changes.at(-1)?.viewport.latitude).toBe(41.39);
    expect(changes.at(-1)?.source).toBe('programmatic');
  });

  test('a camera standing on a transient animation frame at load is not settled', () => {
    const engine = fakeEngine();
    const { changes } = attach(engine);

    // A flyover frame (`jumpTo` fires its `moveend` synchronously).
    engine.fire('move', PROGRAMMATIC_TRANSIENT);
    engine.fire('moveend', PROGRAMMATIC_TRANSIENT);
    engine.fire('load');
    expect(changes.filter((change) => change.isFinal)).toEqual([]);

    // The animation's closing, ordinary move is the settled camera.
    engine.fire('moveend', PROGRAMMATIC);
    expect(changes.filter((change) => change.isFinal)).toHaveLength(1);
  });

  test('the embed (no onViewportChange) hears nothing and costs nothing', () => {
    const engine = fakeEngine();
    const { changes, detach } = attach(engine, false);

    engine.fire('load');
    engine.fire('move', { originalEvent: {} });
    engine.fire('moveend', { originalEvent: {} });
    expect(changes).toEqual([]);

    detach();
    expect(engine.listenerCount()).toBe(0);
  });
});

describe('moves keep the guarantees they had', () => {
  test('a programmatic move never reads as the reader’s', () => {
    const engine = fakeEngine();
    const { changes } = attach(engine);

    engine.fire('load');
    engine.fire('moveend', PROGRAMMATIC);
    engine.fire('moveend', { originalEvent: {} });

    expect(changes.map((change) => change.source)).toEqual([
      'programmatic',
      'programmatic',
      'user',
    ]);
    expect(changes.every((change) => change.isFinal)).toBe(true);
  });

  test('a transient frame is reported live and never as settled', () => {
    const engine = fakeEngine();
    const { changes, advance } = attach(engine);

    advance(MOVE_THROTTLE_MS);
    engine.fire('move', PROGRAMMATIC_TRANSIENT);
    engine.fire('moveend', PROGRAMMATIC_TRANSIENT);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.isFinal).toBe(false);
  });

  test('live frames are throttled; a settle resets the throttle', () => {
    const engine = fakeEngine();
    const { changes, advance } = attach(engine);

    advance(MOVE_THROTTLE_MS);
    engine.fire('move', { originalEvent: {} });
    engine.fire('move', { originalEvent: {} });
    expect(changes).toHaveLength(1);

    engine.fire('moveend', { originalEvent: {} });
    engine.fire('move', { originalEvent: {} });
    expect(changes.map((change) => change.isFinal)).toEqual([false, true, false]);
  });

  test('a camera the engine cannot read is dropped, not thrown', () => {
    const engine = fakeEngine();
    const { changes } = attach(engine);
    engine.getCenter = () => {
      throw new Error('Invalid LngLat object: (NaN, NaN)');
    };

    expect(() => engine.fire('load')).not.toThrow();
    expect(changes).toEqual([]);
  });
});

describe('the rule both forks apply (loadedCamera.ts)', () => {
  const reading = {
    viewport: { latitude: 1, longitude: 2, zoom: 3, bearing: 0, pitch: 0 },
    bounds: { west: 1, south: 0, east: 3, north: 2 },
  };

  test('a loaded, resting camera is a settled programmatic change', () => {
    expect(loadedCameraChange(reading, { moving: false, transient: false })).toEqual({
      ...reading,
      source: 'programmatic',
      isFinal: true,
    });
  });

  test('a moving camera or a transient frame is left to its own settle', () => {
    expect(loadedCameraChange(reading, { moving: true, transient: false })).toBeNull();
    expect(loadedCameraChange(reading, { moving: false, transient: true })).toBeNull();
  });
});

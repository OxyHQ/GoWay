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
 * The web reports run against a fake engine that fires the events MapLibre
 * fires (`fakeCameraEngine.ts`); the native ones are in
 * `nativeCameraReports.test.ts`; both apply `loadedCamera.ts`. The last block
 * reads the two canvases, because a React Native component does not render
 * under Bun: it fails when either canvas stops handing its engine's load to
 * the reports.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  MOVE_THROTTLE_MS,
  PROGRAMMATIC,
  PROGRAMMATIC_TRANSIENT,
  isContainerResize,
  moveSourceOf,
} from '@/components/map/cameraReports.web';
import {
  type CameraReading,
  createLoadedCameraReporter,
  loadedCameraChange,
} from '@/components/map/loadedCamera';
import { runEngineCommand } from '@/components/map/shared';
import type { MapViewportChange } from '@/components/map/types';

import { attachToFake, fakeCameraEngine } from './fakeCameraEngine';

/** What MapLibre's ResizeObserver hands `resize()`; Bun has no DOM to supply one. */
class FakeResizeObserverEntry {}
const globals = globalThis as { ResizeObserverEntry?: unknown };
const hadEntry = 'ResizeObserverEntry' in globals;
beforeAll(() => {
  if (!hadEntry) globals.ResizeObserverEntry = FakeResizeObserverEntry;
});
afterAll(() => {
  if (!hadEntry) delete globals.ResizeObserverEntry;
});
/** The event data of a container resize: MapLibre passes the observer's entries. */
const containerResize = () => {
  const Entry = globals.ResizeObserverEntry as new () => object;
  return { 0: Object.create(Entry.prototype) as object };
};

describe('the web canvas reports the camera a loaded map opened at', () => {
  test('load, with no move at all, is a settled programmatic camera', () => {
    const engine = fakeCameraEngine();
    const { changes } = attachToFake(engine);

    engine.fire('load');

    expect(changes).toHaveLength(1);
    expect(changes[0]?.source).toBe('programmatic');
    expect(changes[0]?.isFinal).toBe(true);
    expect(changes[0]?.viewport).toEqual({
      latitude: 41.4036,
      longitude: 2.1744,
      zoom: 16.5,
      bearing: 30,
      pitch: 60,
    });
    expect(changes[0]?.bounds.west).toBeCloseTo(2.1644, 9);
    expect(changes[0]?.bounds.north).toBeCloseTo(41.4136, 9);
  });

  test('once per engine: a second load event reports nothing', () => {
    const engine = fakeCameraEngine();
    const { finals } = attachToFake(engine);

    engine.fire('load');
    engine.fire('load');

    expect(finals()).toHaveLength(1);
  });

  test('a camera still moving at load is reported when it settles, not before', () => {
    const engine = fakeCameraEngine();
    const { finals } = attachToFake(engine);

    engine.fire('movestart', PROGRAMMATIC);
    engine.fire('load');
    expect(finals()).toEqual([]);

    engine.camera.lat = 41.39;
    engine.fire('moveend', PROGRAMMATIC);
    expect(finals()).toHaveLength(1);
    expect(finals()[0]?.viewport.latitude).toBe(41.39);
    expect(finals()[0]?.source).toBe('programmatic');
  });

  test('a camera standing on a transient animation frame at load is not settled', () => {
    const engine = fakeCameraEngine();
    const { finals } = attachToFake(engine);

    // A flyover frame (`jumpTo` fires its whole move synchronously).
    engine.move(PROGRAMMATIC_TRANSIENT);
    engine.fire('load');
    expect(finals()).toEqual([]);

    // The animation's closing, ordinary move is the settled camera.
    engine.move(PROGRAMMATIC);
    expect(finals()).toHaveLength(1);
  });

  test('a command that settled before load does not stop the load report', () => {
    const engine = fakeCameraEngine();
    const { finals } = attachToFake(engine);

    engine.move(PROGRAMMATIC, { lat: 35.68, lng: 139.76 });
    engine.fire('load');

    expect(finals().map((change) => change.viewport.latitude)).toEqual([35.68, 35.68]);
  });

  test('the embed (no onViewportChange) hears nothing and costs nothing', () => {
    const engine = fakeCameraEngine();
    const { changes, detach } = attachToFake(engine, false);

    engine.fire('load');
    engine.move({ originalEvent: {} });
    expect(changes).toEqual([]);

    detach();
    expect(engine.listenerCount()).toBe(0);
  });
});

describe('moves keep the guarantees they had', () => {
  test('a programmatic move never reads as the reader’s', () => {
    const engine = fakeCameraEngine();
    const { finals } = attachToFake(engine);

    engine.fire('load');
    engine.move(PROGRAMMATIC);
    engine.move({ originalEvent: {} });

    expect(finals().map((change) => change.source)).toEqual([
      'programmatic',
      'programmatic',
      'user',
    ]);
  });

  test('a container resize is not the reader’s move', () => {
    const engine = fakeCameraEngine();
    const { changes, advance } = attachToFake(engine);
    advance(MOVE_THROTTLE_MS);

    // MapLibre's ResizeObserver → `resize(entries)`: movestart, move, resize, moveend.
    engine.move(containerResize(), { span: 0.02 });

    expect(isContainerResize(containerResize())).toBe(true);
    expect(isContainerResize({ originalEvent: {} })).toBe(false);
    expect(moveSourceOf({})).toBe('user');
    expect(changes.map((change) => [change.source, change.isFinal])).toEqual([
      ['programmatic', false],
      ['programmatic', true],
    ]);
  });

  test('a transient frame is reported live and never as settled', () => {
    const engine = fakeCameraEngine();
    const { changes, advance } = attachToFake(engine);

    advance(MOVE_THROTTLE_MS);
    engine.move(PROGRAMMATIC_TRANSIENT);

    expect(changes).toHaveLength(1);
    expect(changes[0]?.isFinal).toBe(false);
  });

  test('live frames are throttled; a settle resets the throttle', () => {
    const engine = fakeCameraEngine();
    const { changes, advance } = attachToFake(engine);

    advance(MOVE_THROTTLE_MS);
    engine.fire('move', { originalEvent: {} });
    engine.fire('move', { originalEvent: {} });
    expect(changes).toHaveLength(1);

    engine.fire('moveend', { originalEvent: {} });
    engine.fire('move', { originalEvent: {} });
    expect(changes.map((change) => change.isFinal)).toEqual([false, true, false]);
  });

  test('a camera the engine cannot read is dropped, not thrown', () => {
    const engine = fakeCameraEngine();
    const { changes } = attachToFake(engine);
    engine.getCenter = () => {
      throw new Error('Invalid LngLat object: (NaN, NaN)');
    };

    expect(() => engine.fire('load')).not.toThrow();
    expect(changes).toEqual([]);
  });
});

describe('the rule both forks apply (loadedCamera.ts)', () => {
  const reading: CameraReading = {
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

  test('an asynchronous read is dropped when a move started or ended meanwhile', async () => {
    for (const between of [
      (reporter: ReturnType<typeof createLoadedCameraReporter>) => reporter.moveStarted(),
      (reporter: ReturnType<typeof createLoadedCameraReporter>) => {
        reporter.moveStarted();
        reporter.moveEnded(false);
      },
    ]) {
      const reporter = createLoadedCameraReporter();
      const changes: MapViewportChange[] = [];
      let answer: (value: CameraReading) => void = () => {};
      reporter.loaded(
        () => new Promise<CameraReading>((resolve) => (answer = resolve)),
        () => (change) => changes.push(change),
      );
      between(reporter);
      answer(reading);
      await Promise.resolve();
      expect(changes).toEqual([]);
    }
  });

  test('an asynchronous read nothing interrupted is reported', async () => {
    const reporter = createLoadedCameraReporter();
    const changes: MapViewportChange[] = [];
    reporter.loaded(
      async () => reading,
      () => (change) => changes.push(change),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(changes).toHaveLength(1);
  });
});

describe('runEngineCommand answers whether the command ran', () => {
  test('true when it ran, false when the engine threw', () => {
    expect(runEngineCommand('test', () => {})).toBe(true);
    expect(
      runEngineCommand('test', () => {
        throw new Error('Invalid LngLat object: (NaN, NaN)');
      }),
    ).toBe(false);
  });
});

describe('wired on both canvases', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');

  test('the web canvas attaches the reports to every engine it builds, and detaches them', () => {
    const web = read('MapCanvas.web.tsx');
    const effect = web.slice(web.indexOf('map = new maplibregl.Map('));
    expect(effect).toMatch(
      /const detachCameraReports = attachCameraReports\(\s*map,\s*\(\) => handlers\.current\.onViewportChange,?\s*\);/,
    );
    const cleanup = effect.slice(effect.indexOf("map.on('error', handleError);"));
    expect(cleanup).toMatch(/return \(\) => \{\s*detachCameraReports\(\);/);
  });

  test('the native canvas hands the style load and every region event to its reports', () => {
    const native = read('MapCanvas.native.tsx');
    const loaded = native.slice(native.indexOf('const handleStyleLoaded = useCallback('));
    const body = loaded.slice(0, loaded.indexOf('\n  }, ['));
    expect(body).toContain('cameraReports.current?.loaded(');
    expect(body).toContain('return map.getViewState();');
    expect(native).toContain(
      'onRegionWillChange={(event) => cameraReports.current?.regionWillChange(event.nativeEvent)}',
    );
    expect(native).toContain('cameraReports.current?.regionIsChanging(event.nativeEvent);');
    expect(native).toContain('cameraReports.current?.regionDidChange(event.nativeEvent)');
    expect(native).toContain('cameraReports.current?.commanded(options?.transient === true);');
    expect(native).toContain('onDidFinishLoadingStyle={handleStyleLoaded}');
  });

  test('every native camera command declares whether it is a transient frame', () => {
    const native = read('MapCanvas.native.tsx');
    const api = native.slice(native.indexOf('      moveTo(target, options) {'));
    for (const command of [
      'fitBounds(bounds, options) {',
      'setBearing(bearing, options) {',
      'resetNorth(options) {',
    ]) {
      const body = api.slice(api.indexOf(command));
      const end = body.indexOf('\n      },');
      expect(body.slice(0, end)).toContain('cameraReports.current?.commanded(false);');
    }
  });

  test('moveTo answers whether it issued a move, on both canvases', () => {
    for (const [file, engine] of [
      ['MapCanvas.web.tsx', 'map'],
      ['MapCanvas.native.tsx', 'camera'],
    ] as const) {
      const source = read(file);
      const start = source.indexOf('      moveTo(target, options) {');
      const body = source.slice(start, source.indexOf('      fitBounds(bounds, options) {', start));
      // No engine, and an undrawable target: nothing issued.
      expect(body).toContain(`if (!${engine}) return false;`);
      expect(body.match(/return false;/g)).toHaveLength(2);
      // Otherwise the engine command's own answer (`false` when it threw).
      expect(body).toMatch(/return runEngineCommand\('jumpTo'/);
      expect(body).toMatch(/return runEngineCommand\('easeTo'/);
    }
    expect(read('MapCanvas.tsx')).toContain('moveTo: () => false,');
  });

  test('a native retry (a remounted engine) gets new reports', () => {
    const native = read('MapCanvas.native.tsx');
    const retry = native.slice(native.indexOf('const retry = useCallback('));
    const body = retry.slice(0, retry.indexOf('\n  }, ['));
    expect(body).toContain(
      'cameraReports.current = createNativeCameraReports(() => viewportListener.current);',
    );
    expect(body).toContain('setReloadKey((key) => key + 1);');
  });
});

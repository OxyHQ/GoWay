/**
 * `@goway.to/maps/testing` — drive the map's REAL camera reports without a GPU.
 *
 * What a screen does with `onCameraChanged` (arm "Search this area", commit a
 * box, pause a tour) is the screen's logic, and the sequences that matter —
 * the opening camera, a programmatic frame, the reader's drag — are the ones a
 * loading map produces. `fakeCameraEngine` is a MapLibre map as far as the
 * reports see it (the events it fires and the camera it reads; the real one
 * needs WebGL), and `attachToFake` runs the SDK's own web reporting on it.
 *
 *     const engine = fakeCameraEngine({ lat: 41.39, lng: 2.17, zoom: 11 });
 *     const reports = attachToFake(engine);
 *     engine.fire('load');
 *     engine.move({ originalEvent: {} }, { lng: 2.2 });   // the reader drags
 *     engine.move(PROGRAMMATIC, { zoom: 14 });            // the app frames
 */
import { attachCameraReports, type CameraEngine } from './cameraReports.web';
import type { MapCameraChange } from './types';

export { PROGRAMMATIC, PROGRAMMATIC_TRANSIENT } from './cameraReports.web';

export interface FakeCamera {
  lat: number;
  lng: number;
  zoom: number;
  bearing: number;
  pitch: number;
  /** Half the box's height and width, in degrees: a bigger container, a bigger box. */
  span: number;
}

export function fakeCameraEngine(start: Partial<FakeCamera> = {}) {
  const listeners = new Map<string, Set<(event: unknown) => void>>();
  const camera: FakeCamera = {
    lat: 41.4036,
    lng: 2.1744,
    zoom: 16.5,
    bearing: 30,
    pitch: 60,
    span: 0.01,
    ...start,
  };
  const engine = {
    camera,
    fire(type: string, event: object = {}) {
      for (const listener of listeners.get(type) ?? []) listener({ type, ...event });
    },
    /** A whole camera move, as MapLibre fires it, ending wherever `to` says. */
    move(event: object, to: Partial<FakeCamera> = {}) {
      engine.fire('movestart', event);
      Object.assign(camera, to);
      engine.fire('move', event);
      engine.fire('moveend', event);
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
      getWest: () => camera.lng - camera.span,
      getSouth: () => camera.lat - camera.span,
      getEast: () => camera.lng + camera.span,
      getNorth: () => camera.lat + camera.span,
    }),
    getZoom: () => camera.zoom,
    getBearing: () => camera.bearing,
    getPitch: () => camera.pitch,
  };
  return engine;
}

export type FakeCameraEngine = ReturnType<typeof fakeCameraEngine>;

/** Attach the real reports to a fake engine; `withListener: false` is the embed. */
export function attachToFake(engine: FakeCameraEngine, withListener = true) {
  const changes: MapCameraChange[] = [];
  let clock = 0;
  const detach = attachCameraReports(
    engine as unknown as CameraEngine,
    () => (withListener ? (change: MapCameraChange) => changes.push(change) : undefined),
    () => clock,
  );
  return {
    changes,
    detach,
    finals: () => changes.filter((change) => change.isFinal),
    advance(ms: number) {
      clock += ms;
    },
  };
}

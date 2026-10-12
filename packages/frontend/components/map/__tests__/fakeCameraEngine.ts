/**
 * A MapLibre map as far as `attachCameraReports` sees it: events it fires and
 * the camera it reads. The real one needs WebGL.
 */
import { attachCameraReports, type CameraEngine } from '@/components/map/cameraReports.web';
import type { MapViewportChange } from '@/components/map/types';

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
    finals: () => changes.filter((change) => change.isFinal),
    advance(ms: number) {
      clock += ms;
    },
  };
}

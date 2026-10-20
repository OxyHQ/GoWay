/**
 * The camera, for the pieces of a map that draw FROM it — the scale bar and
 * the location puck's accuracy halo.
 *
 * A camera move reports at 10 Hz, and nothing around the map should re-render
 * for it. So `MapView` owns one store, feeds it from the engine's camera
 * reports, and every reader subscribes through {@link useMapCamera}, which
 * re-renders it only when ITS value changed. The store is fed whether or not
 * the app passed `onCameraChanged`: an embed with no listener still has a
 * scale bar.
 */
import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

import type { MapCameraChange, ResolvedMapViewport } from './types';

export class MapCameraStore {
  private viewport: ResolvedMapViewport | null = null;
  private readonly listeners = new Set<() => void>();
  private caller: ((change: MapCameraChange) => void) | undefined;

  /** The app's own `onCameraChanged`, set by `MapView` after render. */
  setCaller(caller: ((change: MapCameraChange) => void) | undefined) {
    this.caller = caller;
  }

  /** What the engine is given: this store first, then the app's listener. */
  readonly forward = (change: MapCameraChange) => {
    this.viewport = change.viewport;
    for (const listener of this.listeners) listener();
    this.caller?.(change);
  };

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = () => this.viewport;
}

/** Provided by `MapView`; `null` outside one. */
export const MapCameraContext = createContext<MapCameraStore | null>(null);

const NO_SUBSCRIPTION = () => () => {};

/**
 * A value derived from the camera, re-rendering only when it changes.
 *
 * `select` is read on every report, so it must be cheap and pure; `same` says
 * when two results are the same value (default `Object.is`). Outside a
 * `MapView`, `select(null)`.
 */
export function useMapCamera<T>(
  select: (viewport: ResolvedMapViewport | null) => T,
  same: (a: T, b: T) => boolean = Object.is,
): T {
  const store = useContext(MapCameraContext);
  const last = useRef<{ value: T } | null>(null);
  const getSnapshot = () => {
    const next = select(store ? store.get() : null);
    if (last.current && same(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store ? store.subscribe : NO_SUBSCRIPTION, getSnapshot, getSnapshot);
}

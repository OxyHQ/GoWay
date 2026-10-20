/**
 * The camera, for the few pieces of chrome that draw FROM it — the scale bar
 * and the location puck.
 *
 * A camera move reports at 10 Hz, and the screen around the map must not
 * re-render for it (`docs/MAP_PERFORMANCE.md`). So the canvas hands `forward`
 * to its engine as the viewport listener — it tells this store first and the
 * caller second — and each piece subscribes through {@link useCameraValue},
 * which re-renders it only when ITS value changed. Because `forward` is always
 * the listener, the engine reports the camera even to a caller that passed no
 * `onViewportChange` (the embed), which is exactly when a scale bar is wanted.
 */
import { useLayoutEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { MapViewportChange, ResolvedMapViewport } from './types';

export class MapCameraStore {
  private viewport: ResolvedMapViewport | null = null;
  private readonly listeners = new Set<() => void>();

  report({ viewport }: MapViewportChange) {
    this.viewport = viewport;
    for (const listener of this.listeners) listener();
  }

  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = () => this.viewport;

  private caller: ((change: MapViewportChange) => void) | undefined;

  /** The caller's own listener, set by {@link useMapCameraFeed} after render. */
  setCaller(caller: ((change: MapViewportChange) => void) | undefined) {
    this.caller = caller;
  }

  /** What the engine is given: this store first, then the caller. */
  readonly forward = (change: MapViewportChange) => {
    this.report(change);
    this.caller?.(change);
  };
}

/** The store, and the viewport listener that feeds it and then the caller's. */
export function useMapCameraFeed(
  onViewportChange: ((change: MapViewportChange) => void) | undefined,
) {
  const store = useMemo(() => new MapCameraStore(), []);
  // Read by the engine's listeners, never during render.
  useLayoutEffect(() => {
    store.setCaller(onViewportChange);
  }, [store, onViewportChange]);
  return { store, forward: store.forward };
}

/**
 * A value derived from the camera, re-rendering only when it changes.
 *
 * `select` is read on every report, so it must be cheap and pure; `same` says
 * when two results are the same value (default: `Object.is`).
 */
export function useCameraValue<T>(
  store: MapCameraStore,
  select: (viewport: ResolvedMapViewport | null) => T,
  same: (a: T, b: T) => boolean = Object.is,
): T {
  const last = useRef<{ value: T } | null>(null);
  const getSnapshot = () => {
    const next = select(store.get());
    if (last.current && same(last.current.value, next)) return last.current.value;
    last.current = { value: next };
    return next;
  };
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

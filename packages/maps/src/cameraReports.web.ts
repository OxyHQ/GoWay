/**
 * The web canvas's camera reports: MapLibre's `load`, `movestart`, `move` and
 * `moveend` turned into `MapViewProps.onCameraChanged`.
 *
 * Its own module so it runs against a fake engine in a test (the real one
 * needs WebGL); `MapCanvas.web.tsx` attaches it to every map it builds.
 *
 *  - `load`: the camera the map opened at, by the rule both forks share
 *    (`loadedCamera.ts`).
 *  - `move`: the live camera, throttled, never settled.
 *  - `moveend`: a settled camera, unless it ends a frame of a caller-driven
 *    animation (`MapCameraOptions.transient`), which `move` already reported.
 *
 * `source` comes from the marker GoWay puts on its own camera commands: a
 * marked move is `programmatic` and never arms "Search this area"; so is a
 * container resize (`moveSourceOf`).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

import { type CameraReading, createLoadedCameraReporter } from './loadedCamera';
import { PROGRAMMATIC, PROGRAMMATIC_TRANSIENT } from './moveMarkers';
import { runEngineCommand } from './shared';

export { PROGRAMMATIC, PROGRAMMATIC_TRANSIENT };
import type { MapMoveSource, MapCameraChange } from './types';

/** Streaming viewport updates while a drag is in progress. */
export const MOVE_THROTTLE_MS = 100;

/**
 * Who moved the camera: GoWay (a marked command), the engine itself because
 * its container changed size, or — anything else — the reader.
 *
 * A container resize keeps the centre and zoom and changes only how much is
 * on screen; nobody chose it, so it must neither arm "Search this area" nor
 * end what a reader's move ends (a landmark tour).
 */
export function moveSourceOf(event: unknown): MapMoveSource {
  const marked = event as { gowayProgrammatic?: unknown } | null | undefined;
  if (marked?.gowayProgrammatic === true) return 'programmatic';
  return isContainerResize(event) ? 'programmatic' : 'user';
}

/**
 * A move MapLibre made because its container was resized. Its ResizeObserver
 * hands the observer's entries to `resize()` as the event data, so the move's
 * events carry them — the test MapLibre's own GeolocateControl uses
 * (`event[0] instanceof ResizeObserverEntry`).
 */
export function isContainerResize(event: unknown): boolean {
  if (typeof ResizeObserverEntry === 'undefined') return false;
  return (event as { 0?: unknown } | null | undefined)?.[0] instanceof ResizeObserverEntry;
}

/** A camera move a pointer, wheel, key or touch caused (MapLibre attaches it). */
export function isGestureMove(event: unknown): boolean {
  return (event as { originalEvent?: unknown } | null | undefined)?.originalEvent != null;
}

export function isTransientMove(event: unknown): boolean {
  return (event as { gowayTransient?: unknown } | null | undefined)?.gowayTransient === true;
}

/** The part of a MapLibre map the reports read and listen to. */
export type CameraEngine = Pick<
  MapLibreMap,
  'on' | 'off' | 'getCenter' | 'getBounds' | 'getZoom' | 'getBearing' | 'getPitch'
>;

/**
 * Report `map`'s camera to whatever `listener()` answers at the time — `null`
 * for a caller with no `onCameraChanged` (the embed), which costs nothing.
 * Returns the detach.
 */
export function attachCameraReports(
  map: CameraEngine,
  listener: () => ((change: MapCameraChange) => void) | null | undefined,
  now: () => number = Date.now,
): () => void {
  let lastMoveReport = 0;
  // This engine's one loaded-camera report (`loadedCamera.ts`). A command
  // issued before `load` starts and ends its move before `load` too (`jumpTo`
  // fires both synchronously; `easeTo` is still moving), so the reporter knows
  // at `load` whether the camera is settled.
  const loaded = createLoadedCameraReporter();

  // `getCenter`/`getBounds` BUILD `LngLat`s out of the live transform, so a
  // camera that has gone non-finite throws HERE — and this runs from the
  // engine's own `move` event, which `jumpTo` fires synchronously inside
  // whatever effect commanded it. Not reporting a viewport is a stale
  // "Search this area"; throwing is the error boundary.
  const read = (): CameraReading | null => {
    let reading: CameraReading | null = null;
    runEngineCommand('getViewport', () => {
      const center = map.getCenter();
      const bounds = map.getBounds();
      reading = {
        viewport: {
          latitude: center.lat,
          longitude: center.lng,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        },
        bounds: {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        },
      };
    });
    return reading;
  };

  const report = (changeOf: (reading: CameraReading) => MapCameraChange | null) => {
    const change = listener();
    if (!change) return;
    const reading = read();
    if (!reading) return;
    const next = changeOf(reading);
    if (next) change(next);
  };

  const handleLoad = () => loaded.loaded(read, listener);

  const handleMoveStart = () => loaded.moveStarted();

  const handleMove = (event: unknown) => {
    const at = now();
    if (at - lastMoveReport < MOVE_THROTTLE_MS) return;
    lastMoveReport = at;
    report((reading) => ({ ...reading, source: moveSourceOf(event), isFinal: false }));
  };

  const handleMoveEnd = (event: unknown) => {
    const transient = isTransientMove(event);
    loaded.moveEnded(transient);
    if (transient) return;
    lastMoveReport = 0;
    report((reading) => ({ ...reading, source: moveSourceOf(event), isFinal: true }));
  };

  map.on('load', handleLoad);
  map.on('movestart', handleMoveStart);
  map.on('move', handleMove);
  map.on('moveend', handleMoveEnd);
  return () => {
    map.off('load', handleLoad);
    map.off('movestart', handleMoveStart);
    map.off('move', handleMove);
    map.off('moveend', handleMoveEnd);
  };
}

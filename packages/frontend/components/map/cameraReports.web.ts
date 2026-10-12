/**
 * The web canvas's camera reports: MapLibre's `load`, `move` and `moveend`
 * turned into `MapCanvasProps.onViewportChange`.
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
 * marked move is `programmatic` and never arms "Search this area".
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

import { type CameraReading, loadedCameraChange } from './loadedCamera';
import { runEngineCommand } from './shared';
import type { MapMoveSource, MapViewportChange } from './types';

/**
 * Marker put on every camera COMMAND GoWay issues, read back off the event.
 *
 * Marking our own commands (rather than sniffing for a DOM `originalEvent`) is
 * the safer direction of failure: a command somebody forgets to mark reads as a
 * user gesture, so "Search this area" appears once when it need not have. The
 * alternative — treat anything unrecognised as programmatic — hides the button
 * for good and looks like the feature was never built.
 */
export const PROGRAMMATIC = { gowayProgrammatic: true } as const;

/**
 * One frame of a caller-driven animation (`MapCameraOptions.transient`): a
 * programmatic move whose `moveend` is not a settled camera.
 */
export const PROGRAMMATIC_TRANSIENT = { gowayProgrammatic: true, gowayTransient: true } as const;

/** Streaming viewport updates while a drag is in progress. */
export const MOVE_THROTTLE_MS = 100;

export function moveSourceOf(event: unknown): MapMoveSource {
  const marked = event as { gowayProgrammatic?: unknown } | null | undefined;
  return marked?.gowayProgrammatic === true ? 'programmatic' : 'user';
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
  'on' | 'off' | 'getCenter' | 'getBounds' | 'getZoom' | 'getBearing' | 'getPitch' | 'isMoving'
>;

/**
 * Report `map`'s camera to whatever `listener()` answers at the time — `null`
 * for a caller with no `onViewportChange` (the embed), which costs nothing.
 * Returns the detach.
 */
export function attachCameraReports(
  map: CameraEngine,
  listener: () => ((change: MapViewportChange) => void) | null | undefined,
  now: () => number = Date.now,
): () => void {
  let lastMoveReport = 0;
  // Whether the camera stands on a frame of a caller-driven animation: the
  // last move to END says so. A command issued before `load` ends its move
  // before `load` too (`jumpTo` fires `moveend` synchronously), so this is
  // right at `load` as well.
  let onTransientFrame = false;

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

  const report = (changeOf: (reading: CameraReading) => MapViewportChange | null) => {
    const change = listener();
    if (!change) return;
    const reading = read();
    if (!reading) return;
    const next = changeOf(reading);
    if (next) change(next);
  };

  const handleLoad = () => {
    report((reading) =>
      loadedCameraChange(reading, { moving: map.isMoving(), transient: onTransientFrame }),
    );
  };

  const handleMove = (event: unknown) => {
    const at = now();
    if (at - lastMoveReport < MOVE_THROTTLE_MS) return;
    lastMoveReport = at;
    report((reading) => ({ ...reading, source: moveSourceOf(event), isFinal: false }));
  };

  const handleMoveEnd = (event: unknown) => {
    onTransientFrame = isTransientMove(event);
    if (onTransientFrame) return;
    lastMoveReport = 0;
    report((reading) => ({ ...reading, source: moveSourceOf(event), isFinal: true }));
  };

  map.on('load', handleLoad);
  map.on('move', handleMove);
  map.on('moveend', handleMoveEnd);
  return () => {
    map.off('load', handleLoad);
    map.off('move', handleMove);
    map.off('moveend', handleMoveEnd);
  };
}

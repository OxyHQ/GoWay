/**
 * The native canvas's camera reports: MapLibre Native's region events and its
 * style load turned into `MapCanvasProps.onViewportChange`.
 *
 * The counterpart of `cameraReports.web.ts`, kept free of React Native so it
 * runs in a test; `MapCanvas.native.tsx` creates one per engine (a retry
 * remounts the engine and creates another) and forwards the engine's events.
 *
 *  - `onRegionIsChanging`: the live camera, never settled.
 *  - `onRegionDidChange`: a settled camera, unless the move was a frame of a
 *    caller-driven animation (`MapCameraOptions.transient`).
 *  - the style load: the camera the map opened at, by the rule both forks
 *    share (`loadedCamera.ts`), read with `getViewState()`.
 *
 * And the SETTLED VIEW for whatever follows what is on screen (the imagery
 * credit, `useImageryCredits`): every style load's `getViewState()` — the
 * same read — and every settled region change. Unlike the viewport report it
 * is not once per engine (a style switched to satellite under the same engine
 * must be credited at once) and does not wait for a caller's listener (the
 * embed passes none and is credited all the same).
 *
 * `source` is the engine's own answer: MapLibre Native says whether a finger
 * caused the change, so GoWay never infers it from a marker on the command.
 */
import { type CameraReading, createLoadedCameraReporter } from './loadedCamera';
import type { MapViewportChange } from './types';

/** MapLibre Native's `ViewState`, structurally (`center` and `bounds` in MapLibre order). */
export interface NativeViewState {
  center: readonly [number, number];
  zoom: number;
  bearing: number;
  pitch: number;
  bounds: readonly [number, number, number, number];
}

/** A region event's payload (`ViewStateChangeEvent`). */
export interface NativeRegionChange extends NativeViewState {
  userInteraction: boolean;
}

/** MapLibre Native's view state, in GoWay's terms. */
export function cameraReadingOf(view: NativeViewState): CameraReading {
  const [west, south, east, north] = view.bounds;
  return {
    viewport: {
      latitude: view.center[1],
      longitude: view.center[0],
      zoom: view.zoom,
      bearing: view.bearing,
      pitch: view.pitch,
    },
    bounds: { west, south, east, north },
  };
}

export interface NativeCameraReports {
  /** GoWay commanded the camera; `transient` for one frame of a caller-driven animation. */
  commanded(transient: boolean): void;
  regionWillChange(region: NativeRegionChange): void;
  regionIsChanging(region: NativeRegionChange): void;
  /** `true` when the change was a settled camera, `false` for a transient frame. */
  regionDidChange(region: NativeRegionChange): boolean;
  /** The style finished loading; only the engine's first load reports. */
  loaded(getViewState: () => Promise<NativeViewState>): void;
}

export function createNativeCameraReports(
  listener: () => ((change: MapViewportChange) => void) | null | undefined,
  viewListener: () => ((view: NativeViewState) => void) | null | undefined = () => null,
): NativeCameraReports {
  const loadedReport = createLoadedCameraReporter();
  // Bumped by every settled region change, so a style load's view read that
  // lands after one does not put back the camera it replaced.
  let settledViews = 0;
  // A frame of a caller-driven animation is not a settled camera. The flag is
  // the latest COMMAND's: every camera command declares it, and a move the
  // reader starts ends it — a flyover the reader interrupted, or one that
  // stopped without its closing ordinary move, leaves nothing behind, so the
  // reader's settles are final again (on the web the marker is per event).
  // Not cleared at every move start: a flyover's frames cross the bridge as
  // commands ahead of their region events, so the next command's flag can
  // already be set when the previous frame's move starts.
  let transientCommand = false;

  const report = (region: NativeRegionChange, isFinal: boolean) => {
    listener()?.({
      ...cameraReadingOf(region),
      source: region.userInteraction ? 'user' : 'programmatic',
      isFinal,
    });
  };

  return {
    commanded(transient) {
      transientCommand = transient;
    },
    regionWillChange(region) {
      if (region.userInteraction) transientCommand = false;
      loadedReport.moveStarted();
    },
    regionIsChanging(region) {
      report(region, false);
    },
    regionDidChange(region) {
      const transient = transientCommand && !region.userInteraction;
      loadedReport.moveEnded(transient);
      report(region, !transient);
      if (!transient) {
        settledViews += 1;
        viewListener()?.(region);
      }
      return !transient;
    },
    loaded(getViewState) {
      // One `getViewState()` serves both readers; a throw becomes a rejection.
      let read: Promise<NativeViewState> | undefined;
      const view = () => {
        read ??= (async () => getViewState())();
        return read;
      };
      loadedReport.loaded(async () => cameraReadingOf(await view()), listener);
      if (!viewListener()) return;
      const readAt = settledViews;
      view().then(
        (state) => {
          if (settledViews === readAt) viewListener()?.(state);
        },
        () => {
          // No answer: the next settled move gives the view.
        },
      );
    },
  };
}

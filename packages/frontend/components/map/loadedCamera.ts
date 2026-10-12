/**
 * A map that has loaded has a settled camera, and the canvas reports it.
 *
 * Both forks report the camera through `MapCanvasProps.onViewportChange` when
 * a move SETTLES: MapLibre's `moveend` on the web, `onRegionDidChange` on
 * native. The camera a map OPENS at is not a move: the web engine sets it with
 * the constructor's own `jumpTo`, which fires `moveend` inside `new Map()`,
 * before any listener exists, and MapLibre Native gives no promise either way.
 * So for a long time nothing reported it, and every caller that needed it got
 * it by accident or wrote a workaround. The explore list got it by accident:
 * its first query waits for the first settled camera (`useExplore`), and that
 * arrived only when something RESIZED the map container (MapLibre's `resize()`
 * fires a `moveend`). A window that never resized (headless Chromium, and any
 * browser whose layout settled before the map was built) showed the list's
 * skeletons until the reader panned.
 *
 * The rule, the same for both forks: when the map has loaded, its camera is
 * reported as a settled (`isFinal`) change, `programmatic` because the app
 * opened the map there and the reader did nothing — so it can never arm
 * "Search this area". Unless the camera is not settled:
 *
 *  - a move is under way (an animation, a gesture): that move's own settle
 *    reports the camera when it gets there;
 *  - the camera stands on a frame of a caller-driven animation
 *    (`MapCameraOptions.transient`): a flyover frame is not a settled camera,
 *    and the animation's closing, ordinary move reports one.
 */
import type { GeoBounds, MapViewportChange, ResolvedMapViewport } from './types';

/** What a fork reads off its engine for a camera report. */
export interface CameraReading {
  viewport: ResolvedMapViewport;
  bounds: GeoBounds;
}

/** Whether the camera is somewhere it will not stay. */
export interface CameraMotion {
  /** A move (animation or gesture) is under way. */
  moving: boolean;
  /** The last move to end was a frame of a caller-driven animation. */
  transient: boolean;
}

/** The report a just-loaded map owes its caller, or `null` while the camera is not settled. */
export function loadedCameraChange(
  reading: CameraReading,
  motion: CameraMotion,
): MapViewportChange | null {
  if (motion.moving || motion.transient) return null;
  return {
    viewport: reading.viewport,
    bounds: reading.bounds,
    source: 'programmatic',
    isFinal: true,
  };
}

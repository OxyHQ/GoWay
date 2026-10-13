/**
 * Which box the explore list and search are about — and when that changes.
 *
 * The list comes from a COMMITTED box, not the live camera (`useExplore`).
 * Each settled camera the canvas reports goes through {@link nextBoxStep}:
 *
 *  1. **The first box is the map's opening framing.** That is the camera the
 *     loaded map reports (`components/map/loadedCamera.ts`) — unless the screen
 *     was opened on a place (`/place/<id>`), whose framing on that place IS the
 *     opening framing. While that framing is still to come, an app-reported
 *     camera is held rather than committed, so a map that loads before the
 *     place arrives does not commit the default camera's box (Barcelona) for a
 *     reader who is looking at Tokyo; the framing's own settle commits. If the
 *     place never comes, or the framing could not be issued at all (no engine
 *     to move), the held camera is committed instead ({@link OpeningFraming}).
 *     The reader's own move always commits: they chose.
 *  2. **The same framing, another box, is the same question.** A settle at the
 *     committed centre, zoom, heading and tilt with different bounds — the
 *     container grew or shrank (a window resize, a phone's toolbar) —
 *     recommits the new box, so the list covers what is on screen. Nothing
 *     about it is a new place to look, so it never arms "Search this area".
 *     A rotation or a tilt is not the same framing and changes nothing.
 *  3. **Only the reader's move arms "Search this area"**, and only when it is
 *     far enough to be a different question. An app move (opening a result,
 *     fitting a cluster) never does, and never replaces the box.
 */
import type { GeoBounds, GeoCoordinate, MapViewportChange } from '@/components/map';
import { boundsCenter, distanceMeters } from '@/lib/map/geo';

export interface CommittedBox {
  bounds: GeoBounds;
  /** The box's own centre, for ordering a list by distance. */
  center: GeoCoordinate;
  /** The camera's centre when it was committed — with a tilt, not the box's. */
  camera: GeoCoordinate;
  zoom: number;
  /** The camera's heading and tilt when it was committed: part of its framing. */
  bearing: number;
  pitch: number;
}

/**
 * How far the camera must move before "Search this area" offers itself, as a
 * fraction of the viewport's own diagonal.
 *
 * A fraction rather than a distance, because the same drag means something
 * different at every zoom: 300 m is most of the screen at z17 and invisible at
 * z11. A zoom change of a full level counts on its own — the same centre at
 * twice the scale is a different question.
 */
export const AREA_MOVE_FRACTION = 0.3;
export const AREA_ZOOM_DELTA = 1;

/** Under these, two cameras are the same framing (a resize keeps all four). */
const SAME_CENTRE_M = 1;
const SAME_ZOOM = 1e-6;
const SAME_ANGLE_DEG = 1e-6;

export type BoxStep =
  /** Commit this box (and the button has nothing to offer). */
  | { kind: 'commit'; box: CommittedBox }
  /** The opening framing is still to come: keep this camera in case it never does. */
  | { kind: 'hold' }
  /** The reader moved: whether far enough for "Search this area". */
  | { kind: 'area'; moved: boolean }
  | { kind: 'none' };

export interface BoxContext {
  /** A deep-linked place's framing is still to come (`/place/<id>`). */
  awaitingOpeningFraming: boolean;
}

/** The committed box a settled camera stands for. */
export function boxOf(change: Pick<MapViewportChange, 'bounds' | 'viewport'>): CommittedBox {
  return {
    bounds: change.bounds,
    center: boundsCenter(change.bounds),
    camera: { latitude: change.viewport.latitude, longitude: change.viewport.longitude },
    zoom: change.viewport.zoom,
    bearing: change.viewport.bearing,
    pitch: change.viewport.pitch,
  };
}

/** What a reported camera does to the committed box. */
export function nextBoxStep(
  committed: CommittedBox | null,
  change: MapViewportChange,
  context: BoxContext,
): BoxStep {
  if (!change.isFinal) return { kind: 'none' };

  if (!committed) {
    if (change.source !== 'user' && context.awaitingOpeningFraming) return { kind: 'hold' };
    return { kind: 'commit', box: boxOf(change) };
  }

  if (sameFraming(committed, change)) {
    return sameBounds(committed.bounds, change.bounds)
      ? { kind: 'none' }
      : { kind: 'commit', box: boxOf(change) };
  }

  if (change.source !== 'user') return { kind: 'none' };

  const diagonal = distanceMeters(
    { latitude: change.bounds.south, longitude: change.bounds.west },
    { latitude: change.bounds.north, longitude: change.bounds.east },
  );
  const moved = distanceMeters(committed.center, change.viewport);
  const zoomed = Math.abs(change.viewport.zoom - committed.zoom) >= AREA_ZOOM_DELTA;
  return { kind: 'area', moved: moved > diagonal * AREA_MOVE_FRACTION || zoomed };
}

/** A deep link's opening framing (`/place/<id>`), from waiting for it to done. */
export interface OpeningFraming {
  /** The framing is still to come: an app-reported camera is held, not committed. */
  readonly awaiting: boolean;
  /** Keep a camera reported while the framing is awaited. */
  hold(change: MapViewportChange): void;
  /**
   * Issue the framing with `move`, which answers whether a move was really
   * issued (`MapApi.moveTo`). Returns the box to commit NOW: the held camera
   * when no move was issued — no settle will ever come to commit — else
   * `null`, and the move's own settle commits.
   */
  frame(move: () => boolean): CommittedBox | null;
  /** The framing will never come (the place failed, the reader left it): the held box, if any. */
  abandon(): CommittedBox | null;
}

export function createOpeningFraming(deepLinked: boolean): OpeningFraming {
  let awaiting = deepLinked;
  let held: MapViewportChange | null = null;
  const release = () => {
    const box = held ? boxOf(held) : null;
    held = null;
    awaiting = false;
    return box;
  };
  return {
    get awaiting() {
      return awaiting;
    },
    hold(change) {
      held = change;
    },
    frame(move) {
      if (!awaiting) return null;
      // Done waiting BEFORE the move: a jump (no animation) settles inside
      // `move`, and that settle is the framing — it must commit, not be held.
      awaiting = false;
      if (move()) {
        held = null;
        return null;
      }
      return release();
    },
    abandon() {
      return awaiting ? release() : null;
    },
  };
}

/**
 * Same centre, zoom, heading and tilt: what a container resize leaves alone.
 * A rotation or a tilt about the same centre (the 2D/3D toggle, reset north)
 * is a different framing, and a different box nobody asked the list about.
 */
function sameFraming(committed: CommittedBox, change: MapViewportChange): boolean {
  return (
    Math.abs(change.viewport.zoom - committed.zoom) < SAME_ZOOM &&
    angleBetween(change.viewport.bearing, committed.bearing) < SAME_ANGLE_DEG &&
    Math.abs(change.viewport.pitch - committed.pitch) < SAME_ANGLE_DEG &&
    distanceMeters(committed.camera, change.viewport) < SAME_CENTRE_M
  );
}

/** Degrees between two headings, the short way round (359° and 1° are 2° apart). */
function angleBetween(a: number, b: number): number {
  const turn = Math.abs(a - b) % 360;
  return turn > 180 ? 360 - turn : turn;
}

function sameBounds(a: GeoBounds, b: GeoBounds): boolean {
  return a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north;
}

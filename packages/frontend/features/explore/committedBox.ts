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
 *     place never comes, the held camera is committed instead
 *     ({@link heldOpeningBox}). The reader's own move always commits: they
 *     chose.
 *  2. **The same framing, another box, is the same question.** A settle at the
 *     committed centre and zoom with different bounds — the container grew or
 *     shrank (a window resize, a phone's toolbar) — recommits the new box, so
 *     the list covers what is on screen. Nothing about it is a new place to
 *     look, so it never arms "Search this area".
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

/** Under this, two centres are the same framing (a resize keeps the centre). */
const SAME_CENTRE_M = 1;
const SAME_ZOOM = 1e-6;

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

/**
 * The opening framing will not come (the place failed to load, or the reader
 * left it first): the camera held meanwhile is the opening box after all.
 */
export function heldOpeningBox(
  committed: CommittedBox | null,
  held: MapViewportChange | null,
): CommittedBox | null {
  return committed || !held ? null : boxOf(held);
}

/** Same centre and zoom: what a container resize leaves alone. */
function sameFraming(committed: CommittedBox, change: MapViewportChange): boolean {
  return (
    Math.abs(change.viewport.zoom - committed.zoom) < SAME_ZOOM &&
    distanceMeters(committed.camera, change.viewport) < SAME_CENTRE_M
  );
}

function sameBounds(a: GeoBounds, b: GeoBounds): boolean {
  return a.west === b.west && a.south === b.south && a.east === b.east && a.north === b.north;
}

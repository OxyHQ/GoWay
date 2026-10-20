/**
 * The camera rule (`engine/camera/clearance.ts`) on MapLibre GL JS: the map's
 * eye never inside a building or under the ground.
 *
 * MapLibre owns the camera — centre, zoom, pitch, bearing, and the eye they
 * put `distance` behind and above the centre — and every way it moves goes
 * through one place: drag-rotate, pitch, pinch, the wheel, the keyboard,
 * inertia, and every `jumpTo`/`easeTo`/`flyTo` (flyovers, landmark tours,
 * Camera Studio, deep links). Each builds the camera ASKED for and hands it
 * to `Camera.applyUpdatedTransform`, which runs MapLibre's own terrain rule
 * (`_elevateCameraIfInsideTerrain`: the eye at least ON the terrain, while
 * terrain is on) and then `transformCameraUpdate` — this — before the camera
 * is drawn. While a gesture or an animation lasts MapLibre keeps the camera
 * asked for apart from the one drawn (`_requestedCameraState`, dropped at
 * `moveend`).
 *
 * Three things happen here:
 *
 *  - **Every update** is corrected by the shared rule (`constrain`, with its
 *    settling of data that arrives under the eye).
 *  - **The camera asked for is held at the surface on zoom and pitch**
 *    (`holdAtSurface`): a gesture's zoom in or tilt into a building is taken
 *    back in MapLibre's own accumulated camera, so reversing it answers at
 *    once. The bearing is never held: a rotation lifts the eye over a tower
 *    and sets it down again. The one reach past MapLibre's public API here
 *    (`Camera._requestedCameraState`, in its typings); without it the rule
 *    still holds the eye, with the dead zone back.
 *  - **A still camera** whose buildings change under it (a tile, a landmark,
 *    the terrain) is eased up by one `easeTo`, started on a tick of the map's
 *    animation clock — never while a pointer, a touch or a button is down or
 *    a gesture is moving (an `easeTo` stops MapLibre's handlers, which would
 *    end a drag the reader has just begun), and marked as the map's own move
 *    (`PROGRAMMATIC`), so it arms no "Search this area", pauses no tour and
 *    folds no credit.
 *
 * The ground is the drawn terrain, read by the SAME sampler the city stands
 * its buildings, trees and streets on (`city3dGround.web.ts` → `groundOf`:
 * the DEM's finest tile, as MapLibre's terrain mesh reads it), so the eye, the
 * buildings and the terrain agree on one surface
 * (`docs/MAP_CAMERA_CLEARANCE.md` → The ground).
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

import {
  latitudeFromMercatorY,
  longitudeFromMercatorX,
  mercatorX,
  mercatorY,
} from '@goway.to/sdk/geo';

import { PROGRAMMATIC } from '@goway.to/maps/plugin';
import { groundOf } from './city3dGround.web';
import {
  applyCorrection,
  type CameraPose,
  type ClearanceField,
  cameraDistanceM,
  createCameraClearance,
  eyeInside,
  eyeOf,
  type GroundAt,
  holdAtSurface,
  requirementFor,
} from './engine/camera/clearance';
import type { GroundSampler } from './engine/city3d/terrainGround';
import type { AnimationClock } from './perf/animationClock';

/** MapLibre's near plane: a fiftieth of the screen's height, in its camera's pixels (`_calcMatrices`). */
export const NEAR_PER_HEIGHT = 1 / 50;

/** A still camera's buildings changed under it: eased up over this long, ms. */
export const SETTLE_EASE_MS = 350;

/** What MapLibre hands `transformCameraUpdate`: a whole transform, typed as its camera. */
interface TransformLike {
  center: { lng: number; lat: number };
  zoom: number;
  pitch: number;
  bearing: number;
  elevation: number;
  fov: number;
  height: number;
}

/** The camera MapLibre's gestures accumulate into (`Camera._requestedCameraState`). */
interface AskedCamera {
  zoom: number;
  pitch: number;
  setZoom(zoom: number): void;
  setPitch(pitch: number): void;
}

/** What this reads of the map: MapLibre's `Map`, or a test's stand-in for it. */
export type ClearanceMap = Pick<
  MapLibreMap,
  | 'setTransformCameraUpdate'
  | 'getCenter'
  | 'getZoom'
  | 'getPitch'
  | 'getBearing'
  | 'getCenterElevation'
  | 'getVerticalFieldOfView'
  | 'getCanvas'
  | 'isMoving'
  | 'easeTo'
  | 'on'
  | 'off'
  | 'getTerrain'
  | 'getSource'
> & {
  terrain?: MapLibreMap['terrain'] | null;
  _camera?: { _requestedCameraState?: AskedCamera };
};

/** Where pointers go down and come up: the map's container and the window. */
interface PointerTarget {
  addEventListener(type: string, listener: (event: Event) => void, options?: object): void;
  removeEventListener(type: string, listener: (event: Event) => void, options?: object): void;
}

export function poseOf(camera: TransformLike): CameraPose {
  const { lng, lat } = camera.center;
  const distanceM = cameraDistanceM(camera.zoom, lat, camera.fov, camera.height);
  // Both are in the camera's pixels: the near plane's share of the distance.
  const nearPerDistance = NEAR_PER_HEIGHT / (0.5 / Math.tan((camera.fov * Math.PI) / 180 / 2));
  return {
    centerX: mercatorX(lng),
    centerY: mercatorY(lat),
    centerLatitude: lat,
    centerElevationM: camera.elevation,
    zoom: camera.zoom,
    pitch: camera.pitch,
    bearing: camera.bearing,
    distanceM,
    nearM: distanceM * nearPerDistance,
  };
}

/** Per camera change, for the development probe. */
interface ClearanceStats {
  updates: number;
  corrected: number;
  /** Updates whose camera ASKED FOR an eye inside a building or the ground. */
  askedInside: number;
  /** Updates whose camera DRAWN has its eye inside one (must stay 0). */
  drawnInside: number;
  /** Updates whose zoom or pitch was held at the surface. */
  held: number;
  totalMs: number;
  maxMs: number;
  settles: number;
}

export interface CameraClearanceHandle {
  dispose(): void;
}

export interface CameraClearanceOptions {
  /** The city engine's field (`City3dHandle.clearance`), or `null` while there is none. */
  field: () => ClearanceField | null;
  /** The map's one animation clock: the still camera's ease starts on its tick. */
  clock: AnimationClock;
  /** The map's container: a pointer down on it holds the still camera's ease. */
  container: PointerTarget;
  /** Where a pointer is released (the window: a drag can end off the map). */
  releaseTarget?: PointerTarget;
  /** The time, ms (tests). */
  now?: () => number;
}

export function attachCameraClearance(
  map: ClearanceMap,
  options: CameraClearanceOptions,
): CameraClearanceHandle {
  const now = options.now ?? (() => performance.now());
  const rule = createCameraClearance();
  const dev = typeof __DEV__ !== 'undefined' && __DEV__;
  // The drawn ground: the city's own sampler over whatever terrain the map
  // has, made again only when the terrain (or its DEM source) changes.
  let sampler: { terrain: unknown; source: string; sample: GroundSampler } | null = null;
  const groundAt: GroundAt = (x, y) => {
    const terrain = map.terrain;
    const source = map.getTerrain()?.source;
    if (!terrain || !source) return 0;
    if (sampler?.terrain !== terrain || sampler.source !== source) {
      sampler = { terrain, source, sample: groundOf(map as MapLibreMap, source).sample };
    }
    return sampler.sample(longitudeFromMercatorX(x), latitudeFromMercatorY(y));
  };
  const stats: ClearanceStats | null = dev
    ? {
        updates: 0,
        corrected: 0,
        askedInside: 0,
        drawnInside: 0,
        held: 0,
        totalMs: 0,
        maxMs: 0,
        settles: 0,
      }
    : null;

  // The camera the gesture asked for at the last update, and whose it was:
  // MapLibre makes a new one per gesture or animation.
  let previous: { asked: AskedCamera; zoom: number; pitch: number } | null = null;

  map.setTransformCameraUpdate((next) => {
    const started = now();
    let pose = poseOf(next as unknown as TransformLike);
    const field = options.field();
    const ground = groundAt;
    const asked = map._camera?._requestedCameraState;
    let held = false;
    if (asked && previous?.asked === asked) {
      const at = holdAtSurface(pose, previous, field, ground);
      if (at.zoom !== pose.zoom || at.pitch !== pose.pitch) {
        held = true;
        pose = applyCorrection(pose, at);
        // Into the camera the gesture accumulates: its next step starts here.
        asked.setZoom(at.zoom);
        asked.setPitch(at.pitch);
      }
    }
    previous = asked ? { asked, zoom: pose.zoom, pitch: pose.pitch } : null;
    const correction = rule.constrain(pose, field, ground, started);
    if (stats) {
      const ms = now() - started;
      stats.updates++;
      stats.totalMs += ms;
      stats.maxMs = Math.max(stats.maxMs, ms);
      if (correction) stats.corrected++;
      if (held) stats.held++;
      // Outside the timing: what MAIN would have drawn, and what this draws.
      if (eyeInside(poseOf(next as unknown as TransformLike), field, ground).inside) {
        stats.askedInside++;
      }
      if (eyeInside(applyCorrection(pose, correction), field, ground).inside) stats.drawnInside++;
    }
    if (correction) return correction;
    return held ? { zoom: pose.zoom, pitch: pose.pitch } : {};
  });

  // The still camera: when the buildings under it change, ease it clear —
  // on a tick of the map's clock, and only with no pointer down.
  const drawnPose = (): CameraPose =>
    poseOf({
      center: map.getCenter(),
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      elevation: map.getCenterElevation(),
      fov: map.getVerticalFieldOfView(),
      height: map.getCanvas().clientHeight,
    });
  const pointers = new Set<number>();
  /** A settle is owed: the field changed while the camera could not be eased. */
  let owed = false;
  let seen = -1;
  const free = () => pointers.size === 0 && !map.isMoving();
  const ticket = options.clock.join('cameraClearance', undefined, () => {
    ticket.setAnimating(false);
    if (!free()) {
      owed = true;
      return;
    }
    owed = false;
    const field = options.field();
    const pose = drawnPose();
    const correction = rule.settle(pose, field, groundAt);
    if (!correction) return;
    if (stats) stats.settles++;
    map.easeTo({ ...correction, duration: SETTLE_EASE_MS }, PROGRAMMATIC);
  });
  const ask = () => {
    owed = true;
    if (free()) ticket.setAnimating(true);
  };
  const onRender = () => {
    const field = options.field();
    if (!field || field.version === seen) return;
    seen = field.version;
    ask();
  };
  // A pointer, a touch or a button down holds the ease until it comes up.
  const onDown = (event: Event) => {
    pointers.add((event as PointerEvent).pointerId ?? -1);
  };
  const onUp = (event: Event) => {
    pointers.delete((event as PointerEvent).pointerId ?? -1);
    if (pointers.size === 0 && owed) ask();
  };
  const onMoveEnd = () => {
    if (owed) ask();
  };
  // A release outside the page is never heard: leaving it forgets them all.
  const onBlur = () => {
    pointers.clear();
    if (owed) ask();
  };
  const release = options.releaseTarget ?? options.container;
  options.container.addEventListener('pointerdown', onDown, { capture: true });
  for (const type of ['pointerup', 'pointercancel'] as const) {
    release.addEventListener(type, onUp, { capture: true });
  }
  release.addEventListener('blur', onBlur);
  map.on('render', onRender);
  map.on('moveend', onMoveEnd);

  if (dev) {
    // For the browser checks (`scripts/check-camera-clearance.ts`, the
    // visibility gate): the DRAWN eye against the prisms, on any frame.
    (globalThis as { __gowayClearance?: unknown }).__gowayClearance = {
      stats,
      probe() {
        const pose = drawnPose();
        const field = options.field();
        const ground = groundAt;
        const eye = eyeOf(pose);
        const inside = eyeInside(pose, field, ground);
        return {
          eye: {
            longitude: longitudeFromMercatorX(eye.x),
            latitude: latitudeFromMercatorY(eye.y),
            altitudeM: eye.altitudeM,
          },
          inside: inside.inside,
          depthM: inside.depthM,
          requiredM: requirementFor(pose, field, ground).altitudeM,
          groundM: ground(eye.x, eye.y),
          hasField: field !== null,
          version: field?.version ?? null,
          camera: { zoom: pose.zoom, pitch: pose.pitch, bearing: pose.bearing },
        };
      },
    };
  }

  return {
    dispose() {
      map.setTransformCameraUpdate(null);
      map.off('render', onRender);
      map.off('moveend', onMoveEnd);
      options.container.removeEventListener('pointerdown', onDown, { capture: true });
      for (const type of ['pointerup', 'pointercancel'] as const) {
        release.removeEventListener(type, onUp, { capture: true });
      }
      release.removeEventListener('blur', onBlur);
      ticket.dispose();
      rule.reset();
    },
  };
}

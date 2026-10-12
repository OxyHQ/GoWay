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
 * `moveend`), so what this changes never feeds back into the gesture.
 *
 * Two paths:
 *
 *  - **A moving camera** is corrected in `transformCameraUpdate`, every
 *    update, by the shared rule (with its settling of data that arrives
 *    under the eye).
 *  - **A still camera** whose buildings change under it (a tile, a landmark,
 *    the terrain arriving) is eased up by MapLibre's own `easeTo` — one short
 *    animation through MapLibre's render loop, which the first frame of a
 *    gesture interrupts, never a timer of its own.
 *
 * The ground is read the way MapLibre's own terrain rule reads it
 * (`Terrain.getElevationForLngLatZoom` at the camera's zoom), so the two
 * agree; it is the one place to switch when the shared elevation sampler
 * lands (`docs/MAP_CAMERA_CLEARANCE.md` → The ground).
 */
import type { LngLat, Map as MapLibreMap } from 'maplibre-gl';

import { latitudeFromMercatorY, longitudeFromMercatorX, mercatorX, mercatorY } from '@/lib/map/geo';

import {
  applyCorrection,
  type CameraPose,
  type ClearanceField,
  cameraDistanceM,
  createCameraClearance,
  eyeInside,
  eyeOf,
  type GroundAt,
  requirementFor,
} from './engine/camera/clearance';

/** MapLibre's near plane: a fiftieth of the screen's height, in its camera's pixels (`_calcMatrices`). */
const NEAR_PER_HEIGHT = 1 / 50;

/** A still camera's buildings changed under it: eased up over this long, ms. */
const SETTLE_EASE_MS = 350;

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

function poseOf(camera: TransformLike): CameraPose {
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
  totalMs: number;
  maxMs: number;
  settles: number;
}

export interface CameraClearanceHandle {
  dispose(): void;
}

export function attachCameraClearance(
  map: MapLibreMap,
  options: {
    /** The city engine's field (`City3dHandle.clearance`), or `null` while there is none. */
    field: () => ClearanceField | null;
    /** Marks the still camera's ease as the map's own move, not the reader's. */
    eventData: object;
  },
): CameraClearanceHandle {
  const rule = createCameraClearance();
  // One `LngLat` reused for every ground read (MapLibre's own type, without importing it).
  const at: LngLat = map.getCenter();
  const groundAt =
    (zoom: number): GroundAt =>
    (x, y) => {
      const terrain = map.terrain;
      if (!terrain) return 0;
      at.lng = longitudeFromMercatorX(x);
      at.lat = latitudeFromMercatorY(y);
      return terrain.getElevationForLngLatZoom(at, zoom);
    };
  const stats: ClearanceStats | null = __DEV__
    ? { updates: 0, corrected: 0, askedInside: 0, drawnInside: 0, totalMs: 0, maxMs: 0, settles: 0 }
    : null;

  map.setTransformCameraUpdate((next) => {
    const started = performance.now();
    const pose = poseOf(next as unknown as TransformLike);
    const field = options.field();
    const ground = groundAt(pose.zoom);
    const correction = rule.constrain(pose, field, ground, started);
    if (stats) {
      const ms = performance.now() - started;
      stats.updates++;
      stats.totalMs += ms;
      stats.maxMs = Math.max(stats.maxMs, ms);
      if (correction) stats.corrected++;
      // Development only, outside the timing: what MAIN would have drawn, and what this draws.
      if (eyeInside(pose, field, ground).inside) stats.askedInside++;
      if (eyeInside(applyCorrection(pose, correction), field, ground).inside) stats.drawnInside++;
    }
    return correction ?? {};
  });

  // The still camera: when the buildings under it change, ease it clear.
  let seen = -1;
  const drawnPose = (): CameraPose => {
    const center = map.getCenter();
    return poseOf({
      center,
      zoom: map.getZoom(),
      pitch: map.getPitch(),
      bearing: map.getBearing(),
      elevation: map.getCenterElevation(),
      fov: map.getVerticalFieldOfView(),
      height: map.getCanvas().clientHeight,
    });
  };
  const onRender = () => {
    const field = options.field();
    if (!field || field.version === seen || map.isMoving()) return;
    seen = field.version;
    const pose = drawnPose();
    const correction = rule.settle(pose, field, groundAt(pose.zoom));
    if (!correction) return;
    if (stats) stats.settles++;
    // Not inside MapLibre's own frame: the next task starts the ease.
    setTimeout(() => {
      if (map.isMoving()) return;
      map.easeTo({ ...correction, duration: SETTLE_EASE_MS }, options.eventData);
    }, 0);
  };
  map.on('render', onRender);

  if (__DEV__) {
    // For the browser check (`scripts/check-camera-clearance.ts`): the DRAWN
    // eye against the prisms, sampled on every frame it likes.
    (globalThis as { __gowayClearance?: unknown }).__gowayClearance = {
      stats,
      probe() {
        const pose = drawnPose();
        const field = options.field();
        const ground = groundAt(pose.zoom);
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
      rule.reset();
    },
  };
}

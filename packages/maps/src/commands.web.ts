/**
 * The web map's camera commands — the `MapViewRef` and `<Camera>` both move
 * the camera through these, so the guards below are the only route a camera
 * change takes into maplibre-gl.
 *
 * Every command is marked PROGRAMMATIC (`cameraReports.web.ts`), so the camera
 * it produces is reported as the app's move and never as the reader's.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';
import { boundsCenter, boundsOf, isDegenerateBounds } from '@goway.to/sdk/geo';

import { PROGRAMMATIC, PROGRAMMATIC_TRANSIENT } from './cameraReports.web';
import {
  asFinite,
  describeNumbers,
  isDrawableBounds,
  isDrawableCoordinate,
  isViewport,
  optionalScalar,
  reportMapDefect,
  resolvePadding,
  runEngineCommand,
  toBoundsArray,
  toLngLat,
} from './shared';
import type { GeoBoundingBox, MapViewRef, ResolvedMapViewport } from './types';

/** Zoom used when a fit has nothing with area to fit — see `isDegenerateBounds`. */
export const DEGENERATE_FIT_ZOOM = 15;
/** Breathing room, in px, around a fitted box. */
export const DEFAULT_FIT_PADDING = 48;
export const DEFAULT_CAMERA_DURATION_MS = 500;

export function createWebMapApi(getMap: () => MapLibreMap | null): MapViewRef {
  const api: MapViewRef = {
    moveTo(target, options) {
      const map = getMap();
      if (!map) return false;
      const coordinate = isViewport(target)
        ? { latitude: target.latitude, longitude: target.longitude }
        : target;
      // Leaving the camera where it is beats throwing out of the handler that
      // asked for the move.
      if (!isDrawableCoordinate(coordinate)) {
        reportMapDefect(
          'moveTo',
          `Ignored moveTo: target is not drawable (${describeNumbers(coordinate)}).`,
        );
        return false;
      }
      const viewport = isViewport(target) ? target : undefined;
      // `asFinite` on every scalar: a NaN zoom makes `transform.worldSize` NaN,
      // and the next `getBounds()` throws `Invalid LngLat object: (NaN, NaN)`.
      const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
      const marker = options?.transient ? PROGRAMMATIC_TRANSIENT : PROGRAMMATIC;
      const camera = {
        center: toLngLat(coordinate),
        zoom: asFinite(options?.zoom) ?? asFinite(viewport?.zoom) ?? map.getZoom(),
        bearing: asFinite(options?.bearing) ?? asFinite(viewport?.bearing) ?? map.getBearing(),
        pitch: asFinite(options?.pitch) ?? asFinite(viewport?.pitch) ?? map.getPitch(),
      };
      // A narrower lens (and back); range-checked so a bad value leaves the
      // lens alone rather than inverting the camera.
      const fov = asFinite(options?.fieldOfView);
      if (fov !== undefined && fov >= 10 && fov <= 60 && fov !== map.getVerticalFieldOfView()) {
        runEngineCommand('setVerticalFieldOfView', () => map.setVerticalFieldOfView(fov, marker));
      }
      if (duration <= 0) {
        return runEngineCommand('jumpTo', () => map.jumpTo(camera, marker));
      }
      return runEngineCommand('easeTo', () => map.easeTo({ ...camera, duration }, marker));
    },
    fitBounds(bounds, options) {
      const map = getMap();
      if (!map) return;
      // `isDegenerateBounds` answers `false` for a NaN box — every comparison
      // against NaN is false — so this check comes FIRST.
      if (!isDrawableBounds(bounds)) {
        reportMapDefect(
          'fitBounds',
          `Ignored fitBounds: box is not drawable (${describeNumbers(bounds)}).`,
        );
        return;
      }
      const padding = resolvePadding(options?.padding, DEFAULT_FIT_PADDING);
      if (!padding) return;
      // A canvas with no size is a real state (the first frame before layout,
      // a hidden tab): `cameraForBoxAndBearing` divides the free viewport by
      // the box, so zero pixels is `0 / 0` and a NaN centre that throws.
      const container = map.getContainer();
      if (!container.clientWidth || !container.clientHeight) {
        reportMapDefect('fitBounds:noCanvas', 'Ignored fitBounds: the canvas has no size yet.');
        return;
      }
      // `maxZoom` goes straight into `Math.min(computedZoom, maxZoom)`, and
      // `Math.min(x, undefined)` is NaN — so an absent cap must be an ABSENT
      // key, never a present-and-undefined one (`optionalScalar`).
      const maxZoom = asFinite(options?.maxZoom);
      const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
      if (isDegenerateBounds(bounds)) {
        const centre = boundsCenter(bounds);
        runEngineCommand('easeTo', () =>
          map.easeTo(
            {
              center: toLngLat(centre),
              zoom: Math.min(maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
              duration,
            },
            PROGRAMMATIC,
          ),
        );
        return;
      }
      const [west, south, east, north] = toBoundsArray(bounds);
      runEngineCommand('fitBounds', () =>
        map.fitBounds(
          [
            [west, south],
            [east, north],
          ],
          { padding, duration, ...optionalScalar('maxZoom', maxZoom) },
          PROGRAMMATIC,
        ),
      );
    },
    fitCoordinates(coordinates, options) {
      const bounds = boundsOf(coordinates);
      if (!bounds) return;
      api.fitBounds(bounds, options);
    },
    setBearing(bearing, options) {
      const heading = asFinite(bearing);
      if (heading === undefined) {
        reportMapDefect('setBearing', `Ignored setBearing: ${String(bearing)} is not a bearing.`);
        return;
      }
      const map = getMap();
      if (!map) return;
      runEngineCommand('easeTo', () =>
        map.easeTo(
          {
            bearing: heading,
            duration: asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS,
          },
          PROGRAMMATIC,
        ),
      );
    },
    resetNorth(options) {
      const map = getMap();
      if (!map) return;
      runEngineCommand('easeTo', () =>
        map.easeTo(
          {
            bearing: 0,
            pitch: 0,
            duration: asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS,
          },
          PROGRAMMATIC,
        ),
      );
    },
    async getViewport(): Promise<ResolvedMapViewport | null> {
      const map = getMap();
      if (!map) return null;
      const center = map.getCenter();
      return {
        latitude: center.lat,
        longitude: center.lng,
        zoom: map.getZoom(),
        bearing: map.getBearing(),
        pitch: map.getPitch(),
      };
    },
    async getBounds(): Promise<GeoBoundingBox | null> {
      const map = getMap();
      if (!map) return null;
      const bounds = map.getBounds();
      return {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      };
    },
    captureFrames(draw) {
      const map = getMap();
      if (!map) return () => {};
      // `render` fires right after MapLibre drew the frame, in the same task —
      // the one moment a WebGL canvas without a preserved drawing buffer can
      // still be read.
      const onRender = () => draw({ canvas: map.getCanvas() });
      map.on('render', onRender);
      map.triggerRepaint();
      return () => {
        map.off('render', onRender);
      };
    },
  };
  return api;
}

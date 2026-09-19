/**
 * `MapCanvas` — the shared contract, and the fallback renderer.
 *
 * Metro resolves `MapCanvas.web.tsx` on web and `MapCanvas.native.tsx` on iOS
 * and Android, so THIS file is normally never bundled. It exists for two
 * reasons, both of which matter:
 *
 *  1. **TypeScript resolves `./MapCanvas` to this file.** `tsc` has no platform
 *     extensions, so this module is the one that defines the public signature
 *     every call site is checked against. The two forks are checked separately
 *     against the same `MapCanvasProps`/`MapApi` from `./types`, which is what
 *     keeps them from drifting apart without a compile error.
 *  2. **Any other platform gets a product-owned failure, not a crash.** A
 *     bundler or runtime that matches neither fork lands here and renders the
 *     `unsupported` degraded state — the same component a tile failure shows —
 *     instead of a blank rectangle or a missing-module throw.
 *
 * Feature code imports from `@/components/map`, never from a fork and never
 * from `maplibre-gl` / `@maplibre/maplibre-react-native`.
 */
import { forwardRef, useEffect, useImperativeHandle } from 'react';
import { View } from 'react-native';

import { MapErrorState } from './MapErrorState';
import type { MapApi, MapCanvasProps } from './types';

/** No-op handle, so a caller's `mapRef.current?.moveTo(...)` is still safe. */
const UNSUPPORTED_API: MapApi = {
  moveTo: () => {},
  fitBounds: () => {},
  fitCoordinates: () => {},
  setBearing: () => {},
  resetNorth: () => {},
  getViewport: async () => null,
  getBounds: async () => null,
};

export const MapCanvas = forwardRef<MapApi, MapCanvasProps>(function MapCanvas(
  { style, testID, onError },
  ref,
) {
  useImperativeHandle(ref, () => UNSUPPORTED_API, []);

  useEffect(() => {
    onError?.({ reason: 'unsupported', message: 'No map renderer for this platform.' });
  }, [onError]);

  return (
    <View style={style} testID={testID} className="flex-1">
      <MapErrorState error={{ reason: 'unsupported' }} />
    </View>
  );
});

export type {
  GeoBounds,
  GeoCoordinate,
  MapApi,
  MapCameraOptions,
  MapCanvasError,
  MapCanvasProps,
  MapErrorReason,
  MapFitOptions,
  MapInteractionOptions,
  MapMarker,
  MapMoveSource,
  MapOverlay,
  MapOverlayKind,
  MapOverlayPaint,
  MapViewport,
  MapViewportChange,
  ResolvedMapViewport,
} from './types';

/**
 * `MapCanvas`, iOS + Android — `@maplibre/maplibre-react-native` v11.
 *
 * This is the ONLY native file allowed to import a map engine. It implements
 * the same `MapCanvasProps` / `MapApi` as `MapCanvas.web.tsx`; the two are kept
 * honest by both being checked against `./types`.
 *
 * **This requires a native development build.** MapLibre Native ships real iOS
 * and Android SDKs, so the module is not present in Expo Go and there is no
 * JS-only fallback — `expo start` against Expo Go will fail to resolve the
 * native view at runtime, not at build time. `app.config.js` wires the
 * package's Expo config plugin; see `README.md` → "Native builds".
 *
 * Why MapLibre Native rather than a WebView carrying maplibre-gl (the shape
 * Homiio uses): a WebView map pays a bridge hop for every gesture frame and
 * cannot host Bloom components as annotations. v11's `<Marker>` renders real
 * React children at a coordinate, so GoWay's markers ARE Bloom's markers on
 * native, identical to web.
 */
import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { View, type NativeSyntheticEvent } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  UserLocation,
  type CameraRef,
  type MapRef,
  type PressEvent,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { useTheme } from '@oxy.so/bloom/theme';

import { resolveMapStyleUrl } from '@/lib/map/provider';
import { boundsOf, isDegenerateBounds } from '@/lib/map/geo';

import { DefaultMapMarker } from './DefaultMapMarker';
import { MapAttribution } from './MapAttribution';
import { MapErrorState } from './MapErrorState';
import {
  fromLngLat,
  isViewport,
  resolveInteraction,
  resolveOverlayPaint,
  resolvePadding,
  toBoundsArray,
  toLngLat,
} from './shared';
import {
  DEFAULT_VIEWPORT,
  type GeoBounds,
  type MapApi,
  type MapCanvasError,
  type MapCanvasProps,
  type MapMarker,
  type ResolvedMapViewport,
} from './types';

/** Zoom used when a "fit" has nothing with area to fit — see `isDegenerateBounds`. */
const DEGENERATE_FIT_ZOOM = 15;
/** Default breathing room, in px, around a fitted box. */
const DEFAULT_FIT_PADDING = 48;
const DEFAULT_CAMERA_DURATION_MS = 500;

export const MapCanvas = forwardRef<MapApi, MapCanvasProps>(function MapCanvas(
  {
    initialViewport = DEFAULT_VIEWPORT,
    appearance,
    markers,
    renderMarker,
    overlays,
    showUserLocation = false,
    interaction,
    onViewportChange,
    onPress,
    onMarkerPress,
    onReady,
    onError,
    style,
    testID,
  },
  ref,
) {
  const theme = useTheme();
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);

  const [error, setError] = useState<MapCanvasError | null>(null);
  // Remounting the engine is the only reliable retry MapLibre Native offers:
  // a style that failed to load is not re-fetched by setting the same URL.
  const [reloadKey, setReloadKey] = useState(0);

  const resolvedAppearance = appearance ?? (theme.isDark ? 'dark' : 'light');
  const styleUrl = useMemo(() => resolveMapStyleUrl(resolvedAppearance), [resolvedAppearance]);
  const gestures = resolveInteraction(interaction);

  /**
   * The location dot is drawn only against a permission that is ALREADY
   * granted. `getForegroundPermissionsAsync` reads; it never prompts. So a
   * screen that passes `showUserLocation` before the user has opted in gets
   * nothing rather than a prompt, and opening the map still cannot ask.
   */
  const [locationGranted, setLocationGranted] = useState(false);
  useEffect(() => {
    if (!showUserLocation) {
      setLocationGranted(false);
      return;
    }
    let cancelled = false;
    Location.getForegroundPermissionsAsync()
      .then((permission) => {
        if (!cancelled) setLocationGranted(permission.granted);
      })
      .catch(() => {
        if (!cancelled) setLocationGranted(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showUserLocation]);

  // --- Camera -------------------------------------------------------------

  const api = useMemo<MapApi>(
    () => ({
      moveTo(target, options) {
        const camera = cameraRef.current;
        if (!camera) return;
        const coordinate = isViewport(target)
          ? { latitude: target.latitude, longitude: target.longitude }
          : target;
        const viewport = isViewport(target) ? target : undefined;
        const duration = options?.duration ?? DEFAULT_CAMERA_DURATION_MS;
        const stop = {
          center: toLngLat(coordinate),
          zoom: options?.zoom ?? viewport?.zoom,
          bearing: options?.bearing ?? viewport?.bearing,
          pitch: options?.pitch ?? viewport?.pitch,
        };
        if (duration <= 0) {
          camera.jumpTo(stop);
          return;
        }
        camera.easeTo({ ...stop, duration, easing: 'ease' });
      },
      fitBounds(bounds, options) {
        const camera = cameraRef.current;
        if (!camera) return;
        if (isDegenerateBounds(bounds)) {
          camera.easeTo({
            center: [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
            zoom: Math.min(options?.maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
            duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS,
          });
          return;
        }
        const padding = resolvePadding(options?.padding, DEFAULT_FIT_PADDING);
        camera.fitBounds(toBoundsArray(bounds), {
          padding,
          duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS,
          zoom: options?.maxZoom,
        });
      },
      fitCoordinates(coordinates, options) {
        const bounds = boundsOf(coordinates);
        if (!bounds) return;
        api.fitBounds(bounds, options);
      },
      setBearing(bearing, options) {
        cameraRef.current?.setStop({
          bearing,
          duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS,
          easing: 'ease',
        });
      },
      resetNorth(options) {
        cameraRef.current?.setStop({
          bearing: 0,
          pitch: 0,
          duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS,
          easing: 'ease',
        });
      },
      async getViewport(): Promise<ResolvedMapViewport | null> {
        const map = mapRef.current;
        if (!map) return null;
        try {
          const view = await map.getViewState();
          return {
            latitude: view.center[1],
            longitude: view.center[0],
            zoom: view.zoom,
            bearing: view.bearing,
            pitch: view.pitch,
          };
        } catch {
          return null;
        }
      },
      async getBounds(): Promise<GeoBounds | null> {
        const map = mapRef.current;
        if (!map) return null;
        try {
          const [west, south, east, north] = await map.getBounds();
          return { west, south, east, north };
        } catch {
          return null;
        }
      },
    }),
    [],
  );

  useImperativeHandle(ref, () => api, [api]);

  // --- Events -------------------------------------------------------------

  const emitViewport = useCallback(
    (event: NativeSyntheticEvent<ViewStateChangeEvent>, isFinal: boolean) => {
      if (!onViewportChange) return;
      const { center, zoom, bearing, pitch, bounds, userInteraction } = event.nativeEvent;
      const [west, south, east, north] = bounds;
      onViewportChange({
        viewport: {
          latitude: center[1],
          longitude: center[0],
          zoom,
          bearing,
          pitch,
        },
        bounds: { west, south, east, north },
        // The engine tells us straight out whether a finger caused this, so
        // GoWay never has to infer it from a marker on the command.
        source: userInteraction ? 'user' : 'programmatic',
        isFinal,
      });
    },
    [onViewportChange],
  );

  const handlePress = useCallback(
    (event: NativeSyntheticEvent<PressEvent>) => {
      onPress?.({ coordinate: fromLngLat(event.nativeEvent.lngLat) });
    },
    [onPress],
  );

  const handleStyleLoaded = useCallback(() => {
    setError(null);
    onReady?.();
  }, [onReady]);

  const handleStyleFailed = useCallback(() => {
    // MapLibre Native reports a style/source failure as one event and surfaces
    // no per-tile errors to JS, so `style` is the only reason this fork can
    // distinguish. The user-facing copy covers both cases.
    const next: MapCanvasError = { reason: 'style', message: 'Failed to load the map style.' };
    setError(next);
    onError?.(next);
  }, [onError]);

  const retry = useCallback(() => {
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  // --- Render -------------------------------------------------------------

  const accent = theme.colors.primary;

  return (
    <View style={style} className="flex-1" testID={testID}>
      <MapLibreMap
        key={reloadKey}
        ref={mapRef}
        style={{ flex: 1 }}
        mapStyle={styleUrl}
        dragPan={gestures.pan}
        touchZoom={gestures.zoom}
        touchRotate={gestures.rotate}
        touchPitch={gestures.pitch}
        // GoWay renders its own credit (see MapAttribution) because the
        // OpenFreeMap style carries no `attribution` for the engine to show.
        attribution={false}
        logo={false}
        compass={gestures.rotate}
        compassPosition={{ top: 8, right: 8 }}
        onPress={handlePress}
        onRegionIsChanging={(event) => emitViewport(event, false)}
        onRegionDidChange={(event) => emitViewport(event, true)}
        onDidFinishLoadingStyle={handleStyleLoaded}
        onDidFailLoadingMap={handleStyleFailed}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: toLngLat(initialViewport),
            zoom: initialViewport.zoom,
            bearing: initialViewport.bearing,
            pitch: initialViewport.pitch,
          }}
        />

        {showUserLocation && locationGranted ? <UserLocation animated /> : null}

        {/*
          Overlays are appended on top of the basemap. MapLibre Native cannot
          hand the loaded style back to JS, so there is no first-symbol-layer to
          anchor `beforeId` against the way the web fork does; a GoWay style
          document with a reserved anchor id (see `lib/map/provider.ts`) is what
          closes that difference.
        */}
        {(overlays ?? []).map((overlay) => {
          if (overlay.visible === false) return null;
          const paint = resolveOverlayPaint(overlay.kind, overlay.paint, accent);
          return (
            <GeoJSONSource key={overlay.id} id={`goway:src:${overlay.id}`} data={overlay.data}>
              {overlay.kind === 'line' ? (
                <Layer
                  id={`goway:line:${overlay.id}`}
                  type="line"
                  style={{
                    lineColor: paint.color,
                    lineWidth: paint.width,
                    lineOpacity: paint.opacity,
                    lineCap: 'round',
                    lineJoin: 'round',
                  }}
                />
              ) : overlay.kind === 'fill' ? (
                <Layer
                  id={`goway:fill:${overlay.id}`}
                  type="fill"
                  style={{
                    fillColor: paint.color,
                    fillOpacity: paint.opacity,
                    fillOutlineColor: paint.outlineColor,
                  }}
                />
              ) : (
                <Layer
                  id={`goway:circle:${overlay.id}`}
                  type="circle"
                  style={{
                    circleColor: paint.color,
                    circleOpacity: paint.opacity,
                    circleRadius: paint.radius,
                  }}
                />
              )}
            </GeoJSONSource>
          );
        })}

        {(markers ?? []).map((marker: MapMarker) => (
          <Marker
            key={marker.id}
            id={marker.id}
            lngLat={toLngLat(marker.coordinate)}
            anchor="bottom"
            selected={marker.selected}
          >
            <View>
              {renderMarker ? (
                renderMarker(marker)
              ) : (
                <DefaultMapMarker marker={marker} onPress={() => onMarkerPress?.(marker)} />
              )}
            </View>
          </Marker>
        ))}
      </MapLibreMap>

      <View pointerEvents="box-none" className="absolute bottom-space-4 left-space-8">
        <MapAttribution />
      </View>

      {error ? <MapErrorState error={error} onRetry={retry} /> : null}
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

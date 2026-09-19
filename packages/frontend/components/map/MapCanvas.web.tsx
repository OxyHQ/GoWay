/**
 * `MapCanvas`, web — `maplibre-gl` driven directly against a real `<div>`.
 *
 * This is the ONLY web file allowed to import a map engine. It implements the
 * same `MapCanvasProps` / `MapApi` as `MapCanvas.native.tsx`; the two are kept
 * honest by both being checked against `./types`.
 *
 * Two deliberate choices:
 *
 *  - **No WebView, no iframe, no CDN.** `maplibre-gl` is bundled and runs
 *    against the DOM node react-native-web already gives us for a `<View>`.
 *  - **maplibre-gl v5, pinned.** v6 is ESM-only and starts its tile worker from
 *    a URL it derives from `import.meta.url` — which, inside a Metro bundle, is
 *    not the package directory, so the worker never starts and every tile
 *    request fails silently with no build error and no failing test. Working
 *    around that means copying worker modules into `public/` from
 *    `metro.config.js`, and GoWay's `metro.config.js` delegates wholesale to
 *    `@oxy.so/app-preset` (AGENTS.md: fix the preset, never copy config back
 *    into the app). v5's UMD bundle carries its worker inlined as a Blob, so
 *    there is nothing to vendor and nothing to keep in version lockstep.
 *
 * Markers are DOM markers whose element React portals Bloom components into, so
 * a marker on the web is the same component as a marker on native.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { View } from 'react-native';
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, MapLayerMouseEvent, StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as Location from 'expo-location';
import { useTheme } from '@oxy.so/bloom/theme';

import { overlayLayerId, overlaySourceId, resolveMapStyleUrl } from '@/lib/map/provider';
import { boundsOf, isDegenerateBounds } from '@/lib/map/geo';

import { DefaultMapMarker } from './DefaultMapMarker';
import { MapAttribution } from './MapAttribution';
import { MapErrorState } from './MapErrorState';
import {
  isViewport,
  resolveInteraction,
  resolveOverlayPaint,
  resolvePadding,
  toLngLat,
} from './shared';
import {
  DEFAULT_VIEWPORT,
  type GeoBounds,
  type MapApi,
  type MapCanvasError,
  type MapCanvasProps,
  type MapMarker,
  type MapMoveSource,
  type MapOverlay,
  type ResolvedMapViewport,
} from './types';

const DEGENERATE_FIT_ZOOM = 15;
const DEFAULT_FIT_PADDING = 48;
const DEFAULT_CAMERA_DURATION_MS = 500;
/** Streaming viewport updates while a drag is in progress. */
const MOVE_THROTTLE_MS = 100;

/**
 * Marker put on every camera COMMAND GoWay issues, read back off the event.
 *
 * Marking our own commands (rather than sniffing for a DOM `originalEvent`) is
 * the safer direction of failure: a command somebody forgets to mark reads as a
 * user gesture, so "Search this area" appears once when it need not have. The
 * alternative — treat anything unrecognised as programmatic — hides the button
 * for good and looks like the feature was never built.
 */
const PROGRAMMATIC = { gowayProgrammatic: true } as const;

function moveSourceOf(event: unknown): MapMoveSource {
  const marked = event as { gowayProgrammatic?: unknown } | null | undefined;
  return marked?.gowayProgrammatic === true ? 'programmatic' : 'user';
}

interface MarkerSlot {
  id: string;
  marker: maplibregl.Marker;
  element: HTMLElement;
}

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
  const hostRef = useRef<View | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const markerSlots = useRef<Map<string, MarkerSlot>>(new Map());
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);
  const lastMoveEmit = useRef(0);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<MapCanvasError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Portal targets, mirrored into state so React re-renders the marker bodies
  // when the marker set changes.
  const [slots, setSlots] = useState<readonly MarkerSlot[]>([]);

  const resolvedAppearance = appearance ?? (theme.isDark ? 'dark' : 'light');
  const styleUrl = useMemo(() => resolveMapStyleUrl(resolvedAppearance), [resolvedAppearance]);
  const gestures = resolveInteraction(interaction);
  const accent = theme.colors.primary;

  // Callbacks are read through refs inside the engine's own listeners so that
  // re-creating the map is driven ONLY by the style/reload key — a new inline
  // `onPress` from a parent render must not tear down and rebuild the canvas.
  const handlers = useRef({ onViewportChange, onPress, onReady, onError });
  handlers.current = { onViewportChange, onPress, onReady, onError };

  const emitError = useCallback((next: MapCanvasError) => {
    setError(next);
    handlers.current.onError?.(next);
  }, []);

  // --- Engine lifecycle ---------------------------------------------------

  useEffect(() => {
    // react-native-web renders a `<View>` as a `<div>`, and its ref IS that DOM
    // node — so MapLibre gets a real container without a portal of its own.
    const container = hostRef.current as unknown as HTMLDivElement | null;
    if (!container) return;

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: styleUrl,
        center: toLngLat(initialViewport),
        zoom: initialViewport.zoom,
        bearing: initialViewport.bearing ?? 0,
        pitch: initialViewport.pitch ?? 0,
        // GoWay renders its own credit (see MapAttribution): the OpenFreeMap
        // style documents carry no source `attribution`, so this control would
        // render an EMPTY box — the failure mode where the obligation looks
        // satisfied and is not.
        attributionControl: false,
      });
    } catch (cause) {
      emitError({ reason: 'runtime', message: String(cause) });
      return;
    }

    mapRef.current = map;
    // Captured for the cleanup below: the ref's identity is stable for the
    // component's life, but ESLint cannot know that, and copying it is free.
    const slotRegistry = markerSlots.current;

    const handleLoad = () => {
      setReady(true);
      setError(null);
      handlers.current.onReady?.();
    };

    const emitViewport = (isFinal: boolean, source: MapMoveSource) => {
      const change = handlers.current.onViewportChange;
      if (!change) return;
      const center = map.getCenter();
      const bounds = map.getBounds();
      change({
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
        source,
        isFinal,
      });
    };

    const handleMove = (event: unknown) => {
      const now = Date.now();
      if (now - lastMoveEmit.current < MOVE_THROTTLE_MS) return;
      lastMoveEmit.current = now;
      emitViewport(false, moveSourceOf(event));
    };

    const handleMoveEnd = (event: unknown) => {
      lastMoveEmit.current = 0;
      emitViewport(true, moveSourceOf(event));
    };

    const handleClick = (event: MapLayerMouseEvent) => {
      handlers.current.onPress?.({
        coordinate: { latitude: event.lngLat.lat, longitude: event.lngLat.lng },
      });
    };

    const handleError = (event: maplibregl.ErrorEvent & { sourceId?: string }) => {
      // A source id means a tile/source request failed; without one the style
      // document itself did not load. Both are product failures, and the user
      // gets a different sentence for each.
      emitError({
        reason: event.sourceId ? 'tiles' : 'style',
        message: event.error?.message,
      });
    };

    map.on('load', handleLoad);
    map.on('move', handleMove);
    map.on('moveend', handleMoveEnd);
    map.on('click', handleClick);
    map.on('error', handleError);

    return () => {
      map.off('load', handleLoad);
      map.off('move', handleMove);
      map.off('moveend', handleMoveEnd);
      map.off('click', handleClick);
      map.off('error', handleError);
      for (const slot of slotRegistry.values()) slot.marker.remove();
      slotRegistry.clear();
      setSlots([]);
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      setReady(false);
      map.remove();
      mapRef.current = null;
    };
    // `initialViewport` is initial by contract — re-reading it here would make
    // a parent's inline object literal reset the camera on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [styleUrl, reloadKey, emitError]);

  // --- Interaction toggles ------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const toggle = (handler: { enable(): void; disable(): void }, on: boolean) =>
      on ? handler.enable() : handler.disable();

    toggle(map.dragPan, gestures.pan);
    toggle(map.scrollZoom, gestures.zoom);
    toggle(map.touchZoomRotate, gestures.zoom);
    toggle(map.doubleClickZoom, gestures.zoom);
    toggle(map.keyboard, true);
    toggle(map.dragRotate, gestures.rotate);
    if (gestures.rotate) {
      map.touchZoomRotate.enableRotation();
    } else {
      map.touchZoomRotate.disableRotation();
    }
    map.setMaxPitch(gestures.pitch ? 60 : 0);
  }, [gestures.pan, gestures.zoom, gestures.rotate, gestures.pitch, ready]);

  // --- Markers ------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const next = markers ?? [];
    const seen = new Set<string>();
    let changed = false;

    for (const marker of next) {
      seen.add(marker.id);
      const existing = markerSlots.current.get(marker.id);
      if (existing) {
        existing.marker.setLngLat(toLngLat(marker.coordinate));
        continue;
      }
      const element = document.createElement('div');
      // The pill sizes itself; a fixed-size marker element would clip it.
      element.style.willChange = 'transform';
      const glMarker = new maplibregl.Marker({ element, anchor: 'bottom' })
        .setLngLat(toLngLat(marker.coordinate))
        .addTo(map);
      markerSlots.current.set(marker.id, { id: marker.id, marker: glMarker, element });
      changed = true;
    }

    for (const [id, slot] of markerSlots.current) {
      if (seen.has(id)) continue;
      slot.marker.remove();
      markerSlots.current.delete(id);
      changed = true;
    }

    if (changed) setSlots([...markerSlots.current.values()]);
  }, [markers, ready]);

  // --- Overlays -----------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    const next = overlays ?? [];
    // Overlays go UNDER the first symbol layer so labels stay readable over a
    // route line. The id is derived from the style actually loaded rather than
    // hardcoded, because OpenFreeMap's light and dark styles disagree about
    // which layer that is (see `lib/map/provider.ts`).
    const beforeId = firstSymbolLayerId(map.getStyle());

    for (const overlay of next) {
      applyOverlay(map, overlay, accent, beforeId);
    }

    return () => {
      for (const overlay of next) {
        removeOverlay(map, overlay);
      }
    };
  }, [overlays, accent, ready]);

  // --- User location ------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    if (!showUserLocation) {
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      return;
    }

    let cancelled = false;
    let watcher: Location.LocationSubscription | null = null;

    (async () => {
      // READ the permission; never request it. Opening the map must not be
      // able to prompt (GoWay AGENTS.md → Privacy). `useUserLocation()` is the
      // only thing allowed to ask, and only on a user action.
      const permission = await Location.getForegroundPermissionsAsync();
      if (cancelled || !permission.granted) return;

      watcher = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
        (position) => {
          if (cancelled || !mapRef.current) return;
          const lngLat: [number, number] = [
            position.coords.longitude,
            position.coords.latitude,
          ];
          if (userMarkerRef.current) {
            userMarkerRef.current.setLngLat(lngLat);
            return;
          }
          const element = document.createElement('div');
          element.setAttribute('aria-label', 'Your location');
          Object.assign(element.style, {
            width: '16px',
            height: '16px',
            borderRadius: '9999px',
            background: theme.colors.primary,
            border: '2px solid #ffffff',
            boxShadow: '0 0 0 4px rgba(0,0,0,0.08)',
          } satisfies Partial<CSSStyleDeclaration>);
          userMarkerRef.current = new maplibregl.Marker({ element })
            .setLngLat(lngLat)
            .addTo(mapRef.current);
        },
      );
    })().catch(() => {
      // No fix available is not a map failure; the dot simply does not appear.
    });

    return () => {
      cancelled = true;
      watcher?.remove();
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
    };
  }, [showUserLocation, ready, theme.colors.primary]);

  // --- Imperative handle --------------------------------------------------

  const api = useMemo<MapApi>(
    () => ({
      moveTo(target, options) {
        const map = mapRef.current;
        if (!map) return;
        const coordinate = isViewport(target)
          ? { latitude: target.latitude, longitude: target.longitude }
          : target;
        const viewport = isViewport(target) ? target : undefined;
        const duration = options?.duration ?? DEFAULT_CAMERA_DURATION_MS;
        const camera = {
          center: toLngLat(coordinate),
          zoom: options?.zoom ?? viewport?.zoom ?? map.getZoom(),
          bearing: options?.bearing ?? viewport?.bearing ?? map.getBearing(),
          pitch: options?.pitch ?? viewport?.pitch ?? map.getPitch(),
        };
        if (duration <= 0) {
          map.jumpTo(camera, PROGRAMMATIC);
          return;
        }
        map.easeTo({ ...camera, duration }, PROGRAMMATIC);
      },
      fitBounds(bounds, options) {
        const map = mapRef.current;
        if (!map) return;
        if (isDegenerateBounds(bounds)) {
          map.easeTo(
            {
              center: [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
              zoom: Math.min(options?.maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
              duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS,
            },
            PROGRAMMATIC,
          );
          return;
        }
        map.fitBounds(
          [
            [bounds.west, bounds.south],
            [bounds.east, bounds.north],
          ],
          {
            padding: resolvePadding(options?.padding, DEFAULT_FIT_PADDING),
            duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS,
            maxZoom: options?.maxZoom,
          },
          PROGRAMMATIC,
        );
      },
      fitCoordinates(coordinates, options) {
        const bounds = boundsOf(coordinates);
        if (!bounds) return;
        api.fitBounds(bounds, options);
      },
      setBearing(bearing, options) {
        mapRef.current?.easeTo(
          { bearing, duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS },
          PROGRAMMATIC,
        );
      },
      resetNorth(options) {
        mapRef.current?.easeTo(
          { bearing: 0, pitch: 0, duration: options?.duration ?? DEFAULT_CAMERA_DURATION_MS },
          PROGRAMMATIC,
        );
      },
      async getViewport(): Promise<ResolvedMapViewport | null> {
        const map = mapRef.current;
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
      async getBounds(): Promise<GeoBounds | null> {
        const map = mapRef.current;
        if (!map) return null;
        const bounds = map.getBounds();
        return {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        };
      },
    }),
    [],
  );

  useImperativeHandle(ref, () => api, [api]);

  const retry = useCallback(() => {
    setError(null);
    setReloadKey((key) => key + 1);
  }, []);

  // Keyed lookup rather than a `find` per slot: markers are re-rendered on
  // every camera frame a parent reacts to, and a quadratic scan over a busy
  // viewport is the kind of cost that only shows up on a slow device.
  const markersById = useMemo(() => {
    const index = new globalThis.Map<string, MapMarker>();
    for (const marker of markers ?? []) index.set(marker.id, marker);
    return index;
  }, [markers]);

  // --- Render -------------------------------------------------------------

  return (
    <View style={style} className="flex-1" testID={testID}>
      <View ref={hostRef} className="flex-1" />

      {/* Marker bodies are Bloom components rendered INTO the DOM markers
          MapLibre positions, so the same component draws a marker on web and
          on native. */}
      {slots.map((slot) => {
        const marker = markersById.get(slot.id);
        if (!marker) return null;
        return createPortal(
          renderMarker ? (
            renderMarker(marker)
          ) : (
            <DefaultMapMarker marker={marker} onPress={() => onMarkerPress?.(marker)} />
          ),
          slot.element,
          slot.id,
        );
      })}

      <View pointerEvents="box-none" className="absolute bottom-space-4 left-space-8">
        <MapAttribution />
      </View>

      {error ? <MapErrorState error={error} onRetry={retry} /> : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Overlay plumbing
// ---------------------------------------------------------------------------

/** The first symbol (label) layer in a loaded style, if it has one. */
function firstSymbolLayerId(style: StyleSpecification | undefined): string | undefined {
  return style?.layers?.find((layer) => layer.type === 'symbol')?.id;
}

function applyOverlay(
  map: maplibregl.Map,
  overlay: MapOverlay,
  accent: string,
  beforeId: string | undefined,
): void {
  const sourceId = overlaySourceId(overlay.id);
  const layerId = overlayLayerId(overlay.id, overlay.kind);
  const paint = resolveOverlayPaint(overlay.kind, overlay.paint, accent);
  const visibility = overlay.visible === false ? 'none' : 'visible';

  const existing = map.getSource(sourceId) as GeoJSONSource | undefined;
  if (existing) {
    existing.setData(overlay.data);
  } else {
    map.addSource(sourceId, { type: 'geojson', data: overlay.data });
  }

  if (map.getLayer(layerId)) {
    map.setLayoutProperty(layerId, 'visibility', visibility);
    return;
  }

  if (overlay.kind === 'line') {
    map.addLayer(
      {
        id: layerId,
        type: 'line',
        source: sourceId,
        layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': paint.color,
          'line-width': paint.width,
          'line-opacity': paint.opacity,
        },
      },
      beforeId,
    );
  } else if (overlay.kind === 'fill') {
    map.addLayer(
      {
        id: layerId,
        type: 'fill',
        source: sourceId,
        layout: { visibility },
        paint: {
          'fill-color': paint.color,
          'fill-opacity': paint.opacity,
          'fill-outline-color': paint.outlineColor,
        },
      },
      beforeId,
    );
  } else {
    map.addLayer(
      {
        id: layerId,
        type: 'circle',
        source: sourceId,
        layout: { visibility },
        paint: {
          'circle-color': paint.color,
          'circle-opacity': paint.opacity,
          'circle-radius': paint.radius,
        },
      },
      beforeId,
    );
  }
}

function removeOverlay(map: maplibregl.Map, overlay: MapOverlay): void {
  const layerId = overlayLayerId(overlay.id, overlay.kind);
  const sourceId = overlaySourceId(overlay.id);
  // A style reload between render and cleanup drops both; removing what is no
  // longer there throws, and a throw in a cleanup unmounts the tree.
  try {
    if (map.getLayer(layerId)) map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);
  } catch {
    /* style already gone */
  }
}

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

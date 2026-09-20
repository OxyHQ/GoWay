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
 *  - **maplibre-gl v6, with its worker vendored to our own origin.** GoWay used
 *    to pin v5.24.0 because v5's UMD bundle inlined the tile worker as a Blob
 *    and there was nothing to vendor. That pin is no longer tenable:
 *    GHSA-jrc7-96c5-q579 (CRITICAL — "XSS Sanitizer Bypass in DOM.sanitize()
 *    via Live NamedNodeMap Removal Skip") covers every release `<= 6.4.0`, the
 *    first patched version is 6.4.1, and 5.24.0 is the last release on the 5.x
 *    line, so staying there meant staying vulnerable forever.
 *
 *    v6 is ESM-only and starts its tile worker from a URL it derives from
 *    `import.meta.url`, which inside a Metro bundle is not the package
 *    directory — so left alone the worker never starts and every tile request
 *    fails silently, with no build error and no failing test. The fix is
 *    {@link WORKER_URL} below plus `scripts/vendor-maplibre-worker.js`, which
 *    `metro.config.js` invokes as a side effect BEFORE delegating to
 *    `@oxy.so/app-preset` — a call in front of the preset, not a fork of it, so
 *    AGENTS.md's "never copy config back into the app" still holds.
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
import type {
  GeoJSONSource,
  MapGeoJSONFeature,
  MapLayerMouseEvent,
  StyleSpecification,
} from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import * as Location from 'expo-location';
import { useTheme } from '@oxy.so/bloom/theme';

import {
  overlayLayerId,
  overlaySourceId,
  resolveMapAnchors,
  resolveMapStyleUrl,
} from '@/lib/map/provider';
import { boundsOf, isDegenerateBounds } from '@/lib/map/geo';

import { applyDragAxes } from './dragAxes';
import { DefaultMapMarker } from './DefaultMapMarker';
import {
  collectLabelFeatures,
  isLabelSourceLayer,
  LABEL_HIT_PAD_PX,
  labelCandidatesOf,
  pickLabelFeature,
  type QueriedLabel,
} from './labels';
import { MapAttribution } from './MapAttribution';
import { MapBrand } from './MapBrand';
import { MapErrorState } from './MapErrorState';
import {
  asFinite,
  describeNumbers,
  drawableMarkers,
  drawableOverlays,
  isDrawableBounds,
  isDrawableCoordinate,
  isViewport,
  reportMapDefect,
  resolveInteraction,
  resolveOverlayPaint,
  resolvePadding,
  toLngLat,
} from './shared';
import {
  DEFAULT_VIEWPORT,
  type GeoBounds,
  type GeoCoordinate,
  type MapApi,
  type MapCanvasError,
  type MapCanvasProps,
  type MapLabelFeature,
  type MapMarker,
  type MapMoveSource,
  type MapOverlay,
  type ResolvedMapViewport,
} from './types';

/**
 * Where MapLibre's tile worker is served from, on this origin.
 *
 * maplibre-gl 6 is ESM-only and starts its worker BY URL, derived from
 * `import.meta.url` — which inside a Metro bundle is not the package's
 * directory, so without this no worker starts and no tile ever renders.
 * `scripts/vendor-maplibre-worker.js` (run from `metro.config.js`) copies the
 * INSTALLED package's worker modules to exactly this path, and keying the path
 * on `getVersion()` means the worker can never be a different release from the
 * main-thread code it talks to — their message protocol is internal and
 * unversioned, so a mismatch is a silent blank map, not an error.
 */
const WORKER_URL = `/vendor/maplibre-gl/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`;
if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl(new URL(WORKER_URL, window.location.origin).href);
}

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
    onLabelsChange,
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
  const handlers = useRef({ onViewportChange, onPress, onLabelsChange, onReady, onError });
  handlers.current = { onViewportChange, onPress, onLabelsChange, onReady, onError };

  /**
   * Which style layers a tap and a viewport read are queried against, derived
   * from the style that actually LOADED.
   *
   * Deriving beats naming here, and the web fork is the one that can: the
   * layers are flag-gated (`tuning.ts` omits the POI set entirely when
   * `SHOW_BASEMAP_POIS` is off), they can be renamed, and under the
   * `openfreemap` fallback style none of GoWay's ids exist at all. Walking the
   * loaded document by `source-layer` — the OpenMapTiles schema name, which is
   * the part no vendor gets to rename — answers correctly in all three cases.
   * `MapCanvas.native.tsx` cannot do this (MapLibre Native does not hand the
   * style back to JS) and names them instead; see `lib/map/tapLayers.ts`.
   *
   * `tap` is symbols AND circles — the POI dot is what sits at the anchor, and
   * the label is drawn below it, so a tap on the dot has to resolve. `labels`
   * is symbols only, because the suppression rule downstream is about a NAME
   * the basemap is already drawing: a dot whose label lost its collision is not
   * a reason to hide GoWay's own chip.
   */
  const queryLayers = useRef<{ tap: string[]; labels: string[] }>({ tap: [], labels: [] });

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

    // A camera the engine cannot build is not a reason to have no map: the
    // world view is a truthful starting frame, and whoever passed the bad one
    // is named in the console rather than in an error boundary.
    const start = isDrawableCoordinate(initialViewport) ? initialViewport : DEFAULT_VIEWPORT;
    if (start !== initialViewport) {
      reportMapDefect('viewport:initial', 'initialViewport is not drawable; opened on the default camera.');
    }

    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        style: styleUrl,
        center: toLngLat(start),
        zoom: asFinite(start.zoom) ?? DEFAULT_VIEWPORT.zoom,
        bearing: asFinite(start.bearing) ?? 0,
        pitch: asFinite(start.pitch) ?? 0,
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
      queryLayers.current = resolveQueryLayers(map);
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

    /**
     * Was this click aimed at something GoWay drew?
     *
     * It has to be asked, and it is not obvious that it does. A
     * `maplibregl.Marker`'s element is appended to the map's own CANVAS
     * CONTAINER, and MapLibre binds its handlers there — so a click on a marker
     * bubbles up and MapLibre fires a map `click` for it as well. (Measured, in
     * headless Chromium, before any of this was written: one marker click
     * produced one marker event and one map event whose `target` was the marker
     * div.) That is a live bug and not only a theoretical one: while the
     * directions planner is waiting for a point, tapping a PIN used to both
     * open that stop's field and set a stop under it.
     *
     * The test is our own element registry rather than MapLibre's
     * `.maplibregl-marker` class: the registry is what this component actually
     * owns, and a vendor class name is a string that can change in a patch
     * release without anything failing. The user-location dot is checked too —
     * it is a marker, and a tap on it is no more "a tap on the map" than a tap
     * on a pin is.
     */
    const pressedOwnMarker = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      for (const slot of slotRegistry.values()) {
        if (slot.element === target || slot.element.contains(target)) return true;
      }
      const dot = userMarkerRef.current?.getElement();
      return dot != null && (dot === target || dot.contains(target));
    };

    const handleClick = (event: MapLayerMouseEvent) => {
      const press = handlers.current.onPress;
      if (!press) return;

      // Hit priority, step 1: a GoWay marker wins outright, and `onPress` does
      // not fire underneath it. `onMarkerPress` has already run via the
      // marker's own Bloom `Pressable`.
      if (pressedOwnMarker(event.originalEvent?.target ?? null)) return;

      const coordinate = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
      // The engine cannot hand us a non-finite lngLat today, but everything
      // downstream of this event becomes a marker or a camera target, and the
      // seam's rule is that nothing crosses it unchecked.
      if (!isDrawableCoordinate(coordinate)) {
        reportMapDefect('press:coordinate', 'Ignored a map press: the engine reported a non-drawable coordinate.');
        return;
      }

      // Step 2: the basemap's own label, if the tap landed inside the pad.
      const label = labelAt(map, event.point, coordinate, queryLayers.current.tap);
      // Step 3: bare map — `label` is simply absent.
      press({ coordinate, ...(label ? { label } : {}) });
    };

    /**
     * Report what the basemap is currently labelling.
     *
     * On `idle` rather than `moveend`: `idle` is the frame at which every tile
     * has arrived AND the collision system has finished placing, which is the
     * only moment the answer is the one the user can see. A `moveend` read
     * describes the labels of the tiles that happened to be decoded by then.
     */
    const handleIdle = () => {
      const report = handlers.current.onLabelsChange;
      if (!report) return;
      const layers = queryLayers.current.labels;
      if (layers.length === 0) {
        report(EMPTY_LABELS);
        return;
      }
      const centre = map.getCenter();
      const fallback = { latitude: centre.lat, longitude: centre.lng };
      if (!isDrawableCoordinate(fallback)) return;
      let hits: MapGeoJSONFeature[];
      try {
        hits = map.queryRenderedFeatures({ layers });
      } catch {
        // A style swapped out from under the query is not a product failure —
        // the next idle frame answers correctly.
        return;
      }
      report(collectLabelFeatures(queriedLabelsOf(hits), fallback));
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
    map.on('idle', handleIdle);
    map.on('click', handleClick);
    map.on('error', handleError);

    return () => {
      map.off('load', handleLoad);
      map.off('move', handleMove);
      map.off('moveend', handleMoveEnd);
      map.off('idle', handleIdle);
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
    if (gestures.rotate) {
      map.touchZoomRotate.enableRotation();
    } else {
      map.touchZoomRotate.disableRotation();
    }
    // Bearing and tilt on a desktop are ONE MapLibre handler over two axes, so
    // they go through `applyDragAxes` rather than a `toggle`. Gating that
    // handler on `rotate` alone is what used to leave `{ rotate: false,
    // pitch: true }` with a two-finger pitch gesture and no desktop one at all,
    // while the native fork — which has a prop per axis — honoured both.
    // `dragAxes.ts` carries the contract and what it reaches past to keep it.
    applyDragAxes(map.dragRotate, { rotate: gestures.rotate, pitch: gestures.pitch });

    // Tilt's other half: `touchPitch` is the two-finger vertical drag on a
    // touchscreen — the native fork wires the same gesture as `touchPitch`, so
    // leaving this one on the renderer's default was the one place the two
    // forks could disagree about whether a pitch gesture is live.
    //
    // `setMaxPitch` is the backstop rather than the mechanism: it clamps the
    // camera even if a handler somehow fires. 60° is MapLibre's own ceiling and
    // MapLibre Native's, which is what keeps the forks in step. Pitch stays
    // reachable at EVERY zoom deliberately — `building-3d` only has volumes to
    // show from z15.5, but a gesture that silently stops working when you zoom
    // out is a worse surprise than a tilted view of flat ground.
    toggle(map.touchPitch, gestures.pitch);
    map.setMaxPitch(gestures.pitch ? 60 : 0);
  }, [gestures.pan, gestures.zoom, gestures.rotate, gestures.pitch, ready]);

  // --- Markers ------------------------------------------------------------

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // Undrawable pins never reach `setLngLat`, which throws on one. A dropped
    // marker also has its slot torn down below (it is not in `seen`), so a pin
    // whose coordinate goes bad disappears rather than freezing at its last
    // good position.
    const next = drawableMarkers(markers);
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

    // Raw GeoJSON is the one path into the engine that fails SILENTLY rather
    // than loudly: geojson-vt projects a NaN vertex to a NaN tile coordinate,
    // the feature lands in no tile, and the route line the user asked for is
    // simply absent with nothing in the console. See `shared.ts` →
    // `drawableOverlays`.
    const next = drawableOverlays(overlays);
    // Overlays go UNDER the labels so a route line never covers a street name.
    // GoWay's own style document reserves an anchor layer for exactly this, so
    // the id is CONFIGURED; the derivation below is the fallback for a style
    // that makes no such promise (OpenFreeMap's `liberty` and `fiord` disagree
    // about which layer is first, which is why one had to be invented). See
    // `lib/map/provider.ts` → `MapSourceIds.anchors.beforeLabels`.
    const anchor = resolveMapAnchors().beforeLabels;
    const beforeId =
      anchor && map.getLayer(anchor) ? anchor : firstSymbolLayerId(map.getStyle());

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
          const fix = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          };
          // A fix with no usable position is "no dot", not "no app".
          if (!isDrawableCoordinate(fix)) {
            reportMapDefect('userLocation', 'Skipped a location fix with a non-drawable coordinate.');
            return;
          }
          const lngLat: [number, number] = [fix.longitude, fix.latitude];
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
        // Leaving the camera where it is beats throwing out of the effect that
        // asked for the move.
        if (!isDrawableCoordinate(coordinate)) {
          reportMapDefect('moveTo', `Ignored moveTo: target is not drawable (${describeNumbers(coordinate)}).`);
          return;
        }
        const viewport = isViewport(target) ? target : undefined;
        // `asFinite` on every scalar: a NaN zoom does not tilt the camera oddly,
        // it makes `transform.worldSize` NaN, and the `getBounds()` this canvas
        // runs on the very next `move` event then throws the same
        // `Invalid LngLat object: (NaN, NaN)` a bad coordinate does. Falling
        // back to where the camera already is keeps the move partial rather
        // than fatal.
        const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
        const camera = {
          center: toLngLat(coordinate),
          zoom: asFinite(options?.zoom) ?? asFinite(viewport?.zoom) ?? map.getZoom(),
          bearing: asFinite(options?.bearing) ?? asFinite(viewport?.bearing) ?? map.getBearing(),
          pitch: asFinite(options?.pitch) ?? asFinite(viewport?.pitch) ?? map.getPitch(),
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
        // `isDegenerateBounds` answers `false` for a NaN box — every comparison
        // against NaN is false — so the check below has to come FIRST, or a NaN
        // box walks straight into `map.fitBounds` and throws.
        if (!isDrawableBounds(bounds)) {
          reportMapDefect('fitBounds', `Ignored fitBounds: box is not drawable (${describeNumbers(bounds)}).`);
          return;
        }
        const padding = resolvePadding(options?.padding, DEFAULT_FIT_PADDING);
        if (!padding) return;
        // A canvas with no size is the last route to the same throw, and it is a
        // real state: the first frame before layout, a hidden tab, a collapsed
        // container. `cameraForBoxAndBearing` divides the FREE viewport
        // (`width - padding`) by the box being framed, so a zero width with a
        // zero horizontal padding is `0 / 0`, and the NaN reaches the `LngLat`
        // it builds for the new centre. There is nothing to frame into zero
        // pixels anyway.
        //
        // Web-shaped on purpose: this is maplibre-gl's own arithmetic, running
        // in this thread. The native fork's fit happens inside the platform SDK
        // across the bridge and cannot throw into JS. The VALIDATION above —
        // drawable box, finite padding — is identical on both forks, which is
        // the part that has to be.
        const container = map.getContainer();
        if (!container.clientWidth || !container.clientHeight) {
          reportMapDefect('fitBounds:noCanvas', 'Ignored fitBounds: the canvas has no size yet.');
          return;
        }
        // `maxZoom` goes STRAIGHT into `Math.min(computedZoom, maxZoom)`, and
        // `Math.min(x, NaN)` is NaN — which MapLibre's own `scaleX < 0` guard
        // does not catch, because nothing compares true to NaN. It reaches the
        // centre it unprojects and throws. Dropping it means the fit uses the
        // engine's own maximum, which is what omitting it has always meant.
        const maxZoom = asFinite(options?.maxZoom);
        const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
        if (isDegenerateBounds(bounds)) {
          map.easeTo(
            {
              center: [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
              zoom: Math.min(maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
              duration,
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
          { padding, duration, maxZoom },
          PROGRAMMATIC,
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
        mapRef.current?.easeTo(
          { bearing: heading, duration: asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS },
          PROGRAMMATIC,
        );
      },
      resetNorth(options) {
        mapRef.current?.easeTo(
          { bearing: 0, pitch: 0, duration: asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS },
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

      {/* Both are unconditional and neither takes a prop: the brand and the
          credit must be on every map GoWay draws, including the embed in
          somebody else's page. See MapBrand.tsx. */}
      <MapBrand />
      <MapAttribution />

      {error ? <MapErrorState error={error} onRetry={retry} /> : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Basemap labels
// ---------------------------------------------------------------------------

const EMPTY_LABELS: readonly MapLabelFeature[] = [];

/**
 * The tap and label-read layer sets, from the style that loaded.
 *
 * Filtering on `type` is what keeps a tap on open grass from opening the park:
 * the `park` source-layer is styled as a `fill` and a `line` as well as a
 * label, and a fill is hit anywhere inside its polygon. Only the symbol (and,
 * for the tap read, the POI circle) layers describe something the basemap has
 * actually put a NAME on at a point.
 */
function resolveQueryLayers(map: maplibregl.Map): { tap: string[]; labels: string[] } {
  const tap: string[] = [];
  const labels: string[] = [];
  const style = map.getStyle();
  for (const layer of style?.layers ?? []) {
    const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
    if (!sourceLayer || !isLabelSourceLayer(sourceLayer)) continue;
    if (!map.getLayer(layer.id)) continue;
    if (layer.type === 'symbol') {
      tap.push(layer.id);
      labels.push(layer.id);
    } else if (layer.type === 'circle') {
      tap.push(layer.id);
    }
  }
  return { tap, labels };
}

/** MapLibre's features, with MapLibre removed. */
function queriedLabelsOf(features: readonly MapGeoJSONFeature[]): QueriedLabel[] {
  const out: QueriedLabel[] = [];
  for (const feature of features) {
    const sourceLayer = feature.sourceLayer;
    if (!sourceLayer || !isLabelSourceLayer(sourceLayer)) continue;
    const geometry = feature.geometry;
    // A Point becomes a coordinate; a LineString becomes a PATH, so that
    // `labels.ts` can anchor a street or a river at the point on the way the
    // user actually pointed at. A polygon (a park) gets neither: its name is
    // placed at a pole of inaccessibility that exists only inside MapLibre, and
    // `labels.ts` falls back to the tap, which is inside the thing anyway.
    const coordinate =
      geometry?.type === 'Point'
        ? { longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] }
        : null;
    const path = pathOf(geometry);
    out.push({
      featureId: feature.id ?? null,
      sourceLayer,
      layerId: feature.layer?.id,
      properties: (feature.properties ?? {}) as Readonly<Record<string, unknown>>,
      coordinate,
      path,
    });
  }
  return out;
}

/**
 * A line feature's vertices, in GoWay coordinates — or `null`.
 *
 * Capped, because a motorway clipped to a tile can carry a great many points
 * and this runs inside a click handler. The cap costs nothing in accuracy that
 * matters: the query box is 36 px across, so the part of the line the user
 * could have meant is a handful of segments, and the anchor search walks them
 * in order.
 */
const MAX_PATH_VERTICES = 512;

function pathOf(geometry: GeoJSON.Geometry | null | undefined): GeoCoordinate[] | null {
  if (!geometry) return null;
  const lines =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.type === 'MultiLineString'
        ? geometry.coordinates
        : null;
  if (!lines) return null;
  const out: GeoCoordinate[] = [];
  for (const line of lines) {
    for (const position of line) {
      if (out.length >= MAX_PATH_VERTICES) return out;
      out.push({ longitude: position[0], latitude: position[1] });
    }
  }
  return out.length > 0 ? out : null;
}

/**
 * The basemap label a tap meant, or `null`.
 *
 * A BOX, never the exact pixel. Measured against the real style and real tiles:
 * a query at a POI's own anchor returns the dot alone, six pixels away it
 * returns nothing, and the label glyph the user was aiming at sits 12–20 px
 * below the anchor because `text-anchor` is `top`. See `labels.ts` →
 * {@link LABEL_HIT_PAD_PX}.
 */
function labelAt(
  map: maplibregl.Map,
  point: { x: number; y: number },
  coordinate: GeoCoordinate,
  layers: readonly string[],
): MapLabelFeature | null {
  if (layers.length === 0) return null;
  let hits: MapGeoJSONFeature[];
  try {
    hits = map.queryRenderedFeatures(
      [
        [point.x - LABEL_HIT_PAD_PX, point.y - LABEL_HIT_PAD_PX],
        [point.x + LABEL_HIT_PAD_PX, point.y + LABEL_HIT_PAD_PX],
      ],
      { layers: [...layers] },
    );
  } catch {
    // A layer that vanished between the style load and this click. A tap that
    // resolves to nothing is the pre-existing behaviour, not a failure.
    return null;
  }
  // Anchor first (pure geometry), then rank by projected distance. The two
  // steps are split because the NATIVE fork has to await its projections in
  // between; keeping the same two calls on both forks is what keeps the rule
  // identical.
  const labels = labelCandidatesOf(queriedLabelsOf(hits), coordinate);
  return pickLabelFeature(labels, point, (target) => {
    const projected = map.project([target.longitude, target.latitude]);
    return { x: projected.x, y: projected.y };
  });
}

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
  MapLabelFeature,
  MapLabelKind,
  MapMarker,
  MapMoveSource,
  MapOverlay,
  MapOverlayKind,
  MapOverlayPaint,
  MapPressEvent,
  MapViewport,
  MapViewportChange,
  ResolvedMapViewport,
} from './types';

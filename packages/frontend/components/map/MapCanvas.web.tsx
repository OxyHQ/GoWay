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
  lazy,
  Suspense,
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
import { parseModelPlacement, type ModelPlacement } from '@goway.to/sdk';

import { isReliefId, mapStyleLoading } from '@/lib/map/reliefFlag';
import { mapFeatureStore, useMapFeature } from '@/lib/map/useMapFeatures';
import { clampPixelRatio } from '@/lib/map/quality/profile';
import { useMapQuality } from '@/lib/map/quality/useMapQuality';
import { maxPitchFor } from '@/lib/map/citySkyFlag';
import { litInstant } from '@/lib/map/timeOfDayControl';
import { cityEngineWanted } from '@/lib/map/cityEngineGate';
import {
  type MapAttributionLink,
  overlayLayerId,
  overlaySourceId,
  resolveMapAnchors,
  resolveMapStyleUrl,
} from '@/lib/map/provider';
import { boundsOf, isDegenerateBounds } from '@/lib/map/geo';
import { mapStyleDefinition, presetAppearance } from '@/lib/map/style/catalogue';

import type { City3dHandle } from './city3dLayer.web';
import type { LiveLayerHandle } from './liveLayer.web';
import {
  attachCameraReports,
  isGestureMove,
  isTransientMove,
  PROGRAMMATIC,
  PROGRAMMATIC_TRANSIENT,
} from './cameraReports.web';
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
import { MapAttribution, type MapCreditDisclosure } from './MapAttribution';
import { MapBrand } from './MapBrand';
import { MapErrorState } from './MapErrorState';
import { initialMapRelief, useMapRelief } from './reliefFlags';
import type { ReliefHandle } from './reliefLayer.web';
import { type AnimationClock, createAnimationClock } from './perf/animationClock';
import type { MapRuntime } from './perf/mapRuntime.web';
import {
  drawableModels,
  MODEL_MARKER_PREFIX,
  modelFallbackMarker,
  modelIdOfMarker,
} from './models';
import {
  asFinite,
  describeNumbers,
  drawableMarkers,
  drawableOverlays,
  isDrawableBounds,
  isDrawableCoordinate,
  isViewport,
  optionalScalar,
  reportMapDefect,
  resolveInteraction,
  resolveOverlayPaint,
  resolvePadding,
  runEngineCommand,
  toLngLat,
} from './shared';
import {
  DEFAULT_VIEWPORT,
  type GeoBounds,
  type GeoCoordinate,
  type MapApi,
  type MapCanvasError,
  type MapCanvasProps,
  type MapCreditLink,
  type MapLabelFeature,
  type MapMarker,
  type MapOverlay,
  type MapViewport,
  type ResolvedMapViewport,
} from './types';
import { useCompactCredit } from './useCompactCredit';
import { useMapStyle } from './useMapStyle';
import { applyQualityOverrides, type QualityHost } from './qualityOverrides';
import { useSunLight } from './useSunLight';

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

/**
 * The relief chunk (globe, sky, hillshade, terrain), requested once and then
 * shared. See `lib/map/reliefFlag.ts` and `docs/MAP_TERRAIN_GLOBE.md`.
 */
let reliefChunk: Promise<typeof import('./reliefLayer.web')> | null = null;
function loadReliefChunk(): Promise<typeof import('./reliefLayer.web')> {
  if (!reliefChunk) {
    reliefChunk = import('./reliefLayer.web');
    // Handled where it is used; this only keeps a failed download from also
    // surfacing as an unhandled rejection before any map exists.
    reliefChunk.catch(() => {});
  }
  return reliefChunk;
}

// Requested at module evaluation when this page draws either — long before any
// style document arrives, so the globe is in place before the first frame
// rather than replacing a flat one. Never requested while both are off; turned
// on later from the settings modal, it is requested then.
const INITIAL_RELIEF = initialMapRelief();
if (INITIAL_RELIEF.globe || INITIAL_RELIEF.terrain) loadReliefChunk();

const NO_CREDITS: readonly MapAttributionLink[] = [];

/**
 * The perf HUD (`perf/mapRuntime.web.ts`): only when asked for, with
 * `?perf=1`, in any build — never by default, development included (it covers
 * the map, and its GL counters cost main-thread time). It only SHOWS numbers,
 * so a link cannot change how the map draws for anyone.
 */
const PERF_HUD =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('perf') === '1';

/**
 * The time-of-day scrubber is its own lazy chunk: rendered only once the
 * screen opens it (`timeOfDayOpen`) while the registry's `citySky` is on and
 * the layer that draws the sky is attached, so until somebody opens it the
 * `import()` below is never evaluated and nothing downloads.
 */
const TimeOfDayScrubber = lazy(() => import('./TimeOfDayScrubber.web'));

const DEGENERATE_FIT_ZOOM = 15;
const DEFAULT_FIT_PADDING = 48;
const DEFAULT_CAMERA_DURATION_MS = 500;
interface MarkerSlot {
  id: string;
  marker: maplibregl.Marker;
  element: HTMLElement;
}

export const MapCanvas = forwardRef<MapApi, MapCanvasProps>(function MapCanvas(
  {
    initialViewport = DEFAULT_VIEWPORT,
    appearance,
    mapStyle,
    lightPreset,
    markers,
    renderMarker,
    overlays,
    live,
    timeOfDayOpen = false,
    onTimeOfDayClose,
    onSkyActiveChange,
    showUserLocation = false,
    interaction,
    onViewportChange,
    onPress,
    onMarkerPress,
    models,
    onModelPress,
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

  // The optional features (`lib/map/mapFeatures.ts`), live: a toggle in the
  // settings modal re-renders this, and the effects below attach, detach or
  // rebuild accordingly.
  const city3dFeature = useMapFeature('city3d');
  // The 3D city is on for everyone, but its chunk (three.js), its workers and
  // its GPU memory are fetched only once this map has been near the buildings
  // or tilted towards the horizon, where the sky shows (`cityEngineWanted`):
  // a visit that stays on a flat country or region pays nothing for it. Once
  // reached, it stays attached for the session.
  const [cityZoomReached, setCityZoomReached] = useState(false);
  const city3d = city3dFeature && cityZoomReached;
  const cityTiles = useMapFeature('cityTiles');
  const trees = useMapFeature('city3dTrees');
  const treeFill = useMapFeature('city3dTreeFill');
  const cityLife = useMapFeature('cityLife');
  const cityStreets = useMapFeature('cityStreets');
  const landmarks = useMapFeature('landmarks');
  // The sky, haze, sun shadows and time-of-day scrubber (`citySkyFlag.ts`).
  const citySky = useMapFeature('citySky');
  // The art-directed look (`docs/MAP_3D_CITY.md` → Art direction).
  const detailedCity = useMapFeature('detailedCity');
  const relief = useMapRelief();
  // The quality profile (`lib/map/quality/profile.ts`, `docs/MAP_PERFORMANCE.md`):
  // Settings → Performance and this device's GPU. Its pixel-ratio clamp and
  // MSAA are construction options (read once per map, through the ref); its
  // clock rate is live; a new TIER re-attaches the 3D city.
  const quality = useMapQuality();
  const qualityRef = useRef(quality);
  qualityRef.current = quality;
  // One animation clock and one performance runtime per MapLibre map.
  const clockRef = useRef<AnimationClock | null>(null);
  const reliefRef = useRef<ReliefHandle | null>(null);
  const [runtime, setRuntime] = useState<{ handle: MapRuntime | null } | null>(null);
  /**
   * What the last engine was built for, and where its camera was when it went.
   * A rebuild for a relief toggle, a new style or a new light starts where the
   * person was looking — changing the map's look never moves the map; only a
   * retry starts again at `initialViewport`.
   */
  const lastEngine = useRef<{
    styleUrl: string;
    reloadKey: number;
    camera: MapViewport | null;
  } | null>(null);
  const markerSlots = useRef<Map<string, MarkerSlot>>(new Map());
  const userMarkerRef = useRef<maplibregl.Marker | null>(null);

  const [ready, setReady] = useState(false);
  // City sky: whether the layer that draws it is attached (the scrubber and
  // the higher pitch ceiling exist only then). See the city-3D section below.
  const [skyActive, setSkyActive] = useState(false);
  // What the city-life simulation says it is drawing, for the credit
  // (`MapAttribution` → the disclosure); `null` while nothing simulated is.
  const [cityLifeDisclosure, setCityLifeDisclosure] = useState<MapCreditDisclosure | null>(null);
  // The data credit: spelled out once the map has loaded, folded into its ⓘ
  // after five seconds or at the reader's first pan, zoom or tap
  // (`lib/map/compactCredit.ts`). Always rendered; nothing can switch it off.
  const credit = useCompactCredit(ready);
  const noteCreditInteraction = credit.noteInteraction;
  const [error, setError] = useState<MapCanvasError | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Portal targets, mirrored into state so React re-renders the marker bodies
  // when the marker set changes.
  const [slots, setSlots] = useState<readonly MarkerSlot[]>([]);

  // The style and its light (`useMapStyle.ts`): the screen's, or this
  // device's choice. The appearance everything else reads — the buildings'
  // light, the relief, the 3D city — is the light's.
  const mapStyleState = useMapStyle(
    { style: mapStyle, lightPreset, appearance },
    isDrawableCoordinate(initialViewport) ? initialViewport : DEFAULT_VIEWPORT,
  );
  const { style: styleId, preset: stylePreset } = mapStyleState.selection;
  const settleMapStyle = mapStyleState.settle;
  const resolvedAppearance = presetAppearance(stylePreset);
  const styleFollowsLight = mapStyleDefinition(styleId).light === 'follows';
  // A style with its own relief (Outdoors) shows elevation data whatever the
  // Terrain switch says, so its credit rides along.
  const styleDrawsRelief = mapStyleDefinition(styleId).relief === true;
  const styleUrl = useMemo(
    () => resolveMapStyleUrl({ style: styleId, preset: stylePreset }),
    [styleId, stylePreset],
  );
  const gestures = resolveInteraction(interaction);
  const accent = theme.colors.primary;

  // The buildings' light, aimed from the sun over the viewport centre;
  // `settle` is stable, so the engine effect below can call it without being
  // re-run. See `useSunLight.ts`.
  //
  // The engine id is exactly the engine effect's own dependencies — a new
  // `styleUrl` (an appearance change) or `reloadKey` (a retry) builds a new
  // `maplibregl.Map` at `initialViewport`, wherever the user had panned to —
  // and the start is the same expression that effect builds it at. Without
  // the id the hook kept the OLD engine's settled centre: the constructor's
  // own `jumpTo` fires `moveend` inside `new Map()`, before the listener
  // below exists, so nothing else ever reports the new camera.
  const sunLight = useSunLight(
    resolvedAppearance,
    `${styleUrl}#${reloadKey}`,
    isDrawableCoordinate(initialViewport) ? initialViewport : DEFAULT_VIEWPORT,
  );
  const settleSunLight = sunLight.settle;

  // Callbacks are read through refs inside the engine's own listeners so that
  // re-creating the map is driven ONLY by the style/reload key — a new inline
  // `onPress` from a parent render must not tear down and rebuild the canvas.
  const handlers = useRef({
    onViewportChange,
    onPress,
    onLabelsChange,
    onReady,
    onError,
    onModelPress,
    live,
  });
  handlers.current = {
    onViewportChange,
    onPress,
    onLabelsChange,
    onReady,
    onError,
    onModelPress,
    live,
  };
  // The attached live adapter (`liveLayer.web.ts`), read by the click and
  // hover handlers below; `null` while there is no live layer.
  const liveHandleRef = useRef<LiveLayerHandle | null>(null);

  // --- Models (SDK_MAP_MODELS phase 1) --------------------------------------
  //
  // Parsed through the contract's NaN gate; drawn in 3D by the city engine's
  // model layer when it is attached, and as their fallback markers wherever
  // they are not drawn (see `models.ts`). `moveModel` overrides last until the
  // `models` prop changes.
  const drawnModels = useMemo(() => drawableModels(models), [models]);
  const modelsRef = useRef(drawnModels);
  modelsRef.current = drawnModels;
  const modelOverrides = useRef(new globalThis.Map<string, ModelPlacement>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `models` prop is exactly when overrides expire
  useEffect(() => {
    modelOverrides.current.clear();
  }, [models]);
  const [modelsDrawn, setModelsDrawn] = useState<ReadonlySet<string>>(() => new Set());
  const wantsModelEngine = drawnModels.some((entry) => entry.url !== null);

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

  // biome-ignore lint/correctness/useExhaustiveDependencies: `initialViewport` is initial by contract; re-reading it would reset the camera on every render
  useEffect(() => {
    // react-native-web renders a `<View>` as a `<div>`, and its ref IS that DOM
    // node — so MapLibre gets a real container without a portal of its own.
    const container = hostRef.current as unknown as HTMLDivElement | null;
    if (!container) return;

    // A relief toggle rebuilds the engine (the globe is part of how the style
    // is loaded); it must not also move the camera.
    const previous = lastEngine.current;
    const resume = previous && previous.reloadKey === reloadKey ? previous.camera : null;
    const containerBackground = container.style.background;

    // A camera the engine cannot build is not a reason to have no map: the
    // world view is a truthful starting frame, and whoever passed the bad one
    // is named in the console rather than in an error boundary.
    const start =
      resume ?? (isDrawableCoordinate(initialViewport) ? initialViewport : DEFAULT_VIEWPORT);
    if (!resume && start !== initialViewport) {
      reportMapDefect(
        'viewport:initial',
        'initialViewport is not drawable; opened on the default camera.',
      );
    }

    // With the globe flag on, the style goes in through `setStyle` with the
    // globe projection folded into the document, so the first frame is
    // already a globe; off, this is the constructor it always was.
    const styleLoading = mapStyleLoading(styleUrl, relief.globe);
    if (styleLoading.background !== null) container.style.background = styleLoading.background;
    let map: maplibregl.Map;
    try {
      map = new maplibregl.Map({
        container,
        ...styleLoading.construct,
        center: toLngLat(start),
        zoom: asFinite(start.zoom) ?? DEFAULT_VIEWPORT.zoom,
        bearing: asFinite(start.bearing) ?? 0,
        pitch: asFinite(start.pitch) ?? 0,
        // The quality profile's clamp (a 3× phone draws at 2×) and MSAA, which
        // only the high preset turns on (a construction option: it applies
        // to the next map, never by rebuilding this one).
        pixelRatio: clampPixelRatio(window.devicePixelRatio || 1, qualityRef.current),
        canvasContextAttributes: { antialias: qualityRef.current.render.msaa },
        // GoWay renders its own credit (see MapAttribution): the OpenFreeMap
        // style documents carry no source `attribution`, so this control would
        // render an EMPTY box — the failure mode where the obligation looks
        // satisfied and is not.
        attributionControl: false,
      });
      if (styleLoading.deferred) {
        map.setStyle(styleLoading.deferred.url, {
          transformStyle: styleLoading.deferred.transformStyle,
        });
      }
    } catch (cause) {
      emitError({ reason: 'runtime', message: String(cause) });
      return;
    }

    mapRef.current = map;
    // A resumed engine starts where the old one was, not at `initialViewport`,
    // which is where the sun tracker was just restarted: aim it here.
    if (resume) settleSunLight({ latitude: start.latitude, longitude: start.longitude });

    // The ONE animation clock (`perf/animationClock.ts`): everything that moves
    // by itself asks it for frames; it pauses when the tab is hidden or the
    // map has been left alone for the profile's idle time.
    const clock = createAnimationClock({
      hz: qualityRef.current.frame.animationHz,
      idleMs: qualityRef.current.frame.idlePauseMs,
      requestFrame: () => map.triggerRepaint(),
    });
    clockRef.current = clock;
    const noteInteraction = () => clock.noteInteraction();
    const onVisibility = () => clock.setHidden(document.visibilityState === 'hidden');
    const interactions = ['pointerdown', 'wheel', 'keydown', 'touchstart'] as const;
    for (const type of interactions) {
      container.addEventListener(type, noteInteraction, { passive: true, capture: true });
    }
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();
    // The performance runtime (pixel ratio, dynamic resolution, GPU tier, the
    // HUD): its own small chunk, once the map has loaded.
    let runtimeHandle: MapRuntime | null = null;
    let runtimeCancelled = false;
    const startRuntime = () => {
      import('./perf/mapRuntime.web')
        .then(({ attachMapRuntime }) => {
          if (runtimeCancelled) return;
          runtimeHandle = attachMapRuntime(map, {
            quality: qualityRef.current,
            clock,
            hud: PERF_HUD,
            gpuRecord: mapFeatureStore.getSnapshot().gpu,
            onGpuRecord: (record) => mapFeatureStore.setGpuRecord(record),
          });
          setRuntime({ handle: runtimeHandle });
        })
        .catch((cause: unknown) => {
          // The map draws without it: no dynamic resolution, no HUD.
          reportMapDefect('perf:load', `perf runtime: not loaded (${String(cause)}).`);
          if (!runtimeCancelled) setRuntime({ handle: null });
        });
    };
    map.once('load', startRuntime);

    // Relief (globe, sky, hillshade, terrain), off unless asked for. Attached
    // per map, before its style loads; `resolvedAppearance` is read here
    // because a change of it is a change of `styleUrl`, which rebuilds the map.
    let reliefHandle: ReliefHandle | null = null;
    let reliefCancelled = false;
    if (relief.globe || relief.terrain) {
      loadReliefChunk()
        .then(({ attachRelief }) => {
          if (!reliefCancelled) {
            reliefHandle = attachRelief(map, {
              flags: relief,
              appearance: resolvedAppearance,
              terrain3d: qualityRef.current.relief.terrain3d,
              terrainTextureScale: qualityRef.current.relief.terrainTextureScale,
              // A style with a fixed light (the data basemaps) is not darkened
              // by the sun: its night side would be a different map.
              globeNight: qualityRef.current.relief.globeNight && styleFollowsLight,
              at: skyAtRef.current,
            });
            reliefRef.current = reliefHandle;
          }
        })
        .catch((cause: unknown) => {
          reportMapDefect('relief:load', `relief: not attached (${String(cause)}); flat map kept.`);
        });
    }

    // Captured for the cleanup below: the ref's identity is stable for the
    // component's life, but ESLint cannot know that, and copying it is free.
    const slotRegistry = markerSlots.current;

    const handleLoad = () => {
      queryLayers.current = resolveQueryLayers(map);
      setReady(true);
      setError(null);
      handlers.current.onReady?.();
    };

    const handleMove = (event: unknown) => {
      // The reader moving the map folds the credit; nothing else does. Only a
      // move carrying the input event that caused it is a gesture: MapLibre
      // also moves the camera itself (padding, resize, terrain), unmarked.
      if (isGestureMove(event)) noteCreditInteraction();
    };

    const handleMoveEnd = (event: unknown) => {
      // A frame of a caller-driven animation is not a settled camera: the sun
      // is re-read when the animation's closing, ordinary `moveTo` settles.
      if (isTransientMove(event)) return;
      // The settled camera is when the sun is re-read for the new centre —
      // never `move`, which is every frame. Separate from the camera reports,
      // which report nothing to a caller with no `onViewportChange` (the
      // embed), and which must not decide whether the buildings are lit.
      // `getCenter` builds a `LngLat` and can throw on a broken transform,
      // hence the wrapper.
      runEngineCommand('getCenter', () => {
        const centre = map.getCenter();
        settleSunLight({ latitude: centre.lat, longitude: centre.lng });
        settleMapStyle({ latitude: centre.lat, longitude: centre.lng });
      });
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
      noteCreditInteraction();
      // Hit priority, step 1: a GoWay marker wins outright, and `onPress` does
      // not fire underneath it. `onMarkerPress` has already run via the
      // marker's own Bloom `Pressable`.
      if (pressedOwnMarker(event.originalEvent?.target ?? null)) return;

      // Step 1½: a 3D model, by its screen bounds (`engine/city3d/models.ts`).
      const pickedModel = city3dRef.current?.pickModel(event.point);
      if (pickedModel) {
        const entry = modelsRef.current.find((candidate) => candidate.model.id === pickedModel);
        if (entry) {
          handlers.current.onModelPress?.(entry.model);
          return;
        }
      }

      // Step 1¾: a live point (GoWay Live) is selected, and the tap is
      // consumed; a tap anywhere else clears the selection and carries on.
      const live = handlers.current.live;
      if (live) {
        const liveId = liveHandleRef.current?.pick(event.point) ?? null;
        live.select(liveId);
        if (liveId) return;
      }

      const press = handlers.current.onPress;
      if (!press) return;

      const coordinate = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
      // The engine cannot hand us a non-finite lngLat today, but everything
      // downstream of this event becomes a marker or a camera target, and the
      // seam's rule is that nothing crosses it unchecked.
      if (!isDrawableCoordinate(coordinate)) {
        reportMapDefect(
          'press:coordinate',
          'Ignored a map press: the engine reported a non-drawable coordinate.',
        );
        return;
      }

      // Step 2: the basemap's own label, if the tap landed inside the pad.
      const label = labelAt(map, event.point, coordinate, queryLayers.current.tap);
      // Step 3: bare map — `label` is simply absent.
      press?.({ coordinate, ...(label ? { label } : {}) });
    };

    /**
     * The pointer says whether there is something under it to tap.
     *
     * Google and Apple both do this and it is not decoration: a name on a map
     * looks exactly the same whether it is live or painted on, so without the
     * cursor the only way to find out is to click and see. The user's report
     * was precisely that — the labels had become tappable and still felt dead.
     *
     * Web only, deliberately. There is no hover on a touchscreen, and the
     * native fork has nothing to set.
     *
     * The same `labelAt` the click uses, so the pointer cannot promise a hit
     * the tap then misses — one query, one rule, one answer. It runs on
     * `mousemove`, which fires a lot, and two things keep that cheap: the
     * result is compared against what the cursor already is, so the DOM is
     * touched only on a change; and the whole thing is skipped while the map
     * is moving, when the cursor belongs to the drag and the labels under it
     * are sliding anyway.
     */
    const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
      if (map.isMoving()) return;
      const canvas = map.getCanvas();
      const coordinate = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
      const over =
        (liveHandleRef.current?.pick(event.point) ?? null) !== null ||
        (isDrawableCoordinate(coordinate) &&
          labelAt(map, event.point, coordinate, queryLayers.current.tap) !== null);
      const wanted = over ? 'pointer' : '';
      if (canvas.style.cursor !== wanted) canvas.style.cursor = wanted;
    };

    /**
     * Give the cursor back when the pointer leaves, and when a drag starts.
     *
     * Without this, leaving the canvas over a label leaves `pointer` set on an
     * element the user is no longer on, and it is still there when they come
     * back over empty ground — the stale state is invisible until it is wrong.
     */
    const releaseCursor = () => {
      const canvas = map.getCanvas();
      if (canvas.style.cursor !== '') canvas.style.cursor = '';
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
      // `idle` with every tile in hand is the map saying it drew what was
      // asked for, and it is the only honest moment to retract a tile error.
      // It fires AFTER the failure did, so a square that 404s mid-pan stops
      // speaking for the whole canvas as soon as the view settles.
      //
      // A style error is never cleared here: nothing about a viewport
      // finishing says the style document arrived, and a map with no style has
      // nothing to draw whatever the tiles do.
      if (map.areTilesLoaded()) {
        setError((current) => {
          if (current?.reason !== 'tiles') return current;
          handlers.current.onError?.(null);
          return null;
        });
      }

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
      // Elevation tiles are decoration: a failed one leaves flat ground, which
      // is still a map, and the relief layer reports it itself.
      if (isReliefId(event.sourceId)) return;
      // A source id means a tile/source request failed; without one the style
      // document itself did not load. Both are product failures, and the user
      // gets a different sentence for each.
      //
      // The difference that matters is whether it is RECOVERABLE. A style that
      // did not load leaves nothing to draw and nothing to retry on its own. A
      // tile is one square of a viewport full of them: the rest render, the
      // camera still works, and the next pan may well succeed.
      //
      // Until `handleIdle` learned to clear this, it did not behave that way.
      // One failing tile latched the whole canvas into "Map data unavailable"
      // for the life of the component, and `goway.to` sat in that state on a
      // map that was otherwise complete — the cause was a handful of stale
      // edge-cached tiles among thousands of good ones.
      emitError({
        reason: event.sourceId ? 'tiles' : 'style',
        message: event.error?.message,
      });
    };

    // Before `handleLoad`, so the camera the map opened at is reported before
    // `onReady` tells the caller the map is there (`loadedCamera.ts`).
    const detachCameraReports = attachCameraReports(map, () => handlers.current.onViewportChange);
    map.on('load', handleLoad);
    map.on('move', handleMove);
    map.on('moveend', handleMoveEnd);
    map.on('idle', handleIdle);
    map.on('click', handleClick);
    map.on('mousemove', handleMouseMove);
    map.on('mouseout', releaseCursor);
    map.on('dragstart', releaseCursor);
    map.on('error', handleError);

    return () => {
      detachCameraReports();
      map.off('load', handleLoad);
      map.off('move', handleMove);
      map.off('moveend', handleMoveEnd);
      map.off('idle', handleIdle);
      map.off('click', handleClick);
      map.off('mousemove', handleMouseMove);
      map.off('mouseout', releaseCursor);
      map.off('dragstart', releaseCursor);
      map.off('error', handleError);
      // The canvas outlives this effect on a style swap; a `pointer` left on it
      // would belong to handlers that no longer exist.
      releaseCursor();
      for (const slot of slotRegistry.values()) slot.marker.remove();
      slotRegistry.clear();
      setSlots([]);
      userMarkerRef.current?.remove();
      userMarkerRef.current = null;
      setReady(false);
      reliefCancelled = true;
      reliefHandle?.detach();
      if (reliefRef.current === reliefHandle) reliefRef.current = null;
      map.off('load', startRuntime);
      runtimeCancelled = true;
      runtimeHandle?.dispose();
      setRuntime(null);
      for (const type of interactions) {
        container.removeEventListener(type, noteInteraction, { capture: true });
      }
      document.removeEventListener('visibilitychange', onVisibility);
      clock.dispose();
      if (clockRef.current === clock) clockRef.current = null;
      let camera: MapViewport | null = null;
      runEngineCommand('getCenter', () => {
        const centre = map.getCenter();
        camera = {
          latitude: centre.lat,
          longitude: centre.lng,
          zoom: map.getZoom(),
          bearing: map.getBearing(),
          pitch: map.getPitch(),
        };
      });
      lastEngine.current = { styleUrl, reloadKey, camera };
      map.remove();
      // The globe's space backdrop belongs to the engine that drew a globe.
      container.style.background = containerBackground;
      mapRef.current = null;
    };
    // `initialViewport` is initial by contract — re-reading it here would make
    // a parent's inline object literal reset the camera on every render.
  }, [
    styleUrl,
    styleFollowsLight,
    reloadKey,
    relief,
    emitError,
    settleSunLight,
    settleMapStyle,
    noteCreditInteraction,
  ]);

  // --- Buildings light ----------------------------------------------------

  // Lay the sun light over the style document's static `light`. `ready` is in
  // the dependencies because a style swap builds a NEW map whose document
  // brings the static light back, and `setLight` before `load` throws
  // ("Style is not done loading"), so it waits for the flag `handleLoad` sets.
  // `useSunLight` only produces a new object when the light really changed, so
  // this runs on a settle or a clock tick that moved the sun a whole degree —
  // never per frame. maplibre-gl also diffs the light itself and eases the
  // change over its default 300 ms transition.
  useEffect(() => {
    const map = mapRef.current;
    const light = sunLight.light;
    if (!map || !ready || !light) return;
    runEngineCommand('setLight', () => map.setLight(light));
  }, [sunLight.light, ready]);

  // --- Interaction toggles ------------------------------------------------

  // biome-ignore lint/correctness/useExhaustiveDependencies: `ready` is the trigger; the map lives in a ref, so a fresh map must get its toggles re-applied.
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
    //
    // With the city sky drawn the ceiling is higher, so the horizon can be
    // seen (`maxPitchFor`); this effect is the only place it is set, so a
    // change of `interaction` keeps it, and detaching the sky restores 60°.
    map.setMaxPitch(maxPitchFor({ pitchAllowed: gestures.pitch, skyActive }));
  }, [gestures.pan, gestures.zoom, gestures.rotate, gestures.pitch, ready, skyActive]);

  // --- Markers ------------------------------------------------------------

  // The caller's markers plus a fallback marker for every model not drawn in
  // 3D right now (loading, failed, outside its zoom window, no engine).
  const allMarkers = useMemo(() => {
    const fallbacks: MapMarker[] = [];
    for (const { model, placement, url } of drawnModels) {
      if (url !== null && modelsDrawn.has(model.id)) continue;
      const override = modelOverrides.current.get(model.id);
      fallbacks.push(
        modelFallbackMarker(
          model,
          override ? { ...placement, position: override.position } : placement,
        ),
      );
    }
    return fallbacks.length === 0 ? markers : [...(markers ?? []), ...fallbacks];
  }, [markers, drawnModels, modelsDrawn]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready) return;

    // Undrawable pins never reach `setLngLat`, which throws on one. A dropped
    // marker also has its slot torn down below (it is not in `seen`), so a pin
    // whose coordinate goes bad disappears rather than freezing at its last
    // good position.
    const next = drawableMarkers(allMarkers);
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
  }, [allMarkers, ready]);

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
    const beforeId = anchor && map.getLayer(anchor) ? anchor : firstSymbolLayerId(map.getStyle());

    for (const overlay of next) {
      applyOverlay(map, overlay, accent, beforeId);
    }

    return () => {
      for (const overlay of next) {
        removeOverlay(map, overlay);
      }
    };
  }, [overlays, accent, ready]);

  // --- City 3D (prototype, off unless asked for) ---------------------------

  // The attached layer, and the light it must follow: the SAME `sunLight.light`
  // the effect above hands `building-3d` (including `null`, "the style's own
  // light"), so the two renderers can never be lit differently. A rebuilt
  // engine restarts the sun tracker (`useSunLight`) and re-attaches the layer
  // below, which then starts from the restarted light in this ref.
  const city3dRef = useRef<City3dHandle | null>(null);
  // Mirrors the ref, so the models effect below re-runs once a layer attaches.
  const [city3dHandle, setCity3dHandle] = useState<City3dHandle | null>(null);
  // Credits owed for the landmark models on screen (`docs/MAP_LANDMARKS.md`).
  const [landmarkCredits, setLandmarkCredits] = useState<readonly MapAttributionLink[]>(NO_CREDITS);
  const city3dLightRef = useRef(sunLight.light);

  // City sky: the instant the layer is lit for (`null`: now) and the sun's
  // altitude over the centre for the scrubber's caption.
  // The scrubber is opened on demand by the screen (`timeOfDayOpen`), and
  // only while the sky draws. Shut — by its own close, by the screen, or by
  // the sky going away — the map goes back to now: no other time is ever
  // drawn without the control that says so on screen (`timeOfDayControl.ts`).
  const timeOfDayShown = timeOfDayOpen && citySky && skyActive;
  const [chosenSkyAt, setSkyAt] = useState<Date | null>(null);
  const skyAt = litInstant(timeOfDayShown, chosenSkyAt);
  useEffect(() => {
    // Opened again, it starts from now, not from the last time it showed.
    if (!timeOfDayShown) setSkyAt(null);
  }, [timeOfDayShown]);
  const [sunAltitude, setSunAltitude] = useState<number | null>(null);
  const skyAtRef = useRef(skyAt);
  useEffect(() => {
    skyAtRef.current = skyAt;
    city3dRef.current?.setTime(skyAt);
    // The globe's day and night follow the same instant.
    reliefRef.current?.setTime(skyAt);
  }, [skyAt]);
  // The screen's time-of-day control exists only while there is a sky to set.
  const skyDrawn = citySky && skyActive;
  useEffect(() => {
    onSkyActiveChange?.(skyDrawn);
  }, [onSkyActiveChange, skyDrawn]);
  // Credits the city layer owes while it draws an official 3D model.
  const [city3dCredits, setCity3dCredits] = useState<readonly MapAttributionLink[]>(NO_CREDITS);
  // Credits for the GoWay Live data on screen (set by the live effect below).
  const [liveCredits, setLiveCredits] = useState<readonly MapCreditLink[]>(NO_CREDITS);
  // Everything owed while it is drawn: landmark authors, official building
  // data, live feeds.
  const credits = useMemo(
    () =>
      landmarkCredits.length === 0 && city3dCredits.length === 0 && liveCredits.length === 0
        ? NO_CREDITS
        : [...landmarkCredits, ...city3dCredits, ...liveCredits],
    [landmarkCredits, city3dCredits, liveCredits],
  );
  useEffect(() => {
    city3dLightRef.current = sunLight.light;
    city3dRef.current?.setLight(sunLight.light);
  }, [sunLight.light]);

  // A toggle of the city, its tiles or its trees in the settings modal re-runs this
  // effect: the old layer detaches (giving `building-3d` back) and, if still
  // wanted, a new one attaches — live, without rebuilding the map.
  //
  // With the flag off this effect returns on its first line and the dynamic
  // `import()` below is never evaluated, so the engine chunk (three.js and the
  // mesh worker) is never requested and the style is never touched. With it
  // on, `city3dLayer.web.ts` swaps `building-3d` for the custom layer and
  // `detach` swaps it back — on unmount, and before an appearance change
  // rebuilds the map.
  //
  // The same engine also hosts `models` (SDK_MAP_MODELS phase 1): with the
  // flag off but models to draw, it attaches with `buildings: false` — no
  // tiles, `building-3d` untouched — so a map has at most ONE three.js layer.
  // With neither, nothing is requested.
  useEffect(() => {
    const map = mapRef.current;
    if (!city3dFeature || cityZoomReached || !map || !ready) return;
    const check = () => {
      if (cityEngineWanted({ zoom: map.getZoom(), pitch: map.getPitch() })) {
        setCityZoomReached(true);
      }
    };
    check();
    map.on('zoom', check);
    map.on('pitch', check);
    return () => {
      map.off('zoom', check);
      map.off('pitch', check);
    };
  }, [city3dFeature, cityZoomReached, ready]);
  // The low tier draws a dense style (Streets) at Standard's density: the
  // loaded document's own overrides (`qualityOverrides.ts`), applied while
  // the profile asks for them and undone when it stops, with no rebuild.
  const standardDensity = quality.basemap.density === 'standard';
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !ready || !standardDensity) return;
    let undo: (() => void) | null = null;
    runEngineCommand('qualityOverrides', () => {
      undo = applyQualityOverrides(map as unknown as QualityHost);
    });
    return () => {
      if (mapRef.current === map) runEngineCommand('qualityOverrides', () => undo?.());
    };
  }, [ready, standardDensity]);

  const needsEngine = city3d || wantsModelEngine;
  // The quality profile reaches the attached engine by TIER: a new tier is a
  // new attach (budgets, shadow map, shaders); the rest of it is live below.
  const qualityTier = quality.tier;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new quality tier is a new attach (the engine reads the profile through `qualityRef`)
  useEffect(() => {
    const map = mapRef.current;
    const clock = clockRef.current;
    // `runtime` is set (to a handle, or to `null` if its chunk failed) once
    // the map has loaded: the engine waits for it so the HUD's probe is in.
    if (!needsEngine || !map || !ready || !clock || !runtime) return;
    let handle: City3dHandle | null = null;
    let cancelled = false;
    import('./city3dLayer.web')
      .then(({ attachCity3d }) =>
        cancelled
          ? null
          : attachCity3d(map, {
              appearance: resolvedAppearance,
              style: { style: styleId, preset: stylePreset },
              light: city3dLightRef.current,
              quality: qualityRef.current,
              clock,
              probe: runtime.handle?.probe ?? null,
              buildings: city3d,
              cityTiles,
              trees,
              treeFill,
              cityLife,
              landmarks,
              detailed: detailedCity,
              streets: cityStreets,
              onModelStatus: (id, status) =>
                setModelsDrawn((current) => {
                  if ((status === 'drawn') === current.has(id)) return current;
                  const next = new Set(current);
                  if (status === 'drawn') next.add(id);
                  else next.delete(id);
                  return next;
                }),
              onLandmarkCredits: (links) =>
                setLandmarkCredits(links.length === 0 ? NO_CREDITS : links),
              sky: citySky
                ? {
                    at: skyAtRef.current,
                    onSun: (sun) => setSunAltitude(sun.altitudeDeg),
                  }
                : undefined,
              onCredits: (links) => setCity3dCredits(links.length === 0 ? NO_CREDITS : links),
              // The simulation's label rides in the credit, for exactly as
              // long as anything simulated is drawn (`docs/MAP_CITY_LIFE.md`).
              onCityLife: (disclosure) =>
                setCityLifeDisclosure((current) =>
                  sameDisclosure(current, disclosure) ? current : disclosure,
                ),
            }),
      )
      .then((attached) => {
        // Unmounted (or the appearance changed) while the chunks downloaded:
        // undo at once rather than leave a layer on a map nobody owns.
        if (cancelled) {
          attached?.detach();
          return;
        }
        handle = attached;
        city3dRef.current = attached;
        setCity3dHandle(attached);
        // The light may have moved while the chunks downloaded.
        attached?.setLight(city3dLightRef.current);
        // Dynamic resolution and the GPU benchmark follow the 3D city.
        if (attached && city3d) runtime.handle?.set3d(true);
        attached?.setTime(skyAtRef.current);
        setSkyActive(citySky && attached !== null);
      })
      .catch((cause: unknown) => {
        // The shipped buildings are untouched until the layer is in, so a
        // failure here costs the prototype and nothing else.
        reportMapDefect(
          'city3d:load',
          `city3d: not attached (${String(cause)}); building-3d kept.`,
        );
      });
    return () => {
      cancelled = true;
      if (city3dRef.current === handle) city3dRef.current = null;
      setCity3dHandle((current) => (current === handle ? null : current));
      setModelsDrawn((current) => (current.size === 0 ? current : new Set()));
      // A detached layer draws no landmark, so it owes no landmark credit.
      setLandmarkCredits(NO_CREDITS);
      handle?.detach();
      runtime.handle?.set3d(false);
      setSkyActive(false);
      setCity3dCredits(NO_CREDITS);
      // A detached layer draws nothing simulated.
      setCityLifeDisclosure(null);
    };
  }, [
    ready,
    runtime,
    qualityTier,
    resolvedAppearance,
    styleId,
    stylePreset,
    needsEngine,
    city3d,
    cityTiles,
    trees,
    treeFill,
    cityLife,
    landmarks,
    cityStreets,
    citySky,
    detailedCity,
  ]);

  // The live part of the quality profile: the clock's rate and idle pause,
  // the pixel-ratio clamp and dynamic resolution's limits.
  useEffect(() => {
    clockRef.current?.configure({
      hz: quality.frame.animationHz,
      idleMs: quality.frame.idlePauseMs,
    });
    runtime?.handle?.setQuality(quality);
    reliefRef.current?.setTerrain3d(quality.relief.terrain3d);
    reliefRef.current?.setTerrainTextureScale(quality.relief.terrainTextureScale);
    reliefRef.current?.setGlobeNight(quality.relief.globeNight);
  }, [quality, runtime]);

  // Hand the models to the engine whenever either changes.
  useEffect(() => {
    if (!city3dHandle) return;
    city3dHandle.setModels(
      drawnModels.flatMap(({ model, placement, url }) =>
        url === null
          ? []
          : [
              {
                id: model.id,
                url,
                placement: modelOverrides.current.get(model.id) ?? placement,
                sizing: model.sizing ?? { mode: 'world' as const },
                minZoom: asFinite(model.minZoom) ?? 0,
                maxZoom: asFinite(model.maxZoom) ?? 24,
                occlusion: model.occlusion ?? 'buildings',
                ...(model.tint ? { tint: model.tint } : {}),
              },
            ],
      ),
    );
  }, [city3dHandle, drawnModels]);

  // --- Live (GoWay Live, off unless the screen passes a layer) ------------

  // Absent `live` — every screen unless the registry's `live` is on —
  // this returns on its first line and `liveLayer.web.ts` is never requested.
  const [liveHandle, setLiveHandle] = useState<LiveLayerHandle | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    const clock = clockRef.current;
    if (!live || !map || !ready || !clock) return;
    let attached: LiveLayerHandle | null = null;
    let cancelled = false;
    import('./liveLayer.web')
      .then(({ attachLive }) => {
        if (cancelled) return;
        attached = attachLive(map, live, {
          appearance: resolvedAppearance,
          clock,
          maxEntities: qualityRef.current.live.maxEntities,
        });
        liveHandleRef.current = attached;
        setLiveHandle(attached);
      })
      .catch((cause: unknown) => {
        reportMapDefect('live:load', `live: layer not attached (${String(cause)}).`);
      });
    return () => {
      cancelled = true;
      if (liveHandleRef.current === attached) liveHandleRef.current = null;
      setLiveHandle(null);
      attached?.detach();
    };
  }, [live, ready, resolvedAppearance]);

  // The live layer's 3D pass follows the city engine — the city-3D one, not a
  // models-only engine the flyover may have attached: on when both are.
  useEffect(() => {
    liveHandle?.setCity(city3d ? city3dHandle : null);
  }, [liveHandle, city3dHandle, city3d]);

  // Credits for the live data on screen, beside the basemap's own (`credits` above).
  useEffect(() => {
    if (!live) {
      setLiveCredits(NO_CREDITS);
      return;
    }
    const update = () =>
      setLiveCredits((current) => {
        const next = live.credits();
        return sameCredits(current, next) ? current : next;
      });
    update();
    return live.subscribe(update);
  }, [live]);

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
            reportMapDefect(
              'userLocation',
              'Skipped a location fix with a non-drawable coordinate.',
            );
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
        if (!map) return false;
        const coordinate = isViewport(target)
          ? { latitude: target.latitude, longitude: target.longitude }
          : target;
        // Leaving the camera where it is beats throwing out of the effect that
        // asked for the move.
        if (!isDrawableCoordinate(coordinate)) {
          reportMapDefect(
            'moveTo',
            `Ignored moveTo: target is not drawable (${describeNumbers(coordinate)}).`,
          );
          return false;
        }
        const viewport = isViewport(target) ? target : undefined;
        // `asFinite` on every scalar: a NaN zoom does not tilt the camera oddly,
        // it makes `transform.worldSize` NaN, and the `getBounds()` this canvas
        // runs on the very next `move` event then throws the same
        // `Invalid LngLat object: (NaN, NaN)` a bad coordinate does. Falling
        // back to where the camera already is keeps the move partial rather
        // than fatal.
        const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
        const marker = options?.transient ? PROGRAMMATIC_TRANSIENT : PROGRAMMATIC;
        const camera = {
          center: toLngLat(coordinate),
          zoom: asFinite(options?.zoom) ?? asFinite(viewport?.zoom) ?? map.getZoom(),
          bearing: asFinite(options?.bearing) ?? asFinite(viewport?.bearing) ?? map.getBearing(),
          pitch: asFinite(options?.pitch) ?? asFinite(viewport?.pitch) ?? map.getPitch(),
        };
        // A narrower lens for a landmark tour (and back); range-checked so a
        // bad value leaves the lens alone rather than inverting the camera.
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
        const map = mapRef.current;
        if (!map) return;
        // `isDegenerateBounds` answers `false` for a NaN box — every comparison
        // against NaN is false — so the check below has to come FIRST, or a NaN
        // box walks straight into `map.fitBounds` and throws.
        if (!isDrawableBounds(bounds)) {
          reportMapDefect(
            'fitBounds',
            `Ignored fitBounds: box is not drawable (${describeNumbers(bounds)}).`,
          );
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
        // centre it unprojects and throws.
        //
        // `Math.min(x, undefined)` is ALSO NaN, and that is the one that shipped:
        // dropping a bad `maxZoom` to `undefined` and then still writing the KEY
        // is not the same as omitting it. MapLibre defaults its own `maxZoom`
        // with `extend`, which copies an own key whose value is `undefined` over
        // the default — so every fit that simply did not ask for a maximum (the
        // planner framing a route; the embed's `span=` box) computed a `NaN`
        // zoom and threw `Invalid LngLat object: (NaN, NaN)`. From the route
        // framing that is a throw inside a `useEffect`, which is the error
        // boundary and the whole application.
        // `optionalScalar` is what makes "the caller did not say" absent rather
        // than present-and-undefined; see `shared.ts`.
        const maxZoom = asFinite(options?.maxZoom);
        const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
        if (isDegenerateBounds(bounds)) {
          runEngineCommand('easeTo', () =>
            map.easeTo(
              {
                center: [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
                zoom: Math.min(maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
                duration,
              },
              PROGRAMMATIC,
            ),
          );
          return;
        }
        runEngineCommand('fitBounds', () =>
          map.fitBounds(
            [
              [bounds.west, bounds.south],
              [bounds.east, bounds.north],
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
        const map = mapRef.current;
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
        const map = mapRef.current;
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
      moveModel(id, input) {
        const placement = parseModelPlacement(input);
        if (!placement) {
          reportMapDefect(
            `moveModel:${id}`,
            `Ignored moveModel("${id}"): the placement does not parse.`,
          );
          return;
        }
        modelOverrides.current.set(id, placement);
        city3dRef.current?.moveModel(id, placement);
        // The fallback marker, if that is what is showing, moves too — without
        // a React render per frame.
        markerSlots.current
          .get(`${MODEL_MARKER_PREFIX}${id}`)
          ?.marker.setLngLat(toLngLat(placement.position));
      },
      captureFrames(draw) {
        const map = mapRef.current;
        if (!map) return () => {};
        // `render` fires right after MapLibre drew the frame, in the same task,
        // which is the one moment a WebGL canvas without a preserved drawing
        // buffer can still be read.
        const onRender = () => draw({ canvas: map.getCanvas() });
        map.on('render', onRender);
        map.triggerRepaint();
        return () => {
          map.off('render', onRender);
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
    for (const marker of allMarkers ?? []) index.set(marker.id, marker);
    return index;
  }, [allMarkers]);

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
        // A model's stand-in is the canvas's own marker, never the caller's
        // `renderMarker`, and pressing it is pressing the model.
        const modelId = modelIdOfMarker(slot.id);
        if (modelId !== null) {
          const entry = drawnModels.find((candidate) => candidate.model.id === modelId);
          return createPortal(
            <DefaultMapMarker
              marker={marker}
              onPress={() => (entry ? onModelPress?.(entry.model) : undefined)}
            />,
            slot.element,
            slot.id,
          );
        }
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

      {/* Both are unconditional and nothing can turn either off: the brand
          and the credit must be on every map GoWay draws, including the embed
          in somebody else's page. See MapBrand.tsx. `extra` only ADDS the
          credits of data the city-3D layer is drawing right now. */}
      <MapBrand />
      <MapAttribution
        elevation={styleDrawsRelief}
        extra={credits}
        disclosure={cityLifeDisclosure}
        expanded={credit.expanded}
        onToggle={credit.toggle}
      />

      {timeOfDayShown ? (
        <Suspense fallback={null}>
          <TimeOfDayScrubber
            value={skyAt}
            onChange={setSkyAt}
            onClose={onTimeOfDayClose}
            sunAltitudeDeg={sunAltitude}
          />
        </Suspense>
      ) : null}

      {error ? <MapErrorState error={error} onRetry={retry} /> : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Basemap labels
// ---------------------------------------------------------------------------

const EMPTY_LABELS: readonly MapLabelFeature[] = [];

function sameDisclosure(a: MapCreditDisclosure | null, b: MapCreditDisclosure | null): boolean {
  return a === b || (a !== null && b !== null && a.text === b.text && a.detail === b.detail);
}

function sameCredits(a: readonly MapCreditLink[], b: readonly MapCreditLink[]): boolean {
  return (
    a.length === b.length &&
    a.every((link, index) => link.label === b[index]?.label && link.href === b[index]?.href)
  );
}

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

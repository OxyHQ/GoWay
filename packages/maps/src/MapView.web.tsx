/**
 * `MapView`, web — `maplibre-gl` against a real `<div>`.
 *
 * The engine is built in the host element's ref callback and torn down in its
 * cleanup (React 19). The host is KEYED by what the engine is built from — the
 * resolved style document, the projection, a retry — so a new style is a new
 * engine at the camera the old one was at, and everything drawn on it (sources,
 * layers, markers, plugins) binds again to the new one. No effect decides when
 * an engine exists.
 *
 * Children are rendered once the style has loaded, inside the engine's
 * context; each binds itself to the engine (`Camera.web.tsx`,
 * `GeoJSONSource.web.tsx`, …), one named binding per component file.
 *
 * maplibre-gl 6 is ESM-only and starts its tile worker BY URL. Inside a Metro
 * bundle `import.meta.url` is not the package directory, so the worker is
 * served from this origin instead — `@goway.to/maps/metro` copies it to
 * {@link WORKER_PATH}, keyed on the installed version so the worker and the
 * main thread can never be different releases.
 */
import {
  type ComponentRef,
  forwardRef,
  type ReactNode,
  type RefObject,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { StyleSheet, View } from 'react-native';
import * as maplibregl from 'maplibre-gl';
import type { MapGeoJSONFeature, MapLayerMouseEvent } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import { boundsCenter, isDegenerateBounds } from '@goway.to/sdk/geo';
import { useTheme } from '@oxy.so/bloom/theme';

import { CameraBinding } from './CameraBinding.web';
import { attachCameraReports, isGestureMove } from './cameraReports.web';
import { MapCameraContext, MapCameraStore } from './cameraStore';
import { createWebMapApi, DEFAULT_FIT_PADDING, DEGENERATE_FIT_ZOOM } from './commands.web';
import { CREDIT_AUTO_COLLAPSE_MS, creditReducer, INITIAL_CREDIT_STATE } from './compactCredit';
import { type WebEngine, WebEngineContext } from './engineContext.web';
import { InteractionBinding } from './InteractionBinding.web';
import {
  collectLabelFeatures,
  LABEL_HIT_PAD_PX,
  labelCandidatesOf,
  pickLabelFeature,
  queriedLabelsOf,
} from './labels';
import { LightBinding } from './LightBinding.web';
import { MapAttribution } from './MapAttribution';
import { MapBrand } from './MapBrand';
import { MapScale } from './MapScale';
import { MapErrorState } from './MapErrorState';
import { MapRefContext } from './mapRef';
import { NO_QUERY_LAYERS, type QueryLayers, queryLayersOf } from './queryLayers';
import {
  asFinite,
  isDrawableBounds,
  isDrawableCoordinate,
  reportMapDefect,
  resolvePadding,
  runEngineCommand,
  toBoundsArray,
  toLngLat,
} from './shared';
import { DEFAULT_MAP_STYLE, resolveStyleUrl } from './styleUrl';
import type {
  GeoCoordinate,
  MapError,
  MapInitialViewState,
  MapLabelFeature,
  MapViewport,
  MapViewProps,
  MapViewRef,
} from './types';
import { ZoomLevelContext } from './zoom';

/** Where `@goway.to/maps/metro` puts MapLibre's worker modules, on this origin. */
export const WORKER_PATH = `/vendor/maplibre-gl/${maplibregl.getVersion()}/maplibre-gl-worker.mjs`;
if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl(new URL(WORKER_PATH, window.location.origin).href);
}

/** The whole inhabited world, before anything is known. */
const WORLD_VIEW: MapViewport = { latitude: 20, longitude: 0, zoom: 1.5 };
const DEFAULT_MAX_PITCH = 60;
const EMPTY_LABELS: readonly MapLabelFeature[] = [];

export const MapView = forwardRef<MapViewRef, MapViewProps>(function MapView(props, ref) {
  const {
    mapStyle = DEFAULT_MAP_STYLE,
    lightPreset,
    projection = 'mercator',
    camera,
    light,
    interaction,
    maxPitch,
    credits,
    creditDisclosure,
    style,
    testID,
    children,
  } = props;
  const theme = useTheme();

  // The callbacks and construction options of THIS render, for listeners
  // bound once per engine: a new inline `onPress` must not rebuild the map.
  const latest = useRef(props);
  latest.current = props;
  // Every camera report goes to the store first (the scale bar and the puck's
  // halo read it) and then to the app's `onCameraChanged`, if it passed one.
  const cameraStore = useMemo(() => new MapCameraStore(), []);
  useLayoutEffect(() => {
    cameraStore.setCaller(props.onCameraChanged);
  }, [cameraStore, props.onCameraChanged]);

  const styleUrl = resolveStyleUrl(mapStyle, lightPreset, theme.isDark);
  const styleError: MapError | null =
    styleUrl === null
      ? { reason: 'style', message: `not a published GoWay style: ${mapStyle}` }
      : null;

  const [retry, setRetry] = useState(0);
  const [engine, setEngine] = useState<WebEngine | null>(null);
  const [zoomLevel, setZoomLevel] = useState(() => Math.floor(openingZoom(props.initialViewState)));
  const [error, setError] = useState<MapError | null>(null);
  const [credit, dispatchCredit] = useReducer(creditReducer, INITIAL_CREDIT_STATE);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Where the last engine's camera was when it went: a new style or a new
  // projection never moves the map; only a retry opens at the start again.
  const lastCamera = useRef<MapViewport | null>(null);
  // The `camera` target last applied, across engines (`CameraBinding.web.tsx`).
  const appliedCamera = useRef<string | null>(null);

  const api = useMemo(() => createWebMapApi(() => mapRef.current), []);
  useImperativeHandle(ref, () => api, [api]);

  const report = useCallback((next: MapError | null) => {
    setError(next);
    latest.current.onError?.(next);
  }, []);

  const engineKey = `${styleUrl}|${projection}|${retry}`;

  const attachEngine = useCallback(
    (node: ComponentRef<typeof View> | null) => {
      if (!node || !styleUrl) return;
      // react-native-web renders a `<View>` as a `<div>` and its ref IS that
      // node, so MapLibre gets a real container without a portal of its own.
      const container = node as unknown as HTMLDivElement;
      const options = latest.current;
      const opening = openingCamera(
        lastCamera.current ?? options.initialViewState ?? targetView(options.camera),
      );
      let map: maplibregl.Map;
      try {
        map = new maplibregl.Map({
          container,
          // With the globe, the style goes in through `setStyle` with the
          // projection folded into the document, so the first frame is
          // already a globe rather than a flat map that turns into one.
          ...(projection === 'globe' ? {} : { style: styleUrl }),
          ...opening,
          maxPitch: options.maxPitch ?? DEFAULT_MAX_PITCH,
          ...(asFinite(options.pixelRatio) !== undefined ? { pixelRatio: options.pixelRatio } : {}),
          canvasContextAttributes: { antialias: options.antialias === true },
          // The credit is `MapAttribution`, drawn by this component on every
          // map; the engine's own ornament is off.
          attributionControl: false,
        });
        if (projection === 'globe') {
          map.setStyle(styleUrl, {
            transformStyle: (_previous, next) => ({ ...next, projection: { type: 'globe' } }),
          });
        }
      } catch (cause) {
        report({ reason: 'runtime', message: String(cause) });
        return;
      }
      mapRef.current = map;

      const markerElements = new Set<HTMLElement>();
      const plugins: WebEngine['plugins'] = new Set();
      let queryLayers: QueryLayers = NO_QUERY_LAYERS;
      let collapse: ReturnType<typeof setTimeout> | null = null;

      // Before `load`, so the camera the map opened at is reported before
      // `onReady` says the map is there (`loadedCamera.ts`).
      const detachReports = attachCameraReports(map, () => cameraStore.forward);

      const handleLoad = () => {
        queryLayers = queryLayersOf(map.getStyle()?.layers);
        setEngine({ map, markerElements, plugins, container });
        setError((current) => {
          if (current) latest.current.onError?.(null);
          return null;
        });
        // The credit is spelled out at load and folds after a few seconds, or
        // at the reader's first interaction (`compactCredit.ts`).
        collapse = setTimeout(() => dispatchCredit({ type: 'elapsed' }), CREDIT_AUTO_COLLAPSE_MS);
        latest.current.onReady?.();
      };

      const handleMove = (event: unknown) => {
        // Only a move carrying the input event that caused it is the reader's:
        // MapLibre also moves the camera itself (padding, resize), unmarked.
        if (isGestureMove(event)) dispatchCredit({ type: 'mapInteraction' });
      };

      const handleZoom = () => {
        const level = Math.floor(map.getZoom());
        if (Number.isFinite(level)) setZoomLevel(level);
      };

      /**
       * Was this click aimed at something drawn over the map? A
       * `maplibregl.Marker`'s element is a child of the canvas container, so a
       * click on one bubbles and MapLibre fires a map `click` for it too —
       * which would set a stop under a pin the reader aimed at.
       */
      const pressedOwnMarker = (target: EventTarget | null): boolean => {
        if (!(target instanceof Node)) return false;
        for (const element of markerElements) {
          if (element === target || element.contains(target)) return true;
        }
        return false;
      };

      const handleClick = (event: MapLayerMouseEvent) => {
        dispatchCredit({ type: 'mapInteraction' });
        // Hit priority, step 1: a marker wins outright; its own press ran.
        if (pressedOwnMarker(event.originalEvent?.target ?? null)) return;
        // Step 2: a plugin's own drawing (a 3D model, a live vehicle).
        for (const plugin of plugins) {
          if (plugin.press?.(event.point)) return;
        }
        const press = latest.current.onPress;
        if (!press) return;
        const coordinate = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
        if (!isDrawableCoordinate(coordinate)) {
          reportMapDefect(
            'press:coordinate',
            'Ignored a map press: the engine reported a non-drawable coordinate.',
          );
          return;
        }
        // Step 3: the basemap's own label inside the hit pad; step 4: bare map.
        const label = labelAt(map, event.point, coordinate, queryLayers.tap);
        press({ coordinate, ...(label ? { label } : {}) });
      };

      /**
       * The pointer says whether there is something under it to press — the
       * same `labelAt` the click uses, so the cursor cannot promise a hit the
       * press then misses. Skipped while the map moves.
       */
      const handleMouseMove = (event: maplibregl.MapMouseEvent) => {
        if (map.isMoving()) return;
        const canvas = map.getCanvas();
        const coordinate = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
        let over = false;
        for (const plugin of plugins) {
          if (plugin.hover?.(event.point)) {
            over = true;
            break;
          }
        }
        if (!over && latest.current.onPress && isDrawableCoordinate(coordinate)) {
          over = labelAt(map, event.point, coordinate, queryLayers.tap) !== null;
        }
        const wanted = over ? 'pointer' : '';
        if (canvas.style.cursor !== wanted) canvas.style.cursor = wanted;
      };

      const releaseCursor = () => {
        const canvas = map.getCanvas();
        if (canvas.style.cursor !== '') canvas.style.cursor = '';
      };

      /**
       * `idle`: every tile has arrived and the collision system has placed the
       * labels — the only frame at which the labels on screen are the ones the
       * reader sees, and the only honest moment to retract a tile failure.
       */
      const handleIdle = () => {
        if (map.areTilesLoaded()) {
          setError((current) => {
            if (current?.reason !== 'tiles') return current;
            latest.current.onError?.(null);
            return null;
          });
        }
        const reportLabels = latest.current.onLabelsChange;
        if (!reportLabels) return;
        if (queryLayers.labels.length === 0) {
          reportLabels(EMPTY_LABELS);
          return;
        }
        const centre = map.getCenter();
        const fallback = { latitude: centre.lat, longitude: centre.lng };
        if (!isDrawableCoordinate(fallback)) return;
        let hits: MapGeoJSONFeature[];
        try {
          hits = map.queryRenderedFeatures({ layers: [...queryLayers.labels] });
        } catch {
          // A style swapped out from under the query; the next idle answers.
          return;
        }
        reportLabels(collectLabelFeatures(queriedLabelsOf(hits), fallback));
      };

      const handleError = (event: maplibregl.ErrorEvent & { sourceId?: string }) => {
        const sourceId = event.sourceId;
        if (sourceId) {
          const failure = {
            sourceId,
            status: (event.error as { status?: number } | undefined)?.status,
            message: event.error?.message,
          };
          for (const plugin of plugins) {
            if (plugin.ownsError?.(failure)) return;
          }
        }
        // A source id means a tile/source request failed — recoverable, the
        // rest of the viewport still draws, and `idle` retracts it. Without one
        // the style document itself did not load: nothing to draw.
        report({ reason: sourceId ? 'tiles' : 'style', message: event.error?.message });
      };

      map.on('load', handleLoad);
      map.on('move', handleMove);
      map.on('zoom', handleZoom);
      map.on('idle', handleIdle);
      map.on('click', handleClick);
      map.on('mousemove', handleMouseMove);
      map.on('mouseout', releaseCursor);
      map.on('dragstart', releaseCursor);
      map.on('error', handleError);

      return () => {
        if (collapse) clearTimeout(collapse);
        detachReports();
        releaseCursor();
        runEngineCommand('getCenter', () => {
          const centre = map.getCenter();
          lastCamera.current = {
            latitude: centre.lat,
            longitude: centre.lng,
            zoom: map.getZoom(),
            bearing: map.getBearing(),
            pitch: map.getPitch(),
          };
        });
        setEngine(null);
        if (mapRef.current === map) mapRef.current = null;
        map.remove();
      };
    },
    [styleUrl, projection, report, cameraStore.forward],
  );

  const handleRetry = useCallback(() => {
    setError(null);
    latest.current.onError?.(null);
    lastCamera.current = null;
    appliedCamera.current = null;
    setRetry((count) => count + 1);
  }, []);

  const toggleCredit = useCallback(() => dispatchCredit({ type: 'toggle' }), []);
  const shownError = styleError ?? error;

  return (
    <MapCameraContext.Provider value={cameraStore}>
      <View style={[styles.root, style]} testID={testID}>
        {/* `flex: 1`, not an absolute fill: maplibre-gl's own stylesheet makes its
          container `position: relative`, which would collapse an absolute box
          with no height of its own to nothing. */}
        <View key={engineKey} ref={attachEngine} style={styles.engine} />
        <MapRefContext.Provider value={api}>
          <EngineChildren
            engine={engine}
            zoomLevel={zoomLevel}
            camera={camera}
            appliedCamera={appliedCamera}
            light={light}
            interaction={interaction}
            maxPitch={maxPitch}
          >
            {children}
          </EngineChildren>
        </MapRefContext.Provider>
        {/* Both unconditional, with no prop to turn either off: the mark and the
          credit are on every map (`MapBrand.tsx`, `MapAttribution.tsx`). */}
        <MapBrand />
        <MapScale />
        <MapAttribution
          extra={credits}
          disclosure={creditDisclosure ?? null}
          expanded={credit.expanded}
          onToggle={toggleCredit}
        />
        {shownError ? <MapErrorState error={shownError} onRetry={handleRetry} /> : null}
      </View>
    </MapCameraContext.Provider>
  );
});

/**
 * Everything drawn ON the engine, with its context. Before the style loads
 * there is nothing to bind to, and the map components render nothing.
 */
function EngineChildren({
  engine,
  zoomLevel,
  camera,
  appliedCamera,
  light,
  interaction,
  maxPitch,
  children,
}: {
  engine: WebEngine | null;
  zoomLevel: number;
  camera: MapViewProps['camera'];
  appliedCamera: RefObject<string | null>;
  light: MapViewProps['light'];
  interaction: MapViewProps['interaction'];
  maxPitch: number | undefined;
  children: ReactNode;
}) {
  return (
    <WebEngineContext.Provider value={engine}>
      <ZoomLevelContext.Provider value={zoomLevel}>
        {engine ? (
          <>
            {camera ? (
              <CameraBinding map={engine.map} target={camera} applied={appliedCamera} />
            ) : null}
            <LightBinding map={engine.map} light={light ?? null} />
            <InteractionBinding
              map={engine.map}
              interaction={interaction}
              maxPitch={maxPitch ?? DEFAULT_MAX_PITCH}
            />
          </>
        ) : null}
        {children}
      </ZoomLevelContext.Provider>
    </WebEngineContext.Provider>
  );
}

/** A camera target as an opening view, for a map given no `initialViewState`. */
function targetView(target: MapViewProps['camera']): MapInitialViewState | undefined {
  if (target?.bounds) {
    return {
      bounds: target.bounds,
      ...(target.padding !== undefined ? { padding: target.padding } : {}),
      ...(target.maxZoom !== undefined ? { maxZoom: target.maxZoom } : {}),
    };
  }
  if (target?.center) {
    return { ...target.center, zoom: target.zoom ?? WORLD_VIEW.zoom };
  }
  return undefined;
}

/** The camera half of the engine's constructor options. */
type OpeningCamera = Pick<
  maplibregl.MapOptions,
  'center' | 'zoom' | 'bearing' | 'pitch' | 'bounds' | 'fitBoundsOptions'
>;

/** The zoom a map opens at, for the first clustering pass. */
function openingZoom(view: MapInitialViewState | undefined): number {
  if (!view) return WORLD_VIEW.zoom;
  if ('bounds' in view) return asFinite(view.maxZoom) ?? 10;
  return asFinite(view.zoom) ?? WORLD_VIEW.zoom;
}

/**
 * The constructor's camera options for an opening view: a point and zoom, or
 * a box to frame (a box with no area opens at its centre at street zoom). A
 * view the engine cannot build opens on the whole world, named in the console
 * rather than thrown.
 */
function openingCamera(view: MapInitialViewState | undefined | null): OpeningCamera {
  if (view && 'bounds' in view) {
    if (!isDrawableBounds(view.bounds)) {
      reportMapDefect(
        'initialViewState',
        'initialViewState.bounds is not drawable; opened on the world.',
      );
      return worldCamera();
    }
    if (isDegenerateBounds(view.bounds)) {
      return { center: toLngLat(boundsCenter(view.bounds)), zoom: DEGENERATE_FIT_ZOOM };
    }
    const padding = resolvePadding(view.padding, DEFAULT_FIT_PADDING) ?? undefined;
    const [west, south, east, north] = toBoundsArray(view.bounds);
    const maxZoom = asFinite(view.maxZoom);
    return {
      bounds: [
        [west, south],
        [east, north],
      ],
      fitBoundsOptions: {
        ...(padding ? { padding } : {}),
        ...(maxZoom !== undefined ? { maxZoom } : {}),
      },
    };
  }
  if (view && isDrawableCoordinate(view)) {
    return {
      center: toLngLat(view),
      zoom: asFinite(view.zoom) ?? WORLD_VIEW.zoom,
      bearing: asFinite(view.bearing) ?? 0,
      pitch: asFinite(view.pitch) ?? 0,
    };
  }
  if (view)
    reportMapDefect('initialViewState', 'initialViewState is not drawable; opened on the world.');
  return worldCamera();
}

function worldCamera(): OpeningCamera {
  return { center: toLngLat(WORLD_VIEW), zoom: WORLD_VIEW.zoom };
}

/**
 * The basemap label a press meant, or `null` — queried in a BOX around the
 * press, because a label's glyphs sit 12–20 px from the anchor the engine
 * indexes (`labels.ts` → {@link LABEL_HIT_PAD_PX}).
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
    // A layer that vanished between the style load and this press.
    return null;
  }
  const labels = labelCandidatesOf(queriedLabelsOf(hits), coordinate);
  return pickLabelFeature(labels, point, (target) => {
    const projected = map.project([target.longitude, target.latitude]);
    return { x: projected.x, y: projected.y };
  });
}

const styles = StyleSheet.create({
  // `flexGrow`, not `flex: 1`: `flex: 1` is a zero flex BASIS (react-native-web
  // writes `flex: 1 1 0%`, and Yoga reads it the same way), which overrides a
  // caller's `height` and collapses a map in a scroll view or any parent of
  // auto height to nothing. Growing from its own size, the map fills a bounded
  // parent when given no size and keeps the one it is given.
  root: { flexGrow: 1, position: 'relative', overflow: 'hidden' },
  engine: { flex: 1 },
});

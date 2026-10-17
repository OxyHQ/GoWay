/**
 * `MapView`, iOS + Android — `@maplibre/maplibre-react-native` v11.
 *
 * MapLibre Native is declarative where it matters: the style, the light, the
 * gestures, the camera's target and every source, layer and marker are PROPS
 * of native views, diffed by Fabric, so nothing here binds anything by hand. A
 * `camera` target with the same numbers is the same prop and is not re-sent.
 *
 * **It needs a development build.** MapLibre Native ships real iOS and Android
 * SDKs, so the module is absent from Expo Go; `@goway.to/maps/app.plugin.js`
 * adds it to a build.
 *
 * Markers are real React views at a coordinate (`<Marker>`), so they are the
 * same Bloom components as on the web.
 */
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';
import { type NativeSyntheticEvent, StyleSheet, View } from 'react-native';
import {
  Camera as NativeCamera,
  type CameraRef,
  Map as NativeMap,
  type MapRef,
  type PressEvent,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';
import { boundsCenter, boundsOf, isDegenerateBounds } from '@goway.to/sdk/geo';
import { useTheme } from '@oxy.so/bloom/theme';

import { cameraTargetKey } from './cameraTarget';
import { CREDIT_AUTO_COLLAPSE_MS, creditReducer, INITIAL_CREDIT_STATE } from './compactCredit';
import {
  LABEL_HIT_PAD_PX,
  labelCandidatesOf,
  collectLabelFeatures,
  pickLabelFeature,
  queriedLabelsOf,
} from './labels';
import { MapAttribution } from './MapAttribution';
import { MapBrand } from './MapBrand';
import { MapErrorState } from './MapErrorState';
import { MapRefContext } from './mapRef';
import { createNativeCameraReports, type NativeCameraReports } from './nativeCameraReports';
import { queryLayersForUrl } from './queryLayers';
import {
  asFinite,
  describeNumbers,
  fromLngLat,
  isDrawableBounds,
  isDrawableCoordinate,
  isViewport,
  optionalScalar,
  reportMapDefect,
  resolveInteraction,
  resolvePadding,
  runEngineCommand,
  toBoundsArray,
  toLngLat,
} from './shared';
import { DEFAULT_MAP_STYLE, resolveStyleUrl } from './styleUrl';
import type {
  GeoBoundingBox,
  GeoCoordinate,
  MapCameraTarget,
  MapError,
  MapInitialViewState,
  MapViewProps,
  MapViewRef,
  ResolvedMapViewport,
} from './types';
import { ZoomLevelContext } from './zoom';

/** Zoom used when a fit has nothing with area to fit — see `isDegenerateBounds`. */
const DEGENERATE_FIT_ZOOM = 15;
const DEFAULT_FIT_PADDING = 48;
const DEFAULT_CAMERA_DURATION_MS = 500;
const WORLD_VIEW = { latitude: 20, longitude: 0, zoom: 1.5 };

export const MapView = forwardRef<MapViewRef, MapViewProps>(function MapView(props, ref) {
  const {
    mapStyle = DEFAULT_MAP_STYLE,
    lightPreset,
    initialViewState,
    camera,
    light,
    interaction,
    credits,
    creditDisclosure,
    onPress,
    onCameraChanged,
    onLabelsChange,
    onReady,
    onError,
    style,
    testID,
    children,
  } = props;
  const theme = useTheme();

  let styleUrl: string | null = null;
  let styleError: MapError | null = null;
  try {
    styleUrl = resolveStyleUrl(mapStyle, lightPreset, theme.isDark);
  } catch (cause) {
    styleError = { reason: 'style', message: String(cause) };
  }

  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);
  const [error, setError] = useState<MapError | null>(null);
  // Remounting the engine is the only reliable retry MapLibre Native offers:
  // a style that failed to load is not re-fetched by setting the same URL.
  const [retry, setRetry] = useState(0);
  const [credit, dispatchCredit] = useReducer(creditReducer, INITIAL_CREDIT_STATE);
  const [zoomLevel, setZoomLevel] = useState(() => Math.floor(openingZoom(initialViewState)));

  // The camera reports (`nativeCameraReports.ts`), one per ENGINE: a retry
  // gives the new engine its own, so a move the old one never finished cannot
  // stop the new one reporting the camera it opens at.
  const latestCameraListener = useRef(onCameraChanged);
  latestCameraListener.current = onCameraChanged;
  const [reports, setReports] = useState<NativeCameraReports>(() =>
    createNativeCameraReports(() => latestCameraListener.current),
  );

  const api = useMemo(() => createNativeMapApi(mapRef, cameraRef, () => reports), [reports]);
  useImperativeHandle(ref, () => api, [api]);

  const report = (next: MapError | null) => {
    setError(next);
    onError?.(next);
  };

  /**
   * A press, resolved against the basemap's own labels. Asynchronous where the
   * web is synchronous: the query runs inside the platform SDK. The CONTRACT
   * matches — the same padded box, the same ranking, the same event.
   *
   * A press on a `<Marker>` never gets here: a marker is a real native view and
   * its `Pressable` takes the touch.
   */
  const handlePress = (event: NativeSyntheticEvent<PressEvent>) => {
    dispatchCredit({ type: 'mapInteraction' });
    if (!onPress) return;
    const coordinate = fromLngLat(event.nativeEvent.lngLat);
    if (!isDrawableCoordinate(coordinate)) {
      reportMapDefect(
        'press:coordinate',
        'Ignored a map press: the engine reported a non-drawable coordinate.',
      );
      return;
    }
    const map = mapRef.current;
    const point = event.nativeEvent.point;
    if (!map || !styleUrl || !Array.isArray(point)) {
      onPress({ coordinate });
      return;
    }
    const [x, y] = point;
    void queryLayersForUrl(styleUrl)
      .then(async ({ tap }) => {
        if (tap.length === 0) return null;
        const features = await map.queryRenderedFeatures(
          [
            [x - LABEL_HIT_PAD_PX, y - LABEL_HIT_PAD_PX],
            [x + LABEL_HIT_PAD_PX, y + LABEL_HIT_PAD_PX],
          ],
          { layers: [...tap] },
        );
        const labels = labelCandidatesOf(queriedLabelsOf(features), coordinate);
        if (labels.length === 0) return null;
        // One projection per anchored candidate, gathered up front, so the
        // ranking runs against a plain lookup — the web's arithmetic.
        const projected = new Map<string, { x: number; y: number }>();
        await Promise.all(
          labels.map(async (candidate) => {
            if (!candidate.anchored) return;
            try {
              const [px, py] = await map.project(toLngLat(candidate.coordinate));
              projected.set(pointKey(candidate.coordinate), { x: px, y: py });
            } catch {
              // Unprojectable is ranked as unanchored, not dropped.
            }
          }),
        );
        return pickLabelFeature(
          labels,
          { x, y },
          (target) => projected.get(pointKey(target)) ?? null,
        );
      })
      .then((label) => onPress({ coordinate, ...(label ? { label } : {}) }))
      // A query the platform refused is a press on bare map, not a dead press.
      .catch(() => onPress({ coordinate }));
  };

  /**
   * The basemap's labels on the settled frame — `onRegionDidChange` is the
   * closest native has to the web's `idle`, so a label that appears as the
   * last tiles decode is reported on the NEXT settled frame.
   */
  const reportLabels = (centre: GeoCoordinate) => {
    const map = mapRef.current;
    if (!onLabelsChange || !map || !styleUrl || !isDrawableCoordinate(centre)) return;
    void queryLayersForUrl(styleUrl)
      .then(({ labels }) =>
        labels.length === 0 ? [] : map.queryRenderedFeatures({ layers: [...labels] }),
      )
      .then((features) => onLabelsChange(collectLabelFeatures(queriedLabelsOf(features), centre)))
      .catch(() => {
        // Leaving the previous set alone keeps the app's view stable across a hiccup.
      });
  };

  const handleStyleLoaded = () => {
    setError((current) => {
      if (current) onError?.(null);
      return null;
    });
    // The credit is spelled out at load and folds after a few seconds, or at
    // the reader's first interaction (`compactCredit.ts`).
    setTimeout(() => dispatchCredit({ type: 'elapsed' }), CREDIT_AUTO_COLLAPSE_MS);
    // The camera the map opened at, reported as settled — once per engine.
    reports.loaded(() => {
      const map = mapRef.current;
      if (!map) throw new Error('no engine');
      return map.getViewState();
    });
    onReady?.();
  };

  const handleStyleFailed = () => {
    // MapLibre Native reports a style or source failure as one event and
    // surfaces no per-tile errors to JS.
    report({ reason: 'style', message: 'Failed to load the map style.' });
  };

  const handleRetry = useCallback(() => {
    setError(null);
    onError?.(null);
    setReports(createNativeCameraReports(() => latestCameraListener.current));
    setRetry((count) => count + 1);
  }, [onError]);

  const noteZoom = (zoom: number) => {
    const level = Math.floor(zoom);
    if (Number.isFinite(level)) setZoomLevel(level);
  };

  // The reader moving the map folds the credit; the app moving it does not.
  const foldOnReaderMove = (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    if (event.nativeEvent.userInteraction) dispatchCredit({ type: 'mapInteraction' });
  };

  const gestures = resolveInteraction(interaction);
  const opening = openingViewState(initialViewState ?? targetView(camera));
  const stop = cameraStop(camera);
  const toggleCredit = useCallback(() => dispatchCredit({ type: 'toggle' }), []);
  const shownError = styleError ?? error;

  return (
    <View style={[styles.root, style]} testID={testID}>
      {styleUrl ? (
        <NativeMap
          key={retry}
          ref={mapRef}
          style={styles.fill}
          mapStyle={styleUrl}
          dragPan={gestures.pan}
          touchZoom={gestures.zoom}
          touchRotate={gestures.rotate}
          touchPitch={gestures.pitch}
          // The credit is `MapAttribution`, drawn below on every map.
          attribution={false}
          logo={false}
          light={light ? (light as LightSpecification) : undefined}
          compass={gestures.rotate}
          compassPosition={{ top: 8, right: 8 }}
          onPress={handlePress}
          onRegionWillChange={(event) => reports.regionWillChange(event.nativeEvent)}
          onRegionIsChanging={(event) => {
            foldOnReaderMove(event);
            noteZoom(event.nativeEvent.zoom);
            reports.regionIsChanging(event.nativeEvent);
          }}
          onRegionDidChange={(event) => {
            foldOnReaderMove(event);
            noteZoom(event.nativeEvent.zoom);
            // `false`: one frame of an animation the app drives — not settled.
            if (!reports.regionDidChange(event.nativeEvent)) return;
            const [longitude, latitude] = event.nativeEvent.center;
            reportLabels({ latitude, longitude });
          }}
          onDidFinishLoadingStyle={handleStyleLoaded}
          onDidFailLoadingMap={handleStyleFailed}
        >
          <NativeCamera ref={cameraRef} initialViewState={opening} {...stop} />
          <MapRefContext.Provider value={api}>
            <ZoomLevelContext.Provider value={zoomLevel}>{children}</ZoomLevelContext.Provider>
          </MapRefContext.Provider>
        </NativeMap>
      ) : null}
      {/* Both unconditional, with no prop to turn either off: the mark and the
          credit are on every map (`MapBrand.tsx`, `MapAttribution.tsx`). */}
      <MapBrand />
      <MapAttribution
        extra={credits}
        disclosure={creditDisclosure ?? null}
        expanded={credit.expanded}
        onToggle={toggleCredit}
      />
      {shownError ? <MapErrorState error={shownError} onRetry={handleRetry} /> : null}
    </View>
  );
});

/**
 * The camera's target as MapLibre Native's camera stop props. A box with no
 * area is its centre at street zoom; an undrawable target is no target.
 */
function cameraStop(target: MapCameraTarget | undefined): Record<string, unknown> {
  if (!target || cameraTargetKey(target) === null) return {};
  const duration = asFinite(target.duration) ?? DEFAULT_CAMERA_DURATION_MS;
  if (target.bounds) {
    if (!isDrawableBounds(target.bounds)) {
      reportMapDefect('camera:bounds', `Ignored camera.bounds: ${describeNumbers(target.bounds)}.`);
      return {};
    }
    if (isDegenerateBounds(target.bounds)) {
      return {
        center: toLngLat(boundsCenter(target.bounds)),
        zoom: Math.min(asFinite(target.maxZoom) ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
        duration,
        easing: 'ease',
      };
    }
    const padding = resolvePadding(target.padding, DEFAULT_FIT_PADDING);
    return {
      bounds: toBoundsArray(target.bounds),
      ...(padding ? { padding } : {}),
      duration,
      easing: 'ease',
    };
  }
  if (target.center && isDrawableCoordinate(target.center)) {
    return {
      center: toLngLat(target.center),
      ...optionalScalar('zoom', target.zoom),
      duration,
      easing: 'ease',
    };
  }
  return {};
}

/** A camera target as an opening view, for a map given no `initialViewState`. */
function targetView(target: MapCameraTarget | undefined): MapInitialViewState | undefined {
  if (target?.bounds) {
    return {
      bounds: target.bounds,
      ...(target.padding !== undefined ? { padding: target.padding } : {}),
      ...(target.maxZoom !== undefined ? { maxZoom: target.maxZoom } : {}),
    };
  }
  if (target?.center) return { ...target.center, zoom: target.zoom ?? WORLD_VIEW.zoom };
  return undefined;
}

/** The opening view as MapLibre Native's `initialViewState`. */
function openingViewState(view: MapInitialViewState | undefined): Record<string, unknown> {
  if (view && 'bounds' in view) {
    if (!isDrawableBounds(view.bounds)) return worldView();
    if (isDegenerateBounds(view.bounds)) {
      return { center: toLngLat(boundsCenter(view.bounds)), zoom: DEGENERATE_FIT_ZOOM };
    }
    const padding = resolvePadding(view.padding, DEFAULT_FIT_PADDING);
    return { bounds: toBoundsArray(view.bounds), ...(padding ? { padding } : {}) };
  }
  if (view && isDrawableCoordinate(view)) {
    return {
      center: toLngLat(view),
      zoom: asFinite(view.zoom) ?? WORLD_VIEW.zoom,
      ...optionalScalar('bearing', view.bearing),
      ...optionalScalar('pitch', view.pitch),
    };
  }
  if (view)
    reportMapDefect('initialViewState', 'initialViewState is not drawable; opened on the world.');
  return worldView();
}

function worldView(): Record<string, unknown> {
  return { center: toLngLat(WORLD_VIEW), zoom: WORLD_VIEW.zoom };
}

function openingZoom(view: MapInitialViewState | undefined): number {
  if (!view) return WORLD_VIEW.zoom;
  if ('bounds' in view) return asFinite(view.maxZoom) ?? 10;
  return asFinite(view.zoom) ?? WORLD_VIEW.zoom;
}

/**
 * Key for the projected-position lookup: native projects one coordinate per
 * bridge call, so the ranking cannot ask for a position mid-comparison. Six
 * decimals is ~11 cm — finer than any two distinct POIs.
 */
function pointKey(coordinate: GeoCoordinate): string {
  return `${coordinate.longitude.toFixed(6)},${coordinate.latitude.toFixed(6)}`;
}

/** The native map's camera commands — the `MapViewRef` on iOS and Android. */
function createNativeMapApi(
  mapRef: { current: MapRef | null },
  cameraRef: { current: CameraRef | null },
  reports: () => NativeCameraReports,
): MapViewRef {
  const api: MapViewRef = {
    moveTo(target, options) {
      const camera = cameraRef.current;
      if (!camera) return false;
      const coordinate = isViewport(target)
        ? { latitude: target.latitude, longitude: target.longitude }
        : target;
      if (!isDrawableCoordinate(coordinate)) {
        reportMapDefect(
          'moveTo',
          `Ignored moveTo: target is not drawable (${describeNumbers(coordinate)}).`,
        );
        return false;
      }
      const viewport = isViewport(target) ? target : undefined;
      const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
      reports().commanded(options?.transient === true);
      const stop = {
        center: toLngLat(coordinate),
        ...optionalScalar('zoom', asFinite(options?.zoom) ?? asFinite(viewport?.zoom)),
        ...optionalScalar('bearing', asFinite(options?.bearing) ?? asFinite(viewport?.bearing)),
        ...optionalScalar('pitch', asFinite(options?.pitch) ?? asFinite(viewport?.pitch)),
      };
      if (duration <= 0) return runEngineCommand('jumpTo', () => camera.jumpTo(stop));
      return runEngineCommand('easeTo', () => camera.easeTo({ ...stop, duration, easing: 'ease' }));
    },
    fitBounds(bounds, options) {
      const camera = cameraRef.current;
      if (!camera) return;
      if (!isDrawableBounds(bounds)) {
        reportMapDefect(
          'fitBounds',
          `Ignored fitBounds: box is not drawable (${describeNumbers(bounds)}).`,
        );
        return;
      }
      const padding = resolvePadding(options?.padding, DEFAULT_FIT_PADDING);
      if (!padding) return;
      const maxZoom = asFinite(options?.maxZoom);
      const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
      reports().commanded(false);
      if (isDegenerateBounds(bounds)) {
        runEngineCommand('easeTo', () =>
          camera.easeTo({
            center: toLngLat(boundsCenter(bounds)),
            zoom: Math.min(maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
            duration,
          }),
        );
        return;
      }
      // The cap is `zoom` here and `maxZoom` on web, and ABSENT rather than
      // `undefined` on both (`optionalScalar`).
      runEngineCommand('fitBounds', () =>
        camera.fitBounds(toBoundsArray(bounds), {
          padding,
          duration,
          ...optionalScalar('zoom', maxZoom),
        }),
      );
    },
    fitCoordinates(coordinates, options) {
      const bounds = boundsOf(coordinates);
      if (bounds) api.fitBounds(bounds, options);
    },
    setBearing(bearing, options) {
      const heading = asFinite(bearing);
      if (heading === undefined) {
        reportMapDefect('setBearing', `Ignored setBearing: ${String(bearing)} is not a bearing.`);
        return;
      }
      const camera = cameraRef.current;
      if (!camera) return;
      reports().commanded(false);
      runEngineCommand('setStop', () =>
        camera.setStop({
          bearing: heading,
          duration: asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS,
          easing: 'ease',
        }),
      );
    },
    resetNorth(options) {
      const camera = cameraRef.current;
      if (!camera) return;
      reports().commanded(false);
      runEngineCommand('setStop', () =>
        camera.setStop({
          bearing: 0,
          pitch: 0,
          duration: asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS,
          easing: 'ease',
        }),
      );
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
    async getBounds(): Promise<GeoBoundingBox | null> {
      const map = mapRef.current;
      if (!map) return null;
      try {
        const [west, south, east, north] = await map.getBounds();
        return { west, south, east, north };
      } catch {
        return null;
      }
    },
  };
  return api;
}

const styles = StyleSheet.create({
  // `flexGrow`, not `flex: 1`: `flex: 1` is a zero flex BASIS (react-native-web
  // writes `flex: 1 1 0%`, and Yoga reads it the same way), which overrides a
  // caller's `height` and collapses a map in a scroll view or any parent of
  // auto height to nothing. Growing from its own size, the map fills a bounded
  // parent when given no size and keeps the one it is given.
  root: { flexGrow: 1, position: 'relative', overflow: 'hidden' },
  fill: { flex: 1 },
});

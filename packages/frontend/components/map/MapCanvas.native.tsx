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
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { View, type NativeSyntheticEvent } from 'react-native';
import {
  Camera,
  GeoJSONSource,
  Layer,
  Map as MapLibreMap,
  Marker,
  RasterDEMSource,
  UserLocation,
  type CameraRef,
  type MapRef,
  type PressEvent,
  type ViewStateChangeEvent,
} from '@maplibre/maplibre-react-native';
import * as Location from 'expo-location';
import { useTheme } from '@oxy.so/bloom/theme';
import { parseModelPlacement, type ModelPlacement } from '@goway.to/sdk';

import {
  resolveMapAnchors,
  resolveMapStyleUrl,
  resolveOwnsStyleDocument,
  resolveTerrainTileUrl,
} from '@/lib/map/provider';
import {
  HILLSHADE_BEFORE_LAYER_ID,
  hillshadeLayer,
  RELIEF_DEM,
  RELIEF_SOURCE_IDS,
} from '@/lib/map/style/relief';
import { boundsOf, isDegenerateBounds } from '@/lib/map/geo';
import { mapStyleDefinition, presetAppearance } from '@/lib/map/style/catalogue';
import { LABEL_LAYER_IDS, TAP_LAYER_IDS } from '@/lib/map/tapLayers';

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
import { useCompactCredit } from './useCompactCredit';
import { MapBrand } from './MapBrand';
import { MapErrorState } from './MapErrorState';
import { drawableModels, modelFallbackMarker, modelIdOfMarker } from './models';
import { createNativeCameraReports, type NativeCameraReports } from './nativeCameraReports';
import { useMapRelief } from './reliefFlags';
import {
  asFinite,
  describeNumbers,
  drawableMarkers,
  drawableOverlays,
  fromLngLat,
  isDrawableBounds,
  isDrawableCoordinate,
  isViewport,
  optionalScalar,
  reportMapDefect,
  resolveInteraction,
  resolveOverlayPaint,
  resolvePadding,
  runEngineCommand,
  toBoundsArray,
  toLngLat,
} from './shared';
import {
  DEFAULT_VIEWPORT,
  type GeoBounds,
  type GeoCoordinate,
  type MapApi,
  type MapCanvasError,
  type MapCanvasProps,
  type MapMarker,
  type ResolvedMapViewport,
} from './types';
import { useMapStyle } from './useMapStyle';
import { useSunLight } from './useSunLight';

/** Zoom used when a "fit" has nothing with area to fit — see `isDegenerateBounds`. */
const DEGENERATE_FIT_ZOOM = 15;
/** Default breathing room, in px, around a fitted box. */
const DEFAULT_FIT_PADDING = 48;
const DEFAULT_CAMERA_DURATION_MS = 500;

export const MapCanvas = forwardRef<MapApi, MapCanvasProps>(function MapCanvas(
  {
    initialViewport = DEFAULT_VIEWPORT,
    appearance,
    mapStyle,
    lightPreset,
    markers,
    renderMarker,
    overlays,
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
  // The data credit (`lib/map/compactCredit.ts`): spelled out once the style
  // has loaded, folded after five seconds or at the reader's first pan, zoom
  // or tap. Always rendered; nothing can switch it off.
  const [styleLoaded, setStyleLoaded] = useState(false);
  const credit = useCompactCredit(styleLoaded);
  const noteCreditInteraction = credit.noteInteraction;
  const mapRef = useRef<MapRef>(null);
  const cameraRef = useRef<CameraRef>(null);

  // Models (SDK_MAP_MODELS phase 1): native has no custom-layer API, so every
  // model is its fallback marker here — the same truthful pin the web fork
  // draws wherever it cannot draw the model. `moveModel` moves that marker.
  const drawnModels = useMemo(() => drawableModels(models), [models]);
  const [modelOverrides, setModelOverrides] = useState<ReadonlyMap<string, ModelPlacement>>(
    () => new globalThis.Map(),
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new `models` prop is exactly when overrides expire
  useEffect(() => {
    setModelOverrides(new globalThis.Map());
  }, [models]);
  const allMarkers = useMemo(() => {
    if (drawnModels.length === 0) return markers;
    const fallbacks = drawnModels.map(({ model, placement }) =>
      modelFallbackMarker(model, modelOverrides.get(model.id) ?? placement),
    );
    return [...(markers ?? []), ...fallbacks];
  }, [markers, drawnModels, modelOverrides]);
  // The camera reports (`nativeCameraReports.ts`), read through a ref so a
  // new `onViewportChange` from a parent render reaches them. One per ENGINE:
  // `retry` remounts the engine and gives it a new one, so nothing the old
  // engine was doing (a move it never finished) stops the new one reporting
  // the camera it opens at.
  const viewportListener = useRef(onViewportChange);
  viewportListener.current = onViewportChange;
  const cameraReports = useRef<NativeCameraReports | null>(null);
  cameraReports.current ??= createNativeCameraReports(() => viewportListener.current);

  const [error, setError] = useState<MapCanvasError | null>(null);
  // Remounting the engine is the only reliable retry MapLibre Native offers:
  // a style that failed to load is not re-fetched by setting the same URL.
  const [reloadKey, setReloadKey] = useState(0);

  // A camera the engine cannot build is not a reason to have no map; the world
  // view is a truthful starting frame. Identical to the web fork.
  const start = isDrawableCoordinate(initialViewport) ? initialViewport : DEFAULT_VIEWPORT;
  if (start !== initialViewport) {
    reportMapDefect(
      'viewport:initial',
      'initialViewport is not drawable; opened on the default camera.',
    );
  }

  // The style and its light (`useMapStyle.ts`), exactly as on the web.
  const mapStyleState = useMapStyle({ style: mapStyle, lightPreset, appearance }, start);
  const { style: styleId, preset: stylePreset } = mapStyleState.selection;
  const settleMapStyle = mapStyleState.settle;
  const resolvedAppearance = presetAppearance(stylePreset);
  const styleDrawsRelief = mapStyleDefinition(styleId).relief === true;
  const styleUrl = useMemo(
    () => resolveMapStyleUrl({ style: styleId, preset: stylePreset }),
    [styleId, stylePreset],
  );
  // `undefined` when the loaded style makes no anchor promise; `<Layer>`
  // then appends on top, which is what native did before GoWay owned a style.
  const overlayAnchor = useMemo(() => resolveMapAnchors().beforeLabels, []);
  // The relief prototype's hillshade, under `water` — only on GoWay's own style,
  // which promises that layer (`docs/MAP_TERRAIN_GLOBE.md`). The rest of the
  // relief (globe, 3D terrain, sky) has no API in maplibre-react-native 11.4.
  // A toggle in the settings modal adds or removes it live.
  const { terrain } = useMapRelief();
  const hillshade = useMemo(
    () =>
      // A style with its own relief (Outdoors) already shades the ground.
      terrain && resolveOwnsStyleDocument() && !styleDrawsRelief
        ? hillshadeLayer(resolvedAppearance)
        : null,
    [terrain, resolvedAppearance, styleDrawsRelief],
  );
  const gestures = resolveInteraction(interaction);

  // The buildings' light, aimed from the sun over the viewport centre — the
  // same hook, triggers and dedupe as the web fork. Seeded with the opening
  // camera so the first render already carries it. See `useSunLight.ts`.
  //
  // The engine id is `reloadKey` alone, because that is the only thing that
  // remounts `<Map>` here: a retry, which brings the camera back to `start`.
  // An appearance change does NOT rebuild the native engine — `mapStyle` is a
  // prop on the same view and the camera survives it — so it must not reset
  // the centre either. Whether MapLibre Native reports the remounted camera
  // through `onRegionDidChange` is up to each platform SDK (Android's
  // camera-idle listener, iOS's `regionDidChange`); the id makes the reset
  // not depend on it.
  const sunLight = useSunLight(resolvedAppearance, String(reloadKey), start);

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
        if (!camera) return false;
        const coordinate = isViewport(target)
          ? { latitude: target.latitude, longitude: target.longitude }
          : target;
        // Same rule as the web fork — see `shared.ts` → `isDrawableCoordinate`.
        // The engine differs; the contract the two forks present does not.
        if (!isDrawableCoordinate(coordinate)) {
          reportMapDefect(
            'moveTo',
            `Ignored moveTo: target is not drawable (${describeNumbers(coordinate)}).`,
          );
          return false;
        }
        const viewport = isViewport(target) ? target : undefined;
        // Same rule as web: `undefined` means "leave this axis alone", which is
        // what a NaN was silently NOT doing. See `shared.ts` -> `asFinite`.
        const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
        cameraReports.current?.commanded(options?.transient === true);
        const stop = {
          center: toLngLat(coordinate),
          zoom: asFinite(options?.zoom) ?? asFinite(viewport?.zoom),
          bearing: asFinite(options?.bearing) ?? asFinite(viewport?.bearing),
          pitch: asFinite(options?.pitch) ?? asFinite(viewport?.pitch),
        };
        if (duration <= 0) {
          return runEngineCommand('jumpTo', () => camera.jumpTo(stop));
        }
        return runEngineCommand('easeTo', () =>
          camera.easeTo({ ...stop, duration, easing: 'ease' }),
        );
      },
      fitBounds(bounds, options) {
        const camera = cameraRef.current;
        if (!camera) return;
        // Before `isDegenerateBounds`, which answers `false` for a NaN box
        // because every comparison against NaN is false.
        if (!isDrawableBounds(bounds)) {
          reportMapDefect(
            'fitBounds',
            `Ignored fitBounds: box is not drawable (${describeNumbers(bounds)}).`,
          );
          return;
        }
        const fitPadding = resolvePadding(options?.padding, DEFAULT_FIT_PADDING);
        if (!fitPadding) return;
        const maxZoom = asFinite(options?.maxZoom);
        const duration = asFinite(options?.duration) ?? DEFAULT_CAMERA_DURATION_MS;
        cameraReports.current?.commanded(false);
        if (isDegenerateBounds(bounds)) {
          runEngineCommand('easeTo', () =>
            camera.easeTo({
              center: [(bounds.west + bounds.east) / 2, (bounds.south + bounds.north) / 2],
              zoom: Math.min(maxZoom ?? DEGENERATE_FIT_ZOOM, DEGENERATE_FIT_ZOOM),
              duration,
            }),
          );
          return;
        }
        // The cap is `zoom` here and `maxZoom` on web, and it is ABSENT rather
        // than `undefined` on both: see `shared.ts` -> `optionalScalar` for what
        // writing the key cost the web fork. The two forks must agree about what
        // "the caller did not ask for a maximum" means.
        runEngineCommand('fitBounds', () =>
          camera.fitBounds(toBoundsArray(bounds), {
            padding: fitPadding,
            duration,
            ...optionalScalar('zoom', maxZoom),
          }),
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
        const camera = cameraRef.current;
        if (!camera) return;
        cameraReports.current?.commanded(false);
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
        cameraReports.current?.commanded(false);
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
      moveModel(id, input) {
        const placement = parseModelPlacement(input);
        if (!placement) {
          reportMapDefect(
            `moveModel:${id}`,
            `Ignored moveModel("${id}"): the placement does not parse.`,
          );
          return;
        }
        setModelOverrides((current) => new globalThis.Map(current).set(id, placement));
      },
    }),
    [],
  );

  useImperativeHandle(ref, () => api, [api]);

  // --- Events -------------------------------------------------------------

  /**
   * A tap, resolved against the basemap's own labels.
   *
   * Asynchronous where the web fork is synchronous, and unavoidably so: the
   * query runs inside the platform SDK and the answer comes back over the
   * bridge. The CONTRACT is what has to match, and it does — the same padded
   * box, the same `pickLabelFeature` ranking, the same `MapPressEvent`. The
   * one-frame delay is invisible against a sheet that animates anyway.
   *
   * Hit priority's first step needs no code here. A `<Marker>` on native is a
   * real React Native view, so its `Pressable` consumes the touch and the map's
   * own gesture recogniser never sees it — which is exactly the guarantee the
   * web fork has to reconstruct by hand, because a `maplibregl.Marker` is a DOM
   * child of the canvas container and its clicks bubble.
   */
  const handlePress = useCallback(
    (event: NativeSyntheticEvent<PressEvent>) => {
      noteCreditInteraction();
      const press = onPress;
      if (!press) return;
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
      if (!map || !Array.isArray(point)) {
        press({ coordinate });
        return;
      }
      const [x, y] = point;
      void map
        .queryRenderedFeatures(
          [
            [x - LABEL_HIT_PAD_PX, y - LABEL_HIT_PAD_PX],
            [x + LABEL_HIT_PAD_PX, y + LABEL_HIT_PAD_PX],
          ],
          { layers: [...TAP_LAYER_IDS] },
        )
        .then(async (features) => {
          // Anchoring is pure geometry and runs here, synchronously, for every
          // candidate — including the streets and rivers, whose anchor is the
          // nearest point on the way. That is the whole reason `labels.ts`
          // anchors in a local planar frame rather than in screen pixels:
          // projecting every vertex of every street in the box would be one
          // bridge call each, and there is no affordable version of that.
          const labels = labelCandidatesOf(queriedLabelsOf(features), coordinate);
          if (labels.length === 0) {
            press({ coordinate });
            return;
          }
          // One projection per candidate, gathered up front, so the ranking can
          // run against a plain lookup — identical arithmetic to web's.
          const projected = new Map<string, { x: number; y: number }>();
          await Promise.all(
            labels.map(async (candidate) => {
              if (!candidate.anchored) return;
              try {
                const [px, py] = await map.project([
                  candidate.coordinate.longitude,
                  candidate.coordinate.latitude,
                ]);
                projected.set(pointKey(candidate.coordinate), { x: px, y: py });
              } catch {
                // Unprojectable is ranked as unanchored, not dropped: the
                // engine drew it.
              }
            }),
          );
          const label = pickLabelFeature(
            labels,
            { x, y },
            (target) => projected.get(pointKey(target)) ?? null,
          );
          press({ coordinate, ...(label ? { label } : {}) });
        })
        .catch(() => {
          // A query the platform refused is a tap on bare map, not a dead tap.
          press({ coordinate });
        });
    },
    [onPress, noteCreditInteraction],
  );

  /**
   * Report what the basemap is currently labelling, on the settled frame.
   *
   * `onRegionDidChange` is the closest native has to web's `idle`; there is no
   * event for "the collision system has finished placing". The consequence is
   * honest and small: a label that appears as the last tiles decode is reported
   * on the NEXT settled frame rather than this one.
   */
  const reportLabels = useCallback(
    (centre: GeoCoordinate) => {
      const report = onLabelsChange;
      const map = mapRef.current;
      if (!report || !map || !isDrawableCoordinate(centre)) return;
      void map
        .queryRenderedFeatures({ layers: [...LABEL_LAYER_IDS] })
        .then((features) => {
          report(collectLabelFeatures(queriedLabelsOf(features), centre));
        })
        .catch(() => {
          // Nothing to report is not the same as reporting nothing: leaving the
          // previous set alone keeps suppression stable across a hiccup.
        });
    },
    [onLabelsChange],
  );

  const handleStyleLoaded = useCallback(() => {
    setStyleLoaded(true);
    setError(null);
    // The camera the map opened at, reported as settled — once per engine,
    // by the rule both forks share (`loadedCamera.ts`). MapLibre Native may
    // or may not follow its first frame with `onRegionDidChange`, and a
    // caller cannot depend on a maybe.
    cameraReports.current?.loaded(() => {
      const map = mapRef.current;
      if (!map) throw new Error('no engine');
      return map.getViewState();
    });
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
    cameraReports.current = createNativeCameraReports(() => viewportListener.current);
    setReloadKey((key) => key + 1);
  }, []);

  // The reader moving the map folds the credit; the app moving it does not.
  const foldOnReaderMove = (event: NativeSyntheticEvent<ViewStateChangeEvent>) => {
    if (event.nativeEvent.userInteraction) noteCreditInteraction();
  };

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
        // MapLibre Native has no imperative `setLight`; v11 takes the style's
        // light as a PROP on `<Map>` (typed `LightSpecification`). Verified in
        // the installed 11.4.1 source, not assumed: both platforms re-apply it
        // when the prop changes AND after every `onDidFinishLoadingStyle`, so a
        // style swap or a retry gets it back without anything here. iOS
        // replaces the whole light, Android sets only the keys given — GoWay
        // always gives all four, so they agree. `undefined` (a style GoWay does
        // not own) leaves the document's light untouched.
        light={sunLight.light ?? undefined}
        compass={gestures.rotate}
        compassPosition={{ top: 8, right: 8 }}
        onPress={handlePress}
        onRegionWillChange={(event) => cameraReports.current?.regionWillChange(event.nativeEvent)}
        onRegionIsChanging={(event) => {
          foldOnReaderMove(event);
          cameraReports.current?.regionIsChanging(event.nativeEvent);
        }}
        onRegionDidChange={(event) => {
          foldOnReaderMove(event);
          // `false`: one frame of a flyover — in progress, not settled.
          if (!cameraReports.current?.regionDidChange(event.nativeEvent)) return;
          // The settled frame is also when the basemap's labels are worth
          // re-reading — see `reportLabels`.
          const [longitude, latitude] = event.nativeEvent.center;
          reportLabels({ latitude, longitude });
          // And when the sun is re-read for the new centre: once per settle,
          // never on `onRegionIsChanging`. Unconditional, unlike the label
          // report — the embed passes no callbacks and is lit all the same.
          sunLight.settle({ latitude, longitude });
          settleMapStyle({ latitude, longitude });
        }}
        onDidFinishLoadingStyle={handleStyleLoaded}
        onDidFailLoadingMap={handleStyleFailed}
      >
        <Camera
          ref={cameraRef}
          initialViewState={{
            center: toLngLat(start),
            zoom: asFinite(start.zoom) ?? DEFAULT_VIEWPORT.zoom,
            bearing: asFinite(start.bearing),
            pitch: asFinite(start.pitch),
          }}
        />

        {showUserLocation && locationGranted ? <UserLocation animated /> : null}

        {hillshade ? (
          <RasterDEMSource
            id={RELIEF_SOURCE_IDS.hillshade}
            tiles={[resolveTerrainTileUrl()]}
            encoding={RELIEF_DEM.encoding}
            tileSize={RELIEF_DEM.tileSize}
            minzoom={RELIEF_DEM.minzoom}
            maxzoom={RELIEF_DEM.maxzoom}
          >
            <Layer {...hillshade} beforeId={HILLSHADE_BEFORE_LAYER_ID} />
          </RasterDEMSource>
        ) : null}

        {/*
          Overlays sit UNDER the labels, so a route line never covers a street
          name. MapLibre Native cannot hand the loaded style back to JS, so
          there is no first-symbol-layer to derive the way the web fork does —
          the anchor has to be something the style PROMISES. GoWay's own style
          document reserves one (`lib/map/provider.ts` →
          `MapSourceIds.anchors.beforeLabels`), which is what finally closes the
          platform difference. An `undefined` anchor — a style GoWay did not
          author, e.g. the `openfreemap` fallback — restores the old behaviour
          of appending on top.
        */}
        {/* Raw GeoJSON fails SILENTLY rather than loudly — a NaN vertex tiles
            to nothing and the route line is simply absent. Same rule, same
            helper, as the web fork. See `shared.ts` -> `drawableOverlays`. */}
        {drawableOverlays(overlays).map((overlay) => {
          if (overlay.visible === false) return null;
          const paint = resolveOverlayPaint(overlay.kind, overlay.paint, accent);
          return (
            <GeoJSONSource key={overlay.id} id={`goway:src:${overlay.id}`} data={overlay.data}>
              {overlay.kind === 'line' ? (
                <Layer
                  id={`goway:line:${overlay.id}`}
                  beforeId={overlayAnchor}
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
                  beforeId={overlayAnchor}
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
                  beforeId={overlayAnchor}
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

        {/* Undrawable pins are dropped rather than handed to the engine — see
            `shared.ts` → `isDrawableCoordinate`. Identical to the web fork. */}
        {drawableMarkers(allMarkers).map((marker: MapMarker) => {
          const modelId = modelIdOfMarker(marker.id);
          const model =
            modelId === null
              ? undefined
              : drawnModels.find((entry) => entry.model.id === modelId)?.model;
          return (
            <Marker
              key={marker.id}
              id={marker.id}
              lngLat={toLngLat(marker.coordinate)}
              anchor="bottom"
              selected={marker.selected}
            >
              <View>
                {modelId !== null ? (
                  // A model's stand-in: the canvas's own marker, pressing it presses the model.
                  <DefaultMapMarker
                    marker={marker}
                    onPress={() => (model ? onModelPress?.(model) : undefined)}
                  />
                ) : renderMarker ? (
                  renderMarker(marker)
                ) : (
                  <DefaultMapMarker marker={marker} onPress={() => onMarkerPress?.(marker)} />
                )}
              </View>
            </Marker>
          );
        })}
      </MapLibreMap>

      {/* Both are unconditional and neither takes a prop: the brand and the
          credit must be on every map GoWay draws, including the embed in
          somebody else's page. See MapBrand.tsx. */}
      <MapBrand />
      <MapAttribution
        elevation={styleDrawsRelief}
        expanded={credit.expanded}
        onToggle={credit.toggle}
      />

      {error ? <MapErrorState error={error} onRetry={retry} /> : null}
    </View>
  );
});

// ---------------------------------------------------------------------------
// Basemap labels
// ---------------------------------------------------------------------------

/**
 * The platform's GeoJSON features, with the platform removed.
 *
 * Native returns plain GeoJSON, so `sourceLayer` arrives as a property rather
 * than as a field on the feature the way maplibre-gl hands it over. Both
 * spellings are accepted because the two platform SDKs do not agree about it,
 * and a feature this cannot classify is dropped rather than guessed at — the
 * source-layer is what decides whether a hit is a POI or a district, and being
 * wrong about that opens the wrong sheet.
 */
function queriedLabelsOf(features: readonly GeoJSON.Feature[]): QueriedLabel[] {
  const out: QueriedLabel[] = [];
  for (const feature of features) {
    const properties = (feature.properties ?? {}) as Readonly<Record<string, unknown>>;
    const sourceLayer = sourceLayerOf(feature, properties);
    if (!sourceLayer || !isLabelSourceLayer(sourceLayer)) continue;
    const geometry = feature.geometry;
    const coordinate =
      geometry?.type === 'Point'
        ? { longitude: geometry.coordinates[0], latitude: geometry.coordinates[1] }
        : null;
    out.push({
      featureId: feature.id ?? null,
      sourceLayer,
      properties,
      coordinate,
      // A street or a river is a LINE: `labels.ts` anchors it at the point on
      // the way the user pointed at. Identical to the web fork.
      path: pathOf(geometry),
    });
  }
  return out;
}

function sourceLayerOf(
  feature: GeoJSON.Feature,
  properties: Readonly<Record<string, unknown>>,
): string | null {
  const direct = (feature as { sourceLayer?: unknown }).sourceLayer;
  if (typeof direct === 'string' && direct) return direct;
  for (const key of ['source-layer', 'sourceLayer', 'layer']) {
    const value = properties[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

/** A line feature's vertices, capped. Identical to the web fork. */
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
 * Key for the projected-position lookup.
 *
 * Native projects one coordinate per bridge call, so the ranking cannot ask for
 * a position mid-comparison the way web's synchronous `map.project` lets it.
 * Six decimals is ~11 cm — finer than any two distinct POIs, coarse enough that
 * the same coordinate always produces the same key.
 */
function pointKey(coordinate: GeoCoordinate): string {
  return `${coordinate.longitude.toFixed(6)},${coordinate.latitude.toFixed(6)}`;
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

/**
 * `MapCanvas`, web — GoWay's map, composed on `@goway.to/maps`.
 *
 * The SDK draws the map every app gets: the style and its light, the camera,
 * the markers, sources and layers, the mark and the credit. This composes
 * GoWay's own on top: its style choices and the sun's light, the explore
 * screen's markers and overlays, 3D models with their fallback markers, and
 * the engine features only GoWay draws — the 3D city and its sky, the relief,
 * GoWay Live, camera clearance, the clock and the performance runtime — which
 * reach the engine as ONE plugin (`gowayEngine.web.ts`) through `<MapPlugin>`.
 * No effect here binds anything to the engine: what changes is a prop.
 */
import {
  forwardRef,
  lazy,
  Suspense,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { StyleSheet, View } from 'react-native';
import {
  DefaultMapMarker,
  GeoJSONSource,
  Layer,
  MapPlugin,
  type MapMarkerData,
  type MapMarkerItem,
  Markers,
  MapView,
  type MapViewRef,
  UserLocation,
} from '@goway.to/maps';
import { useTheme } from '@oxy.so/bloom/theme';
import { parseModelPlacement, type ModelPlacement } from '@goway.to/sdk';

import { maxPitchFor } from '@/lib/map/citySkyFlag';
import {
  overlayLayerId,
  overlaySourceId,
  resolveMapAnchors,
  resolveMapStyleUrl,
  TERRAIN_ATTRIBUTION_LINK,
  type MapAttributionLink,
} from '@/lib/map/provider';
import type { ImageryView } from '@/lib/map/imageryCoverage';
import { clampPixelRatio } from '@/lib/map/quality/profile';
import { useMapQuality } from '@/lib/map/quality/useMapQuality';
import { mapStyleDefinition, presetAppearance } from '@/lib/map/style/catalogue';
import { litInstant } from '@/lib/map/timeOfDayControl';
import { useMapFeature } from '@/lib/map/useMapFeatures';

import { type GoWayEngineProps, gowayEngine, preloadRelief } from './gowayEngine.web';
import { drawableModels, modelFallbackMarker, modelIdOfMarker } from './models';
import { markerData, markerItem } from './markerItems';
import { drawableOverlays, overlayStyle } from './overlays';
import { initialMapRelief, useMapRelief } from './reliefFlags';
import {
  DEFAULT_VIEWPORT,
  type MapApi,
  type MapCameraChange,
  type MapCanvasProps,
  type MapCreditDisclosure,
  type MapLiveLayer,
  type MapMarker,
} from './types';
import { useImageryCredits } from './useImageryCredits';
import { useMapStyle } from './useMapStyle';
import { useSunLight } from './useSunLight';

// Requested at module evaluation when this page draws either relief feature —
// long before any style document arrives.
preloadRelief(initialMapRelief());

/**
 * The perf HUD: only with `?perf=1`, in any build — never by default (it
 * covers the map, and its GL counters cost main-thread time).
 */
const PERF_HUD =
  typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('perf') === '1';

/** The time-of-day scrubber is its own lazy chunk, fetched only once it is opened. */
const TimeOfDayScrubber = lazy(() => import('./TimeOfDayScrubber.web'));

const NO_LINKS: readonly MapAttributionLink[] = [];
const NO_DRAWN: ReadonlySet<string> = new Set();

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
  const mapRef = useRef<MapViewRef>(null);

  // The optional features, live: a toggle in the settings modal re-renders
  // this, and the engine plugin attaches, detaches or rebuilds accordingly.
  const buildings = useMapFeature('city3d');
  const cityTiles = useMapFeature('cityTiles');
  const trees = useMapFeature('city3dTrees');
  const treeFill = useMapFeature('city3dTreeFill');
  const cityLife = useMapFeature('cityLife');
  const landmarks = useMapFeature('landmarks');
  const detailed = useMapFeature('detailedCity');
  const streets = useMapFeature('cityStreets');
  const sky = useMapFeature('citySky');
  const city = useMemo(
    () => ({ buildings, cityTiles, trees, treeFill, cityLife, landmarks, detailed, streets, sky }),
    [buildings, cityTiles, trees, treeFill, cityLife, landmarks, detailed, streets, sky],
  );
  const relief = useMapRelief();
  const quality = useMapQuality();

  // The style and its light: the screen's, or this device's choice.
  const mapStyleState = useMapStyle({ style: mapStyle, lightPreset, appearance }, initialViewport);
  const { style: styleId, preset: stylePreset } = mapStyleState.selection;
  const settleMapStyle = mapStyleState.settle;
  const resolvedAppearance = presetAppearance(stylePreset);
  const definition = mapStyleDefinition(styleId);
  const styleUrl = useMemo(
    () => resolveMapStyleUrl({ style: styleId, preset: stylePreset }),
    [styleId, stylePreset],
  );
  // The buildings' light, aimed from the sun over the settled camera. The
  // map keeps its camera across a new style, so the tracker keeps its centre.
  const sunLight = useSunLight(resolvedAppearance, 'goway-map', initialViewport);
  const settleSunLight = sunLight.settle;

  // --- What the engine plugin tells the canvas ---------------------------
  const [skyActive, setSkyActive] = useState(false);
  const [sunAltitude, setSunAltitude] = useState<number | null>(null);
  const [cityLifeDisclosure, setCityLifeDisclosure] = useState<MapCreditDisclosure | null>(null);
  const [landmarkCredits, setLandmarkCredits] = useState<readonly MapAttributionLink[]>(NO_LINKS);
  const [cityCredits, setCityCredits] = useState<readonly MapAttributionLink[]>(NO_LINKS);
  const [modelsDrawn, setModelsDrawn] = useState<ReadonlySet<string>>(NO_DRAWN);
  const moveModelInEngine = useRef<((id: string, placement: ModelPlacement) => void) | null>(null);

  // --- Models: drawn in 3D where they can be, as their marker elsewhere ---
  const drawnModels = useMemo(() => drawableModels(models), [models]);
  // `moveModel` overrides hold until the `models` prop changes.
  const [overrides, setOverrides] = useState<{
    models: typeof models;
    placements: ReadonlyMap<string, ModelPlacement>;
  }>({ models, placements: new Map() });
  if (overrides.models !== models) setOverrides({ models, placements: new Map() });
  const placements = overrides.models === models ? overrides.placements : null;
  const engineModels = useMemo(
    () =>
      drawnModels.flatMap(({ model, placement, url }) =>
        url === null
          ? []
          : [
              {
                id: model.id,
                url,
                placement,
                sizing: model.sizing ?? { mode: 'world' as const },
                minZoom: finite(model.minZoom) ?? 0,
                maxZoom: finite(model.maxZoom) ?? 24,
                occlusion: model.occlusion ?? 'buildings',
                ...(model.tint ? { tint: model.tint } : {}),
              },
            ],
      ),
    // A drawn model's `moveModel` overrides reach the engine directly, without
    // a render per frame; a new `models` prop (which drops them) rebuilds this.
    [drawnModels],
  );

  // The caller's markers plus a fallback marker for every model not drawn in
  // 3D right now (loading, failed, outside its zoom window, no engine).
  const allMarkers = useMemo(() => {
    const fallbacks: MapMarker[] = [];
    for (const { model, placement, url } of drawnModels) {
      if (url !== null && modelsDrawn.has(model.id)) continue;
      const moved = placements?.get(model.id);
      fallbacks.push(modelFallbackMarker(model, moved ?? placement));
    }
    return fallbacks.length === 0 ? (markers ?? []) : [...(markers ?? []), ...fallbacks];
  }, [markers, drawnModels, modelsDrawn, placements]);
  const markersById = useMemo(
    () => new Map(allMarkers.map((marker) => [marker.id, marker])),
    [allMarkers],
  );

  // --- The time of day ----------------------------------------------------
  // Shown only while the sky draws; shut, the map goes back to now, and opened
  // again it starts from now rather than from the last time it showed.
  const timeOfDayShown = timeOfDayOpen && city.sky && skyActive;
  const [chosenSkyAt, setSkyAt] = useState<Date | null>(null);
  if (!timeOfDayShown && chosenSkyAt !== null) setSkyAt(null);
  const skyAt = litInstant(timeOfDayShown, chosenSkyAt);

  // --- Credits owed while something is drawn -----------------------------
  const [imageryView, setImageryView] = useState<ImageryView | null>(null);
  const imageryMode = definition.imagery ?? null;
  const imageryCredits = useImageryCredits(imageryMode, imageryView);
  const liveCredits = useLiveCredits(live ?? null);
  const elevation = relief.terrain || definition.relief === true;
  const credits = useMemo(
    () => [
      ...(elevation ? [TERRAIN_ATTRIBUTION_LINK] : []),
      ...imageryCredits,
      ...landmarkCredits,
      ...cityCredits,
      ...liveCredits,
    ],
    [elevation, imageryCredits, landmarkCredits, cityCredits, liveCredits],
  );

  // --- The engine plugin's props ------------------------------------------
  const engineCallbacks = useMemo(
    () => ({
      onModelStatus: (id: string, status: 'drawn' | 'fallback') =>
        setModelsDrawn((current) => {
          if ((status === 'drawn') === current.has(id)) return current;
          const next = new Set(current);
          if (status === 'drawn') next.add(id);
          else next.delete(id);
          return next;
        }),
      onModelPress: (id: string) => {
        const entry = drawnModels.find((candidate) => candidate.model.id === id);
        if (entry) onModelPress?.(entry.model);
      },
      onLandmarkCredits: (links: readonly MapAttributionLink[]) =>
        setLandmarkCredits(links.length === 0 ? NO_LINKS : links),
      onCityCredits: (links: readonly MapAttributionLink[]) =>
        setCityCredits(links.length === 0 ? NO_LINKS : links),
      onCityLife: (disclosure: MapCreditDisclosure | null) =>
        setCityLifeDisclosure((current) =>
          sameDisclosure(current, disclosure) ? current : disclosure,
        ),
      // The screen's time-of-day control exists only while there is a sky.
      onSkyActive: (active: boolean) => {
        setSkyActive(active);
        onSkyActiveChange?.(active);
      },
      onSunAltitude: (altitude: number) => setSunAltitude(altitude),
      onModelMover: (move: ((id: string, placement: ModelPlacement) => void) | null) => {
        moveModelInEngine.current = move;
      },
    }),
    [drawnModels, onModelPress, onSkyActiveChange],
  );
  const engineProps = useMemo<GoWayEngineProps>(
    () => ({
      quality,
      relief,
      appearance: resolvedAppearance,
      style: { style: styleId, preset: stylePreset },
      styleFollowsLight: definition.light === 'follows',
      city,
      light: sunLight.light,
      skyAt,
      models: engineModels,
      live: live ?? null,
      perfHud: PERF_HUD,
      ...engineCallbacks,
    }),
    [
      quality,
      relief,
      resolvedAppearance,
      styleId,
      stylePreset,
      definition.light,
      city,
      sunLight.light,
      skyAt,
      engineModels,
      live,
      engineCallbacks,
    ],
  );

  // --- The camera, as the screen and GoWay's own trackers hear it --------
  const handleCameraChanged = useCallback(
    (change: MapCameraChange) => {
      onViewportChange?.(change);
      if (!change.isFinal) return;
      // The settled camera is when the sun and a sun-following style are
      // re-read for the new centre — never per frame.
      const centre = { latitude: change.viewport.latitude, longitude: change.viewport.longitude };
      settleSunLight(centre);
      settleMapStyle(centre);
      // The imagery sources on screen, re-read at every settled camera.
      if (imageryMode) setImageryView({ zoom: change.viewport.zoom, ...change.bounds });
    },
    [onViewportChange, settleSunLight, settleMapStyle, imageryMode],
  );

  // --- The canvas's handle ------------------------------------------------
  useImperativeHandle(
    ref,
    (): MapApi => ({
      moveTo: (target, options) => mapRef.current?.moveTo(target, options) ?? false,
      fitBounds: (bounds, options) => mapRef.current?.fitBounds(bounds, options),
      fitCoordinates: (coordinates, options) =>
        mapRef.current?.fitCoordinates(coordinates, options),
      setBearing: (bearing, options) => mapRef.current?.setBearing(bearing, options),
      resetNorth: (options) => mapRef.current?.resetNorth(options),
      getViewport: async () => (await mapRef.current?.getViewport()) ?? null,
      getBounds: async () => (await mapRef.current?.getBounds()) ?? null,
      captureFrames: (draw) => mapRef.current?.captureFrames?.(draw) ?? (() => {}),
      moveModel(id, input) {
        const placement = parseModelPlacement(input);
        if (!placement) return;
        // The 3D model moves in the engine without a render; its fallback
        // marker, if that is what shows, moves with the override.
        moveModelInEngine.current?.(id, placement);
        setOverrides((current) => {
          const next = new Map(current.placements);
          next.set(id, placement);
          return { models: current.models, placements: next };
        });
      },
    }),
    [],
  );

  // --- Markers: GoWay's, drawn by the SDK ---------------------------------
  // Places may gather into Bloom's cluster bubble (by `@goway.to/maps`'s
  // clustering, never the selected one); everything else is always a pin.
  const { clustered, pinned, selectedId } = useMemo(() => {
    const gathered: MapMarkerData[] = [];
    const alone: MapMarkerData[] = [];
    let selected: string | null = null;
    for (const marker of allMarkers) {
      (marker.clustered ? gathered : alone).push(markerData(marker));
      if (marker.clustered && marker.selected) selected = marker.id;
    }
    return { clustered: gathered, pinned: alone, selectedId: selected };
  }, [allMarkers]);
  const drawMarker = useCallback(
    (item: MapMarkerItem, press: () => void) => {
      // A cluster is Bloom's bubble; pressing it opens it where it splits.
      if (item.kind === 'cluster') return <DefaultMapMarker item={item} onPress={press} />;
      const marker = markersById.get(item.marker.id);
      if (!marker) return null;
      // A model's stand-in is the canvas's own marker, never the caller's
      // `renderMarker`, and pressing it is pressing the model.
      const modelId = modelIdOfMarker(marker.id);
      if (modelId !== null) {
        const entry = drawnModels.find((candidate) => candidate.model.id === modelId);
        return (
          <DefaultMapMarker
            item={markerItem(marker)}
            onPress={() => (entry ? onModelPress?.(entry.model) : undefined)}
          />
        );
      }
      return renderMarker ? (
        renderMarker(marker)
      ) : (
        <DefaultMapMarker item={markerItem(marker)} onPress={() => onMarkerPress?.(marker)} />
      );
    },
    [markersById, drawnModels, onModelPress, renderMarker, onMarkerPress],
  );

  const accent = theme.colors.primary;
  const beforeLabels = resolveMapAnchors().beforeLabels;

  return (
    <View style={[styles.root, style]} testID={testID}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        mapStyle={styleUrl}
        initialViewState={initialViewport}
        projection={relief.globe ? 'globe' : 'mercator'}
        light={sunLight.light}
        interaction={interaction}
        // With the city sky drawn the ceiling is higher, so the horizon shows.
        maxPitch={maxPitchFor({ pitchAllowed: interaction?.pitch ?? true, skyActive })}
        // The quality profile's clamp (a 3× phone draws at 2×) and MSAA,
        // construction options of the next engine.
        pixelRatio={clampPixelRatio(window.devicePixelRatio || 1, quality)}
        antialias={quality.render.msaa}
        credits={credits}
        creditDisclosure={cityLifeDisclosure}
        onPress={onPress}
        onCameraChanged={handleCameraChanged}
        onLabelsChange={onLabelsChange}
        onReady={onReady}
        onError={onError}
      >
        <MapPlugin plugin={gowayEngine} props={engineProps} />
        {drawableOverlays(overlays).map((overlay) => {
          const { paint, layout } = overlayStyle(overlay, accent);
          return (
            <GeoJSONSource key={overlay.id} id={overlaySourceId(overlay.id)} data={overlay.data}>
              <Layer
                id={overlayLayerId(overlay.id, overlay.kind)}
                type={overlay.kind}
                paint={paint}
                layout={layout}
                // Under the labels, so a route line never covers a street name.
                {...(beforeLabels ? { beforeId: beforeLabels } : {})}
              />
            </GeoJSONSource>
          );
        })}
        <Markers data={clustered} cluster selectedId={selectedId} renderMarker={drawMarker} />
        <Markers data={pinned} renderMarker={drawMarker} />
        <UserLocation visible={showUserLocation} />
      </MapView>

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
    </View>
  );
});

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function sameDisclosure(a: MapCreditDisclosure | null, b: MapCreditDisclosure | null): boolean {
  return a === b || (a !== null && b !== null && a.text === b.text && a.detail === b.detail);
}

/** The credits of the GoWay Live data on screen, read from the layer's own subscription. */
function useLiveCredits(live: MapLiveLayer | null): readonly MapAttributionLink[] {
  const cache = useRef<readonly MapAttributionLink[]>(NO_LINKS);
  const subscribe = useCallback(
    (listener: () => void) => (live ? live.subscribe(listener) : () => {}),
    [live],
  );
  const read = useCallback(() => {
    const next = live ? live.credits() : NO_LINKS;
    if (!sameLinks(cache.current, next)) cache.current = next.length === 0 ? NO_LINKS : next;
    return cache.current;
  }, [live]);
  return useSyncExternalStore(subscribe, read, read);
}

function sameLinks(a: readonly MapAttributionLink[], b: readonly MapAttributionLink[]): boolean {
  return (
    a.length === b.length &&
    a.every((link, index) => link.label === b[index]?.label && link.href === b[index]?.href)
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
});

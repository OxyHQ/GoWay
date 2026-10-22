/**
 * `MapCanvas`, iOS + Android — GoWay's map, composed on `@goway.to/maps`.
 *
 * The SDK draws the map (`MapLibre Native`, declarative throughout); this
 * composes GoWay's own on top: its style choices and the sun's light, the
 * explore screen's markers and overlays, the relief's hillshade, and 3D models
 * — which MapLibre Native cannot draw (it has no custom-layer API), so every
 * model is its fallback marker here, the same truthful pin the web draws
 * wherever it cannot draw the model. `moveModel` moves that marker.
 *
 * This is also the file TypeScript reads for `./MapCanvas`: both forks
 * implement the same `MapCanvasProps` and `MapApi`.
 */
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  DefaultMapMarker,
  GeoJSONSource,
  Layer,
  type MapMarkerData,
  type MapMarkerItem,
  Markers,
  MapView,
  type MapViewRef,
  RasterDEMSource,
  UserLocation,
} from '@goway.to/maps';
import { useTheme } from '@oxy.so/bloom/theme';
import { parseModelPlacement, type ModelPlacement } from '@goway.to/sdk';

import type { ImageryView } from '@/lib/map/imageryCoverage';
import {
  type MapAttributionLink,
  overlayLayerId,
  overlaySourceId,
  resolveMapAnchors,
  resolveMapStyleUrl,
  resolveOwnsStyleDocument,
  resolveTerrainTileUrl,
  TERRAIN_ATTRIBUTION_LINK,
} from '@/lib/map/provider';
import {
  HILLSHADE_BEFORE_LAYER_ID,
  hillshadeLayer,
  RELIEF_DEM,
  RELIEF_SOURCE_IDS,
} from '@/lib/map/style/relief';
import { mapStyleDefinition, presetAppearance } from '@/lib/map/style/catalogue';

import { drawableModels, modelFallbackMarker, modelIdOfMarker } from './models';
import { markerData, markerItem } from './markerItems';
import { drawableOverlays, overlayStyle } from './overlays';
import { useMapRelief } from './reliefFlags';
import { DEFAULT_VIEWPORT, type MapApi, type MapCameraChange, type MapCanvasProps } from './types';
import { useImageryCredits } from './useImageryCredits';
import { useMapStyle } from './useMapStyle';
import { useSunLight } from './useSunLight';

export const MapCanvas = forwardRef<MapApi, MapCanvasProps>(function MapCanvas(
  {
    initialViewport = DEFAULT_VIEWPORT,
    appearance,
    mapStyle,
    lightPreset,
    markers,
    credits: callerCredits,
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
  const mapRef = useRef<MapViewRef>(null);

  // The style and its light, exactly as on the web.
  const mapStyleState = useMapStyle({ style: mapStyle, lightPreset, appearance }, initialViewport);
  const { style: styleId, preset: stylePreset } = mapStyleState.selection;
  const settleMapStyle = mapStyleState.settle;
  const resolvedAppearance = presetAppearance(stylePreset);
  const definition = mapStyleDefinition(styleId);
  const styleUrl = useMemo(
    () => resolveMapStyleUrl({ style: styleId, preset: stylePreset }),
    [styleId, stylePreset],
  );
  const sunLight = useSunLight(resolvedAppearance, 'goway-map', initialViewport);
  const settleSunLight = sunLight.settle;

  // The relief's hillshade under `water`, on GoWay's own style only (which
  // promises that layer). The rest of the relief has no API on native. A
  // style with its own relief already shades the ground, and a photograph has
  // its own shadows.
  const { terrain } = useMapRelief();
  const imageryMode = definition.imagery ?? null;
  const hillshade =
    terrain && resolveOwnsStyleDocument() && definition.relief !== true && !imageryMode
      ? hillshadeLayer(resolvedAppearance)
      : null;

  // Satellite and hybrid are drawn over GoWay's imagery: the credit names each
  // imagery source while it is on screen.
  const [imageryView, setImageryView] = useState<ImageryView | null>(null);
  const imageryCredits = useImageryCredits(imageryMode, imageryView);
  // Elevation data is on screen while the hillshade or the style's own relief is.
  const elevation = terrain || definition.relief === true;
  const credits = useMemo<readonly MapAttributionLink[]>(
    () => [
      ...(elevation ? [TERRAIN_ATTRIBUTION_LINK] : []),
      ...imageryCredits,
      ...(callerCredits ?? []),
    ],
    [elevation, imageryCredits, callerCredits],
  );

  // Models: every one is its fallback marker here; `moveModel` overrides hold
  // until the `models` prop changes.
  const drawnModels = useMemo(() => drawableModels(models), [models]);
  const [overrides, setOverrides] = useState<{
    models: typeof models;
    placements: ReadonlyMap<string, ModelPlacement>;
  }>({ models, placements: new Map() });
  if (overrides.models !== models) setOverrides({ models, placements: new Map() });
  const placements = overrides.models === models ? overrides.placements : null;
  const allMarkers = useMemo(() => {
    if (drawnModels.length === 0) return markers ?? [];
    const fallbacks = drawnModels.map(({ model, placement }) =>
      modelFallbackMarker(model, placements?.get(model.id) ?? placement),
    );
    return [...(markers ?? []), ...fallbacks];
  }, [markers, drawnModels, placements]);
  const markersById = useMemo(
    () => new Map(allMarkers.map((marker) => [marker.id, marker])),
    [allMarkers],
  );
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

  const handleCameraChanged = useCallback(
    (change: MapCameraChange) => {
      onViewportChange?.(change);
      if (!change.isFinal) return;
      const centre = { latitude: change.viewport.latitude, longitude: change.viewport.longitude };
      settleSunLight(centre);
      settleMapStyle(centre);
      if (imageryMode) setImageryView({ zoom: change.viewport.zoom, ...change.bounds });
    },
    [onViewportChange, settleSunLight, settleMapStyle, imageryMode],
  );

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
      moveModel(id, input) {
        const placement = parseModelPlacement(input);
        if (!placement) return;
        setOverrides((current) => {
          const next = new Map(current.placements);
          next.set(id, placement);
          return { models: current.models, placements: next };
        });
      },
    }),
    [],
  );

  const drawMarker = useCallback(
    (item: MapMarkerItem, press: () => void) => {
      // A cluster is Bloom's bubble; pressing it opens it where it splits.
      if (item.kind === 'cluster') return <DefaultMapMarker item={item} onPress={press} />;
      const marker = markersById.get(item.marker.id);
      if (!marker) return null;
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
  // `undefined` when the style makes no anchor promise: the overlay then goes
  // on top, which is what native did before GoWay owned a style.
  const beforeLabels = resolveMapAnchors().beforeLabels;

  return (
    <View style={[styles.root, style]} testID={testID}>
      <MapView
        ref={mapRef}
        style={StyleSheet.absoluteFill}
        mapStyle={styleUrl}
        initialViewState={initialViewport}
        light={sunLight.light}
        interaction={interaction}
        credits={credits}
        onPress={onPress}
        onCameraChanged={handleCameraChanged}
        onLabelsChange={onLabelsChange}
        onReady={onReady}
        onError={onError}
      >
        {hillshade ? (
          <RasterDEMSource
            id={RELIEF_SOURCE_IDS.hillshade}
            tiles={[resolveTerrainTileUrl()]}
            encoding={RELIEF_DEM.encoding}
            tileSize={RELIEF_DEM.tileSize}
            minzoom={RELIEF_DEM.minzoom}
            maxzoom={RELIEF_DEM.maxzoom}
          >
            <Layer
              id={hillshade.id}
              type="hillshade"
              paint={hillshade.paint}
              {...(hillshade.minzoom !== undefined ? { minzoom: hillshade.minzoom } : {})}
              {...(hillshade.maxzoom !== undefined ? { maxzoom: hillshade.maxzoom } : {})}
              beforeId={HILLSHADE_BEFORE_LAYER_ID}
            />
          </RasterDEMSource>
        ) : null}
        {drawableOverlays(overlays).map((overlay) => {
          // Hidden overlays leave the native tree: native has no source to keep warm.
          if (overlay.visible === false) return null;
          const { paint, layout } = overlayStyle(overlay, accent);
          return (
            <GeoJSONSource key={overlay.id} id={overlaySourceId(overlay.id)} data={overlay.data}>
              <Layer
                id={overlayLayerId(overlay.id, overlay.kind)}
                type={overlay.kind}
                paint={paint}
                layout={layout}
                {...(beforeLabels ? { beforeId: beforeLabels } : {})}
              />
            </GeoJSONSource>
          );
        })}
        <Markers data={clustered} cluster selectedId={selectedId} renderMarker={drawMarker} />
        <Markers data={pinned} renderMarker={drawMarker} />
        <UserLocation visible={showUserLocation} />
      </MapView>
    </View>
  );
});

const styles = StyleSheet.create({
  root: { flex: 1 },
});

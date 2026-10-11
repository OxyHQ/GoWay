/**
 * The MapLibre adapter for the city-3D prototype: a `CustomLayerInterface`
 * that hands MapLibre's GL context and camera to the host-neutral three.js
 * engine in `engine/city3d/`.
 *
 * Reached ONLY through `import('./city3dLayer.web')` in `MapCanvas.web.tsx`,
 * and only when `isCity3dRequested` says so; it in turn loads the engine (and
 * three.js) through `components/engine3d/lazyChunk.ts`, the one async boundary
 * all three.js consumers share. With the flag off neither chunk is requested,
 * and the style, the layer list and the first-paint bundles are what they were
 * (measured; see `docs/MAP_3D_CITY.md` → "What the flag costs when off").
 *
 * `MapCanvas.web.tsx` is "the ONLY web file allowed to import a map engine",
 * and this file keeps to the letter of that: its `maplibre-gl` import is
 * TYPE-ONLY, erased at compile time. It operates on the `Map` instance
 * `MapCanvas` already created and passes in; it never constructs anything of
 * MapLibre's.
 *
 * ## What attaching does to the map
 *
 *  1. Adds one `custom` layer, `goway:city3d`, directly BEFORE `building-3d`,
 *     so it sits in the same stratum: above the flat footprints and roads,
 *     below every label and the overlay anchor.
 *  2. Hides `building-3d` — the two would draw the same buildings twice — and
 *     remembers its visibility so {@link City3dHandle.detach} can put it back.
 *     It is hidden only once the custom layer is in, so a failure anywhere
 *     before that leaves the shipped buildings exactly as they were.
 *
 * Nothing else changes: the flat `building` fill keeps drawing underneath at
 * every zoom (the meshes occlude it, as the extrusions did), and the mark and
 * the data credit stay where `MapCanvas` renders them, outside the GL canvas.
 *
 * ## A style without `building-3d`: decline, do not guess
 *
 * The layer REPLACES `building-3d`, and `building-3d` is also its anchor. A
 * style without one — the `openfreemap` escape hatch, or an
 * `EXPO_PUBLIC_MAP_STYLE_URL_*` override (`lib/map/provider.ts` →
 * `getMapSource`) — is a document GoWay does not own, which chose not to
 * extrude buildings, and whose label stratum this code has never seen
 * (`provider.ts` drops the `beforeLabels` anchor for an override for exactly
 * that reason). The first version appended the meshes on top of such a style
 * — above every label (PR #119 review). Guessing an anchor ("the first symbol
 * layer") would put 3D buildings into a style that did not ask for them; so
 * the prototype declines, with one console line, and the style stays exactly
 * as it was. The check runs BEFORE the engine chunk is fetched, so declining
 * costs no download either.
 */
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';
import type { CustomLayerInterface, Map as MapLibreMap, VectorTileSource } from 'maplibre-gl';

import { CITY_TILE_LAYER, CITY_TILE_PATH, CITY_TILE_ZOOM } from '@/lib/map/cityTiles';
import { isCityTilesRequested, MAP_CITY_TILES_ENABLED } from '@/lib/map/cityTilesFlag';
import { getMapSource, GOWAY_LAYER_PREFIX, type MapAppearance } from '@/lib/map/provider';
import {
  BUILDING_3D_LAYER_ID,
  BUILDINGS_3D_FADE,
  buildingHeightRamp,
} from '@/lib/map/style/buildings3d';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';

import { cityLightFromSpec, sameCityLight } from './city3dLight';
// Type-only on purpose: the engine chunk imports these modules at runtime, and
// a module two lazy chunks share is hoisted into the first-paint `__common`
// chunk (see `engine3d/lazyChunk.ts`; `components/__tests__/engine3dChunk.test.ts`).
import type { CityEngine, CityEngineStats } from './engine/city3d/cityEngine';
import type { CityLight } from './engine/city3d/occlusion';
import { reportMapDefect } from './shared';

/**
 * GoWay's per-building city tiles are drawn from more, smaller tiles than the
 * z14 basemap: 16 z15 tiles is ~3.7 km square around the camera (4 z14
 * tiles' worth), and a dense one is ~20 MB of buffers (measured: Eixample,
 * 7,934 buildings, 600k vertices).
 */
const CITY_TILES_MAX = 16;

/**
 * Which tiles to mesh: GoWay's city tiles when this page asked for them
 * (`lib/map/cityTilesFlag.ts`), else the basemap's own `building` layer.
 * Exported for the tests.
 */
export function citySourceFor(
  basemap: { template: string; maxzoom: number },
  cityTiles: boolean,
  origin: string,
) {
  if (!cityTiles) {
    return {
      tileUrlTemplate: basemap.template,
      tileZoom: basemap.maxzoom,
      sourceLayer: OPENMAPTILES_SOURCE_LAYERS.building,
      tileFormat: 'openmaptiles' as const,
    };
  }
  return {
    tileUrlTemplate: `${origin}${CITY_TILE_PATH}`,
    tileZoom: CITY_TILE_ZOOM,
    sourceLayer: CITY_TILE_LAYER,
    tileFormat: 'goway' as const,
    maxTiles: CITY_TILES_MAX,
  };
}

/** The custom layer's id, in GoWay's own namespace. */
export const CITY3D_LAYER_ID = `${GOWAY_LAYER_PREFIX}city3d`;

export interface AttachCity3dOptions {
  appearance: MapAppearance;
  /**
   * The light `MapCanvas.web.tsx` gives `building-3d`: `useSunLight`'s sun
   * light, or `null` when GoWay leaves the style document's own light alone
   * (`resolveOwnsStyleDocument`) — in which case this follows `map.getLight()`,
   * exactly as the extrusion does.
   */
  light: LightSpecification | null;
}

export interface City3dHandle {
  /**
   * Hand over the light `building-3d` was just given (same value, same
   * moment — `MapCanvas.web.tsx` calls both from one effect's state). `null`
   * means "the style's own light".
   */
  setLight(light: LightSpecification | null): void;
  /** Remove the layer, free the engine, and show `building-3d` again. Idempotent. */
  detach(): void;
}

/**
 * Put the city-3D layer on a LOADED map. `null` (with one console warning,
 * and the map untouched) when the style has no `building-3d` to replace or no
 * vector source to read buildings from.
 *
 * Async because the engine chunk is fetched here, BEFORE anything touches the
 * map: if that download fails, `building-3d` was never hidden.
 */
export async function attachCity3d(
  map: MapLibreMap,
  options: AttachCity3dOptions,
): Promise<City3dHandle | null> {
  if (!map.getLayer(BUILDING_3D_LAYER_ID)) {
    reportMapDefect(
      'city3d:no-extrusion',
      `city3d: the style has no "${BUILDING_3D_LAYER_ID}" layer to replace; not attached.`,
    );
    return null;
  }
  const source = map.getSource<VectorTileSource>(getMapSource().ids.basemap);
  const template = source?.tiles?.[0];
  if (!source || !template) {
    reportMapDefect('city3d:source', 'city3d: the style has no tiled vector source; not attached.');
    return null;
  }
  const { createCityEngine } = await import('@/components/engine3d/lazyChunk');
  // The adapter only loads with the city-3D flag on, so that half is `true` here.
  const cityTiles = isCityTilesRequested({
    city3d: true,
    enabled: MAP_CITY_TILES_ENABLED,
    // `typeof`: the bun tests that attach to a fake map run without the global.
    development: typeof __DEV__ !== 'undefined' && __DEV__,
    search: typeof window !== 'undefined' ? window.location.search : '',
  });
  const citySource = citySourceFor(
    { template, maxzoom: source.maxzoom },
    cityTiles,
    typeof window !== 'undefined' ? window.location.origin : '',
  );

  const palette = buildingHeightRamp(CARTOGRAPHY_PALETTES[options.appearance]);
  let lightSpec = options.light;
  let applied: CityLight | null = null;
  let engine: CityEngine | null = null;

  // The light as MapLibre would apply it to `building-3d` this frame: the
  // given spec (or the style's own), at the current bearing — which matters
  // only for a `viewport`-anchored light, i.e. the static fallback.
  const currentLight = (): CityLight =>
    cityLightFromSpec(lightSpec ?? map.getLight(), map.getBearing());

  const layer: CustomLayerInterface = {
    id: CITY3D_LAYER_ID,
    type: 'custom',
    // Share the depth buffer with the map, so the meshes and anything else 3D
    // occlude each other correctly.
    renderingMode: '3d',
    onAdd(host, gl) {
      applied = currentLight();
      engine = createCityEngine({
        gl: gl as WebGL2RenderingContext,
        canvas: host.getCanvas(),
        ...citySource,
        palette,
        light: applied,
        fade: BUILDINGS_3D_FADE,
        requestRepaint: () => host.triggerRepaint(),
        onStats: __DEV__ ? publishStats : undefined,
      });
      if (__DEV__) publishLight(lightSpec ?? map.getLight(), applied);
    },
    render(_gl, args) {
      // Re-derived every frame (a few multiplications), handed over only when
      // it changed: a new sun light, or a rotation under a viewport light.
      const light = currentLight();
      if (engine && !sameCityLight(applied, light)) {
        applied = light;
        engine.setLight(light);
        if (__DEV__) publishLight(lightSpec ?? map.getLight(), light);
      }
      const bounds = map.getBounds();
      engine?.render({
        mercatorToClip: args.defaultProjectionData.mainMatrix,
        zoom: map.getZoom(),
        center: map.getCenter(),
        bounds: {
          west: bounds.getWest(),
          south: bounds.getSouth(),
          east: bounds.getEast(),
          north: bounds.getNorth(),
        },
      });
    },
    onRemove() {
      engine?.dispose();
      engine = null;
    },
  };

  // Checked again: the chunk download above yielded, and the style may have
  // been swapped meanwhile.
  if (!map.getLayer(BUILDING_3D_LAYER_ID)) return null;
  const previousVisibility = map.getLayoutProperty(BUILDING_3D_LAYER_ID, 'visibility');

  map.addLayer(layer, BUILDING_3D_LAYER_ID);
  map.setLayoutProperty(BUILDING_3D_LAYER_ID, 'visibility', 'none');

  let detached = false;
  return {
    setLight(next) {
      lightSpec = next;
      // Picked up by the next frame's `currentLight()`.
      map.triggerRepaint();
    },
    detach() {
      if (detached) return;
      detached = true;
      // The map may already be gone (an appearance change tears it down before
      // this cleanup runs); then there is nothing left to restore.
      try {
        if (map.getLayer(CITY3D_LAYER_ID)) map.removeLayer(CITY3D_LAYER_ID);
        if (map.getLayer(BUILDING_3D_LAYER_ID)) {
          map.setLayoutProperty(
            BUILDING_3D_LAYER_ID,
            'visibility',
            previousVisibility ?? 'visible',
          );
        }
      } catch {
        // A removed map throws on style access; the layer went with it.
      }
      engine?.dispose();
      engine = null;
    },
  };
}

/**
 * Development only: the engine's numbers on `globalThis.__gowayCity3d`, so a
 * console (or a headless browser) can read tiles, triangles and GPU bytes
 * without a UI for them.
 */
function publishStats(stats: CityEngineStats): void {
  (globalThis as { __gowayCity3d?: CityEngineStats }).__gowayCity3d = stats;
}

/**
 * Development only: the light in force and what the engine was given for it,
 * on `globalThis.__gowayCity3dLight`, so "is the city lit by the same sun as
 * `building-3d`" can be checked in a running page.
 */
function publishLight(spec: unknown, light: CityLight): void {
  (globalThis as { __gowayCity3dLight?: unknown }).__gowayCity3dLight = { spec, light };
}

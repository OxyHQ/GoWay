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
 */
import type { CustomLayerInterface, Map as MapLibreMap, VectorTileSource } from 'maplibre-gl';

import { getMapSource, GOWAY_LAYER_PREFIX, type MapAppearance } from '@/lib/map/provider';
import {
  BUILDING_3D_LAYER_ID,
  BUILDINGS_3D_FADE,
  buildingHeightRamp,
} from '@/lib/map/style/buildings3d';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';

import type { CityEngine, CityEngineStats } from './engine/city3d/cityEngine';
// Type-only on purpose: the engine chunk imports `occlusion.ts` at runtime,
// and a module two lazy chunks share is hoisted into the first-paint
// `__common` chunk (see `engine3d/lazyChunk.ts`). The defaults it holds are
// applied inside the engine instead.
import type { CityLight } from './engine/city3d/occlusion';
import { reportMapDefect } from './shared';

/** The custom layer's id, in GoWay's own namespace. */
export const CITY3D_LAYER_ID = `${GOWAY_LAYER_PREFIX}city3d`;

export interface AttachCity3dOptions {
  appearance: MapAppearance;
  /**
   * The light. Defaults to `DEFAULT_CITY_LIGHT`. This is where a real
   * sun (`lib/map/sun.ts`, on another branch) is meant to arrive — see
   * `CityLight` in `engine/city3d/occlusion.ts`.
   */
  light?: CityLight;
}

export interface City3dHandle {
  setLight(light: CityLight): void;
  /** Remove the layer, free the engine, and show `building-3d` again. Idempotent. */
  detach(): void;
}

/**
 * Put the city-3D layer on a LOADED map. `null` (with one console warning)
 * when the style has no vector source to read buildings from — the map is
 * left untouched.
 *
 * Async because the engine chunk is fetched here, BEFORE anything touches the
 * map: if that download fails, `building-3d` was never hidden.
 */
export async function attachCity3d(
  map: MapLibreMap,
  options: AttachCity3dOptions,
): Promise<City3dHandle | null> {
  const source = map.getSource<VectorTileSource>(getMapSource().ids.basemap);
  const template = source?.tiles?.[0];
  if (!source || !template) {
    reportMapDefect('city3d:source', 'city3d: the style has no tiled vector source; not attached.');
    return null;
  }
  const { createCityEngine } = await import('@/components/engine3d/lazyChunk');

  const palette = buildingHeightRamp(CARTOGRAPHY_PALETTES[options.appearance]);
  let light = options.light;
  let engine: CityEngine | null = null;

  const layer: CustomLayerInterface = {
    id: CITY3D_LAYER_ID,
    type: 'custom',
    // Share the depth buffer with the map, so the meshes and anything else 3D
    // occlude each other correctly.
    renderingMode: '3d',
    onAdd(host, gl) {
      engine = createCityEngine({
        gl: gl as WebGL2RenderingContext,
        canvas: host.getCanvas(),
        tileUrlTemplate: template,
        tileZoom: source.maxzoom,
        sourceLayer: OPENMAPTILES_SOURCE_LAYERS.building,
        palette,
        appearance: options.appearance,
        light,
        fade: BUILDINGS_3D_FADE,
        requestRepaint: () => host.triggerRepaint(),
        onStats: __DEV__ ? publishStats : undefined,
      });
    },
    render(_gl, args) {
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

  const hasExtrusion = Boolean(map.getLayer(BUILDING_3D_LAYER_ID));
  const previousVisibility = hasExtrusion
    ? map.getLayoutProperty(BUILDING_3D_LAYER_ID, 'visibility')
    : undefined;

  map.addLayer(layer, hasExtrusion ? BUILDING_3D_LAYER_ID : undefined);
  if (hasExtrusion) map.setLayoutProperty(BUILDING_3D_LAYER_ID, 'visibility', 'none');

  let detached = false;
  return {
    setLight(next) {
      light = next;
      engine?.setLight(next);
    },
    detach() {
      if (detached) return;
      detached = true;
      // The map may already be gone (an appearance change tears it down before
      // this cleanup runs); then there is nothing left to restore.
      try {
        if (map.getLayer(CITY3D_LAYER_ID)) map.removeLayer(CITY3D_LAYER_ID);
        if (hasExtrusion && map.getLayer(BUILDING_3D_LAYER_ID)) {
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

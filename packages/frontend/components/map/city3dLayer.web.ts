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

import { MAP_LANDMARKS_ENABLED } from '@/lib/config';
import {
  isCity3dTreeFillRequested,
  isCity3dTreesRequested,
  MAP_CITY3D_TREE_FILL_ENABLED,
  MAP_CITY3D_TREES_ENABLED,
} from '@/lib/map/city3dTreesFlag';
import {
  CITY_COVERAGE_PATH,
  CITY_TILE_LAYER,
  CITY_TILE_PATH,
  CITY_TILE_ZOOM,
  CITY_TREE_LAYER,
  type CityCoverageBox,
  parseCityCoverage,
} from '@/lib/map/cityTiles';
import { isCityLifeRequested, MAP_CITY_LIFE_ENABLED } from '@/lib/map/cityLifeFlag';
import { CITY_ROAD_TILE_PATH } from '@/lib/map/cityRoads';
import { isCityTilesRequested, MAP_CITY_TILES_ENABLED } from '@/lib/map/cityTilesFlag';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import { nightFactor } from '@/lib/map/landmarks/night';
import { isLandmarksRequested } from '@/lib/map/landmarksFlag';
import {
  getMapSource,
  GOWAY_LAYER_PREFIX,
  type MapAppearance,
  type MapAttributionLink,
  resolveMapAnchors,
} from '@/lib/map/provider';
import {
  BUILDING_3D_LAYER_ID,
  BUILDINGS_3D_FADE,
  buildingHeightRamp,
} from '@/lib/map/style/buildings3d';
import { CARTOGRAPHY_PALETTES } from '@/lib/map/style/palette';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';

import { followTerrain } from './city3dGround.web';
import { cityLightFromSpec, sameCityLight } from './city3dLight';
import { treeColours } from './city3dTrees';
// Type-only on purpose: the engine chunk imports these modules at runtime, and
// a module two lazy chunks share is hoisted into the first-paint `__common`
// chunk (see `engine3d/lazyChunk.ts`; `components/__tests__/engine3dChunk.test.ts`).
import type { CityEngine, CityEngineStats, LandmarkSpec } from './engine/city3d/cityEngine';
import type { ModelSpec, ModelStatus } from './engine/city3d/models';
import type { CityLight } from './engine/city3d/occlusion';
import type { CityOverlay } from './engine/city3d/overlay';
import type { GroundStats } from './engine/city3d/terrainGround';
import type { CityLifeStats } from './engine/cityLife/lifeRenderer';
import { type CityLifeChip, mountCityLifeChip } from './cityLifeChip.web';
import { reportMapDefect } from './shared';

/**
 * Which tiles to mesh: always the basemap's own `building` layer, and — when
 * this page asked for them (`lib/map/cityTilesFlag.ts`) — GoWay's city tiles
 * INSTEAD wherever `coverage` says they were compiled (per tile, by the
 * engine's `sources.ts`). Outside every archive, or with no coverage at all
 * (the route unreachable), the basemap's buildings draw: never a flat map.
 * Exported for the tests.
 */
export function citySourceFor(
  basemap: { template: string; maxzoom: number },
  cityTiles: boolean,
  origin: string,
  coverage: readonly CityCoverageBox[] = [],
) {
  const base = {
    tileUrlTemplate: basemap.template,
    tileZoom: basemap.maxzoom,
    sourceLayer: OPENMAPTILES_SOURCE_LAYERS.building,
  };
  if (!cityTiles) return { ...base, city: null };
  return {
    ...base,
    city: {
      tileUrlTemplate: `${origin}${CITY_TILE_PATH}`,
      tileZoom: CITY_TILE_ZOOM,
      sourceLayer: CITY_TILE_LAYER,
      treeLayer: CITY_TREE_LAYER,
      coverage,
    },
  };
}

/**
 * The areas the city-tile archives cover (`CITY_COVERAGE_PATH`). Any failure
 * — unreachable, slow, malformed — is NO coverage: the layer then draws the
 * basemap's buildings everywhere rather than a flat map. Exported for tests.
 */
export async function fetchCityCoverage(
  origin: string,
  fetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response> = fetch,
  timeoutMs = 4000,
): Promise<CityCoverageBox[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${origin}${CITY_COVERAGE_PATH}`, { signal: controller.signal });
    if (!response.ok) return [];
    return parseCityCoverage(await response.json());
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The simulation's budget: agents drawn at most, at full density (z17+). The
 * numbers are measured in `docs/MAP_CITY_LIFE.md` → Performance.
 */
const CITY_LIFE_BUDGET = { cars: 1200, people: 1200 };

/** One fixed seed: the same view opens on the same simulated city. */
const CITY_LIFE_SEED = 20261011;

/** The custom layer's id, in GoWay's own namespace. */
export const CITY3D_LAYER_ID = `${GOWAY_LAYER_PREFIX}city3d`;

/**
 * Landmarks are handed to the engine within this distance of the view's
 * centre, and kept until they are past {@link LANDMARK_DROP_M} (hysteresis,
 * so panning along the edge does not load, hide and re-mesh one repeatedly).
 * The city tiles reach ~1.8 km from the centre; a landmark taller than its
 * neighbours is worth drawing a little beyond them.
 */
const LANDMARK_RADIUS_M = 3_000;
const LANDMARK_DROP_M = 4_000;
/** At most this many landmarks are in the scene at once (the model layer allows 20 assets). */
const MAX_LANDMARKS = 8;
/** Below this zoom no landmark is loaded (the buildings appear from 15.5). */
const LANDMARK_MIN_ZOOM = 14;

/**
 * Which landmarks the engine should hold for a view: the nearest within
 * {@link LANDMARK_RADIUS_M}, plus those already held that are still within
 * {@link LANDMARK_DROP_M}. Exported for the tests.
 */
export function landmarksForView(
  all: readonly PreparedLandmark[],
  held: ReadonlySet<string>,
  view: { zoom: number; center: { lat: number; lng: number } },
  near: (
    list: readonly PreparedLandmark[],
    centre: { latitude: number; longitude: number },
    radius: number,
  ) => PreparedLandmark[],
): PreparedLandmark[] {
  if (view.zoom < LANDMARK_MIN_ZOOM) return [];
  const centre = { latitude: view.center.lat, longitude: view.center.lng };
  const close = new Set(near(all, centre, LANDMARK_RADIUS_M).map((l) => l.entry.id));
  return near(all, centre, LANDMARK_DROP_M)
    .filter((l) => held.has(l.entry.id) || close.has(l.entry.id))
    .slice(0, MAX_LANDMARKS);
}

/** The models' custom layer (same engine; see `modelsLayer` below). */
export const MODELS_LAYER_ID = `${GOWAY_LAYER_PREFIX}models`;

/**
 * Where the models' layer goes: right AFTER the overlay anchor, so every GoWay
 * overlay (inserted before the anchor) stays under it and every label over
 * it; on a style with no anchor promise, before its first label; else on top.
 */
function modelsLayerBefore(map: MapLibreMap): string | undefined {
  const layers = map.getStyle()?.layers ?? [];
  const anchor = resolveMapAnchors().beforeLabels;
  const at = anchor ? layers.findIndex((l) => l.id === anchor) : -1;
  if (at >= 0) return layers[at + 1]?.id;
  return layers.find((l) => l.type === 'symbol')?.id;
}

export interface AttachCity3dOptions {
  appearance: MapAppearance;
  /**
   * The light `MapCanvas.web.tsx` gives `building-3d`: `useSunLight`'s sun
   * light, or `null` when GoWay leaves the style document's own light alone
   * (`resolveOwnsStyleDocument`) — in which case this follows `map.getLight()`,
   * exactly as the extrusion does.
   */
  light: LightSpecification | null;
  /**
   * Draw the city's buildings. `false` attaches the same engine to host
   * coordinate-anchored models only (`MapCanvasProps.models`) while the
   * style's own `building-3d` keeps drawing — and occluding them through the
   * shared depth buffer. Defaults to `true`.
   */
  buildings?: boolean;
  /** A model was drawn, or fell back to its marker. */
  onModelStatus?: (id: string, status: ModelStatus) => void;
  /**
   * The credits owed for the landmark models drawn right now
   * (`docs/MAP_LANDMARKS.md`), for `MapAttribution`; called on every change.
   */
  onLandmarkCredits?: (links: readonly MapAttributionLink[]) => void;
}

export interface City3dHandle {
  /**
   * Hand over the light `building-3d` was just given (same value, same
   * moment — `MapCanvas.web.tsx` calls both from one effect's state). `null`
   * means "the style's own light".
   */
  setLight(light: LightSpecification | null): void;
  /** The models in the scene (`engine/city3d/models.ts`). */
  setModels(specs: readonly ModelSpec[]): void;
  /** Move one model, for a frame of an animation. */
  moveModel(id: string, placement: ModelSpec['placement']): void;
  /** The model drawn under a CSS-pixel point, or `null`. */
  pickModel(point: { x: number; y: number }): string | null;
  /**
   * Override how much of night the models and landmarks are lit for (0 … 1).
   * By default it follows the appearance (`lib/map/landmarks/night.ts` →
   * `nightFactor`); the sky's time of day hands its own here.
   */
  setNightFactor(nightFactor: number): void;
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
  const buildings = options.buildings !== false;
  const source = map.getSource<VectorTileSource>(getMapSource().ids.basemap);
  const template = source?.tiles?.[0] ?? '';
  if (buildings && (!source || !template)) {
    reportMapDefect('city3d:source', 'city3d: the style has no tiled vector source; not attached.');
    return null;
  }
  const { createCityEngine, createCityLife } = await import('@/components/engine3d/lazyChunk');
  // City tiles replace the BUILDINGS' source; a models-only engine (the city
  // flag off) draws no buildings, so it never asks.
  const cityTiles =
    buildings &&
    isCityTilesRequested({
      city3d: true,
      enabled: MAP_CITY_TILES_ENABLED,
      // `typeof`: the bun tests that attach to a fake map run without the global.
      development: typeof __DEV__ !== 'undefined' && __DEV__,
      search: typeof window !== 'undefined' ? window.location.search : '',
    });
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // The simulation drives on the road archive compiled beside the city tiles,
  // so it needs both flags above it (`lib/map/cityLifeFlag.ts`).
  const cityLife =
    cityTiles &&
    isCityLifeRequested({
      city3d: true,
      cityTiles,
      enabled: MAP_CITY_LIFE_ENABLED,
      development: typeof __DEV__ !== 'undefined' && __DEV__,
      search: typeof window !== 'undefined' ? window.location.search : '',
    });
  const coverage = cityTiles ? await fetchCityCoverage(origin) : [];
  if (cityTiles && coverage.length === 0) {
    reportMapDefect(
      'city3d:city-coverage',
      'city3d: the city tiles report no coverage; drawing the basemap buildings instead.',
    );
  }
  const citySource = citySourceFor(
    { template, maxzoom: source?.maxzoom ?? 14 },
    cityTiles,
    origin,
    coverage,
  );

  const cartography = CARTOGRAPHY_PALETTES[options.appearance];
  const trees = treeColours(cartography);
  const palette = {
    ...buildingHeightRamp(cartography),
    treeCrown: trees.crown,
    treeConifer: trees.conifer,
    treeTrunk: trees.trunk,
  };
  // Stylised trees in mapped woods and parks (`engine/city3d/trees.ts`).
  const standTrees = isCity3dTreesRequested({
    enabled: MAP_CITY3D_TREES_ENABLED,
    // `typeof`: the attach tests run without the bundler's `__DEV__`.
    development: typeof __DEV__ !== 'undefined' && __DEV__,
    search: typeof window === 'undefined' ? '' : window.location.search,
  });
  // The styling fill of mapped woods: off unless asked for.
  const fillWoods = isCity3dTreeFillRequested({
    enabled: MAP_CITY3D_TREE_FILL_ENABLED,
    development: typeof __DEV__ !== 'undefined' && __DEV__,
    search: typeof window === 'undefined' ? '' : window.location.search,
  });

  // Landmarks replace per-building OSM ids, so they need the city tiles.
  const landmarksOn =
    cityTiles &&
    isLandmarksRequested({
      enabled: MAP_LANDMARKS_ENABLED,
      development: typeof __DEV__ !== 'undefined' && __DEV__,
      search: typeof window !== 'undefined' ? window.location.search : '',
    });
  let landmarkModule: typeof import('@/lib/map/landmarks/load') | null = null;
  let landmarkList: readonly PreparedLandmark[] = [];
  const heldLandmarks = new Set<string>();
  const drawnLandmarks = new Set<string>();
  let night = nightFactor({ appearance: options.appearance });
  if (landmarksOn) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    void import('@/lib/map/landmarks/load')
      .then(async (module) => {
        landmarkList = await module.loadLandmarks(origin);
        landmarkModule = module;
        map.triggerRepaint();
      })
      .catch((cause: unknown) =>
        reportMapDefect('landmarks:load', `landmarks: not loaded (${String(cause)}).`),
      );
  }
  const updateLandmarks = (view: { zoom: number; center: { lat: number; lng: number } }) => {
    if (!engine || !landmarkModule || landmarkList.length === 0) return;
    const next = landmarksForView(landmarkList, heldLandmarks, view, landmarkModule.landmarksNear);
    const same =
      next.length === heldLandmarks.size && next.every((l) => heldLandmarks.has(l.entry.id));
    if (same) return;
    heldLandmarks.clear();
    for (const l of next) heldLandmarks.add(l.entry.id);
    engine.setLandmarks(
      next.map(
        (l): LandmarkSpec => ({
          id: l.entry.id,
          url: l.url,
          placement: l.placement,
          sizing: { mode: 'world' },
          // The engine draws landmarks only with the buildings (from the
          // fade's start); a zoom window here would toggle "drawn", and with
          // it the hidden buildings, on every zoom across it.
          minZoom: 0,
          maxZoom: 24,
          occlusion: 'buildings',
          hides: l.hides,
        }),
      ),
    );
  };
  const onLandmarkStatus = (id: string, status: ModelStatus) => {
    if (status === 'drawn') drawnLandmarks.add(id);
    else drawnLandmarks.delete(id);
    if (landmarkModule) {
      options.onLandmarkCredits?.(landmarkModule.landmarkCredits(landmarkList, drawnLandmarks));
    }
  };

  let lightSpec = options.light;
  let applied: CityLight | null = null;
  let engine: CityEngine | null = null;
  // Models handed over before MapLibre called `onAdd`.
  let queuedModels: readonly ModelSpec[] | null = null;
  let unfollowTerrain: (() => void) | null = null;
  let chip: CityLifeChip | null = null;

  // The light as MapLibre would apply it to `building-3d` this frame: the
  // given spec (or the style's own), at the current bearing — which matters
  // only for a `viewport`-anchored light, i.e. the static fallback.
  const currentLight = (): CityLight =>
    cityLightFromSpec(lightSpec ?? map.getLight(), map.getBearing());

  // ONE engine for both layers below: one renderer, one scene, one light. It
  // is freed when the last of them leaves the map (a style swap, `remove()`).
  let liveLayers = 0;
  const releaseEngine = () => {
    liveLayers--;
    if (liveLayers > 0) return;
    unfollowTerrain?.();
    unfollowTerrain = null;
    engine?.dispose();
    engine = null;
    chip?.remove();
    chip = null;
  };
  const ensureEngine = (host: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) => {
    liveLayers++;
    if (engine) return engine;
    applied = currentLight();
    const overlays: CityOverlay[] = [];
    if (cityLife) {
      // Labelled for exactly as long as anything simulated is drawn.
      const label = mountCityLifeChip(host.getContainer());
      chip = label;
      overlays.push(
        createCityLife({
          roadTileTemplate: `${origin}${CITY_ROAD_TILE_PATH}`,
          budget: CITY_LIFE_BUDGET,
          seed: CITY_LIFE_SEED,
          requestRepaint: () => host.triggerRepaint(),
          onActiveChange: (active) => label.setVisible(active),
          onStats: __DEV__ ? publishLifeStats : undefined,
        }),
      );
    }
    engine = createCityEngine({
      gl: gl as WebGL2RenderingContext,
      canvas: host.getCanvas(),
      ...citySource,
      // The fill reads OpenMapTiles' landcover; on city tiles the engine
      // reads it from the basemap tile under them.
      trees: standTrees
        ? {
            sourceLayers: {
              landcover: OPENMAPTILES_SOURCE_LAYERS.landcover,
              landuse: OPENMAPTILES_SOURCE_LAYERS.landuse,
              water: OPENMAPTILES_SOURCE_LAYERS.water,
              transportation: OPENMAPTILES_SOURCE_LAYERS.transportation,
              building: OPENMAPTILES_SOURCE_LAYERS.building,
            },
            fillWoods,
          }
        : null,
      palette,
      light: applied,
      fade: BUILDINGS_3D_FADE,
      requestRepaint: () => host.triggerRepaint(),
      onStats: __DEV__ ? publishStats : undefined,
      onGroundStats: __DEV__ ? publishGroundStats : undefined,
      buildings,
      onModelStatus: options.onModelStatus,
      overlays,
      onLandmarkStatus,
    });
    engine.setNightFactor(night);
    if (queuedModels) engine.setModels(queuedModels);
    // On 3D terrain the buildings stand on the drawn ground, not at sea level.
    unfollowTerrain = followTerrain(map, engine);
    if (__DEV__) publishLight(lightSpec ?? map.getLight(), applied);
    return engine;
  };

  // The view MapLibre hands this frame, with the light re-derived (a few
  // multiplications) and handed over only when it changed: a new sun light,
  // or a rotation under a viewport light.
  const frameView = (args: { defaultProjectionData: { mainMatrix: ArrayLike<number> } }) => {
    const light = currentLight();
    if (engine && !sameCityLight(applied, light)) {
      applied = light;
      engine.setLight(light);
      if (__DEV__) publishLight(lightSpec ?? map.getLight(), light);
    }
    const bounds = map.getBounds();
    return {
      mercatorToClip: args.defaultProjectionData.mainMatrix,
      zoom: map.getZoom(),
      center: map.getCenter(),
      bounds: {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      },
    };
  };

  const layer: CustomLayerInterface = {
    id: CITY3D_LAYER_ID,
    type: 'custom',
    // Share the depth buffer with the map, so the meshes and anything else 3D
    // occlude each other correctly.
    renderingMode: '3d',
    onAdd(host, gl) {
      ensureEngine(host, gl);
    },
    render(_gl, args) {
      const view = frameView(args);
      if (landmarksOn) updateLandmarks(view);
      engine?.render(view);
    },
    onRemove: releaseEngine,
  };

  /**
   * The models' layer: the SAME engine, drawn at a different depth of the
   * style. Buildings belong under the route line (a route is drawn over the
   * city, as every map does); a vehicle ON the route must not be painted over
   * by it. So the models are a second custom layer, directly after the
   * overlay anchor — above every GoWay overlay, below every label — still
   * `'3d'`, so they depth-test against the buildings already in the depth
   * buffer and are hidden behind them. Two layers, one renderer and one
   * scene: none of the costs `docs/MAP_3D_CITY.md` → "One engine, one scene"
   * rejects (state resets twice, two precision fixes, two lights).
   */
  const modelsLayer: CustomLayerInterface = {
    id: MODELS_LAYER_ID,
    type: 'custom',
    renderingMode: '3d',
    onAdd(host, gl) {
      ensureEngine(host, gl);
    },
    render(_gl, args) {
      const view = frameView(args);
      if (__DEV__ && engine) publishModelAlignment(map, engine);
      engine?.renderModels(view);
    },
    onRemove: releaseEngine,
  };

  // Checked again: the chunk download above yielded, and the style may have
  // been swapped meanwhile.
  if (!map.getLayer(BUILDING_3D_LAYER_ID)) return null;
  const previousVisibility = map.getLayoutProperty(BUILDING_3D_LAYER_ID, 'visibility');

  if (buildings) {
    map.addLayer(layer, BUILDING_3D_LAYER_ID);
    map.setLayoutProperty(BUILDING_3D_LAYER_ID, 'visibility', 'none');
  }
  // The models' layer joins the style only once there is a model to draw, so
  // the city alone changes the style exactly as it always did.
  const ensureModelsLayer = () => {
    if (map.getLayer(MODELS_LAYER_ID)) return;
    map.addLayer(modelsLayer, modelsLayerBefore(map));
  };

  let detached = false;
  return {
    setLight(next) {
      lightSpec = next;
      // Picked up by the next frame's `currentLight()`.
      map.triggerRepaint();
    },
    setModels(specs) {
      queuedModels = specs;
      if (specs.length > 0 && !detached) ensureModelsLayer();
      engine?.setModels(specs);
    },
    moveModel(id, placement) {
      engine?.setModelPlacement(id, placement);
    },
    pickModel(point) {
      return engine?.pickModel(point) ?? null;
    },
    setNightFactor(factor) {
      night = factor;
      engine?.setNightFactor(factor);
    },
    detach() {
      if (detached) return;
      detached = true;
      // The map may already be gone (an appearance change tears it down before
      // this cleanup runs); then there is nothing left to restore.
      try {
        if (map.getLayer(MODELS_LAYER_ID)) map.removeLayer(MODELS_LAYER_ID);
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
      unfollowTerrain?.();
      unfollowTerrain = null;
      engine?.dispose();
      engine = null;
      chip?.remove();
      chip = null;
      if (drawnLandmarks.size > 0) options.onLandmarkCredits?.([]);
    },
  };
}

/**
 * Development only: each drawn model's anchor where the ENGINE put it beside
 * where MapLibre's own `project` puts the same coordinate, on
 * `globalThis.__gowayModelAlignment` — the alignment check of
 * `docs/SDK_MAP_MODELS.md` phase 1 ("a model's ground point against
 * `map.project` within 1 px"), readable by a headless browser at any camera.
 * Reads the PREVIOUS frame's anchors against the current camera, so it is
 * only meaningful once the camera has settled (as the check does).
 */
function publishModelAlignment(map: MapLibreMap, engine: CityEngine): void {
  const anchors = engine.modelAnchors();
  if (anchors.length === 0) return;
  (globalThis as { __gowayModelAlignment?: unknown }).__gowayModelAlignment = anchors.map((a) => {
    const p = map.project([a.lng, a.lat]);
    return {
      id: a.id,
      engine: { x: a.x, y: a.y },
      map: { x: p.x, y: p.y },
      error: Math.hypot(p.x - a.x, p.y - a.y),
    };
  });
}

/**
 * Development only: the city-life simulation's numbers on
 * `globalThis.__gowayCityLife` (agents, targets, step time, network size).
 */
function publishLifeStats(stats: CityLifeStats): void {
  (globalThis as { __gowayCityLife?: CityLifeStats }).__gowayCityLife = stats;
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
 * Development only: how placing the buildings on terrain is going, on
 * `globalThis.__gowayCity3dGround` (tiles grounded, sampling and placing time).
 */
function publishGroundStats(stats: GroundStats): void {
  (globalThis as { __gowayCity3dGround?: GroundStats }).__gowayCity3dGround = stats;
}

/**
 * Development only: the light in force and what the engine was given for it,
 * on `globalThis.__gowayCity3dLight`, so "is the city lit by the same sun as
 * `building-3d`" can be checked in a running page.
 */
function publishLight(spec: unknown, light: CityLight): void {
  (globalThis as { __gowayCity3dLight?: unknown }).__gowayCity3dLight = { spec, light };
}

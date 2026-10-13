/**
 * The MapLibre adapter for the city-3D prototype: a `CustomLayerInterface`
 * that hands MapLibre's GL context and camera to the host-neutral three.js
 * engine in `engine/city3d/`.
 *
 * Reached ONLY through `import('./city3dLayer.web')` in `MapCanvas.web.tsx`,
 * and only when the map-feature registry's `city3d` says so (or a caller has
 * models to draw); it in turn loads the engine (and
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

import {
  CITY_COVERAGE_PATH,
  CITY_TILE_LAYER,
  CITY_TILE_PATH,
  CITY_TILE_ZOOM,
  CITY_TREE_LAYER,
  type CityCoverageArea,
  type CityCoverageTiles,
  parseCityCoverage,
} from '@/lib/map/cityTiles';
import { deviceLocale } from '@/lib/i18n';
import { CITY_LOD2_SOURCES } from '@/lib/map/cityOfficial';
import { CITY_ROAD_TILE_PATH } from '@/lib/map/cityRoads';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import { nightFactor } from '@/lib/map/landmarks/night';
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
import { streetPaletteInput } from '@/lib/map/style/streetPalette';
import { OPENMAPTILES_SOURCE_LAYERS } from '@/lib/map/style/schema';
import type { QualityProfile } from '@/lib/map/quality/profile';
import { sunPosition } from '@/lib/map/sun';
import { mercatorX, mercatorY } from '@/lib/map/geo';

import { followTerrain } from './city3dGround.web';
import { cityLightFromSpec, sameCityLight } from './city3dLight';
import { applyCityGround, cityMaterials } from './city3dStyle';
import { treeColours } from './city3dTrees';
// Type-only on purpose: the engine chunk imports these modules at runtime, and
// a module two lazy chunks share is hoisted into the first-paint `__common`
// chunk (see `engine3d/lazyChunk.ts`; `components/__tests__/engine3dChunk.test.ts`).
import type { CitySun } from './engine/city3d/atmosphere';
import type {
  CityEngine,
  CityEngineStats,
  CityPass,
  FrameProbe,
  LandmarkSpec,
} from './engine/city3d/cityEngine';
import type { ModelSpec, ModelStatus } from './engine/city3d/models';
import type { CityLight } from './engine/city3d/occlusion';
import type { CityOverlay } from './engine/city3d/overlay';
import type { GroundStats } from './engine/city3d/terrainGround';
import type { CityLifeStats } from './engine/cityLife/lifeRenderer';
import type { CityStreetsStats } from './engine/cityStreets/streetRenderer';
import { type CityLifeLabel, cityLifeReporter } from './cityLifeLabel';
import { type StreetNameBlockers, mountStreetNameBlockers } from './streetNameBlockers.web';
import { mountStreetOwnership } from './streetOwnership.web';
import type { AnimationClock } from './perf/animationClock';
import { reportMapDefect } from './shared';

/**
 * Which tiles to mesh: always the basemap's own `building` layer, and — when
 * this page asked for them (the registry's `cityTiles`) — GoWay's city tiles
 * INSTEAD wherever `coverage` says they were compiled (per tile, by the
 * engine's `sources.ts`). Outside every archive, or with no coverage at all
 * (the route unreachable), the basemap's buildings draw: never a flat map.
 * Exported for the tests.
 */
export function citySourceFor(
  basemap: { template: string; maxzoom: number },
  cityTiles: boolean,
  origin: string,
  coverage: readonly CityCoverageArea[] = [],
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
 * What the city archives cover, from `CITY_COVERAGE_PATH`: where the
 * building tiles draw, and where the road archive (street detail, and city
 * life's exact roads) is published.
 */
export interface CityCoverageDocument {
  buildings: CityCoverageArea[];
  /**
   * The road archive's coverage, or `null` where the document does not say
   * (development's compile boxes): then every road tile is asked for, and a
   * 204/404 is the basemap — what development always did.
   */
  roads: CityCoverageArea[] | null;
  /** The document could not be had (unreachable, slow, not a 200, malformed). */
  failed: boolean;
}

const NO_COVERAGE: CityCoverageDocument = { buildings: [], roads: [], failed: true };

/** An encoded owned-tile set, checked; `null` if it is not one. */
function coverageTree(value: unknown): CityCoverageTiles | null {
  if (!value || typeof value !== 'object') return null;
  const { maxZoom, bits } = value as { maxZoom?: unknown; bits?: unknown };
  const valid =
    typeof maxZoom === 'number' &&
    Number.isInteger(maxZoom) &&
    maxZoom >= 0 &&
    maxZoom <= 24 &&
    typeof bits === 'string' &&
    bits.length > 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(bits);
  return valid ? { maxZoom, bits } : null;
}

/**
 * The coverage document. Any failure — unreachable, slow, malformed — is NO
 * coverage: the layer then draws the basemap's buildings everywhere rather
 * than a flat map, and asks for no road tile. Exported for tests.
 *
 * The production document (`worker/city.js`) carries owned-tile sets, passed
 * on ENCODED; the engine decodes them (`engine/city3d/coverageIndex.ts`), so
 * the decoder ships in the engine's chunk only. The shape is checked here all
 * the same, so a document that is neither form is "no coverage" and reported,
 * not a decode error later. Production before any region is published answers
 * `{ schema: 2, regions: [], tiles: null }`: nothing covered, not a failure.
 */
export async function fetchCityCoverageDocument(
  origin: string,
  fetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response> = fetch,
  timeoutMs = 4000,
): Promise<CityCoverageDocument> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(`${origin}${CITY_COVERAGE_PATH}`, { signal: controller.signal });
    if (!response.ok) return NO_COVERAGE;
    const document = (await response.json()) as {
      schema?: unknown;
      tiles?: unknown;
      roads?: unknown;
    } | null;
    if (document?.schema === 2 || (document && 'tiles' in document)) {
      const tiles = coverageTree(document.tiles);
      const roads = coverageTree(document.roads);
      // `tiles` present but not a tree (and not the unpublished `null`): broken.
      if (!tiles && document.tiles != null) return NO_COVERAGE;
      return {
        buildings: tiles ? [tiles] : [],
        // A document without `roads` (an older Worker, the development
        // regional form) says nothing about them; one with no tiles at all
        // has no road archive either.
        roads: roads ? [roads] : 'roads' in document || !tiles ? [] : null,
        failed: false,
      };
    }
    const boxes = parseCityCoverage(document);
    return { buildings: boxes, roads: null, failed: false };
  } catch {
    return NO_COVERAGE;
  } finally {
    clearTimeout(timer);
  }
}

/** Where the building tiles draw ({@link fetchCityCoverageDocument}`.buildings`). */
export async function fetchCityCoverage(
  origin: string,
  fetcher: (url: string, init: { signal: AbortSignal }) => Promise<Response> = fetch,
  timeoutMs = 4000,
): Promise<CityCoverageArea[]> {
  return (await fetchCityCoverageDocument(origin, fetcher, timeoutMs)).buildings;
}

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
/** The basemap's tile zoom: the engine picks a source per z14 cell (`sources.ts`). */
const LANDMARK_COVERAGE_ZOOM = 14;

/**
 * The landmarks the map can actually draw — the ONE list the engine is handed
 * and the tour and its pill offer (`offerLandmarks`), so nobody is flown to a
 * model that never appears:
 *
 *  - its z14 cell is wholly published (`covers`, the engine's own source rule,
 *    `engine/city3d/sources.ts`): a partly published cell at a region's edge
 *    is drawn from the basemap, whose blocks carry no per-building ids, so the
 *    model would replace nothing — and is not drawn there;
 *  - its model has not failed to load (`failed`): a broken asset never draws,
 *    at any camera, in any preset.
 *
 * Every preset holds at least one landmark (`landmarks.max` ≥ 2, nearest the
 * view first), and the tour's camera stands at the landmark, so an offered
 * landmark is the nearest — and held — when the tour arrives. Exported for tests.
 */
export function drawableLandmarks(
  landmarks: readonly PreparedLandmark[],
  coverage: readonly CityCoverageArea[],
  failed: ReadonlySet<string>,
  covers: (
    tile: { z: number; x: number; y: number },
    areas: readonly CityCoverageArea[],
  ) => boolean,
): PreparedLandmark[] {
  const n = 2 ** LANDMARK_COVERAGE_ZOOM;
  return landmarks.filter(
    ({ entry, placement }) =>
      !failed.has(entry.id) &&
      covers(
        {
          z: LANDMARK_COVERAGE_ZOOM,
          x: Math.floor(mercatorX(placement.position.longitude) * n),
          y: Math.floor(mercatorY(placement.position.latitude) * n),
        },
        coverage,
      ),
  );
}

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
  /** At most this many in the scene at once: the quality profile's `landmarks.max`. */
  max: number,
): PreparedLandmark[] {
  if (view.zoom < LANDMARK_MIN_ZOOM) return [];
  const centre = { latitude: view.center.lat, longitude: view.center.lng };
  const close = new Set(near(all, centre, LANDMARK_RADIUS_M).map((l) => l.entry.id));
  return near(all, centre, LANDMARK_DROP_M)
    .filter((l) => held.has(l.entry.id) || close.has(l.entry.id))
    .slice(0, max);
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
  /**
   * Read the buildings from GoWay's own city tiles (`docs/MAP_3D_CITY.md` →
   * Phase 2) rather than the basemap's `building` layer: the map-feature
   * registry's `cityTiles` answer, which `MapCanvas.web.tsx` reads live and
   * re-attaches on. Ignored without `buildings`. Defaults to `false`.
   */
  cityTiles?: boolean;
  /**
   * Stand the trees OpenStreetMap records (`engine/city3d/trees.ts`): the
   * registry's `city3dTrees` answer. Defaults to `false`.
   */
  trees?: boolean;
  /**
   * Also fill mapped woods with illustrative trees: the registry's
   * `city3dTreeFill`. Ignored without `trees`. Defaults to `false`.
   */
  treeFill?: boolean;
  /**
   * Draw the city-life SIMULATION on the city tiles' road graph
   * (`docs/MAP_CITY_LIFE.md`): the registry's `cityLife`. Ignored without
   * `cityTiles`. Defaults to `false`.
   */
  cityLife?: boolean;
  /**
   * Draw the hand-crafted landmarks in place of their buildings
   * (`docs/MAP_LANDMARKS.md`): the registry's `landmarks`. Ignored without
   * `cityTiles`. Defaults to `false`.
   */
  landmarks?: boolean;
  /**
   * Draw the city in the art-directed look (`engine/city3d/materials.ts`,
   * `docs/MAP_3D_CITY.md` → Art direction): the registry's `detailedCity`.
   * It is drawn in the city sky's light, so it brings a live-clock sky when
   * {@link AttachCity3dOptions.sky} is absent. Ignored without `buildings`.
   * Defaults to `false`.
   */
  detailed?: boolean;
  /**
   * The map's quality profile (`lib/map/quality/profile.ts`): the engine's
   * budgets, the simulation's agents, the landmarks held. A new tier is a
   * new attach (`MapCanvas.web.tsx`).
   */
  quality: QualityProfile;
  /**
   * The map's one animation clock (`perf/animationClock.ts`): city life and
   * animated models tick through it, never on a timer of their own.
   */
  clock: AnimationClock;
  /** `?perf=1`: the HUD's frame probe (`perf/mapRuntime.web.ts`). */
  probe?: FrameProbe | null;
  /**
   * Draw the streets — surfaces, sidewalks, lane markings, crossings, names —
   * from the road archive (`docs/MAP_STREETS.md`): the registry's
   * `cityStreets`. Ignored without `buildings`. Defaults to `false`.
   */
  streets?: boolean;
  /** A model was drawn, or fell back to its marker. */
  onModelStatus?: (id: string, status: ModelStatus) => void;
  /**
   * The credits owed for the landmark models drawn right now
   * (`docs/MAP_LANDMARKS.md`), for `MapAttribution`; called on every change.
   */
  onLandmarkCredits?: (links: readonly MapAttributionLink[]) => void;
  /**
   * The city-sky phase (`lib/map/citySkyFlag.ts`): sky, haze, real sun
   * shadows and physical light, for the instant `at` (`null`: now). Absent:
   * the buildings are lit by {@link AttachCity3dOptions.light}, as before.
   * Needs `buildings`: the sky is drawn by the buildings' layer.
   */
  sky?: {
    at: Date | null;
    /** Told the sun over the map centre whenever it moves by a whole degree. */
    onSun?: (sun: CitySun) => void;
  };
  /**
   * The data credits the layer owes while it draws — one per official 3D
   * dataset whose surfaces are on screen (`CITY_LOD2_SOURCES`), `[]` when
   * none is. `MapCanvas` adds them to its credit line.
   */
  onCredits?: (links: readonly MapAttributionLink[]) => void;
  /**
   * What the city-life simulation is drawing, in the reader's language, or
   * `null` once nothing simulated is: told the moment it changes, and `null`
   * on detach. `MapCanvas` hands it to the credit, so the label is on screen
   * for exactly as long as anything simulated is drawn
   * (`docs/MAP_CITY_LIFE.md` → Honesty).
   */
  onCityLife?: (label: CityLifeLabel | null) => void;
}

/** Source ids → their credit links, unknown ids dropped. Exported for the tests. */
export function creditsFor(sources: readonly string[]): MapAttributionLink[] {
  const links: MapAttributionLink[] = [];
  for (const id of sources) {
    if (!Object.hasOwn(CITY_LOD2_SOURCES, id)) continue;
    const { label, href } = CITY_LOD2_SOURCES[id as keyof typeof CITY_LOD2_SOURCES];
    links.push({ label, href });
  }
  return links;
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
  /** City-sky only: light the city for `at`, or for the live clock with `null`. */
  setTime(at: Date | null): void;
  /**
   * Draw another feature's objects with this engine's renderer, in a custom
   * layer of their own directly above the buildings (below every label).
   * Returns the remover, which also disposes the pass. GoWay Live is the one
   * caller (`liveLayer.web.ts`).
   */
  addPass(pass: CityPass): () => void;
  /**
   * The drawn ground the city stands on, as a sampler (`terrainGround.ts` →
   * `Ground`), or `null` on a flat map: for a pass that stands its objects on
   * the same terrain (GoWay Live's vehicles), without asking MapLibre per
   * point (`queryTerrainElevation` re-derives covering tiles per call).
   */
  ground(): ((longitude: number, latitude: number) => number) | null;
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
  const { coverageCovers, createCityEngine, createCityLife, createCityStreets, StreetSurface } =
    await import('@/components/engine3d/lazyChunk');
  // City tiles replace the BUILDINGS' source; a models-only engine (the city
  // flag off) draws no buildings, so it never asks.
  const cityTiles = buildings && options.cityTiles === true;
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  // The simulation drives on the compiled road archive where there is one and
  // on the basemap's roads, healed, everywhere else: the registry's `cityLife`,
  // handed in, needs no city tiles.
  const cityLife = buildings && options.cityLife === true;
  // The registry's `cityStreets`, handed in: drawn from the road archive.
  const streets = buildings && options.streets === true;
  // One coverage document says where the building tiles AND the road archive
  // are published. Nothing published (goway.to before its first region, or
  // anywhere outside one) is the basemap: its buildings, its roads for city
  // life, no street detail and no landmark — and no request for a tile that
  // cannot exist.
  const coverageDocument =
    cityTiles || cityLife || streets
      ? await fetchCityCoverageDocument(origin)
      : { buildings: [], roads: [], failed: false };
  if (coverageDocument.failed) {
    reportMapDefect(
      'city3d:city-coverage',
      'city3d: the city coverage could not be read; drawing the basemap buildings instead.',
    );
  }
  const coverage = cityTiles ? coverageDocument.buildings : [];
  const roadCoverage = coverageDocument.roads;
  const roadsPublished = roadCoverage === null || roadCoverage.length > 0;
  const citySource = citySourceFor(
    { template, maxzoom: source?.maxzoom ?? 14 },
    cityTiles,
    origin,
    coverage,
  );

  const cartography = CARTOGRAPHY_PALETTES[options.appearance];
  const trees = treeColours(cartography);
  // The art-directed look (the registry's `detailedCity`).
  const detailed = buildings && options.detailed === true;
  const palette = {
    ...buildingHeightRamp(cartography),
    treeCrown: trees.crown,
    treeConifer: trees.conifer,
    treeTrunk: trees.trunk,
  };
  // Stylised trees in mapped woods and parks (`engine/city3d/trees.ts`), and
  // the styling fill of mapped woods: the registry's answers, handed in.
  const standTrees = options.trees === true;
  const fillWoods = standTrees && options.treeFill === true;

  // Landmarks replace per-building OSM ids, so they need the city tiles.
  // The registry's `landmarks`, handed in.
  const landmarksOn = cityTiles && coverage.length > 0 && options.landmarks === true;
  let landmarkModule: typeof import('@/lib/map/landmarks/load') | null = null;
  let landmarkList: readonly PreparedLandmark[] = [];
  const heldLandmarks = new Set<string>();
  const drawnLandmarks = new Set<string>();
  const failedLandmarks = new Set<string>();
  let allLandmarks: readonly PreparedLandmark[] = [];
  let landmarksLoaded = false;
  // Development only: what the landmarks are doing, for a headless check
  // (the visibility gate waits for its landmark to be drawn or failed).
  const reportLandmarks = () => {
    if (!__DEV__) return;
    publishLandmarkStats({
      loaded: landmarksLoaded,
      offered: landmarkList.map(({ entry }) => entry.id),
      held: [...heldLandmarks],
      drawn: [...drawnLandmarks],
      failed: [...failedLandmarks],
    });
  };
  /** Recompute what can be drawn, and tell the tour. */
  const reofferLandmarks = () => {
    landmarkList = drawableLandmarks(allLandmarks, coverage, failedLandmarks, coverageCovers);
    landmarkModule?.offerLandmarks(landmarkList.map(({ entry }) => entry.id));
  };
  let night = nightFactor({ appearance: options.appearance });
  if (landmarksOn) {
    const origin = typeof window !== 'undefined' ? window.location.origin : '';
    void import('@/lib/map/landmarks/load')
      .then(async (module) => {
        // Only what the map can draw (`drawableLandmarks`): the engine is
        // handed exactly the list the tour and its pill offer.
        allLandmarks = await module.loadLandmarks(origin);
        if (detached) return;
        landmarkModule = module;
        landmarksLoaded = true;
        reofferLandmarks();
        reportLandmarks();
        map.triggerRepaint();
      })
      .catch((cause: unknown) =>
        reportMapDefect('landmarks:load', `landmarks: not loaded (${String(cause)}).`),
      );
  }
  const updateLandmarks = (view: { zoom: number; center: { lat: number; lng: number } }) => {
    if (!engine || !landmarkModule || landmarkList.length === 0) return;
    const next = landmarksForView(
      landmarkList,
      heldLandmarks,
      view,
      landmarkModule.landmarksNear,
      options.quality.landmarks.max,
    );
    const same =
      next.length === heldLandmarks.size && next.every((l) => heldLandmarks.has(l.entry.id));
    if (same) return;
    heldLandmarks.clear();
    for (const l of next) heldLandmarks.add(l.entry.id);
    reportLandmarks();
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
    reportLandmarks();
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
  // The detailed look is drawn in the city sky's light — its one shading path
  // (`engine/city3d/materials.ts`) — so it brings a live-clock sky when the
  // page asked for none (the `citySky` feature adds the time-of-day scrubber).
  const sky = buildings ? (options.sky ?? (detailed ? { at: null } : null)) : null;
  let skyAt = sky?.at ?? null;
  let reportedSun = '';
  // MapLibre's own `sky` (drawn behind everything, and its fog blended into
  // distant 3D terrain) follows the city sky's colours while it is attached;
  // whatever was there before (the relief prototype's) comes back on detach.
  const previousHostSky = sky ? (map.getSky?.() ?? null) : null;
  let appliedHostSky = '';
  // The simulation's label: reported through `onCityLife` rather than drawn
  // here, so it sits in the map's credit; tied to the renderer's own
  // `onActiveChange`, not to a flag a screen could read differently.
  const life = cityLifeReporter((label) => options.onCityLife?.(label), deviceLocale());
  let nameBlockers: StreetNameBlockers | null = null;
  let pendingNames: readonly (readonly [number, number])[] | null = null;
  let namesTimer: ReturnType<typeof setTimeout> | null = null;
  let streetOwnership: ReturnType<typeof mountStreetOwnership> | null = null;
  let coverageTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCoverage: { x: number; y: number }[] = [];

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
    life.end();
    nameBlockers?.remove();
    nameBlockers = null;
    if (coverageTimer) clearTimeout(coverageTimer);
    streetOwnership?.remove();
    streetOwnership = null;
  };
  const ensureEngine = (host: MapLibreMap, gl: WebGLRenderingContext | WebGL2RenderingContext) => {
    liveLayers++;
    if (engine) return engine;
    applied = currentLight();
    const overlays: CityOverlay[] = [];
    const streetSurface = new StreetSurface();
    Reflect.set(globalThis, '__terrainStreetDebug', streetSurface);
    if (streets && roadsPublished) {
      // First, so the streets are in the scene under everything else.
      overlays.push(
        createCityStreets({
          surface: streetSurface,
          onCoverage: (tiles) => {
            pendingCoverage = tiles;
            if (coverageTimer) return;
            coverageTimer = setTimeout(() => {
              coverageTimer = null;
              if (detached) return;
              streetOwnership ??= mountStreetOwnership(host);
              streetOwnership.set(pendingCoverage);
            }, 0);
          },
          roadTileTemplate: `${origin}${CITY_ROAD_TILE_PATH}`,
          roadCoverage,
          glyphTemplate: absoluteGlyphs(host.getStyle()?.glyphs, origin),
          fontstack: STREET_FONTSTACK,
          palette: streetPaletteInput(),
          quality: options.quality.streets,
          requestRepaint: () => host.triggerRepaint(),
          // One name on a street, not two: the map's flat label yields where
          // the name is painted (`streetNameBlockers.web.ts`).
          // Reported from inside the frame; the style is changed after it.
          onPaintedNames: (points) => {
            pendingNames = points;
            if (namesTimer) return;
            namesTimer = setTimeout(() => {
              namesTimer = null;
              if (detached || !pendingNames) return;
              nameBlockers ??= mountStreetNameBlockers(host);
              nameBlockers.set(pendingNames);
              pendingNames = null;
            }, 0);
          },
          onStats: __DEV__ ? publishStreetStats : undefined,
        }),
      );
    }
    if (cityLife) {
      // Labelled for exactly as long as anything simulated is drawn.
      overlays.push(
        createCityLife({
          surface: streetSurface,
          roadTileTemplate: `${origin}${CITY_ROAD_TILE_PATH}`,
          roadCoverage,
          // Worldwide: where no road archive tile exists, the basemap's own roads.
          basemapRoads: template
            ? {
                template,
                zoom: Math.min(source?.maxzoom ?? 14, 15),
                sourceLayer: OPENMAPTILES_SOURCE_LAYERS.transportation,
              }
            : undefined,
          // The simulation's budget at full density (z17+): the quality
          // profile's (`docs/MAP_CITY_LIFE.md` → Performance).
          budget: { cars: options.quality.life.cars, people: options.quality.life.people },
          seed: CITY_LIFE_SEED,
          clock: options.clock,
          onActiveChange: (active) => life.setActive(active),
          onLabel: (content) => life.setContent(content),
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
      quality: options.quality,
      clock: options.clock,
      probe: options.probe ?? undefined,
      onStats: __DEV__ ? publishStats : undefined,
      onGroundStats: __DEV__ ? publishGroundStats : undefined,
      buildings,
      onModelStatus: options.onModelStatus,
      onSources: options.onCredits
        ? (sources) => options.onCredits?.(creditsFor(sources))
        : undefined,
      overlays,
      onLandmarkStatus,
      onLandmarkFailed: (id) => {
        // A model that cannot load is never drawn: neither held nor offered.
        failedLandmarks.add(id);
        reofferLandmarks();
        reportLandmarks();
        // The next frame hands the engine the list without it.
        map.triggerRepaint();
      },
      sky: sky ? { appearance: options.appearance } : undefined,
      // The detailed response; the night seam blends its day and night.
      material: detailed ? cityMaterials() : undefined,
    });
    engine.setNightFactor(night);
    updateSun();
    if (queuedModels) engine.setModels(queuedModels);
    // On 3D terrain the buildings stand on the drawn ground, not at sea level.
    unfollowTerrain = followTerrain(map, engine);
    if (__DEV__) publishLight(lightSpec ?? map.getLight(), applied);
    return engine;
  };

  // City sky: the REAL sun over the map centre at the chosen instant — not
  // the shaped light `building-3d` gets (`sunLitBuildingsLight` caps its polar
  // angle for legibility): a shadow's length and the sky's colour are facts
  // about where the sun is. Rounded to a tenth of a degree, below anything
  // the sky or a shadow can show, so a live clock does not redraw the shadow
  // map more than every few seconds. The night factor follows it — the one
  // place the sky hands its time of day to the models, landmarks, overlays
  // and the city's own night looks (`setNightFactor`).
  const updateSun = () => {
    if (!sky || !engine) return;
    const center = map.getCenter();
    const sun = sunPosition(skyAt ?? new Date(), center.lat, center.lng);
    if (!Number.isFinite(sun.azimuthDeg) || !Number.isFinite(sun.altitudeDeg)) return;
    const rounded: CitySun = {
      azimuthDeg: Math.round(sun.azimuthDeg * 10) / 10,
      altitudeDeg: Math.round(sun.altitudeDeg * 10) / 10,
    };
    engine.setSun(rounded);
    const nextNight = nightFactor({
      appearance: options.appearance,
      sunAltitudeDeg: rounded.altitudeDeg,
    });
    if (nextNight !== night) {
      night = nextNight;
      engine.setNightFactor(night);
    }
    const colours = engine.hostSkyColours();
    const signature = colours ? `${colours.sky}${colours.horizon}${colours.fog}` : '';
    if (colours && signature !== appliedHostSky) {
      appliedHostSky = signature;
      try {
        map.setSky({
          ...(previousHostSky ?? {}),
          'sky-color': colours.sky,
          'horizon-color': colours.horizon,
          'fog-color': colours.fog,
          // MapLibre's own terrain fog OFF while the city sky draws: the
          // city sky's haze covers the ground (and the terrain under it), so
          // both at once hazed the basemap twice — a pale veil over the whole
          // view (owner preview, Madrid, review of #125). 1 = no ground fog.
          'fog-ground-blend': 1,
        });
      } catch {
        // A style not loaded yet: the next sun change tries again.
        appliedHostSky = '';
      }
    }
    const whole = `${Math.round(rounded.azimuthDeg)},${Math.round(rounded.altitudeDeg)}`;
    if (whole !== reportedSun) {
      reportedSun = whole;
      sky.onSun?.(rounded);
    }
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
    // City sky: the shadow map is drawn in MapLibre's offscreen pass, before
    // its own framebuffer is bound (`engine/city3d/sky.ts`). Otherwise none.
    prerender: sky
      ? (_gl, args) => {
          updateSun();
          engine?.prerender(frameView(args));
        }
      : undefined,
    onAdd(host, gl) {
      ensureEngine(host, gl);
    },
    render(_gl, args) {
      updateSun();
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
  // The detailed look's ground: the style's own generated overrides, undone on
  // detach. Only with the city drawn: models alone do not restyle the map.
  const restoreGround = buildings && detailed ? applyCityGround(map) : null;
  // The models' layer joins the style only once there is a model to draw, so
  // the city alone changes the style exactly as it always did.
  const ensureModelsLayer = () => {
    if (map.getLayer(MODELS_LAYER_ID)) return;
    map.addLayer(modelsLayer, modelsLayerBefore(map));
  };

  // The pitch ceiling the sky needs is NOT set here: `MapCanvas.web.tsx`'s
  // interaction effect owns `setMaxPitch` (`maxPitchFor`), so it cannot be
  // reset under an attached sky.

  // Under the live clock nothing else asks for a frame while the map sits
  // still; the sun moves a quarter of a degree a minute.
  const clock = sky
    ? setInterval(() => {
        if (skyAt === null) map.triggerRepaint();
      }, 30_000)
    : null;

  let detached = false;
  const passes = new Map<string, CityPass>();
  const removePass = (id: string) => {
    const pass = passes.get(id);
    if (!pass) return;
    passes.delete(id);
    try {
      if (map.getLayer(id)) map.removeLayer(id);
    } catch {
      // The map is gone; the layer went with it.
    }
    pass.dispose();
  };
  return {
    ground() {
      return engine?.ground?.sample ?? null;
    },
    addPass(pass) {
      const id = `${GOWAY_LAYER_PREFIX}${pass.id}`;
      removePass(id);
      if (detached || !map.getLayer(BUILDING_3D_LAYER_ID)) {
        pass.dispose();
        return () => {};
      }
      passes.set(id, pass);
      map.addLayer(
        {
          id,
          type: 'custom',
          renderingMode: '3d',
          // A pass holds the engine like the city's own layers do: it may be
          // the first of them added, and the engine lives while any is in.
          onAdd(host, gl) {
            ensureEngine(host, gl);
          },
          render(_gl, args) {
            engine?.renderPass(pass, frameView(args));
          },
          onRemove: releaseEngine,
        },
        // Directly above the city layer: `building-3d` is hidden, and its slot
        // is the buildings' stratum, below the labels.
        BUILDING_3D_LAYER_ID,
      );
      return () => removePass(id);
    },
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
      // Under the city sky the time of day decides (`updateSun`).
      if (sky) return;
      night = factor;
      engine?.setNightFactor(factor);
    },
    setTime(at) {
      skyAt = at;
      map.triggerRepaint();
    },
    detach() {
      if (detached) return;
      detached = true;
      if (clock) clearInterval(clock);
      for (const id of [...passes.keys()]) removePass(id);
      restoreGround?.();
      // The map may already be gone (an appearance change tears it down before
      // this cleanup runs); then there is nothing left to restore.
      try {
        if (appliedHostSky) map.setSky(previousHostSky ?? {});
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
      life.end();
      nameBlockers?.remove();
      nameBlockers = null;
      if (coverageTimer) clearTimeout(coverageTimer);
      streetOwnership?.remove();
      streetOwnership = null;
      if (drawnLandmarks.size > 0) options.onLandmarkCredits?.([]);
      landmarkModule?.offerLandmarks([]);
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

/** The style's glyph stack street names are painted in (`streetAtlas.ts`). */
const STREET_FONTSTACK = 'Inter Bold';

/** A style's glyph template made absolute for a worker; `null` when the style has none. */
export function absoluteGlyphs(glyphs: string | undefined, origin: string): string | null {
  if (!glyphs) return null;
  if (/^https?:\/\//.test(glyphs)) return glyphs;
  return glyphs.startsWith('/') ? `${origin}${glyphs}` : null;
}

/** What the landmarks are doing, on `globalThis.__gowayLandmarks` (development only). */
export interface LandmarkStats {
  /** The registry has been read. */
  loaded: boolean;
  /** Ids the map can draw (in coverage, not failed). */
  offered: string[];
  /** Ids handed to the engine for this view. */
  held: string[];
  drawn: string[];
  /** Ids whose model could not load: their buildings stay. */
  failed: string[];
}

function publishLandmarkStats(stats: LandmarkStats): void {
  (globalThis as { __gowayLandmarks?: LandmarkStats }).__gowayLandmarks = stats;
}

/** Development only: the street renderer's numbers on `globalThis.__gowayCityStreets`. */
function publishStreetStats(stats: CityStreetsStats): void {
  (globalThis as { __gowayCityStreets?: CityStreetsStats }).__gowayCityStreets = stats;
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

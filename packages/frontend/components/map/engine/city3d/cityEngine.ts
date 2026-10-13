/**
 * The city-3D engine: three.js drawing GoWay's buildings INTO the map's own
 * WebGL context, with the map's own camera.
 *
 * This and `cityMeshes.ts` (which only this module imports) are the modules of
 * the feature that import `three`, and they are only
 * ever reached through `components/engine3d/lazyChunk.ts` — dynamically
 * imported by `components/map/city3dLayer.web.ts`, itself dynamically imported
 * by `MapCanvas.web.tsx` when the flag is on. So nobody with the flag off
 * downloads a byte of it, and native bundles never contain it. Same rule, and
 * the same chunk, as `components/street3d/engine/sparkEngine.ts`; why they
 * share ONE chunk is explained in `lazyChunk.ts`.
 *
 * ## Host-neutral on purpose
 *
 * Nothing here knows it is inside MapLibre. The host hands over a WebGL2
 * context and, every frame, a mercator → clip matrix plus where the camera is
 * ({@link CityView}); the engine draws. `city3dLayer.web.ts` is the MapLibre
 * adapter that turns a `CustomLayerInterface` into those calls. That split is
 * what keeps MapLibre a replaceable adapter (AGENTS.md → Product boundaries)
 * and what lets the same engine draw the SDK's coordinate-anchored 3D models
 * (`docs/SDK_MAP_MODELS.md`, written in parallel) — one three.js scene, one
 * camera, one depth buffer shared with the basemap, not one per feature.
 *
 * ## What happens per frame
 *
 *  1. Pick EVERY tile the camera sees, at the source's max zoom (14 — the
 *     only zoom whose buildings carry heights), each at a level of detail
 *     for its distance, within the draw budgets (`lod.ts`).
 *  2. Ask the worker pool for any (tile, level) that is missing — nearest
 *     first, a bounded number in flight; cancel any no longer wanted.
 *  3. Admit arrived meshes to the GPU within a per-frame upload budget, so
 *     three dense tiles landing together do not stall one frame.
 *  4. Draw each tile at its level, or — while that level loads — at whatever
 *     level of it is cached, so tilting or panning never opens a hole; swaps
 *     are screen-door cross-fades (`transitions.ts`). Placement is a
 *     centre-relative model matrix (`tileMath.ts`: float32 precision) with
 *     the compact vertex format's units folded in (`packing.ts`).
 *
 * Nothing is meshed on this thread. A dense Barcelona tile is ~1.1 M vertices
 * and ~165 ms of meshing at full detail (measured, see `docs/MAP_3D_CITY.md`);
 * on the main thread that is ten dropped frames per tile.
 */
import * as THREE from 'three';

import type { CityMaterial } from '@/lib/map/style/palette3d';

import {
  MESH_SIDES,
  applyGround,
  createTileEntry,
  createTreeShapes,
  disposeEntry,
  groundTileFor,
  placeEntry,
  setEntryFade,
  setEntryTreeDetail,
  setEntryVisible,
  type TileEntry,
} from './cityMeshes';
import {
  fitBudget,
  type Lod,
  lodThresholds,
  metresPerPixel,
  type LodTile,
  lodKey,
  selectLodTiles,
  type TileCost,
} from './lod';
import type { CityCoverageArea } from '@/lib/map/cityTiles';

import type { ClearanceField } from '../camera/clearance';
import { createVolumeField, type ModelVolumes, type TileVolumes } from '../camera/field';
import type { QualityProfile } from '@/lib/map/quality/profile';

import type { AnimationClock } from '../../perf/animationClock';
import { cityQuality } from '../quality';

import { hexToRgb } from '@/lib/map/colour';
import { hiddenFeatureIds, tilesAround } from './landmarkTiles';
import { materialRamp, materialUniformValues } from './materials';
import type { CitySun, HostSkyColours, SkyAppearance } from './atmosphere';
import {
  type DrawnTile,
  FrameSchedule,
  runsSkyOffscreenPass,
  SKY_PASS_LAYER,
  WARM_LAYER,
} from './frameSelection';
import { createMaterialWarmup } from './materialWarmup';
import { createModelLayer, type ModelSpec, type ModelStatus } from './models';
import type { CityLight } from './occlusion';
import type { CityTileFormat, MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import { type CitySky, type CitySkyStats, type CitySkyView, createCitySky } from './sky';
import { createDetailedMaterial } from './tsl/detailedMaterial';
import { type CityMaterialResponse, clayResponse } from './tsl/skyBuildingMaterial';
import {
  centeredProjection,
  type LngLatBox,
  mercatorXFromLng,
  mercatorYFromLat,
  type TileId,
  tileKey,
} from './tileMath';
import type { CityOverlay, FrameUploadBudget } from './overlay';
import {
  createGround,
  type Ground,
  type GroundLattice,
  type GroundSampler,
  type GroundStats,
  TileGrounder,
} from './terrainGround';
import { incompleteRetryMs, TileCache, TileScheduler } from './tileScheduler';
import { assignSources, type SourcedTile } from './sources';
import { Transitions } from './transitions';
import { treeMinHeightM } from './tsl/treeMaterial';
import { createTslPass, type Warming } from './tsl/tslPass';
import type { TreeSourceLayers } from './treeSources';
import { WorkerPool, webWorker } from './workerPool';

/** The palette's building height ramp (`buildingHeightRamp` in `buildings3d.ts`), plus trees. */
export interface CityPalette {
  low: string;
  tall: string;
  veryTall: string;
  tallM: number;
  veryTallM: number;
  /** Tree crowns and trunks, derived from the palette's park colour (`city3dTrees.ts`). */
  treeCrown?: string;
  treeConifer?: string;
  treeTrunk?: string;
}

export interface CityEngineOptions {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** `{z}/{x}/{y}` template of the vector source carrying OpenMapTiles' `building` layer. */
  tileUrlTemplate: string;
  /** The source's max zoom: tiles are fetched at this zoom only. */
  tileZoom: number;
  sourceLayer: string;
  /**
   * GoWay's per-building city tiles, drawn INSTEAD of the OpenMapTiles
   * buildings above wherever `coverage` says they were compiled — per tile,
   * by `sources.ts`; everywhere else the OpenMapTiles path draws. Absent: the
   * OpenMapTiles buildings everywhere.
   */
  city?: {
    tileUrlTemplate: string;
    tileZoom: number;
    sourceLayer: string;
    /** The city tiles' layer of trees OSM records (`CITY_TREE_LAYER`). */
    treeLayer: string;
    coverage: readonly CityCoverageArea[];
  } | null;
  /**
   * Trees (`workerTrees.ts`): on city tiles the trees OSM records; with
   * `fillWoods`, also the styling fill of mapped woods from OpenMapTiles'
   * layers (off by default). `null`: no trees.
   */
  trees?: { sourceLayers: TreeSourceLayers; fillWoods?: boolean } | null;
  palette: CityPalette;
  /** The map's light, converted (`components/map/city3dLight.ts`); see `CityLight`. */
  light: CityLight;
  /** The zoom fade, shared with the `fill-extrusion` layer this replaces. */
  fade: { start: number; end: number };
  /** Ask the host for another frame (new geometry arrived). */
  requestRepaint: () => void;
  /**
   * The map's quality profile (`lib/map/quality/profile.ts`): every budget
   * the engine applies — draw, cache, upload, workers, trees, LOD, shadows —
   * is read from it (`engine/quality.ts`), none is the engine's own.
   */
  quality: QualityProfile;
  /**
   * The map's one animation clock (`perf/animationClock.ts`): an animated
   * model asks it for frames instead of repainting every frame itself.
   * Absent (tests, a host without one): animated models repaint as before.
   */
  clock?: AnimationClock;
  /** `?perf=1`: names this frame's parts for the HUD (`perf/mapRuntime.web.ts`). */
  probe?: FrameProbe;
  /**
   * The engine's clock, ms (default `performance.now`): frame pacing, upload
   * admission, retries and the shadow map's redraw throttle all read it, so
   * the CI budget gate can run the engine on a virtual clock and get the same
   * counts every run.
   */
  now?: () => number;
  /** Development statistics, called whenever they change. */
  onStats?: (stats: CityEngineStats) => void;
  /** Development statistics for placing buildings on terrain (`terrainGround.ts`). */
  onGroundStats?: (stats: GroundStats) => void;
  /**
   * `false`: draw no buildings (no worker, no tile requests) — the engine is
   * hosting coordinate-anchored models alone, over the style's own
   * `fill-extrusion`. Defaults to `true`.
   */
  buildings?: boolean;
  /** A model became drawn, or fell back to its marker (`models.ts`). */
  onModelStatus?: (id: string, status: ModelStatus) => void;
  /**
   * The official 3D datasets (`CITY_LOD2_SOURCES` ids) whose surfaces are
   * DRAWN — in a visible tile, past the zoom fade — called whenever that set
   * changes, so the map credits a source exactly while it is shown.
   */
  onSources?: (sources: readonly string[]) => void;
  /** Drawn in the same scene, camera, light and ground (`overlay.ts`): the city-life simulation. */
  overlays?: CityOverlay[];
  /** A landmark model became drawn (its buildings hidden), or stopped being. */
  onLandmarkStatus?: (id: string, status: ModelStatus) => void;
  /** A landmark's model could not be loaded: it will never draw. */
  onLandmarkFailed?: (id: string) => void;
  /**
   * Sky, haze, sun shadows and physical light (`sky.ts`), behind the city-sky
   * flag. Absent: the engine draws exactly what it always has, lit by
   * {@link CityEngineOptions.light}. Present: the buildings, trees and
   * overlays are lit by the sun given to {@link CityEngine.setSun} instead.
   */
  sky?: {
    appearance: SkyAppearance;
    /**
     * The art direction's material response for the one sky-lit shading
     * path (`tsl/skyBuildingMaterial.ts` documents the contract). Absent: the
     * detailed look's when {@link CityEngineOptions.material} is set, else
     * the default clay.
     */
    response?: CityMaterialResponse;
  };
  /**
   * The detailed look (`materials.ts`, the `detailedCity` map feature): the material's
   * day and night, blended on the GPU by the night seam (`setNightFactor`).
   * With {@link CityEngineOptions.sky} — its one shading path — every building
   * is drawn in the sky's light through this response, and
   * its day ramp replaces {@link CityEngineOptions.palette}'s. Without a sky,
   * or absent: the look is unchanged.
   */
  material?: { day: CityMaterial; night: CityMaterial };
}

/**
 * A hand-crafted landmark (`docs/MAP_LANDMARKS.md`): a model drawn in the
 * BUILDINGS' pass — under the route line, like every building — that hides
 * the city-tile buildings it replaces while (and only while) it is drawn.
 */
export interface LandmarkSpec extends ModelSpec {
  /** City-tile feature ids of the buildings the model replaces. */
  hides: readonly number[];
}

/** Brackets the parts of a frame for the perf HUD: `enter('sky')` … `leave()`. */
export interface FrameProbe {
  enter(section: string): void;
  leave(): void;
}

/** What the host knows about its camera this frame. */
export interface CityView {
  /** Column-major mercator `[0,1]` (conformal z) → clip, in float64. */
  mercatorToClip: ArrayLike<number>;
  zoom: number;
  center: { lng: number; lat: number };
  bounds: LngLatBox;
}

export interface CityEngineStats {
  /** Tiles selected for the view (any level). */
  tilesWanted: number;
  /** …of which cached at the level selected. */
  tilesLoaded: number;
  tilesPending: number;
  /** Selected tiles per level: `[full, simple, coarse]`. */
  tilesByLod: [number, number, number];
  /** Building triangles and vertices drawn last frame. */
  triangles: number;
  vertices: number;
  /** Trees (instances) and their triangles drawn last frame. */
  trees: number;
  treeTriangles: number;
  /** GPU bytes held by the tile cache. */
  gpuBytes: number;
  /** Worker time for the last tile: decode + mesh, and tree placement. */
  lastMeshMs: number;
  lastTreeMs: number;
  /** This thread's time in `render()` (selection, scheduling, three's draw calls), smoothed. */
  frameCpuMs: number;
  /** …of which the city's own draw calls (buildings, trees, overlays), smoothed. */
  drawCpuMs: number;
  /** Meshes waiting for the per-frame upload budget. */
  uploadsQueued: number;
  workers: number;
  errors: number;
  sky?: CitySkyStats;
  /** The night factor in force (`setNightFactor`, `lib/map/landmarks/night.ts`). */
  nightFactor: number;
}

/** What a {@link CityPass} draws with: the engine's TSL pass (`tsl/tslPass.ts`). */
export interface CityPassRenderer {
  /** Draw `scene` with `camera` into the map's frame and depth buffer. */
  drawScene(scene: THREE.Scene, camera: THREE.Camera): unknown;
}

/**
 * Another feature's objects, drawn by THIS engine's TSL pass in a style layer
 * of their own (`city3dLayer.web.ts → addPass`) — one renderer, one depth
 * buffer, as "One engine, one scene" in `docs/MAP_3D_CITY.md` asks. GoWay
 * Live's 3D shapes are one (`engine/live3d/livePass.ts`).
 */
export interface CityPass {
  readonly id: string;
  /** Draw through `renderer` (it resets its own GL state) for this frame's camera. */
  render(renderer: CityPassRenderer, view: CityView): void;
  dispose(): void;
}

export interface CityEngine {
  /** The host's offscreen pass, before its framebuffer is bound (city sky: the shadow map). */
  prerender(view: CityView): void;
  /** Draw the buildings and trees (and, city sky, the sky and haze under them). */
  render(view: CityView): void;
  /** The real sun over the view (city sky only; ignored otherwise). */
  setSun(sun: CitySun): void;
  /**
   * City sky: the colours the host map's own `sky` should have for the sun
   * last set (`atmosphere.ts` → `hostSkyColours`), or `null`. Plain data, for
   * the adapter to hand MapLibre.
   */
  hostSkyColours(): HostSkyColours | null;
  /**
   * How much of a night the city is drawn as, 0…1 — what `setNightFactor`
   * last set, as a live `{ value }`: the SAME object every city material reads
   * as `uniform float uNightFactor`, so a material built elsewhere (window
   * glow, an overlay) can take it as its own uniform. Read it; never write it.
   */
  readonly nightFactor: { readonly value: number };
  /** Draw the models — from their own layer, above the overlays (`city3dLayer.web.ts`). */
  renderModels(view: CityView): void;
  /** The drawn ground everything stands on (`setGround`), or `null` on a flat map. */
  readonly ground: Ground | null;
  /**
   * The buildings held and the landmarks drawn, as the height field the
   * camera must clear (`camera/clearance.ts`, `docs/MAP_CAMERA_CLEARANCE.md`).
   */
  readonly clearance: ClearanceField;
  /** Draw a pass with this engine's renderer. Not faded with the buildings: a pass owns its own visibility. */
  renderPass(pass: CityPass, view: CityView): void;
  /** The map's light, re-applied whenever `building-3d`'s would change (the sun). */
  setLight(light: CityLight): void;
  setPalette(palette: CityPalette): void;
  /** Coordinate-anchored models in the same scene (`models.ts`, SDK_MAP_MODELS phase 1). */
  setModels(specs: readonly ModelSpec[]): void;
  setModelPlacement(id: string, placement: ModelSpec['placement']): void;
  /** The landmarks near the view (the host picks which; `setLandmarks([])` clears). */
  setLandmarks(specs: readonly LandmarkSpec[]): void;
  /** 0 (day) … 1 (night), for every model and landmark (`modelLook.ts`). */
  setNightFactor(nightFactor: number): void;
  /** The model under a CSS-pixel point of the last frame, or `null`. */
  pickModel(point: { x: number; y: number }): string | null;
  /** Each drawn model's anchor on screen in the last frame (development checks). */
  modelAnchors(): ReturnType<ReturnType<typeof createModelLayer>['anchors']>;
  /**
   * The terrain the buildings and trees stand on, as a sampler of the drawn
   * ground and the DEM lattice it is drawn from (`terrainGround.ts`), or
   * `null` for none. Call again whenever the terrain changes (a DEM tile
   * arrived); every tile is then re-grounded, a few per frame.
   */
  setGround(sample: GroundSampler | null, lattice?: GroundLattice): void;
  dispose(): void;
}

/** Tiles re-grounded per frame: each is a grid on the DEM lattice (4,356 samples for a z15 tile) plus a pass over its vertices. */
const GROUND_TILES_PER_FRAME = 1;

/**
 * Entry budget, which is what bounds EMPTY tiles (sea, fields): they weigh
 * nothing against the cache's byte budget but are cached so a revisit does
 * not fetch them again (see `tileScheduler.ts`). Every (tile, level) is one
 * entry, and up to 48 tiles are drawn.
 */
const MAX_CACHED_TILES = 160;

// The draw, cache, upload and tree budgets are the quality profile's
// (`engine/quality.ts` → `cityQuality`; `docs/MAP_PERFORMANCE.md`): what one
// frame may draw (bytes, vertices), what the cache may hold beyond it (panning
// slack and fallback levels), the bytes of new meshes handed to the GPU per
// frame (at least one mesh always goes; the overlays get what the city's
// arrivals leave, `overlay.ts` → `FrameUploadBudget`), and tree instances per frame,
// nearest tiles first (a tile past it draws its buildings without trees).

/**
 * While the map is animating, a frame slower than this admits one mesh only;
 * a gap longer than {@link IDLE_GAP_MS} is the map at rest, not a slow frame.
 */
const SLOW_FRAME_MS = 50;
const IDLE_GAP_MS = 500;

/**
 * A frame's upload budget of `bytes` (`overlay.ts` → {@link FrameUploadBudget}):
 * the first upload always fits, then only what is left.
 */
function frameUploadBudget(bytes: number): FrameUploadBudget {
  let left = bytes;
  let taken = false;
  return {
    take(size) {
      if (taken && size > left) return false;
      taken = true;
      left -= size;
      return true;
    },
  };
}

/** Requests in flight per worker: enough to overlap fetch and mesh, few enough to cancel. */
const MAX_IN_FLIGHT_PER_WORKER = 2;

/**
 * Size of a level relative to full detail, for a tile not yet measured at
 * it: means over the five measured tiles in `docs/MAP_3D_CITY.md`.
 */
const LEVEL_RATIO = [1, 0.46, 0.25] as const;

/** Full-detail size assumed for a tile nothing is known about yet. */
const UNKNOWN_FULL: TileCost = { bytes: 6 * 1024 * 1024, vertices: 400_000 };

function hexToVector(hex: string): THREE.Vector3 {
  return new THREE.Vector3(...hexToRgb(hex));
}

function expandTemplate(template: string, tile: TileId): string {
  return template
    .replace('{z}', String(tile.z))
    .replace('{x}', String(tile.x))
    .replace('{y}', String(tile.y));
}

/** The fill's source tile for a city tile: its ancestor at the fill source's zoom. */
function treeFill(
  tile: TileId,
  fill: { tileUrlTemplate: string; tileZoom: number; mappedLayer: string },
): { url: string; tile: TileId; mappedLayer: string } {
  const shift = Math.max(0, tile.z - fill.tileZoom);
  const parent = { z: tile.z - shift, x: tile.x >> shift, y: tile.y >> shift };
  return {
    url: expandTemplate(fill.tileUrlTemplate, parent),
    tile: parent,
    mappedLayer: fill.mappedLayer,
  };
}

/** A (tile, level) the engine requests, and from which source. */
type LodRequest = TileId & { lod: Lod; format: CityTileFormat };

/** A worker reply waiting for the upload budget. */
interface Arrival {
  key: string;
  lod: Lod;
  format: CityTileFormat;
  reply: Extract<MeshWorkerResponse, { type: 'mesh' }>;
}

export function createCityEngine(options: CityEngineOptions): CityEngine {
  const quality = cityQuality(
    options.quality,
    typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency,
  );
  // A tree budget of 0 is no trees at all: the workers place none.
  const trees = quality.treeBudget > 0 ? (options.trees ?? null) : null;
  const probe = options.probe;
  const now = options.now ?? (() => performance.now());
  const camera = new THREE.Camera();
  const overlays = options.overlays ?? [];

  const light = {
    uLightPosition: { value: new THREE.Vector3(0, 0, 1) },
    uLightIntensity: { value: 0.5 },
    uLightColor: { value: new THREE.Vector3(1, 1, 1) },
    uOpacity: { value: 1 },
    // On 3D terrain: read the per-vertex lift (`terrainGround.ts`).
    uGrounded: { value: 0 },
    // The night seam (`setNightFactor`): read by every night-time look.
    uNightFactor: { value: 0 },
  };
  // The detailed look is a response to the sky's light: its one shading path
  // (`materials.ts`). Without a sky there is nothing for it to answer.
  const detailed = options.sky ? options.material : undefined;
  // City sky: its light inputs, shadow map and haze light the buildings in
  // place of the map's light — one shading path (`tsl/skyBuildingMaterial.ts`).
  const sky: CitySky | null = options.sky
    ? createCitySky({
        appearance: options.sky.appearance,
        shadows: quality.shadows,
        now,
        nightFactor: light.uNightFactor,
        requestRepaint: () => options.requestRepaint(),
      })
    : null;
  // Overlays (city life, the streets) get the sky's live inputs too (`overlay.ts` → `setSky`).
  if (sky) for (const overlay of overlays) overlay.setSky?.(sky.nodes);
  // The sky's ground passes draw first in the same render as the buildings
  // (`SKY_PASS_LAYER`); a frame with no city draws them alone.
  camera.layers.enable(SKY_PASS_LAYER);
  const skyPassCamera = new THREE.Camera();
  skyPassCamera.layers.set(SKY_PASS_LAYER);
  const buildingUniforms = {
    ...light,
    uLow: { value: new THREE.Vector3() },
    uTall: { value: new THREE.Vector3() },
    uVeryTall: { value: new THREE.Vector3() },
    uTallM: { value: 60 },
    uVeryTallM: { value: 180 },
  };
  // The detailed look's response and surface tint (day and night), only when it is on.
  const detailedMaterial =
    detailed && sky
      ? createDetailedMaterial(materialUniformValues(detailed), sky.nodes.nightFactor)
      : null;
  let drawCpuMs = 0;
  const treeUniforms = {
    ...light,
    uCrown: { value: new THREE.Vector3(0.3, 0.5, 0.3) },
    uConifer: { value: new THREE.Vector3(0.2, 0.4, 0.3) },
    uTreeMinHeight: { value: 0 },
    uTrunk: { value: new THREE.Vector3(0.3, 0.3, 0.25) },
  };
  // The engine's one renderer (`docs/MAP_NATIVE_3D.md` → Phase 2): three's
  // `WebGPURenderer` in this same context, drawing every material — the
  // buildings (map-lit, or under the sky), the trees, the sky's passes and
  // every overlay — bound to these same uniforms. Imported statically: a
  // separate `import()` would share three's core with this chunk, and Expo
  // hoists a module two async chunks share into the first-paint `__common`
  // chunk (measured: 27.5 → 135.8 KB gzip for every visitor).
  const tslPass = createTslPass({
    gl: options.gl,
    canvas: options.canvas,
    buildingUniforms,
    treeUniforms,
    side: MESH_SIDES,
    ...(sky
      ? {
          sky: {
            nodes: sky.nodes,
            response: options.sky?.response ?? detailedMaterial?.response ?? clayResponse,
            detailedSurface: detailedMaterial?.surface,
          },
        }
      : {}),
    onReady: () => options.requestRepaint(),
  });
  for (const overlay of overlays) overlay.attach(tslPass.scene);
  if (sky) tslPass.scene.add(sky.passes);
  // The shared materials draw every tile (`cityMeshes.ts`, which also explains
  // which faces each keeps: the model matrices mirror y, and three swaps its
  // notion of "front" with the determinant).
  const context = { tsl: tslPass };
  // Where the city tiles draw instead of the basemap's buildings (`sources.ts`).
  const city = options.city
    ? { tileZoom: options.city.tileZoom, coverage: options.city.coverage }
    : null;
  const shapes = createTreeShapes();
  // The materials, built while the first tiles are still meshing
  // (`materialWarmup.ts`): every format this engine draws, on its one pass.
  const warmup = createMaterialWarmup(
    context,
    shapes,
    city ? ['openmaptiles', 'goway'] : ['openmaptiles'],
  );
  // What the city's warm-up builds: its own meshes (the sky's passes are
  // warmed first, on their own, with `skyPassCamera`).
  const warmCamera = new THREE.Camera();
  warmCamera.layers.set(WARM_LAYER);
  // The passes' warm-up done (the sky may draw), the city's (its tiles may
  // arrive), and whether the grounded variants were started. The passes go
  // first: three builds, so the sky shows without waiting for the city's.
  // The grounded variants (a tile on terrain) follow in the background, so
  // terrain arriving later lifts the drawn city in the frame it comes.
  let passesWarmed = false;
  let warmed = false;
  let groundStarted = false;
  let warming: Warming | null = null;
  const startWarming = (camera: THREE.Camera, finish: () => void) => {
    const started = withPassesShown(() => tslPass.warm(tslPass.scene, camera));
    warming = started;
    void started.done.then(() => {
      if (disposed || warming !== started) return;
      warming = null;
      finish();
      options.requestRepaint();
    });
  };
  /** One step of the warm-up in progress, from the render callback. */
  const stepWarming = () => {
    if (!warming && tslPass.ready) {
      if (sky && !passesWarmed) {
        startWarming(skyPassCamera, () => {
          passesWarmed = true;
        });
      } else if (!warmed) {
        // Terrain already in: its grounded variants are the ones the tiles need.
        if (ground) groundStarted = warmup.ground();
        startWarming(warmCamera, () => {
          warmed = true;
        });
      } else if (!groundStarted) {
        groundStarted = true;
        if (warmup.ground()) startWarming(warmCamera, () => {});
      }
    }
    const current = warming;
    // The next step is the next frame's; the builds then ask for one when done.
    if (current && withPassesShown(() => current.step())) options.requestRepaint();
  };
  /** `run` with the sky's passes shown: the warm-up builds them too. */
  const withPassesShown = <T>(run: () => T): T => {
    const passes = sky?.passes;
    const shown = passes?.visible ?? false;
    if (passes) passes.visible = true;
    try {
      return run();
    } finally {
      if (passes) passes.visible = shown;
    }
  };
  const transitions = new Transitions<TileEntry>();

  // `null` entries are empty tiles (sea, fields): cached so they are not
  // fetched again on every revisit.
  const cache = new TileCache<TileEntry>(quality.cacheBytes, MAX_CACHED_TILES, (entry) => {
    transitions.drop(entry);
    disposeEntry(entry);
    grounder.forget(entry.key);
    volumesVersion++;
  });
  // The camera's height field (`camera/field.ts`): the finest mesh held per
  // tile and the landmarks drawn, re-listed only when one of them (or the
  // ground) changed — a tile admitted or evicted, a landmark drawn or not.
  let volumesVersion = 0;
  let volumesListed = -1;
  let volumeTiles: TileVolumes[] = [];
  let volumeModels: ModelVolumes[] = [];
  const listVolumes = () => {
    if (volumesListed === volumesVersion) return;
    volumesListed = volumesVersion;
    const finest = new Map<string, { lod: Lod; tile: TileVolumes }>();
    for (const entry of cache.values()) {
      const volumes = entry?.packed?.volumes;
      if (!entry?.packed || !volumes) continue;
      const name = entry.key.slice(0, entry.key.indexOf('@'));
      const known = finest.get(name);
      if (known && known.lod <= entry.lod) continue;
      const [z, x, y] = name.split('/').map(Number);
      finest.set(name, {
        lod: entry.lod,
        tile: { tile: { z, x, y }, volumes, polygonBoxes: entry.packed.polygonBoxes },
      });
    }
    volumeTiles = [...finest.values()].map((f) => f.tile);
    volumeModels = landmarks.volumes();
  };
  const clearance = createVolumeField({
    version: () => volumesVersion,
    tiles: () => {
      listVolumes();
      return volumeTiles;
    },
    models: () => {
      listVolumes();
      return volumeModels;
    },
    ground: () => ground,
  });
  const scheduler = new TileScheduler<LodRequest>((t) => lodKey(tileKey(t), t.lod));
  const requests = new Map<number, LodRequest>();
  const retryTimers = new Set<ReturnType<typeof setTimeout>>();
  const arrivals: Arrival[] = [];
  // Tiles drawn from an incomplete answer, and when to ask for them again.
  const incomplete = new Map<string, { attempts: number; retryAt: number }>();
  const previousLods = new Map<string, Lod>();
  let selected: SourcedTile[] = [];
  let nextRequestId = 1;
  let frame = 0;
  let disposed = false;
  let lastMeshMs = 0;
  let lastTreeMs = 0;
  let errors = 0;
  // Which official datasets each tile entry draws, and the set last reported.
  const entrySources = new WeakMap<object, readonly string[]>();
  let drawnSources = '';
  const reportSources = (sources: ReadonlySet<string>) => {
    const key = [...sources].sort().join(',');
    if (key === drawnSources) return;
    drawnSources = key;
    options.onSources?.(key ? key.split(',') : []);
  };
  let frameCpuMs = 0;
  let lastFrameAt = 0;
  let lastStatsAt = 0;
  let lastSignature = '';
  let drawn = { triangles: 0, vertices: 0, trees: 0, treeTriangles: 0 };
  // Tiles this frame wanted to draw but could not yet: on terrain, not lifted.
  const unlifted = new Set<string>();
  // Measured full-detail cost per canonical tile, and a running mean of it.
  const measured = new Map<string, TileCost>();
  let meanFull: TileCost = UNKNOWN_FULL;

  const buildings = options.buildings !== false;
  // No buildings, no workers: a models-only engine never fetches a tile.
  const pool = new WorkerPool<MeshWorkerRequest & { id: number }, MeshWorkerResponse>(
    (events) => webWorker(new Worker(new URL('./meshWorker', import.meta.url)), events),
    buildings ? quality.workers : 0,
    (reply) => onReply(reply),
    // A worker died with this request: retried like any failed tile.
    (id, message) => onReply({ type: 'error', id, message }),
  );
  const grounder = new TileGrounder(now, options.onGroundStats);
  let groundSampler: GroundSampler | null = null;
  let ground: Ground | null = null;
  // The lifts seen on this terrain, for the selection's culling range.
  let liftRange: { min: number; max: number } | null = null;

  /**
   * On terrain, the ground the view's tiles stand on, conservatively: the
   * centre's ground ±300 m, widened by every lift already applied (±50 m);
   * before any tile is lifted, the centre ±1,500 m.
   */
  const terrainFor = (view: CityView) => {
    if (!groundSampler) return undefined;
    const sampled = groundSampler(view.center.lng, view.center.lat);
    const centreM = Number.isFinite(sampled) ? sampled : 0;
    if (!liftRange) return { centreM, minM: centreM - 1500, maxM: centreM + 1500 };
    return {
      centreM,
      minM: Math.min(centreM - 300, liftRange.min - 50),
      maxM: Math.max(centreM + 300, liftRange.max + 50),
    };
  };

  const models = createModelLayer({
    requestRepaint: options.requestRepaint,
    animation: options.clock?.join('models'),
    onStatus: (id, status) => options.onModelStatus?.(id, status),
    pageOrigin: typeof location !== 'undefined' ? location.origin : null,
  });
  // Landmarks: the same model layer, a second instance drawn in the
  // buildings' pass. Their buildings are hidden only while they are drawn.
  const landmarkHides = new Map<string, readonly number[]>();
  const landmarkPositions = new Map<string, LandmarkSpec['placement']['position']>();
  const drawnLandmarks = new Set<string>();
  let hidden: number[] = [];
  // Every change to the hidden set is a new version. A tile near the change
  // is STALE until a mesh made with that version (or later) arrives — also
  // one whose request was already in flight with the old set. Its old mesh
  // draws meanwhile. Keyed by canonical tile (`z/x/y`): only city tiles, at
  // full detail, carry per-building ids.
  let hiddenVersion = 0;
  const stale = new Map<string, number>();
  const requestVersion = new Map<number, number>();
  const canonical = (key: string) => {
    const at = key.indexOf('@');
    return at < 0 ? key : key.slice(0, at);
  };
  const rehide = (id: string) => {
    hidden = hiddenFeatureIds(drawnLandmarks, landmarkHides);
    hiddenVersion++;
    const position = landmarkPositions.get(id);
    if (position && options.city) {
      // At the CITY tiles' zoom (15), not the basemap's (14): only they carry ids.
      for (const key of tilesAround(position, options.city.tileZoom)) stale.set(key, hiddenVersion);
    }
    options.requestRepaint();
  };
  const landmarks = createModelLayer({
    requestRepaint: options.requestRepaint,
    animation: options.clock?.join('landmarks'),
    onStatus: (id, status) => {
      if ((status === 'drawn') === drawnLandmarks.has(id)) return;
      if (status === 'drawn') drawnLandmarks.add(id);
      else drawnLandmarks.delete(id);
      volumesVersion++;
      rehide(id);
      options.onLandmarkStatus?.(id, status);
    },
    onLoadFailed: (id) => options.onLandmarkFailed?.(id),
    pageOrigin: typeof location !== 'undefined' ? location.origin : null,
    // The eye must not enter them (`camera/clearance.ts`).
    volumes: true,
  });

  // Models are drawn in their own pass (their own layer in the style), with
  // their own camera (see `models.ts` → Frames) but by the same TSL pass, into
  // the same depth buffer.
  const drawModels = (view: CityView) => {
    if (!models.active) return;
    models.render(tslPass, view, {
      width: options.canvas.clientWidth,
      height: options.canvas.clientHeight,
    });
  };

  const reportStats = (force = false) => {
    if (!options.onStats) return;
    const at = now();
    const byLod: [number, number, number] = [0, 0, 0];
    let loaded = 0;
    for (const tile of selected) {
      byLod[tile.lod]++;
      if (cache.has(lodKey(tileKey(tile), tile.lod))) loaded++;
    }
    // Counts that changed are reported at once; timings at most 4× a second.
    const signature = `${byLod.join()}|${loaded}|${scheduler.pendingCount}|${arrivals.length}|${unlifted.size}|${errors}`;
    if (!force && signature === lastSignature && at - lastStatsAt < 250) return;
    lastSignature = signature;
    lastStatsAt = at;
    options.onStats({
      tilesWanted: selected.length,
      tilesLoaded: loaded,
      // On terrain a tile is not drawn until it is lifted: pending until then.
      tilesPending: scheduler.pendingCount + arrivals.length + unlifted.size,
      tilesByLod: byLod,
      ...drawn,
      gpuBytes: cache.bytes,
      lastMeshMs,
      lastTreeMs,
      frameCpuMs,
      drawCpuMs,
      uploadsQueued: arrivals.length,
      workers: pool.size,
      errors,
      sky: sky ? { ...sky.stats } : undefined,
      nightFactor: light.uNightFactor.value,
    });
  };

  /** A tile's cost at a level: measured, else scaled from what is known. */
  const costOf = (tile: TileId, lod: Lod): TileCost => {
    const entry = cache.get(lodKey(tileKey(tile), lod));
    if (entry) return { bytes: entry.bytes, vertices: entry.vertices };
    if (entry === null) return { bytes: 0, vertices: 0 };
    const full = measured.get(tileKey(tile)) ?? meanFull;
    return { bytes: full.bytes * LEVEL_RATIO[lod], vertices: full.vertices * LEVEL_RATIO[lod] };
  };

  const remember = (key: string, lod: Lod, entry: TileEntry | null) => {
    // Every measurement is turned into a full-detail figure for this tile.
    const cost = entry
      ? { bytes: entry.bytes, vertices: entry.vertices }
      : { bytes: 0, vertices: 0 };
    const full = {
      bytes: cost.bytes / LEVEL_RATIO[lod],
      vertices: cost.vertices / LEVEL_RATIO[lod],
    };
    measured.set(key, full);
    meanFull = {
      bytes: meanFull.bytes * 0.8 + full.bytes * 0.2,
      vertices: meanFull.vertices * 0.8 + full.vertices * 0.2,
    };
  };

  const protectedKeys = (): Set<string> => {
    const keys = new Set(scheduler.wantedKeys);
    for (const entry of transitions.inUse()) keys.add(entry.key);
    return keys;
  };

  const onReply = (reply: MeshWorkerResponse) => {
    if (disposed) return;
    const request = requests.get(reply.id);
    requests.delete(reply.id);
    const meshedWith = requestVersion.get(reply.id) ?? 0;
    requestVersion.delete(reply.id);
    if (!request) return;

    if (reply.type === 'cancelled') return;
    if (reply.type === 'error') {
      // One bad tile costs that tile; the rest of the city keeps drawing. It
      // is retried with a bounded backoff (`tileScheduler.ts`) EVEN IF THE
      // VIEW NEVER CHANGES — the timer asks for a frame, and that frame's
      // `plan` re-requests it — because `building-3d`, which would otherwise
      // have drawn it, is hidden.
      const delay = scheduler.failed(request, reply.id, now());
      if (delay === null) return;
      errors++;
      const timer = setTimeout(() => {
        retryTimers.delete(timer);
        if (!disposed) options.requestRepaint();
      }, delay);
      retryTimers.add(timer);
      reportStats(true);
      return;
    }
    if (!scheduler.succeeded(request, reply.id)) return;
    // Meshed with the current hidden set (or none near it changed since).
    const tileName = tileKey(request);
    if ((stale.get(tileName) ?? 0) <= meshedWith) stale.delete(tileName);
    lastMeshMs = reply.meshMs;
    lastTreeMs = reply.treeMs;
    // GPU work waits for the upload budget (`admit`); the bookkeeping is done.
    arrivals.push({
      key: lodKey(tileKey(request), request.lod),
      lod: request.lod,
      format: request.format,
      reply,
    });
    options.requestRepaint();
  };

  /** Entries lifted for the first time last frame: this frame draws (uploads) them. */
  let awaitingFirstDraw = new Set<string>();
  /** Entries drawn at least once: their meshes are on the GPU. */
  const drawnEntries = new WeakSet<TileEntry>();

  /** This frame's upload budget: the city's arrivals first, then the overlays. */
  const uploadBudgetAt = (now: number) => {
    // A long gap since the last frame is the map at rest, not a slow frame.
    const gap = now - lastFrameAt;
    const slow = lastFrameAt > 0 && gap > SLOW_FRAME_MS && gap < IDLE_GAP_MS;
    return frameUploadBudget(slow ? 0 : quality.uploadBytesPerFrame);
  };

  /** Hand queued meshes to the GPU, nearest first, within this frame's budget. */
  const admit = (now: number, upload: FrameUploadBudget) => {
    // No tile becomes drawable before its materials are built
    // (`materialWarmup.ts`): its first draw would build them, in the frame.
    // Held here, the arrivals then go up under this budget as always.
    if (arrivals.length === 0 || !warmed) return;
    const rank = new Map<string, number>();
    for (const tile of selected) rank.set(lodKey(tileKey(tile), tile.lod), tile.r);
    arrivals.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    const wanted = protectedKeys();
    while (arrivals.length > 0) {
      const next = arrivals[0];
      const bytes = (next.reply.mesh?.bytes ?? 0) + (next.reply.trees?.data.byteLength ?? 0);
      if (!upload.take(bytes)) break;
      arrivals.shift();
      const entry = createTileEntry(
        context,
        shapes,
        next.key,
        next.lod,
        next.reply.mesh,
        next.reply.trees,
        next.format,
      );
      if (entry && next.reply.sources) entrySources.set(entry, next.reply.sources);
      remember(next.key.slice(0, next.key.indexOf('@')), next.lod, entry);
      if (next.reply.treesComplete === false) {
        const attempts = (incomplete.get(next.key)?.attempts ?? 0) + 1;
        const delay = incompleteRetryMs(attempts);
        if (delay === null) incomplete.delete(next.key);
        else {
          incomplete.set(next.key, { attempts, retryAt: now + delay });
          const timer = setTimeout(() => {
            retryTimers.delete(timer);
            if (!disposed) options.requestRepaint();
          }, delay);
          retryTimers.add(timer);
        }
      } else {
        incomplete.delete(next.key);
      }
      cache.put(next.key, entry, entry?.bytes ?? 0, frame, wanted);
      if (entry?.packed?.volumes) volumesVersion++;
    }
    if (arrivals.length > 0) options.requestRepaint();
    reportStats(true);
  };

  const updateWanted = (view: CityView, now: number) => {
    if (!buildings || view.zoom < options.fade.start) {
      selected = [];
    } else {
      const chosen = selectLodTiles(
        { ...view, terrain: terrainFor(view) },
        options.tileZoom,
        quality.lod,
        previousLods,
      );
      const fitted = fitBudget(chosen, costOf, quality.draw);
      previousLods.clear();
      for (const tile of fitted) previousLods.set(tileKey(tile), tile.lod);
      // City tiles where they cover the ground, the basemap elsewhere.
      selected = assignSources(fitted, city);
    }
    if (selected.length === 0) previousLods.clear();

    // Every frame, not only when the wanted set changes: a failed tile's
    // retry comes due on a frame where nothing else did.
    const wanted: LodRequest[] = selected.map((t) => ({
      z: t.z,
      x: t.x,
      y: t.y,
      lod: t.lod,
      format: t.format,
    }));
    // A reply waiting for the upload budget is neither pending nor cached;
    // it must not be requested again.
    const arrived = new Set(arrivals.map((arrival) => arrival.key));
    // An incomplete tile whose retry is due counts as not cached: asked again.
    const due = (key: string) => {
      const retry = incomplete.get(key);
      return retry !== undefined && now >= retry.retryAt;
    };
    const plan = scheduler.plan(
      wanted,
      now,
      (key) =>
        (cache.has(key) && !due(key) && !stale.has(canonical(key))) ||
        (arrived.has(key) && !stale.has(canonical(key))),
    );
    for (const id of plan.cancel) {
      pool.cancel(id, { type: 'cancel', id });
      requests.delete(id);
      requestVersion.delete(id);
    }
    const room = pool.size * MAX_IN_FLIGHT_PER_WORKER - pool.inFlight;
    for (const request of plan.request.slice(0, Math.max(0, room))) {
      const id = nextRequestId++;
      requests.set(id, request);
      requestVersion.set(id, hiddenVersion);
      scheduler.started(request, id);
      const tile: TileId = { z: request.z, x: request.x, y: request.y };
      pool.send(
        {
          type: 'mesh',
          id,
          tile,
          ...(request.format === 'goway' && options.city
            ? {
                url: expandTemplate(options.city.tileUrlTemplate, tile),
                sourceLayer: options.city.sourceLayer,
                format: 'goway' as const,
                ...(hidden.length > 0 ? { hidden } : {}),
                // The fill reads the basemap's landcover: the city tiles
                // carry buildings and the trees OSM records, no landcover.
                ...(trees
                  ? {
                      treeFill: treeFill(tile, {
                        tileUrlTemplate: options.tileUrlTemplate,
                        tileZoom: options.tileZoom,
                        mappedLayer: options.city.treeLayer,
                      }),
                    }
                  : {}),
              }
            : {
                url: expandTemplate(options.tileUrlTemplate, tile),
                sourceLayer: options.sourceLayer,
                format: 'openmaptiles' as const,
              }),
          lod: request.lod,
          trees: trees && request.lod < 2 ? trees.sourceLayers : null,
          treeFillWoods: trees?.fillWoods === true,
        },
        tileKey(tile),
      );
    }
    if (plan.cancel.length > 0 || plan.request.length > 0) reportStats(true);
  };

  /** What a selected tile shows now: its level, or any cached level of it. */
  const bestFor = (tile: LodTile): TileEntry | null | undefined => {
    const key = tileKey(tile);
    const exact = cache.get(lodKey(key, tile.lod));
    if (exact !== undefined) return exact;
    // Nearest level first, finer before coarser at the same distance.
    for (const delta of [1, 2]) {
      for (const lod of [tile.lod - delta, tile.lod + delta]) {
        if (lod < 0 || lod > 2) continue;
        const other = cache.get(lodKey(key, lod as Lod));
        if (other) return other;
      }
    }
    return undefined;
  };

  // City sky: the frame's selection is made by its FIRST pass — the offscreen
  // one, before the shadow map — and reused by the main pass
  // (`frameSelection.ts`); each tile's terrain lift has a revision the shadow
  // map's key reads, and `groundEpoch` covers terrain switching on or off.
  const schedule = new FrameSchedule();
  const groundRevisions = new Map<string, number>();
  let groundEpoch = 0;
  interface PreparedFrame {
    started: number;
    opacity: number;
    active: boolean;
    skyView: CitySkyView;
    casters: { tiles: DrawnTile[]; groundEpoch: number };
    /** Official datasets whose surfaces this frame draws (`onSources`). */
    sources: ReadonlySet<string>;
  }
  let prepared: PreparedFrame | null = null;

  /** Select, schedule, ground and place this frame's tiles, and set the camera. */
  const prepare = (view: CityView): PreparedFrame => {
    const started = now();
    frame++;
    updateWanted(view, started);
    const upload = uploadBudgetAt(started);
    admit(started, upload);
    lastFrameAt = started;

    const span = options.fade.end - options.fade.start;
    const opacity = Math.max(0, Math.min(1, (view.zoom - options.fade.start) / span));
    light.uOpacity.value = opacity;
    treeUniforms.uTreeMinHeight.value = treeMinHeightM(view.zoom);

    const center = { x: mercatorXFromLng(view.center.lng), y: mercatorYFromLat(view.center.lat) };
    if (overlays.length > 0) {
      probe?.enter('life');
      for (const overlay of overlays) overlay.update({ view, center, opacity, upload });
      probe?.leave();
    }
    transitions.begin();
    for (const tile of selected) {
      const best = bestFor(tile);
      // `undefined`: nothing cached yet — keep whatever the slot shows.
      const key = tileKey(tile);
      transitions.show(key, best === undefined ? transitions.shown(key) : best, started);
      if (best) {
        cache.touch(best.key, frame);
        best.placement = tile;
      }
      // A slot still fading out an older level keeps that one placed too.
      const showing = transitions.shown(key);
      if (showing) showing.placement = tile;
    }
    const { draws, active } = transitions.draws(started);

    // On terrain: lift stale entries, nearest first, a few per frame. An
    // entry never grounded would be drawn at sea level — inside the hill —
    // so it waits for its first lift. Its first draw is also when its mesh
    // goes to the GPU, and the lift and that upload are the two largest
    // pieces of a tile's arrival: one frame holding both was the engine's
    // share of the laptop's slowest frames (`docs/MAP_PERFORMANCE.md` → the
    // laptop's main thread). So they alternate: an entry lifted before it was
    // ever drawn is first drawn the frame after, and that frame lifts
    // nothing. An entry already drawn (flat, before the terrain came) has its
    // mesh on the GPU: it is drawn as soon as it is lifted, as before.
    const grounded = grounder.active;
    const firstGrounded = new Set<string>();
    const uploading = awaitingFirstDraw;
    awaitingFirstDraw = firstGrounded;
    if (grounded && uploading.size > 0) {
      options.requestRepaint();
    } else if (grounded) {
      let budget = GROUND_TILES_PER_FRAME;
      for (const tile of selected) {
        const entry = bestFor(tile);
        if (!entry || grounder.isCurrent(entry.key)) continue;
        if (budget-- <= 0) {
          options.requestRepaint();
          break;
        }
        if (!grounder.hasGround(entry.key) && !drawnEntries.has(entry)) {
          firstGrounded.add(entry.key);
        }
        const result = grounder.ground(entry.key, groundTileFor(entry, tile));
        if (result) {
          applyGround(entry, result);
          groundRevisions.set(entry.key, (groundRevisions.get(entry.key) ?? 0) + 1);
          liftRange = {
            min: Math.min(liftRange?.min ?? result.min, result.min),
            max: Math.max(liftRange?.max ?? result.max, result.max),
          };
        }
      }
    }

    for (const entry of cache.values()) setEntryVisible(entry, false);
    drawn = { triangles: 0, vertices: 0, trees: 0, treeTriangles: 0 };
    unlifted.clear();
    const casting: DrawnTile[] = [];
    const sources = new Set<string>();
    if (opacity > 0) {
      // Nearest first, so the tree budget spends itself on the near tiles.
      const rank = new Map<string, number>();
      for (const tile of selected) rank.set(tileKey(tile), tile.r);
      const r = (entry: TileEntry) => rank.get(entry.key.slice(0, entry.key.indexOf('@'))) ?? 1e9;
      draws.sort((a, b) => r(a.value) - r(b.value));
      // Trees keep their near shapes only as far as buildings keep full
      // detail; past it the far canopy is under a pixel away from the near.
      const nearTreesWithin = lodThresholds(
        quality.lod,
        metresPerPixel(view.zoom, view.center.lat),
      )[0];
      for (const { value: entry, from, to } of draws) {
        if (!entry.placement) continue;
        if (grounded && (!grounder.hasGround(entry.key) || firstGrounded.has(entry.key))) {
          unlifted.add(entry.key);
          continue;
        }
        placeEntry(entry, entry.placement, center);
        setEntryTreeDetail(entry, shapes, r(entry) < nearTreesWithin);
        setEntryFade(entry, from, to);
        setEntryVisible(entry, true);
        drawnEntries.add(entry);
        for (const source of entrySources.get(entry) ?? []) sources.add(source);
        casting.push({
          key: entry.key,
          tile: entry.placement,
          wrap: entry.placement.wrap ?? 0,
          groundRevision: groundRevisions.get(entry.key) ?? 0,
        });
        drawn.triangles += entry.triangles;
        drawn.vertices += entry.vertices;
        if (entry.trees.length > 0 && drawn.trees + entry.treeCount > quality.treeBudget) {
          // Past the budget a farther tile shows its buildings only.
          for (const mesh of entry.trees) mesh.visible = false;
        } else {
          drawn.trees += entry.treeCount;
          drawn.treeTriangles += entry.treeTriangles;
        }
      }
    }
    if (firstGrounded.size > 0) options.requestRepaint();
    const projection = centeredProjection(view.mercatorToClip, center);
    camera.projectionMatrix.fromArray(projection);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    const skyView: CitySkyView = {
      projection,
      center,
      centerLngLat: view.center,
      bounds: view.bounds,
      zoom: view.zoom,
      opacity,
      // On 3D terrain the drawn ground is not at sea level (`terrainFor`).
      groundM: grounded ? (terrainFor(view)?.centreM ?? 0) : 0,
    };
    return {
      started,
      opacity,
      active,
      skyView,
      casters: { tiles: casting, groundEpoch },
      sources,
    };
  };

  const engine: CityEngine = {
    prerender(view) {
      if (disposed || !sky || !runsSkyOffscreenPass({ sky: true, buildings })) return;
      if (schedule.prerender()) {
        probe?.enter('city');
        prepared = prepare(view);
        probe?.leave();
      }
      if (!prepared) return;
      // Whatever the buildings' opacity: the sky decides whether there is
      // anything to cast, and allocates its shadow target either way. Only
      // the buildings cast (`cityMeshes.ts` → `CASTER_LAYER`).
      probe?.enter('shadows');
      sky.prerender(tslPass, tslPass.scene, prepared.skyView, prepared.casters);
      probe?.leave();
    },

    render(view) {
      if (disposed || !buildings) return;
      probe?.enter('city');
      const frameOf = schedule.render() || !prepared ? prepare(view) : prepared;
      prepared = null;

      // The pass resets three's view of the GL state the map changed before
      // each draw; MapLibre in turn marks its own state dirty after a custom
      // layer returns, so nothing needs restoring after.
      // The sky and the haze are drawn at every zoom the effect covers,
      // buildings or not: in the buildings' render, or alone without them.
      let skyPasses = false;
      if (sky) {
        probe?.enter('sky');
        skyPasses = sky.update(tslPass, frameOf.skyView) && passesWarmed;
        sky.passes.visible = skyPasses;
        if (skyPasses && frameOf.opacity <= 0) tslPass.drawScene(tslPass.scene, skyPassCamera);
        probe?.leave();
      }
      // Once the pass is up, and again when the terrain first arrives: build
      // the materials ahead of the tiles (after the sky has allocated its
      // shadow map, which they sample), here in the map's render callback
      // (`tsl/tslPass.ts` → `warm`).
      stepWarming();
      if (frameOf.opacity > 0) {
        const drawStarted = performance.now();
        tslPass.draw(camera);
        const drawn = performance.now() - drawStarted;
        drawCpuMs = drawCpuMs === 0 ? drawn : drawCpuMs * 0.9 + drawn * 0.1;
        if (landmarks.active) {
          probe?.enter('landmarks');
          landmarks.render(tslPass, view, {
            width: options.canvas.clientWidth,
            height: options.canvas.clientHeight,
          });
          probe?.leave();
        }
      }
      reportSources(frameOf.sources);
      probe?.leave();
      if (frameOf.active) options.requestRepaint();

      const cpu = now() - frameOf.started;
      frameCpuMs = frameCpuMs === 0 ? cpu : frameCpuMs * 0.9 + cpu * 0.1;
      reportStats();
    },

    nightFactor: light.uNightFactor,

    hostSkyColours() {
      return sky?.hostSky ?? null;
    },

    setSun(sun) {
      if (!sky) return;
      sky.setSun(sun);
      // What the engine still lights MapLibre's way — the trees, and the
      // overlays through their `setLight` — follows the sky.
      const host = sky.hostLight;
      if (host) {
        light.uLightPosition.value.set(...host.position);
        light.uLightColor.value.set(...host.color);
        const overlayLight = {
          position: host.position,
          intensity: light.uLightIntensity.value,
          color: host.color,
        };
        for (const overlay of overlays) overlay.setLight(overlayLight);
      }
    },

    get ground() {
      return ground;
    },

    clearance,

    renderModels(view) {
      if (disposed || !models.active) return;
      probe?.enter('models');
      drawModels(view);
      probe?.leave();
    },

    renderPass(pass, view) {
      if (disposed) return;
      // The TSL pass resets three's view of the GL state before it draws.
      pass.render(tslPass, view);
    },

    setGround(sample, lattice) {
      // One terrain path and ONE cache of it (`terrainGround.ts` → `Ground`):
      // buildings, trees, the street detail and city life (the grids), models,
      // landmarks and live vehicles (the same sampler, at their anchor).
      ground = sample ? createGround(sample, lattice) : null;
      volumesVersion++;
      grounder.setGround(ground);
      models.setGround(sample);
      for (const overlay of overlays) overlay.setGround(ground);
      landmarks.setGround(sample);
      groundSampler = sample;
      liftRange = null;
      groundEpoch++;
      light.uGrounded.value = sample ? 1 : 0;
      // Culling bounds follow: without terrain every mesh is back at `z = 0`;
      // with it, each keeps its last lift until re-grounded.
      for (const entry of cache.values()) {
        applyGround(entry, sample ? grounder.resultFor(entry.key) : null);
      }
      options.requestRepaint();
    },

    setModels(specs) {
      models.setModels(specs);
    },

    setModelPlacement(id, placement) {
      models.setPlacement(id, placement);
    },

    setLandmarks(specs) {
      for (const spec of specs) {
        landmarkHides.set(spec.id, spec.hides);
        landmarkPositions.set(spec.id, spec.placement.position);
      }
      landmarks.setModels(specs);
    },

    setNightFactor(factor) {
      light.uNightFactor.value = factor;
      models.setNightFactor(factor);
      landmarks.setNightFactor(factor);
      for (const overlay of overlays) overlay.setNightFactor?.(factor);
    },

    pickModel(point) {
      return models.pick(point);
    },

    modelAnchors() {
      return models.anchors();
    },

    setLight(next) {
      // Not normalised: the radial term is MapLibre's gain (see `CityLight`).
      // Under the city sky the trees and the overlays follow the sky's light
      // instead (`setSun`); the models and landmarks keep the map's.
      if (!sky) light.uLightPosition.value.set(...next.position);
      light.uLightIntensity.value = next.intensity;
      if (!sky) light.uLightColor.value.set(...next.color);
      models.setLight(next);
      if (!sky) for (const overlay of overlays) overlay.setLight(next);
      landmarks.setLight(next);
      options.requestRepaint();
    },

    setPalette(palette) {
      buildingUniforms.uLow.value.copy(hexToVector(palette.low));
      buildingUniforms.uTall.value.copy(hexToVector(palette.tall));
      buildingUniforms.uVeryTall.value.copy(hexToVector(palette.veryTall));
      buildingUniforms.uTallM.value = palette.tallM;
      buildingUniforms.uVeryTallM.value = palette.veryTallM;
      if (palette.treeCrown) treeUniforms.uCrown.value.copy(hexToVector(palette.treeCrown));
      if (palette.treeTrunk) treeUniforms.uTrunk.value.copy(hexToVector(palette.treeTrunk));
      if (palette.treeConifer) treeUniforms.uConifer.value.copy(hexToVector(palette.treeConifer));
      options.requestRepaint();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      reportSources(new Set());
      pool.terminate();
      models.dispose();
      for (const overlay of overlays) overlay.dispose();
      sky?.dispose();
      landmarks.dispose();
      grounder.clear();
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      transitions.clear();
      cache.clear();
      // After any build still in flight: disposing detaches the shared tree
      // buffers its meshes read.
      void (warming?.done ?? Promise.resolve()).then(() => warmup.dispose());
      tslPass.dispose();
      shapes.dispose();
      requests.clear();
      arrivals.length = 0;
    },
  };

  engine.setPalette(options.palette);
  if (detailed) {
    // The detailed look's DAY ramp; night darkens it on the GPU (`uMatAlbedoScale`).
    const ramp = materialRamp(detailed.day);
    buildingUniforms.uLow.value.fromArray(ramp.low);
    buildingUniforms.uTall.value.fromArray(ramp.tall);
    buildingUniforms.uVeryTall.value.fromArray(ramp.veryTall);
    buildingUniforms.uTallM.value = ramp.tallM;
    buildingUniforms.uVeryTallM.value = ramp.veryTallM;
  }
  engine.setLight(options.light);
  return engine;
}

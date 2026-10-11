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

import {
  applyGround,
  createTileEntry,
  createTreeShapes,
  disposeEntry,
  groundTileFor,
  placeEntry,
  setEntryFade,
  setEntryVisible,
  type TileEntry,
} from './cityMeshes';
import {
  type DrawBudget,
  fitBudget,
  LOD_POLICY,
  type Lod,
  type LodTile,
  lodKey,
  selectLodTiles,
  type TileCost,
} from './lod';
import type { CityCoverageBox } from '@/lib/map/cityTiles';

import { createModelLayer, type ModelSpec, type ModelStatus } from './models';
import type { CityLight } from './occlusion';
import { OSM_FRAGMENT_SHADER, OSM_VERTEX_SHADER } from './osmShaders';
import type { CityTileFormat, MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import { CITY_FRAGMENT_SHADER, CITY_VERTEX_SHADER } from './shaders';
import {
  centeredProjection,
  type LngLatBox,
  mercatorXFromLng,
  mercatorYFromLat,
  type TileId,
  tileKey,
} from './tileMath';
import { type GroundSampler, type GroundStats, TileGrounder } from './terrainGround';
import { incompleteRetryMs, TileCache, TileScheduler } from './tileScheduler';
import { assignSources, type SourcedTile } from './sources';
import { Transitions } from './transitions';
import { treeMinHeightM } from './treeShaders';
import type { TreeSourceLayers } from './treeSources';
import { poolSize, WorkerPool } from './workerPool';

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
    coverage: readonly CityCoverageBox[];
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
  /**
   * Buildings drawn last frame at a height MEASURED from the terrain's
   * surface model, nothing recording theirs (`measuredHeight.ts`): the
   * runtime `height_source=dsm`.
   */
  measured: number;
  /** GPU bytes held by the tile cache. */
  gpuBytes: number;
  /** Worker time for the last tile: decode + mesh, and tree placement. */
  lastMeshMs: number;
  lastTreeMs: number;
  /** This thread's time in `render()` (selection, scheduling, three's draw calls), smoothed. */
  frameCpuMs: number;
  /** Meshes waiting for the per-frame upload budget. */
  uploadsQueued: number;
  workers: number;
  errors: number;
}

export interface CityEngine {
  /** Draw the buildings and trees. */
  render(view: CityView): void;
  /** Draw the models — from their own layer, above the overlays (`city3dLayer.web.ts`). */
  renderModels(view: CityView): void;
  /** The map's light, re-applied whenever `building-3d`'s would change (the sun). */
  setLight(light: CityLight): void;
  setPalette(palette: CityPalette): void;
  /** Coordinate-anchored models in the same scene (`models.ts`, SDK_MAP_MODELS phase 1). */
  setModels(specs: readonly ModelSpec[]): void;
  setModelPlacement(id: string, placement: ModelSpec['placement']): void;
  /** The model under a CSS-pixel point of the last frame, or `null`. */
  pickModel(point: { x: number; y: number }): string | null;
  /** Each drawn model's anchor on screen in the last frame (development checks). */
  modelAnchors(): ReturnType<ReturnType<typeof createModelLayer>['anchors']>;
  /**
   * The terrain the buildings and trees stand on, as a sampler of the drawn
   * ground, or `null` for none. Call again whenever the terrain changes (a DEM
   * tile arrived); every tile is then re-grounded, a few per frame.
   */
  setGround(sample: GroundSampler | null): void;
  dispose(): void;
}

/** Tiles re-grounded per frame: each is a 1,089-sample grid plus a pass over its vertices. */
const GROUND_TILES_PER_FRAME = 1;

/**
 * GPU budget for cached tile meshes: what is drawn ({@link DRAW_BUDGET}) plus
 * panning slack and the coarser levels kept for fallback.
 */
const MAX_CACHED_BYTES = 192 * 1024 * 1024;

/**
 * Entry budget, which is what bounds EMPTY tiles (sea, fields): they weigh
 * nothing against {@link MAX_CACHED_BYTES} but are cached so a revisit does
 * not fetch them again (see `tileScheduler.ts`). Every (tile, level) is one
 * entry, and up to 48 tiles are drawn.
 */
const MAX_CACHED_TILES = 160;

/**
 * What one frame may draw (`docs/MAP_3D_CITY.md` → "Budgets"). Measured
 * before this budget, Barcelona's six nearest full-detail tiles were 136 MB
 * and 6.6 M vertices and still left the far half of a tilted view flat.
 */
export const DRAW_BUDGET: DrawBudget = { bytes: 128 * 1024 * 1024, vertices: 8_000_000 };

/**
 * Tree instances drawn per frame, nearest tiles first (`docs/MAP_3D_CITY.md`
 * → "Budgets"); a tile past it draws its buildings without trees.
 */
export const TREE_BUDGET = 40_000;

/** Bytes of new meshes handed to the GPU per frame (at least one mesh always goes). */
const UPLOAD_BYTES_PER_FRAME = 12 * 1024 * 1024;

/**
 * While the map is animating, a frame slower than this admits one mesh only;
 * a gap longer than {@link IDLE_GAP_MS} is the map at rest, not a slow frame.
 */
const SLOW_FRAME_MS = 50;
const IDLE_GAP_MS = 500;

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
  const value = Number.parseInt(hex.slice(1, 7), 16);
  return new THREE.Vector3(
    ((value >> 16) & 255) / 255,
    ((value >> 8) & 255) / 255,
    (value & 255) / 255,
  );
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
  const renderer = new THREE.WebGLRenderer({ canvas: options.canvas, context: options.gl });
  // The map owns the framebuffer: never clear what it has already drawn.
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();

  const light = {
    uLightPosition: { value: new THREE.Vector3(0, 0, 1) },
    uLightIntensity: { value: 0.5 },
    uLightColor: { value: new THREE.Vector3(1, 1, 1) },
    uOpacity: { value: 1 },
    // On 3D terrain: read the per-vertex lift (`terrainGround.ts`).
    uGrounded: { value: 0 },
  };
  const buildingUniforms = {
    ...light,
    uLow: { value: new THREE.Vector3() },
    uTall: { value: new THREE.Vector3() },
    uVeryTall: { value: new THREE.Vector3() },
    uTallM: { value: 60 },
    uVeryTallM: { value: 180 },
  };
  const treeUniforms = {
    ...light,
    uCrown: { value: new THREE.Vector3(0.3, 0.5, 0.3) },
    uConifer: { value: new THREE.Vector3(0.2, 0.4, 0.3) },
    uTreeMinHeight: { value: 0 },
    uTrunk: { value: new THREE.Vector3(0.3, 0.3, 0.25) },
  };
  // Every material is a `RawShaderMaterial` with these shaders and its own
  // fade pair, built per tile entry (`cityMeshes.ts`, which also explains
  // which faces each keeps: the model matrices mirror y, and three swaps its
  // notion of "front" with the determinant).
  const context = {
    scene,
    buildingUniforms,
    buildingShaders: {
      openmaptiles: { vertexShader: CITY_VERTEX_SHADER, fragmentShader: CITY_FRAGMENT_SHADER },
      goway: { vertexShader: OSM_VERTEX_SHADER, fragmentShader: OSM_FRAGMENT_SHADER },
    },
    treeUniforms,
  };
  // Where the city tiles draw instead of the basemap's buildings (`sources.ts`).
  const city = options.city
    ? { tileZoom: options.city.tileZoom, coverage: options.city.coverage }
    : null;
  const shapes = createTreeShapes();
  const transitions = new Transitions<TileEntry>();

  // `null` entries are empty tiles (sea, fields): cached so they are not
  // fetched again on every revisit.
  const cache = new TileCache<TileEntry>(MAX_CACHED_BYTES, MAX_CACHED_TILES, (entry) => {
    transitions.drop(entry);
    disposeEntry(entry, scene);
    grounder.forget(entry.key);
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
  let frameCpuMs = 0;
  let lastFrameAt = 0;
  let lastStatsAt = 0;
  let lastSignature = '';
  let drawn = { triangles: 0, vertices: 0, trees: 0, treeTriangles: 0, measured: 0 };
  // Measured full-detail cost per canonical tile, and a running mean of it.
  const measured = new Map<string, TileCost>();
  let meanFull: TileCost = UNKNOWN_FULL;

  const buildings = options.buildings !== false;
  // No buildings, no workers: a models-only engine never fetches a tile.
  const pool = new WorkerPool<MeshWorkerRequest & { id: number }, MeshWorkerResponse>(
    () => new Worker(new URL('./meshWorker', import.meta.url)),
    buildings
      ? poolSize(typeof navigator === 'undefined' ? undefined : navigator.hardwareConcurrency)
      : 0,
    (reply) => onReply(reply),
    // A worker died with this request: retried like any failed tile.
    (id, message) => onReply({ type: 'error', id, message }),
  );
  const grounder = new TileGrounder(() => performance.now(), options.onGroundStats);
  let groundSampler: GroundSampler | null = null;
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
    onStatus: (id, status) => options.onModelStatus?.(id, status),
    pageOrigin: typeof location !== 'undefined' ? location.origin : null,
  });
  // Models are drawn in their own pass (their own layer in the style), with
  // their own camera (see `models.ts` → Frames) but the same renderer and the
  // same depth buffer.
  const drawModels = (view: CityView) => {
    if (!models.active) return;
    renderer.resetState();
    models.render(renderer, view, {
      width: options.canvas.clientWidth,
      height: options.canvas.clientHeight,
    });
  };

  const reportStats = (force = false) => {
    if (!options.onStats) return;
    const now = performance.now();
    const byLod: [number, number, number] = [0, 0, 0];
    let loaded = 0;
    for (const tile of selected) {
      byLod[tile.lod]++;
      if (cache.has(lodKey(tileKey(tile), tile.lod))) loaded++;
    }
    // Counts that changed are reported at once; timings at most 4× a second.
    const signature = `${byLod.join()}|${loaded}|${scheduler.pendingCount}|${arrivals.length}|${errors}`;
    if (!force && signature === lastSignature && now - lastStatsAt < 250) return;
    lastSignature = signature;
    lastStatsAt = now;
    options.onStats({
      tilesWanted: selected.length,
      tilesLoaded: loaded,
      tilesPending: scheduler.pendingCount + arrivals.length,
      tilesByLod: byLod,
      ...drawn,
      gpuBytes: cache.bytes,
      lastMeshMs,
      lastTreeMs,
      frameCpuMs,
      uploadsQueued: arrivals.length,
      workers: pool.size,
      errors,
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
    if (!request) return;

    if (reply.type === 'cancelled') return;
    if (reply.type === 'error') {
      // One bad tile costs that tile; the rest of the city keeps drawing. It
      // is retried with a bounded backoff (`tileScheduler.ts`) EVEN IF THE
      // VIEW NEVER CHANGES — the timer asks for a frame, and that frame's
      // `plan` re-requests it — because `building-3d`, which would otherwise
      // have drawn it, is hidden.
      const delay = scheduler.failed(request, reply.id, performance.now());
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

  /** Hand queued meshes to the GPU, nearest first, within this frame's budget. */
  const admit = (now: number) => {
    if (arrivals.length === 0) return;
    const rank = new Map<string, number>();
    for (const tile of selected) rank.set(lodKey(tileKey(tile), tile.lod), tile.r);
    arrivals.sort((a, b) => (rank.get(a.key) ?? 1e9) - (rank.get(b.key) ?? 1e9));
    // A long gap since the last frame is the map at rest, not a slow frame.
    const gap = now - lastFrameAt;
    const slow = lastFrameAt > 0 && gap > SLOW_FRAME_MS && gap < IDLE_GAP_MS;
    let budget = slow ? 0 : UPLOAD_BYTES_PER_FRAME;
    let admitted = 0;
    const wanted = protectedKeys();
    while (arrivals.length > 0) {
      const next = arrivals[0];
      const bytes = (next.reply.mesh?.bytes ?? 0) + (next.reply.trees?.data.byteLength ?? 0);
      if (admitted > 0 && bytes > budget) break;
      arrivals.shift();
      admitted++;
      budget -= bytes;
      const entry = createTileEntry(
        context,
        shapes,
        next.key,
        next.lod,
        next.reply.mesh,
        next.reply.trees,
        next.format,
      );
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
        LOD_POLICY,
        previousLods,
      );
      const fitted = fitBudget(chosen, costOf, DRAW_BUDGET);
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
      (key) => (cache.has(key) && !due(key)) || arrived.has(key),
    );
    for (const id of plan.cancel) {
      pool.cancel(id, { type: 'cancel', id });
      requests.delete(id);
    }
    const room = pool.size * MAX_IN_FLIGHT_PER_WORKER - pool.inFlight;
    for (const request of plan.request.slice(0, Math.max(0, room))) {
      const id = nextRequestId++;
      requests.set(id, request);
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
                // The fill reads the basemap's landcover: the city tiles
                // carry buildings and the trees OSM records, no landcover.
                ...(options.trees
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
          trees: options.trees && request.lod < 2 ? options.trees.sourceLayers : null,
          treeFillWoods: options.trees?.fillWoods === true,
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

  const engine: CityEngine = {
    render(view) {
      if (disposed || !buildings) return;
      const started = performance.now();
      frame++;
      updateWanted(view, started);
      admit(started);
      lastFrameAt = started;

      const span = options.fade.end - options.fade.start;
      const opacity = Math.max(0, Math.min(1, (view.zoom - options.fade.start) / span));
      light.uOpacity.value = opacity;
      treeUniforms.uTreeMinHeight.value = treeMinHeightM(view.zoom);

      const center = { x: mercatorXFromLng(view.center.lng), y: mercatorYFromLat(view.center.lat) };
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
      // so it waits for its first lift.
      const grounded = grounder.active;
      if (grounded) {
        let budget = GROUND_TILES_PER_FRAME;
        for (const tile of selected) {
          const entry = bestFor(tile);
          if (!entry || grounder.isCurrent(entry.key)) continue;
          if (budget-- <= 0) {
            options.requestRepaint();
            break;
          }
          const result = grounder.ground(entry.key, groundTileFor(entry, tile));
          if (result) {
            applyGround(entry, result);
            liftRange = {
              min: Math.min(liftRange?.min ?? result.min, result.min),
              max: Math.max(liftRange?.max ?? result.max, result.max),
            };
          }
        }
      }

      for (const entry of cache.values()) setEntryVisible(entry, false);
      drawn = { triangles: 0, vertices: 0, trees: 0, treeTriangles: 0, measured: 0 };
      if (opacity > 0) {
        // Nearest first, so the tree budget spends itself on the near tiles.
        const rank = new Map<string, number>();
        for (const tile of selected) rank.set(tileKey(tile), tile.r);
        const r = (entry: TileEntry) => rank.get(entry.key.slice(0, entry.key.indexOf('@'))) ?? 1e9;
        draws.sort((a, b) => r(a.value) - r(b.value));
        for (const { value: entry, from, to } of draws) {
          if (!entry.placement) continue;
          if (grounded && !grounder.hasGround(entry.key)) continue;
          placeEntry(entry, entry.placement, center);
          setEntryFade(entry, from, to);
          setEntryVisible(entry, true);
          drawn.triangles += entry.triangles;
          drawn.vertices += entry.vertices;
          if (grounded) drawn.measured += entry.measured;
          if (entry.trees.length > 0 && drawn.trees + entry.treeCount > TREE_BUDGET) {
            // Past the budget a farther tile shows its buildings only.
            for (const mesh of entry.trees) mesh.visible = false;
          } else {
            drawn.trees += entry.treeCount;
            drawn.treeTriangles += entry.treeTriangles;
          }
        }
        camera.projectionMatrix.fromArray(centeredProjection(view.mercatorToClip, center));
        camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
        // three caches GL state it believes it set; the map changed all of it
        // since the last frame. MapLibre in turn marks its own state dirty
        // after a custom layer returns, so nothing needs restoring after.
        renderer.resetState();
        renderer.render(scene, camera);
      }
      if (active) options.requestRepaint();

      const cpu = performance.now() - started;
      frameCpuMs = frameCpuMs === 0 ? cpu : frameCpuMs * 0.9 + cpu * 0.1;
      reportStats();
    },

    renderModels(view) {
      if (disposed) return;
      drawModels(view);
    },

    setGround(sample) {
      grounder.setSampler(sample);
      // The models stand on the same drawn ground as the buildings.
      models.setGround(sample);
      groundSampler = sample;
      liftRange = null;
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

    pickModel(point) {
      return models.pick(point);
    },

    modelAnchors() {
      return models.anchors();
    },

    setLight(next) {
      // Not normalised: the radial term is MapLibre's gain (see `CityLight`).
      light.uLightPosition.value.set(...next.position);
      light.uLightIntensity.value = next.intensity;
      light.uLightColor.value.set(...next.color);
      models.setLight(next);
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
      pool.terminate();
      models.dispose();
      grounder.clear();
      for (const timer of retryTimers) clearTimeout(timer);
      retryTimers.clear();
      transitions.clear();
      cache.clear();
      shapes.dispose();
      requests.clear();
      arrivals.length = 0;
      // `dispose()` frees three's own bookkeeping. NOT `forceContextLoss()`,
      // which `sparkEngine` uses on its own canvas: this context is the MAP's,
      // and losing it would blank the basemap.
      renderer.dispose();
    },
  };

  engine.setPalette(options.palette);
  engine.setLight(options.light);
  return engine;
}

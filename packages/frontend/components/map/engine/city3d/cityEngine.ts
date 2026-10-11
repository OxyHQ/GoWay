/**
 * The city-3D engine: three.js drawing GoWay's buildings INTO the map's own
 * WebGL context, with the map's own camera.
 *
 * This is the only module of the feature that imports `three`, and it is only
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
 *  1. Pick the tiles near the view (`tilesForView`) at the source's max zoom
 *     (14 — GoWay's tiles are over-zoomed beyond it, so one mesh per z14 tile
 *     serves every zoom the layer draws at).
 *  2. Ask the worker for any that are missing; cancel any no longer wanted.
 *  3. Place every loaded mesh with a centre-relative model matrix and draw
 *     (`tileMath.ts` explains why centre-relative: float32 precision).
 *
 * Nothing is meshed on this thread. A dense Barcelona tile is ~1.1 M vertices
 * and ~165 ms of meshing (measured, see `docs/MAP_3D_CITY.md`); on the main
 * thread that is ten dropped frames per tile.
 */
import * as THREE from 'three';

import type { TileMesh } from './mesher';
import type { CityLight } from './occlusion';
import type { MeshWorkerRequest, MeshWorkerResponse } from './protocol';
import { CITY_FRAGMENT_SHADER, CITY_VERTEX_SHADER } from './shaders';
import {
  centeredProjection,
  type LngLatBox,
  mercatorXFromLng,
  mercatorYFromLat,
  type TileId,
  tileKey,
  tileModelMatrix,
  tilesForView,
} from './tileMath';

/** The palette's building height ramp (`buildingHeightRamp` in `buildings3d.ts`). */
export interface CityPalette {
  low: string;
  tall: string;
  veryTall: string;
  tallM: number;
  veryTallM: number;
}

export interface CityEngineOptions {
  gl: WebGL2RenderingContext;
  canvas: HTMLCanvasElement;
  /** `{z}/{x}/{y}` template of the vector source carrying OpenMapTiles' `building` layer. */
  tileUrlTemplate: string;
  /** The source's max zoom: tiles are fetched at this zoom only. */
  tileZoom: number;
  sourceLayer: string;
  palette: CityPalette;
  /** The map's light, converted (`components/map/city3dLight.ts`); see `CityLight`. */
  light: CityLight;
  /** The zoom fade, shared with the `fill-extrusion` layer this replaces. */
  fade: { start: number; end: number };
  /** Ask the host for another frame (new geometry arrived). */
  requestRepaint: () => void;
  /** Development statistics, called whenever they change. */
  onStats?: (stats: CityEngineStats) => void;
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
  tilesWanted: number;
  tilesLoaded: number;
  tilesPending: number;
  triangles: number;
  gpuBytes: number;
  lastMeshMs: number;
  errors: number;
}

export interface CityEngine {
  render(view: CityView): void;
  /** The map's light, re-applied whenever `building-3d`'s would change (the sun). */
  setLight(light: CityLight): void;
  setPalette(palette: CityPalette): void;
  dispose(): void;
}

/** The nearest tiles drawn. A z14 tile is ~1.8–2.4 km, so 6 covers any view the layer draws at. */
const MAX_TILES = 6;

/**
 * GPU budget for cached tile meshes. A dense Barcelona tile is ~26 MB of
 * buffers and a Manhattan one ~6 MB (measured); 192 MB keeps the visible set
 * plus a little panning slack without becoming the page's biggest allocation.
 */
const MAX_CACHED_BYTES = 192 * 1024 * 1024;

interface CachedTile {
  tile: TileId;
  mesh: THREE.Mesh;
  bytes: number;
  triangles: number;
  lastUsed: number;
}

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

function toGeometry(mesh: TileMesh): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(mesh.normals, 3, true));
  geometry.setAttribute('shade', new THREE.BufferAttribute(mesh.shade, 2, true));
  geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  // From the worker's bounds, so three never walks a million vertices on this
  // thread to compute them itself.
  const min = new THREE.Vector3(...mesh.bounds.min);
  const max = new THREE.Vector3(...mesh.bounds.max);
  geometry.boundingBox = new THREE.Box3(min, max);
  geometry.boundingSphere = geometry.boundingBox.getBoundingSphere(new THREE.Sphere());
  return geometry;
}

export function createCityEngine(options: CityEngineOptions): CityEngine {
  const renderer = new THREE.WebGLRenderer({ canvas: options.canvas, context: options.gl });
  // The map owns the framebuffer: never clear what it has already drawn.
  renderer.autoClear = false;

  const scene = new THREE.Scene();
  const camera = new THREE.Camera();

  const uniforms = {
    uLow: { value: new THREE.Vector3() },
    uTall: { value: new THREE.Vector3() },
    uVeryTall: { value: new THREE.Vector3() },
    uTallM: { value: 60 },
    uVeryTallM: { value: 180 },
    uLightPosition: { value: new THREE.Vector3(0, 0, 1) },
    uLightIntensity: { value: 0.5 },
    uLightColor: { value: new THREE.Vector3(1, 1, 1) },
    uOpacity: { value: 1 },
  };

  const material = new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader: CITY_VERTEX_SHADER,
    fragmentShader: CITY_FRAGMENT_SHADER,
    uniforms,
    // Every model matrix mirrors y (local ENU is y-north, mercator y-south —
    // see `tileModelMatrix`), and three, seeing a negative determinant, swaps
    // which winding it calls front. The mirror is undone by MapLibre's own
    // projection, which three cannot see; so the faces three now calls BACK
    // are the outward ones. Verified by rendering the same Barcelona frame
    // both ways: `FrontSide` draws hollow boxes (inner faces only, no roofs);
    // `BackSide` draws the buildings.
    side: THREE.BackSide,
    // Premultiplied, as MapLibre composites custom layers.
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    transparent: false,
  });

  const cache = new Map<string, CachedTile>();
  const pending = new Map<string, number>();
  const requests = new Map<number, TileId>();
  let nextRequestId = 1;
  let wantedKeys: string[] = [];
  let frame = 0;
  let disposed = false;
  let lastMeshMs = 0;
  let errors = 0;

  const worker = new Worker(new URL('./meshWorker', import.meta.url));
  const send = (message: MeshWorkerRequest) => worker.postMessage(message);

  const reportStats = () => {
    if (!options.onStats) return;
    let triangles = 0;
    let gpuBytes = 0;
    for (const entry of cache.values()) {
      triangles += entry.triangles;
      gpuBytes += entry.bytes;
    }
    options.onStats({
      tilesWanted: wantedKeys.length,
      tilesLoaded: wantedKeys.filter((key) => cache.has(key)).length,
      tilesPending: pending.size,
      triangles,
      gpuBytes,
      lastMeshMs,
      errors,
    });
  };

  const evict = () => {
    let total = 0;
    for (const entry of cache.values()) total += entry.bytes;
    if (total <= MAX_CACHED_BYTES) return;
    const wanted = new Set(wantedKeys);
    const candidates = [...cache.entries()]
      .filter(([key]) => !wanted.has(key))
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    for (const [key, entry] of candidates) {
      if (total <= MAX_CACHED_BYTES) break;
      scene.remove(entry.mesh);
      entry.mesh.geometry.dispose();
      cache.delete(key);
      total -= entry.bytes;
    }
  };

  worker.onmessage = (event: MessageEvent<MeshWorkerResponse>) => {
    if (disposed) return;
    const reply = event.data;
    const tile = requests.get(reply.id);
    requests.delete(reply.id);
    if (!tile) return;
    const key = tileKey(tile);
    if (pending.get(key) === reply.id) pending.delete(key);

    if (reply.type === 'error') {
      // One bad tile costs that tile. It is retried the next time it is wanted
      // after the view changes, and the rest of the city keeps drawing.
      errors++;
      reportStats();
      return;
    }
    lastMeshMs = reply.meshMs;
    if (reply.mesh) {
      const mesh = new THREE.Mesh(toGeometry(reply.mesh), material);
      // The engine writes `matrixWorld` itself every frame (centre-relative);
      // three must not recompute it from position/rotation/scale.
      mesh.matrixAutoUpdate = false;
      mesh.matrixWorldAutoUpdate = false;
      mesh.visible = false;
      scene.add(mesh);
      const bytes =
        reply.mesh.positions.byteLength +
        reply.mesh.normals.byteLength +
        reply.mesh.shade.byteLength +
        reply.mesh.indices.byteLength;
      cache.set(key, {
        tile,
        mesh,
        bytes,
        triangles: reply.mesh.indices.length / 3,
        lastUsed: frame,
      });
      evict();
    }
    reportStats();
    options.requestRepaint();
  };
  worker.onerror = () => {
    errors++;
    reportStats();
  };

  const updateWanted = (view: CityView) => {
    const tiles =
      view.zoom >= options.fade.start
        ? tilesForView(view.bounds, view.center, options.tileZoom, MAX_TILES)
        : [];
    const keys = tiles.map(tileKey);
    if (keys.join('|') === wantedKeys.join('|')) return;
    wantedKeys = keys;
    const wanted = new Set(keys);

    for (const [key, id] of pending) {
      if (wanted.has(key)) continue;
      send({ type: 'cancel', id });
      requests.delete(id);
      pending.delete(key);
    }
    for (const tile of tiles) {
      const key = tileKey(tile);
      if (cache.has(key) || pending.has(key)) continue;
      const id = nextRequestId++;
      requests.set(id, tile);
      pending.set(key, id);
      send({
        type: 'mesh',
        id,
        tile,
        url: expandTemplate(options.tileUrlTemplate, tile),
        sourceLayer: options.sourceLayer,
      });
    }
    reportStats();
  };

  const engine: CityEngine = {
    render(view) {
      if (disposed) return;
      frame++;
      updateWanted(view);

      const span = options.fade.end - options.fade.start;
      const opacity = Math.max(0, Math.min(1, (view.zoom - options.fade.start) / span));
      if (opacity <= 0) return;
      uniforms.uOpacity.value = opacity;

      const center = { x: mercatorXFromLng(view.center.lng), y: mercatorYFromLat(view.center.lat) };
      camera.projectionMatrix.fromArray(centeredProjection(view.mercatorToClip, center));
      camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();

      const wanted = new Set(wantedKeys);
      for (const [key, entry] of cache) {
        const visible = wanted.has(key);
        entry.mesh.visible = visible;
        if (!visible) continue;
        entry.lastUsed = frame;
        entry.mesh.matrixWorld.fromArray(tileModelMatrix(entry.tile, center));
      }

      // three caches GL state it believes it set; the map changed all of it
      // since the last frame. MapLibre in turn marks its own state dirty after
      // a custom layer returns, so nothing needs restoring on the way out.
      renderer.resetState();
      renderer.render(scene, camera);
    },

    setLight(light) {
      // Not normalised: the radial term is MapLibre's gain (see `CityLight`).
      uniforms.uLightPosition.value.set(...light.position);
      uniforms.uLightIntensity.value = light.intensity;
      uniforms.uLightColor.value.set(...light.color);
      options.requestRepaint();
    },

    setPalette(palette) {
      uniforms.uLow.value.copy(hexToVector(palette.low));
      uniforms.uTall.value.copy(hexToVector(palette.tall));
      uniforms.uVeryTall.value.copy(hexToVector(palette.veryTall));
      uniforms.uTallM.value = palette.tallM;
      uniforms.uVeryTallM.value = palette.veryTallM;
      options.requestRepaint();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      worker.terminate();
      for (const entry of cache.values()) {
        scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
      }
      cache.clear();
      pending.clear();
      requests.clear();
      material.dispose();
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

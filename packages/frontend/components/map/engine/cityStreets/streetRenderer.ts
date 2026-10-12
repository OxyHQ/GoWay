/**
 * The street-detail renderer: road surfaces, sidewalks and markings drawn in
 * the city-3D scene (`docs/MAP_STREETS.md`), as a {@link CityOverlay} of the
 * city engine — same scene, camera, depth buffer, terrain and sky as the
 * buildings (`docs/MAP_3D_CITY.md` → "One engine, one scene").
 *
 * Reached only through `components/engine3d/lazyChunk.ts` (it imports
 * three.js), and only when the registry's `cityStreets` is on.
 *
 * Per z15 road tile, two meshes (surfaces, markings) built by ONE worker
 * through the engine's `WorkerPool`; which tiles and at which level comes from
 * the engine's own `selectLodTiles`, with thresholds set so a tile is drawn at
 * full detail where the street is at z17 or closer on screen, simplified from
 * z16, and not at all below.
 */
import * as THREE from 'three';

import type { CityView } from '../city3d/cityEngine';
import { type LodPolicy, metresPerPixel, selectLodTiles } from '../city3d/lod';
import type { CityLight } from '../city3d/occlusion';
import type { CityOverlay, CityOverlayFrame, CityOverlaySky } from '../city3d/overlay';
import { GROUND, type Ground } from '../city3d/terrainGround';
import {
  EARTH_CIRCUMFERENCE_M,
  tileKey,
  tileModelMatrix,
  tileSizeMetres,
  type ViewTile,
} from '../city3d/tileMath';
import { WorkerPool } from '../city3d/workerPool';
import type { PackedMarkings, PackedSurfaces } from './meshBuffers';
import type { StreetWorkerRequest, StreetWorkerResponse } from './protocol';
import { ATLAS_SIZE } from './streetAtlas';
import type { StreetMeshStats } from './streetMesher';
import type { QualityProfile } from '@/lib/map/quality/profile';
import { markingShaders, surfaceShaders } from './streetShaders';

/** Streets are drawn from this zoom; they fade in over the next quarter zoom. */
export const STREETS_MIN_ZOOM = 16;
const FADE_ZOOMS = 0.25;
/** Where the street is at this zoom on screen or closer, full detail. */
export const FULL_DETAIL_ZOOM = 17;

/**
 * Fixed working limits (`docs/MAP_STREETS.md` → Budgets). What a frame may
 * DRAW — tiles and triangles — is the quality profile's `streets`
 * (`lib/map/quality/profile.ts`), never a number of this module's.
 */
export const STREET_BUDGET = {
  /** Meshes kept, drawn or not, per tile the profile lets us draw. */
  cachedPerDrawn: 2,
  /** Requests in flight. */
  maxInFlight: 3,
  /** Ground grids sampled per frame (each ~1,000 terrain reads). */
  groundsPerFrame: 2,
  /** Clip-space depth nudge per layer (×w). */
  depthBias: 2e-6,
} as const;

/** sRGB 0–1 per slot, in the order of `meshBuffers.ts` → `SURFACE` and `PAINT` (`streetPalette.ts`). */
export interface StreetPaletteInput {
  surfaces: {
    day: readonly (readonly [number, number, number])[];
    night: readonly (readonly [number, number, number])[];
  };
  paint: {
    day: readonly (readonly [number, number, number])[];
    night: readonly (readonly [number, number, number])[];
  };
}

export interface CityStreetsOptions {
  /** Absolute `{z}/{x}/{y}` template of the road tiles. */
  roadTileTemplate: string;
  /** The map style's glyph template (absolute), or `null`: no names or words. */
  glyphTemplate: string | null;
  fontstack: string;
  palette: StreetPaletteInput;
  /** The quality profile's `streets`: tiles and triangles a frame may draw. */
  quality: QualityProfile['streets'];
  requestRepaint: () => void;
  /**
   * Where painted names are on screen now: `[lng, lat]` points along each,
   * from the tiles drawn at full detail. Called when that set changes; the
   * host keeps its flat road labels off those stretches.
   */
  onPaintedNames?: (points: readonly [number, number][]) => void;
  onStats?: (stats: CityStreetsStats) => void;
}

export interface CityStreetsStats {
  tilesDrawn: number;
  tilesFull: number;
  tilesCached: number;
  pending: number;
  triangles: number;
  drawCalls: number;
  /** Worker time to mesh a tile (decode excluded), last and mean. */
  lastMeshMs: number;
  meanMeshMs: number;
  /** Totals of the drawn tiles' mesher stats. */
  drawn: Pick<
    StreetMeshStats,
    'crossings' | 'stopLines' | 'arrows' | 'names' | 'words' | 'junctions'
  >;
  errors: number;
}

interface Entry {
  key: string;
  tile: { x: number; y: number };
  state: 'pending' | 'ready' | 'empty' | 'failed';
  id: number;
  retryAt: number;
  surfaces: THREE.Mesh | null;
  markings: THREE.Mesh | null;
  simpleSurfaces: number;
  simpleMarkings: number;
  stats: StreetMeshStats | null;
  paintedNames: [number, number][];
  ground: THREE.DataTexture | null;
  groundVersion: number;
  uniforms: {
    uGround: { value: THREE.Texture | null };
    uGrounded: { value: number };
    uTileSize: { value: number };
    uDetail: { value: number };
  };
  lastUsed: number;
}

const vec3s = (list: readonly (readonly [number, number, number])[]) =>
  list.map(([r, g, b]) => new THREE.Vector3(r, g, b));

export function createCityStreets(options: CityStreetsOptions): CityOverlay {
  const group = new THREE.Group();
  group.matrixAutoUpdate = false;
  group.matrixWorldAutoUpdate = false;

  const atlasBytes = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);
  const atlas = new THREE.DataTexture(
    atlasBytes,
    ATLAS_SIZE,
    ATLAS_SIZE,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  atlas.magFilter = THREE.LinearFilter;
  atlas.minFilter = THREE.LinearFilter;
  atlas.generateMipmaps = false;
  atlas.needsUpdate = true;
  let atlasEpoch = -1;

  const shared = {
    uNightFactor: { value: 0 },
    uFade: { value: 1 },
    uPxPerM: { value: 1 },
    uDepthBias: { value: STREET_BUDGET.depthBias },
    uAtlas: { value: atlas as THREE.Texture },
    uSurfaceDay: { value: vec3s(options.palette.surfaces.day) },
    uSurfaceNight: { value: vec3s(options.palette.surfaces.night) },
    uPaintDay: { value: vec3s(options.palette.paint.day) },
    uPaintNight: { value: vec3s(options.palette.paint.night) },
  };
  let sky: CityOverlaySky | null = null;
  let shaders: {
    surfaces: ReturnType<typeof surfaceShaders>;
    markings: ReturnType<typeof markingShaders>;
  } | null = null;
  const shadersNow = () => {
    shaders ??= { surfaces: surfaceShaders(sky), markings: markingShaders(sky) };
    return shaders;
  };

  const maxCached = Math.max(4, options.quality.maxTiles * STREET_BUDGET.cachedPerDrawn);
  let namedKey = '';
  const entries = new Map<string, Entry>();
  const byId = new Map<number, Entry>();
  let nextId = 1;
  let disposed = false;
  let frameNo = 0;
  let errors = 0;
  let lastMeshMs = 0;
  let meshMsSum = 0;
  let meshCount = 0;
  // The engine's ONE ground (`terrainGround.ts` → `Ground`): the same cached
  // grids the buildings, trees and city life stand on.
  let ground: Ground | null = null;
  let groundVersion = 0;
  const previousLods = new Map<string, 0 | 1 | 2>();

  const pool = new WorkerPool<StreetWorkerRequest & { id: number }, StreetWorkerResponse>(
    () => new Worker(new URL('./streetWorker', import.meta.url)),
    1,
    (reply) => onReply(reply),
    (id, message) => onReply({ type: 'error', id, message }),
  );

  const disposeMeshes = (entry: Entry) => {
    for (const mesh of [entry.surfaces, entry.markings]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      mesh.geometry.dispose();
      (mesh.material as THREE.Material).dispose();
    }
    entry.surfaces = null;
    entry.markings = null;
    entry.ground?.dispose();
    entry.ground = null;
    entry.groundVersion = -1;
  };

  const meshFor = (
    entry: Entry,
    data: PackedSurfaces | PackedMarkings,
    kind: 'surfaces' | 'markings',
  ): THREE.Mesh => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geometry.setAttribute('attr', new THREE.BufferAttribute(data.attrs, 4));
    if ('offsets' in data) {
      geometry.setAttribute('offset', new THREE.BufferAttribute(data.offsets, 2));
      geometry.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2));
    }
    geometry.setIndex(new THREE.BufferAttribute(data.indices, 1));
    const source = shadersNow()[kind];
    const material = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3,
      ...source,
      uniforms: { ...(sky?.uniforms ?? {}), ...shared, ...entry.uniforms },
      side: THREE.DoubleSide,
      ...(kind === 'markings'
        ? {
            transparent: true,
            depthWrite: false,
            blending: THREE.CustomBlending,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
          }
        : {}),
    });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // Under everything else in the scene: surfaces first among the opaque,
    // markings first among the blended (before city life's contact shadows).
    mesh.renderOrder = kind === 'surfaces' ? -3 : -2;
    mesh.visible = false;
    group.add(mesh);
    return mesh;
  };

  const onReply = (reply: StreetWorkerResponse) => {
    if (disposed || reply.type === 'cancelled') return;
    const entry = byId.get(reply.id);
    byId.delete(reply.id);
    if (!entry || entry.id !== reply.id) return;
    if (reply.type === 'error') {
      errors++;
      entry.state = 'failed';
      entry.retryAt = performance.now() + 4000;
      return;
    }
    if (reply.epoch !== atlasEpoch) {
      // A fresh worker packs a fresh atlas: everything meshed against the old one is stale.
      atlasEpoch = reply.epoch;
      atlasBytes.fill(0);
      for (const other of entries.values()) {
        if (other !== entry && other.state === 'ready') {
          disposeMeshes(other);
          other.state = 'failed';
          other.retryAt = 0;
        }
      }
    }
    for (const patch of reply.patches) {
      for (let row = 0; row < patch.h; row++) {
        atlasBytes.set(
          patch.data.subarray(row * patch.w, (row + 1) * patch.w),
          (patch.y + row) * ATLAS_SIZE + patch.x,
        );
      }
    }
    if (reply.patches.length > 0) atlas.needsUpdate = true;
    lastMeshMs = reply.meshMs;
    if (reply.stats) {
      meshMsSum += reply.meshMs;
      meshCount++;
    }
    entry.stats = reply.stats;
    entry.paintedNames = reply.paintedNames;
    if (!reply.surfaces && !reply.markings) {
      entry.state = 'empty';
    } else {
      if (reply.surfaces) {
        entry.surfaces = meshFor(entry, reply.surfaces, 'surfaces');
        entry.simpleSurfaces = reply.surfaces.simpleCount;
      }
      if (reply.markings) {
        entry.markings = meshFor(entry, reply.markings, 'markings');
        entry.simpleMarkings = reply.markings.simpleCount;
      }
      entry.state = 'ready';
    }
    options.requestRepaint();
  };

  const request = (entry: Entry) => {
    const id = nextId++;
    entry.id = id;
    entry.state = 'pending';
    byId.set(id, entry);
    pool.send(
      {
        type: 'mesh',
        id,
        x: entry.tile.x,
        y: entry.tile.y,
        template: options.roadTileTemplate,
        glyphs: options.glyphTemplate,
        fontstack: options.fontstack,
      },
      entry.key,
    );
  };

  const evict = (wanted: ReadonlySet<string>) => {
    if (entries.size <= maxCached) return;
    const idle = [...entries.values()]
      .filter((e) => !wanted.has(e.key))
      .sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of idle) {
      if (entries.size <= maxCached) break;
      if (entry.state === 'pending') pool.cancel(entry.id, { type: 'cancel', id: entry.id });
      byId.delete(entry.id);
      disposeMeshes(entry);
      entries.delete(entry.key);
    }
  };

  let stats: CityStreetsStats | null = null;
  let lastStatsAt = 0;

  const overlay: CityOverlay = {
    attach(scene) {
      scene.add(group);
    },

    update({ view, center, opacity }: CityOverlayFrame) {
      if (disposed) return;
      frameNo++;
      for (const entry of entries.values()) {
        if (entry.surfaces) entry.surfaces.visible = false;
        if (entry.markings) entry.markings.visible = false;
      }
      const fade = Math.max(0, Math.min(1, (view.zoom - STREETS_MIN_ZOOM) / FADE_ZOOMS));
      shared.uFade.value = fade * (opacity > 0 ? 1 : 0);
      if (shared.uFade.value <= 0) {
        if (namedKey !== '') {
          namedKey = '';
          options.onPaintedNames?.([]);
        }
        return;
      }

      const selected = select(view);
      const wanted = new Set(selected.map((t) => tileKey(t)));
      const now = performance.now();
      // Ask for what is missing, nearest first, within the in-flight budget.
      let inFlight = byId.size;
      for (const tile of selected) {
        const key = tileKey(tile);
        let entry = entries.get(key);
        if (!entry) {
          entry = {
            key,
            tile: { x: tile.x, y: tile.y },
            state: 'failed',
            id: 0,
            retryAt: 0,
            surfaces: null,
            markings: null,
            simpleSurfaces: 0,
            simpleMarkings: 0,
            stats: null,
            paintedNames: [],
            ground: null,
            groundVersion: -1,
            uniforms: {
              uGround: { value: null },
              uGrounded: { value: 0 },
              uTileSize: { value: tileSizeMetres({ z: 15, x: tile.x, y: tile.y }) },
              uDetail: { value: 0 },
            },
            lastUsed: frameNo,
          };
          entries.set(key, entry);
        }
        entry.lastUsed = frameNo;
        if (
          entry.state === 'failed' &&
          now >= entry.retryAt &&
          inFlight < STREET_BUDGET.maxInFlight
        ) {
          request(entry);
          inFlight++;
        }
      }
      // Cancel what the view no longer wants.
      for (const entry of entries.values()) {
        if (entry.state === 'pending' && !wanted.has(entry.key)) {
          pool.cancel(entry.id, { type: 'cancel', id: entry.id });
          byId.delete(entry.id);
          entry.state = 'failed';
          entry.retryAt = 0;
        }
      }
      evict(wanted);

      // Place, ground and draw.
      let groundBudget = STREET_BUDGET.groundsPerFrame;
      const drawn = { crossings: 0, stopLines: 0, arrows: 0, names: 0, words: 0, junctions: 0 };
      let triangles = 0;
      let drawCalls = 0;
      let tilesDrawn = 0;
      let tilesFull = 0;
      const named: Entry[] = [];
      for (const tile of selected) {
        const entry = entries.get(tileKey(tile));
        if (entry?.state !== 'ready') continue;
        if (ground) {
          const at = { z: 15, x: tile.x, y: tile.y };
          if (entry.groundVersion !== groundVersion) {
            if (!ground.hasGrid(at) && groundBudget-- <= 0) {
              options.requestRepaint();
              if (entry.groundVersion < 0) continue;
            } else {
              const grid = ground.grid(at);
              entry.ground?.dispose();
              const texture = new THREE.DataTexture(
                grid,
                GROUND.grid,
                GROUND.grid,
                THREE.RedFormat,
                THREE.FloatType,
              );
              texture.needsUpdate = true;
              entry.ground = texture;
              entry.uniforms.uGround.value = texture;
              entry.groundVersion = groundVersion;
            }
          }
          entry.uniforms.uGrounded.value = 1;
        } else {
          entry.uniforms.uGrounded.value = 0;
        }
        // The profile's triangles: nearest first, a tile that would pass them
        // draws its simplified level instead, and past that not at all.
        const cost = (mesh: THREE.Mesh | null, simple: number, all: boolean) =>
          mesh ? (all ? (mesh.geometry.index?.count ?? 0) : simple) / 3 : 0;
        const costOf = (all: boolean) =>
          cost(entry.surfaces, entry.simpleSurfaces, all) +
          cost(entry.markings, entry.simpleMarkings, all);
        let full = tile.lod === 0;
        if (full && triangles + costOf(true) > options.quality.drawTriangles) full = false;
        if (!full && triangles + costOf(false) > options.quality.drawTriangles) continue;
        const effective = view.zoom - Math.log2(Math.max(tile.r, 1e-6));
        entry.uniforms.uDetail.value = Math.max(
          0,
          Math.min(1, (effective - (FULL_DETAIL_ZOOM - 0.1)) / 0.3),
        );
        const matrix = tileModelMatrix(tile, center);
        tilesDrawn++;
        if (full) tilesFull++;
        for (const [mesh, simple] of [
          [entry.surfaces, entry.simpleSurfaces],
          [entry.markings, entry.simpleMarkings],
        ] as const) {
          if (!mesh) continue;
          const count = full ? (mesh.geometry.index?.count ?? 0) : simple;
          if (count === 0) continue;
          mesh.geometry.setDrawRange(0, count);
          mesh.matrixWorld.fromArray(matrix);
          mesh.visible = true;
          triangles += count / 3;
          drawCalls++;
        }
        if (entry.stats)
          for (const k of Object.keys(drawn) as (keyof typeof drawn)[]) drawn[k] += entry.stats[k];
        if (full && entry.uniforms.uDetail.value >= 0.5 && entry.paintedNames.length > 0) {
          named.push(entry);
        }
      }
      // The painted names on screen, reported only when the set changes.
      const key = named.map((e) => e.key).join(',');
      if (key !== namedKey) {
        namedKey = key;
        options.onPaintedNames?.(named.flatMap((e) => e.paintedNames));
      }
      // Device pixels per metre at the centre: 512-px tiles, mercator's 1/cos(lat).
      const ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
      shared.uPxPerM.value =
        (ratio * 512 * 2 ** view.zoom) /
        (EARTH_CIRCUMFERENCE_M * Math.cos((view.center.lat * Math.PI) / 180));

      if (options.onStats && now - lastStatsAt > 500) {
        lastStatsAt = now;
        stats = {
          tilesDrawn,
          tilesFull,
          tilesCached: entries.size,
          pending: byId.size,
          triangles,
          drawCalls,
          lastMeshMs,
          meanMeshMs: meshCount > 0 ? meshMsSum / meshCount : 0,
          drawn,
          errors,
        };
        options.onStats(stats);
      }
    },

    setLight(_light: CityLight) {
      // Unlit like the basemap, or lit by the sky (`setSky`).
    },

    setGround(next) {
      ground = next;
      groundVersion++;
      options.requestRepaint();
    },

    setSky(next) {
      sky = next;
      shaders = null;
      // The sky's night factor is the one every city material reads.
      const night = next.uniforms.uNightFactor as { value: number } | undefined;
      if (night) shared.uNightFactor = night;
    },

    setNightFactor(nightFactor) {
      if (!sky) shared.uNightFactor.value = nightFactor;
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (namedKey !== '') options.onPaintedNames?.([]);
      pool.terminate();
      for (const entry of entries.values()) disposeMeshes(entry);
      entries.clear();
      atlas.dispose();
      group.removeFromParent();
    },
  };

  /** The z15 road tiles to draw, nearest first, each with `lod` 0 (full) or 1 (simplified). */
  function select(view: CityView): (ViewTile & { lod: 0 | 1 | 2; r: number })[] {
    const centreM = ground ? ground.sample(view.center.lng, view.center.lat) : 0;
    const terrain =
      ground && Number.isFinite(centreM)
        ? { centreM, minM: centreM - 300, maxM: centreM + 300 }
        : undefined;
    const tiles = selectLodTiles(
      { ...view, terrain },
      15,
      streetLodPolicy(view.center.lat, options.quality.maxTiles),
      previousLods,
    ).filter((t) => t.lod < 2);
    previousLods.clear();
    for (const t of tiles) previousLods.set(tileKey(t), t.lod);
    return tiles;
  }

  return overlay;
}

/**
 * The engine's LOD selection, aimed at streets: a level's "error" is the
 * metres a pixel covers at the zoom it starts at, so `selectLodTiles` gives
 * level 0 where the tile is at z17 or closer on screen and level 1 from z16
 * (`lodThresholds`: a level starts at `r = error / metresPerPixel`). No floors:
 * at z16.5 nothing is at full detail, as the levels say. Exported for the tests.
 */
export function streetLodPolicy(lat: number, maxTiles: number): LodPolicy {
  return {
    maxFullTiles: maxTiles,
    maxTiles,
    levelErrorM: [metresPerPixel(FULL_DETAIL_ZOOM, lat), metresPerPixel(STREETS_MIN_ZOOM, lat)],
    pixelTolerance: 1,
    minFullWithin: 0,
    minSimpleWithin: 0,
    drawWithin: 0,
    hysteresis: 0.1,
    boxHeightM: 20,
  };
}

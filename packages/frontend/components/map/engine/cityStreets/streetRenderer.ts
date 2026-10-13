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

import type { CityCoverageArea } from '@/lib/map/cityTiles';

import type { CityView } from '../city3d/cityEngine';
import { coverageCovers } from '../city3d/coverageIndex';
import { type LodPolicy, metresPerPixel, selectLodTiles } from '../city3d/lod';
import type { CityLight } from '../city3d/occlusion';
import type { CityOverlay, CityOverlayFrame, CityOverlaySky } from '../city3d/overlay';
import {
  type Ground,
  STREET_GROUND_MARGIN,
  streetGround,
  TERRAIN_LATTICE,
} from '../city3d/terrainGround';
import {
  EARTH_CIRCUMFERENCE_M,
  tileKey,
  tileModelMatrix,
  tileSizeMetres,
  type ViewTile,
} from '../city3d/tileMath';
import { WorkerPool, webWorker } from '../city3d/workerPool';
import type { PackedMarkings, PackedSurfaces } from './meshBuffers';
import type { StreetWorkerRequest, StreetWorkerResponse } from './protocol';
import { createGroundAtlas } from './groundAtlas';
import { ATLAS_SIZE } from './streetAtlas';
import {
  createStreetMaterials,
  STREET_TILE_USERDATA_KEY,
  type StreetMaterials,
  type StreetTile,
} from './streetMaterials';
import type { StreetMeshStats } from './streetMesher';
import type { QualityProfile } from '@/lib/map/quality/profile';

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
  /** Ground grids sampled per frame (each 4,356 terrain reads, ~2 ms, on GoWay's DEM). */
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
  /**
   * Where the road archive is published (`fetchCityCoverage` → `roads`): a
   * tile outside it is neither asked for nor drawn, and the basemap's roads
   * show there. `null`: unknown (a development archive), every tile is asked.
   */
  roadCoverage: readonly CityCoverageArea[] | null;
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
  /** The clock (ms) for retries and the statistics' interval; absent: `performance.now`. */
  now?: () => number;
}

export interface CityStreetsStats {
  /** Tiles this view selects (inside the road coverage). */
  tilesWanted: number;
  /**
   * …of which answered: meshed (`ready`) or known to hold no street
   * (`empty`). With `pending` 0, `tilesSettled === tilesWanted` is "every tile
   * the view wants is in" — the streets are SETTLED. A failed tile waiting
   * for its retry is not settled.
   */
  tilesSettled: number;
  tilesDrawn: number;
  tilesFull: number;
  tilesCached: number;
  /** Tiles being meshed, and meshed tiles held for a frame's upload budget. */
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
  /** Its slot in the ground atlas while it holds one. */
  slot: number | null;
  /**
   * Which of its meshes have gone to the GPU (each within a frame's `upload`
   * budget, surfaces first: a tile cut to the terrain's facets is a few MB).
   */
  uploaded: { surfaces: boolean; markings: boolean };
  groundVersion: number;
  /** Its tile's live values, which the shared materials read through the mesh's `userData`. */
  uniforms: {
    uGroundSlot: { value: number };
    uGrounded: { value: number };
    uTileSize: { value: number };
    uDetail: { value: number };
  };
  lastUsed: number;
}

/** The entry's tile as the TSL materials read it, live from its uniforms. */
function streetTileOf(uniforms: Entry['uniforms']): StreetTile {
  return {
    get slot() {
      return uniforms.uGroundSlot.value;
    },
    get grounded() {
      return uniforms.uGrounded.value;
    },
    get tileSizeM() {
      return uniforms.uTileSize.value;
    },
    get detail() {
      return uniforms.uDetail.value;
    },
  };
}

const vec3s = (list: readonly (readonly [number, number, number])[]) =>
  list.map(([r, g, b]) => new THREE.Vector3(r, g, b));

export function createCityStreets(options: CityStreetsOptions): CityOverlay {
  // Drawn by the engine's one renderer (`tsl/tslPass.ts`), lit by the city
  // sky when there is one (`setSky`).
  const tslGroup = new THREE.Group();
  tslGroup.matrixAutoUpdate = false;
  tslGroup.matrixWorldAutoUpdate = false;
  // Every cached tile's ground grid, one slot each: the quality profile's
  // tiles (`streets.maxTiles`) times what is kept per drawn tile, and the
  // drawn ones again for the moment a cache overflows before it evicts.
  const maxCached = Math.max(4, options.quality.maxTiles * STREET_BUDGET.cachedPerDrawn);
  const groundSlots = maxCached + options.quality.maxTiles;
  // The terrain mesh's squares on a street tile (MapLibre's 128 unless a
  // terrain says otherwise): what the meshes are cut to (`groundLattice.ts`)
  // and what the atlas holds the corners of (`terrainGround.ts` → `streetGround`).
  let groundMeshCells = TERRAIN_LATTICE.meshCells;
  const atlasSide = (cells: number) => cells + 1 + 2 * STREET_GROUND_MARGIN;
  let groundAtlas = createGroundAtlas(groundSlots, atlasSide(groundMeshCells));

  const atlasBytes = new Uint8Array(ATLAS_SIZE * ATLAS_SIZE);
  /** Glyph patches arrived that the GPU's copy of the atlas lacks. */
  let atlasDirty = false;
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
    uSurfaceDay: { value: vec3s(options.palette.surfaces.day) },
    uSurfaceNight: { value: vec3s(options.palette.surfaces.night) },
    uPaintDay: { value: vec3s(options.palette.paint.day) },
    uPaintNight: { value: vec3s(options.palette.paint.night) },
  };
  // The city sky's light inputs (`setSky`), before the first material is built.
  let sky: CityOverlaySky | null = null;
  // One material per kind for every tile, built on first use.
  let materials: StreetMaterials | null = null;
  const materialsNow = () => {
    materials ??= createStreetMaterials({
      groundAtlas: groundAtlas.texture,
      groundMeshCells,
      sdfAtlas: atlas,
      surfaceDay: shared.uSurfaceDay.value,
      surfaceNight: shared.uSurfaceNight.value,
      paintDay: shared.uPaintDay.value,
      paintNight: shared.uPaintNight.value,
      nightFactor: () => shared.uNightFactor.value,
      fade: () => shared.uFade.value,
      pxPerM: () => shared.uPxPerM.value,
      depthBias: STREET_BUDGET.depthBias,
      sky,
    });
    return materials;
  };

  const clock = options.now ?? (() => performance.now());
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
    (events) => webWorker(new Worker(new URL('./streetWorker', import.meta.url)), events),
    1,
    (reply) => onReply(reply),
    (id, message) => onReply({ type: 'error', id, message }),
  );

  const disposeMeshes = (entry: Entry) => {
    for (const mesh of [entry.surfaces, entry.markings]) {
      if (!mesh) continue;
      mesh.removeFromParent();
      // The materials are shared by every tile (`streetMaterials.ts`).
      mesh.geometry.dispose();
    }
    entry.surfaces = null;
    entry.markings = null;
    if (entry.slot !== null) groundAtlas.release(entry.slot);
    entry.slot = null;
    entry.uniforms.uGrounded.value = 0;
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
    const material = materialsNow()[kind];
    const mesh = new THREE.Mesh(geometry, material);
    mesh.userData[STREET_TILE_USERDATA_KEY] = streetTileOf(entry.uniforms);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.matrixWorldAutoUpdate = false;
    // Under everything else in the scene: surfaces first among the opaque,
    // markings first among the blended (before city life's contact shadows).
    mesh.renderOrder = kind === 'surfaces' ? -3 : -2;
    mesh.visible = false;
    tslGroup.add(mesh);
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
      entry.retryAt = clock() + 4000;
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
    // Uploaded with the first tile that goes up after it (`update`): only
    // tiles meshed from now on read the new glyphs.
    if (reply.patches.length > 0) atlasDirty = true;
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
      entry.uploaded = { surfaces: false, markings: false };
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
        groundMeshCells,
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
  let lastSignature = '';

  const overlay: CityOverlay = {
    attach(scene) {
      scene.add(tslGroup);
    },

    update({ view, center, opacity, upload }: CityOverlayFrame) {
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
      const now = clock();
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
            slot: null,
            uploaded: { surfaces: false, markings: false },
            groundVersion: -1,
            uniforms: {
              uGroundSlot: { value: 0 },
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
      /** Tiles meshed and wanted, held for a later frame's upload budget. */
      let held = 0;
      const named: Entry[] = [];
      for (const tile of selected) {
        const entry = entries.get(tileKey(tile));
        if (entry?.state !== 'ready') continue;
        if (ground) {
          const at = { z: 15, x: tile.x, y: tile.y };
          if (entry.groundVersion !== groundVersion) {
            entry.slot ??= groundAtlas.claim();
            if (entry.slot === null || (!ground.hasGrid(at) && groundBudget-- <= 0)) {
              options.requestRepaint();
              if (entry.groundVersion < 0) continue;
            } else {
              groundAtlas.write(entry.slot, streetGround(ground.grid(at), groundMeshCells));
              entry.uniforms.uGroundSlot.value = entry.slot;
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
        // Its first draws hand its meshes (and any new glyphs, with the
        // markings) to the GPU, one mesh at a time within what the frame's
        // budget has left (`overlay.ts`): the surfaces, then the markings.
        let waiting = false;
        for (const kind of ['surfaces', 'markings'] as const) {
          const mesh = entry[kind];
          if (!mesh || entry.uploaded[kind]) continue;
          let bytes = kind === 'markings' && atlasDirty ? atlasBytes.byteLength : 0;
          const geometry = mesh.geometry;
          for (const attribute of Object.values(geometry.attributes))
            bytes += (attribute as THREE.BufferAttribute).array.byteLength;
          bytes += geometry.index?.array.byteLength ?? 0;
          if (!upload.take(bytes)) {
            waiting = true;
            break;
          }
          entry.uploaded[kind] = true;
          if (kind === 'markings' && atlasDirty) {
            atlas.needsUpdate = true;
            atlasDirty = false;
          }
        }
        if (waiting) {
          held++;
          options.requestRepaint();
        }
        // No street before its surfaces: the paint alone would float on the map.
        if (entry.surfaces && !entry.uploaded.surfaces) continue;
        const matrix = tileModelMatrix(tile, center);
        tilesDrawn++;
        if (full) tilesFull++;
        for (const [mesh, simple, sent] of [
          [entry.surfaces, entry.simpleSurfaces, entry.uploaded.surfaces],
          [entry.markings, entry.simpleMarkings, entry.uploaded.markings],
        ] as const) {
          if (!mesh || !sent) continue;
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

      // Counts that changed are reported AT ONCE; timings at most twice a
      // second. Throttling the counts too left the last report stale for
      // good: the frame that drew the last tiles fell inside the 500 ms, and
      // a map at rest draws no frame after it, so `pending` read 2 forever
      // while both tiles were on the screen (the visibility gate's landmark
      // views never settled). The city engine's `reportStats` works the same way.
      let tilesSettled = 0;
      for (const tile of selected) {
        const state = entries.get(tileKey(tile))?.state;
        if (state === 'ready' || state === 'empty') tilesSettled++;
      }
      const signature = `${selected.length}|${tilesSettled}|${tilesDrawn}|${tilesFull}|${entries.size}|${byId.size}|${held}|${errors}`;
      if (options.onStats && statsDue(signature, lastSignature, now, lastStatsAt)) {
        lastStatsAt = now;
        lastSignature = signature;
        stats = {
          tilesWanted: selected.length,
          tilesSettled,
          tilesDrawn,
          tilesFull,
          tilesCached: entries.size,
          pending: byId.size + held,
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
      const meshCells = next ? next.lattice.meshCells : groundMeshCells;
      if (meshCells !== groundMeshCells) {
        // A terrain with another mesh (never MapLibre's own 128): every mesh
        // was cut to the old facets and every slot is the old size. Start over.
        for (const entry of entries.values()) {
          if (entry.state === 'pending') pool.cancel(entry.id, { type: 'cancel', id: entry.id });
          disposeMeshes(entry);
        }
        entries.clear();
        byId.clear();
        materials?.dispose();
        materials = null;
        groundAtlas.dispose();
        groundMeshCells = meshCells;
        groundAtlas = createGroundAtlas(groundSlots, atlasSide(groundMeshCells));
      }
      options.requestRepaint();
    },

    setSky(next) {
      // Set once, before the first frame builds the materials; the sky's
      // night factor is then the one the streets read, as every city material.
      sky = next;
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
      materials?.dispose();
      atlas.dispose();
      groundAtlas.dispose();
      tslGroup.removeFromParent();
    },
  };

  /** The z15 road tiles to draw, nearest first, each with `lod` 0 (full) or 1 (simplified). */
  function select(view: CityView): (ViewTile & { lod: 0 | 1 | 2; r: number })[] {
    const centreM = ground ? ground.sample(view.center.lng, view.center.lat) : 0;
    const terrain =
      ground && Number.isFinite(centreM)
        ? { centreM, minM: centreM - 300, maxM: centreM + 300 }
        : undefined;
    const { roadCoverage } = options;
    const tiles = selectLodTiles(
      { ...view, terrain },
      15,
      streetLodPolicy(view.center.lat, options.quality.maxTiles),
      previousLods,
      // Only where the road archive is published, before the tile budget fills.
      roadCoverage === null ? undefined : (t) => coverageCovers(t, roadCoverage),
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

/** Timings are refreshed at most this often; counts whenever they change. */
export const STREET_STATS_INTERVAL_MS = 500;

/**
 * Whether a frame's statistics are reported: always when any count changed
 * (`signature`), else once the interval has passed (the timings).
 */
export function statsDue(
  signature: string,
  lastSignature: string,
  now: number,
  lastAt: number,
): boolean {
  return signature !== lastSignature || now - lastAt > STREET_STATS_INTERVAL_MS;
}

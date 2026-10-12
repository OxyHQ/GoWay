/**
 * What one cached tile is on the GPU: its building chunks at one level of
 * detail and, at levels 0 and 1, its instanced trees — one {@link TileEntry}.
 *
 * Reached only from `cityEngine.ts` (and so only through the lazy three.js
 * chunk; `components/__tests__/engine3dChunk.test.ts` pins that).
 *
 * Every entry's meshes draw with the engine's SHARED materials (`tsl/`: the
 * buildings map-lit or sky-lit, the trees), on the engine's uniforms — light,
 * palette, zoom fade — and read the entry's OWN fade pair per mesh, shared by
 * its buildings and trees, so a level-of-detail cross-fade dissolves a tile's
 * buildings and trees together (`transitions.ts`).
 */
import * as THREE from 'three';

import { SHADOW_CASTER_LAYER } from './frameSelection';
import type { Lod } from './lod';
import { type PackedMesh, quantizedModelMatrix, Z_UNITS_PER_METRE } from './packing';
import { GROUND, type GroundResult, type GroundTile, gridAt } from './terrainGround';
import { type TileId, tileSizeMetres } from './tileMath';
import { type MercatorPoint, tileModelMatrix, type ViewTile } from './tileMath';
import {
  BROADLEAF_VARIANTS,
  farConiferShape,
  farPalmShape,
  farTreeShape,
  nearConiferShape,
  nearPalmShape,
  nearTreeShape,
  type TreeShape,
} from './treeGeometry';
import type { CityTileFormat } from './protocol';
import type { TreeInstances } from './trees';
import { FADE_USERDATA_KEY } from './transitions';
import type { TslPass } from './tsl/tslPass';
import { TREE_UNIT_USERDATA_KEY } from './tsl/treeMaterial';

export interface TileEntry {
  /** The cache key (`lodKey`). */
  key: string;
  lod: Lod;
  buildings: THREE.Mesh[];
  /**
   * The engine's TSL pass and this tile's format, so a fade can switch the
   * tile's meshes to the shared dithered variants (`tsl/tslPass.ts`).
   */
  tsl: { pass: Pick<TslPass, 'buildings' | 'trees'>; format: CityTileFormat };
  /** Instanced trees: broadleaf, then conifers (each one draw call, when present). */
  trees: THREE.Mesh[];
  fade: { uFadeFrom: { value: number }; uFadeTo: { value: number } };
  /** Whether its meshes draw the dithered variants (see `setEntryFade`). */
  dithering: boolean;
  unitM: number;
  /** Local metres of the buildings' stored origin (`PackedMesh.originM`). */
  originM: [number, number];
  /** Where it was last drawn (its world copy can change as the camera pans). */
  placement: ViewTile | null;
  bytes: number;
  vertices: number;
  triangles: number;
  treeCount: number;
  treeTriangles: number;
  /**
   * Whether the trees draw their near shapes. A level-0 tile's trees switch
   * to the far shapes by distance (`setEntryTreeDetail`); a level-1 tile's
   * are always far.
   */
  treesNear: boolean;
  /** The CPU side kept for placing it on terrain (`groundTileFor`). */
  packed: PackedMesh | null;
  instances: TreeInstances | null;
}

/** What the engine shares with every entry it builds. */
export interface EntryContext {
  /** The engine's TSL pass (`tsl/tslPass.ts`): its scene and shared materials. */
  tsl: Pick<TslPass, 'scene' | 'buildings' | 'trees'>;
}

/**
 * Which faces three must keep, by how many mirrors the model matrix holds.
 *
 * three culls by winding and flips its notion of "front" when the object's
 * matrix has a negative determinant. Both meshes are wound counter-clockwise
 * seen from outside in ENU, and MapLibre's projection — which three cannot
 * see — mirrors y once more. So:
 *
 *  - **Trees** are placed in metres by `tileModelMatrix`, ONE mirror (ENU
 *    y-north → mercator y-south): three flips, and the outward faces are the
 *    ones it calls BACK (`cityEngine.ts` records the render that proved it).
 *  - **Buildings** are placed in stored units (`quantizedModelMatrix`), whose
 *    y is stored southward: a SECOND mirror, the determinant is positive
 *    again, three does not flip, and the outward faces are FRONT. Rendered
 *    both ways: `BackSide` here draws hollow, roofless shells.
 */
const SIDE = { buildings: THREE.FrontSide, trees: THREE.BackSide } as const;

/** Both sides, for the TSL pass's shared materials. */
export const MESH_SIDES = SIDE;

/**
 * The unit trees' buffers, uploaded once and shared by every tile: for each
 * of `TREE_SHAPES` (`trees.ts`), the near and the far shape.
 */
export interface TreeShapes {
  near: TreeShapeBuffers[];
  far: TreeShapeBuffers[];
  dispose(): void;
}

interface TreeShapeBuffers {
  position: THREE.BufferAttribute;
  normal: THREE.BufferAttribute;
  part: THREE.BufferAttribute;
  index: THREE.BufferAttribute;
  triangles: number;
}

function shapeBuffers(shape: TreeShape): TreeShapeBuffers {
  return {
    position: new THREE.BufferAttribute(shape.positions, 3),
    normal: new THREE.BufferAttribute(shape.normals, 3),
    part: new THREE.BufferAttribute(shape.part, 1),
    index: new THREE.BufferAttribute(shape.indices, 1),
    triangles: shape.indices.length / 3,
  };
}

export function createTreeShapes(): TreeShapes {
  const broadleafFar = shapeBuffers(farTreeShape());
  const near = [
    ...Array.from({ length: BROADLEAF_VARIANTS }, (_, variant) =>
      shapeBuffers(nearTreeShape(variant)),
    ),
    shapeBuffers(nearConiferShape()),
    shapeBuffers(nearPalmShape()),
  ];
  const far = [
    ...Array.from({ length: BROADLEAF_VARIANTS }, () => broadleafFar),
    shapeBuffers(farConiferShape()),
    shapeBuffers(farPalmShape()),
  ];
  return {
    near,
    far,
    dispose() {
      // three frees a buffer when a geometry holding it is disposed; these
      // are held by no tile any more (see `disposeEntry`), so hand them to
      // one throwaway geometry each and dispose that.
      for (const shape of new Set([...near, ...far])) {
        const holder = new THREE.BufferGeometry();
        holder.setAttribute('position', shape.position);
        holder.setAttribute('normal', shape.normal);
        holder.setAttribute('part', shape.part);
        holder.setIndex(shape.index);
        holder.dispose();
      }
    },
  };
}

function hide(mesh: THREE.Mesh): THREE.Mesh {
  // The engine writes `matrixWorld` itself every frame (centre-relative);
  // three must not recompute it from position/rotation/scale.
  mesh.matrixAutoUpdate = false;
  mesh.matrixWorldAutoUpdate = false;
  mesh.visible = false;
  return mesh;
}

/**
 * Build a tile's entry from a worker reply. `null` when there is nothing to
 * draw (no buildings and no trees) — cached as an empty tile.
 */
export function createTileEntry(
  context: EntryContext,
  shapes: TreeShapes,
  key: string,
  lod: Lod,
  mesh: PackedMesh | null,
  instances: TreeInstances | null,
  format: CityTileFormat = 'openmaptiles',
): TileEntry | null {
  if (!mesh && !instances) return null;
  const fade = { uFadeFrom: { value: 0 }, uFadeTo: { value: 1 } };
  const entry: TileEntry = {
    key,
    lod,
    buildings: [],
    tsl: { pass: context.tsl, format },
    trees: [],
    fade,
    dithering: false,
    unitM: mesh?.unitM ?? instances?.unitM ?? 1,
    originM: mesh?.originM ?? [0, 0],
    placement: null,
    bytes: 0,
    vertices: 0,
    triangles: 0,
    treeCount: 0,
    treeTriangles: 0,
    treesNear: lod === 0,
    packed: mesh,
    instances: lod < 2 ? instances : null,
  };

  if (mesh) {
    const material = context.tsl.buildings.get(format, false);
    // Bounds from the worker, in stored units: three never walks the vertices.
    const box = new THREE.Box3(
      new THREE.Vector3(...mesh.bounds.min),
      new THREE.Vector3(...mesh.bounds.max),
    );
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    for (const chunk of mesh.chunks) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(chunk.position, 4));
      geometry.setAttribute('normal', new THREE.BufferAttribute(chunk.normal, 4, true));
      geometry.setIndex(new THREE.BufferAttribute(chunk.index, 1));
      // GoWay city tiles' surface colour and storey rhythm (`tsl/buildingSurface.ts`);
      // their per-building flags ride in the normal's spare lane (`packing.ts`).
      if (chunk.color)
        geometry.setAttribute('color', new THREE.BufferAttribute(chunk.color, 4, true));
      if (chunk.facade) geometry.setAttribute('facade', new THREE.BufferAttribute(chunk.facade, 4));
      geometry.boundingBox = box;
      geometry.boundingSphere = sphere;
      const part = hide(new THREE.Mesh(geometry, material));
      // The materials are shared by every tile and read its fade per mesh.
      part.userData[FADE_USERDATA_KEY] = fade;
      // Buildings cast the city sky's sun shadows (`frameSelection.ts`).
      part.layers.enable(SHADOW_CASTER_LAYER);
      context.tsl.scene.add(part);
      entry.buildings.push(part);
    }
    entry.bytes += mesh.bytes;
    entry.vertices += mesh.vertices;
    entry.triangles += mesh.triangles;
  }

  // Trees at levels 0 and 1 only; level 2 is too far for a tree to show.
  if (instances && lod < 2) {
    // One shared TSL material for every tile's trees (`tsl/treeMaterial.ts`);
    // each mesh carries its tile's unit and fade.
    const material = context.tsl.trees.get(false);
    const forLevel = lod === 0 ? shapes.near : shapes.far;
    let from = 0;
    const ranges = instances.ranges.map((count, i) => {
      const range = { shape: forLevel[i], index: i, from, count };
      from += count;
      return range;
    });
    for (const { shape, index, from, count } of ranges) {
      if (count === 0) continue;
      const geometry = new THREE.InstancedBufferGeometry();
      geometry.setAttribute('position', shape.position);
      geometry.setAttribute('normal', shape.normal);
      geometry.setAttribute('part', shape.part);
      geometry.setIndex(shape.index);
      geometry.setAttribute(
        'aTree',
        new THREE.InstancedBufferAttribute(
          instances.data.subarray(from * 4, (from + count) * 4),
          4,
        ),
      );
      geometry.instanceCount = count;
      const trees = hide(new THREE.Mesh(geometry, material));
      // Which instances it draws (its terrain lifts, `applyGround`), as which
      // shape (its level of detail, `setEntryTreeDetail`), and what the shared
      // material reads per mesh.
      trees.userData = {
        from,
        shape: index,
        count,
        [TREE_UNIT_USERDATA_KEY]: instances.unitM,
        [FADE_USERDATA_KEY]: fade,
      };
      // Its bounds are the instances', which three cannot see; the tile was
      // already chosen by the engine's own frustum test (`lod.ts`).
      trees.frustumCulled = false;
      context.tsl.scene.add(trees);
      entry.trees.push(trees);
      entry.treeTriangles += count * shape.triangles;
    }
    entry.bytes += instances.data.byteLength;
    entry.treeCount = instances.count;
  }
  return entry;
}

/** Place an entry's meshes for `tile` (its world copy) relative to `center`. */
export function placeEntry(entry: TileEntry, tile: ViewTile, center: MercatorPoint): void {
  entry.placement = tile;
  const model = tileModelMatrix(tile, center);
  if (entry.buildings.length > 0) {
    const quantized = quantizedModelMatrix(model, entry.unitM, entry.originM);
    for (const mesh of entry.buildings) mesh.matrixWorld.fromArray(quantized);
  }
  for (const mesh of entry.trees) mesh.matrixWorld.fromArray(model);
}

/**
 * Set where an entry is in its fade (`transitions.ts`). The screen-door
 * `discard` is compiled in only while it is fading (`DITHER`): a shader that
 * can discard loses early depth testing for every pixel it draws.
 */
export function setEntryFade(entry: TileEntry, from: number, to: number): void {
  entry.fade.uFadeFrom.value = from;
  entry.fade.uFadeTo.value = to;
  const dither = from > 0 || to < 1;
  if (dither === entry.dithering) return;
  entry.dithering = dither;
  // The meshes switch to their shared dithered variants.
  const trees = entry.tsl.pass.trees.get(dither);
  for (const mesh of entry.trees) mesh.material = trees;
  const buildings = entry.tsl.pass.buildings.get(entry.tsl.format, dither);
  for (const mesh of entry.buildings) mesh.material = buildings;
}

/**
 * Draw a level-0 tile's trees with their near or far shapes: the same
 * instances, the unit tree's buffers swapped (only when it changes; three
 * rebinds the vertex array once). A far canopy is 20 triangles to the near
 * one's 98, and beyond the distance where buildings would lose their bevels
 * the difference is under a pixel (`docs/MAP_PERFORMANCE.md` → hotspots).
 */
export function setEntryTreeDetail(entry: TileEntry, shapes: TreeShapes, near: boolean): void {
  if (entry.lod !== 0 || entry.treesNear === near) return;
  entry.treesNear = near;
  const set = near ? shapes.near : shapes.far;
  let triangles = 0;
  for (const mesh of entry.trees) {
    const { shape: index, count } = mesh.userData as { shape: number; count: number };
    const shape = set[index];
    const geometry = mesh.geometry;
    geometry.setAttribute('position', shape.position);
    geometry.setAttribute('normal', shape.normal);
    geometry.setAttribute('part', shape.part);
    geometry.setIndex(shape.index);
    triangles += count * shape.triangles;
  }
  entry.treeTriangles = triangles;
}

export function setEntryVisible(entry: TileEntry, visible: boolean): void {
  for (const mesh of entry.buildings) mesh.visible = visible;
  for (const mesh of entry.trees) mesh.visible = visible;
}

/** Free an entry's GPU buffers and materials. */
export function disposeEntry(entry: TileEntry): void {
  for (const mesh of entry.buildings) {
    // The materials are shared, and freed by their pass.
    mesh.removeFromParent();
    mesh.geometry.dispose();
  }
  for (const mesh of entry.trees) {
    mesh.removeFromParent();
    // three's dispose frees EVERY buffer the geometry holds, and the unit
    // tree's are shared by every tile (deleting them would leave the other
    // tiles' vertex arrays pointing at a dead buffer). Detach them first, so
    // only this tile's instance buffer goes; `TreeShapes.dispose` frees them
    // with the engine.
    const geometry = mesh.geometry;
    geometry.deleteAttribute('position');
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('part');
    geometry.setIndex(null);
    geometry.dispose();
  }
}

/** The last source-vertex index `<= s` in sorted `starts`, or −1. */
function unitOf(starts: Uint32Array, s: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= s) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * How `terrainGround.ts` places this entry on terrain: every building vertex
 * lifted by its polygon's ground (its foot sunk, as there), every tree by the
 * ground under it. The lifts are ONE array — the building chunks' vertices in
 * order, then the trees in instance order — whose slices become the chunks'
 * `ground` and the trees' `aGround` attributes ({@link applyGround}).
 */
export function groundTileFor(entry: TileEntry, tile: TileId): GroundTile {
  const tileSizeM = tileSizeMetres(tile);
  const packed = entry.packed;
  const instances = entry.instances;
  return {
    tile,
    tileSizeM,
    polygonBoxes: packed?.polygonBoxes ?? new Float32Array(0),
    lift(placed, grid, out) {
      const chunks = packed?.chunks ?? [];
      let total = instances?.count ?? 0;
      for (const chunk of chunks) total += chunk.position.length / 4;
      const values = out && out.length === total ? out : new Float32Array(total);
      let min = Infinity;
      let max = -Infinity;
      let at = 0;
      const starts = packed?.polygonStarts ?? new Uint32Array(0);
      const footZ = GROUND.footM * Z_UNITS_PER_METRE;
      for (const chunk of chunks) {
        // Chunks keep the mesh's vertex order (`packing.ts`), the one
        // `polygonStarts` indexes: walk it a unit's run of vertices at a
        // time, so a vertex costs one comparison and one store — this is the
        // engine's largest single piece of main-thread work when a tile
        // arrives on terrain (`docs/MAP_PERFORMANCE.md` → hotspots).
        const position = chunk.position;
        const count = position.length / 4;
        let unit = unitOf(starts, at);
        let i = 0;
        while (i < count) {
          const next = unit + 1 < starts.length ? Math.min(count, starts[unit + 1] - at) : count;
          if (unit < 0) {
            values.fill(0, at + i, at + next);
          } else {
            const top = placed.anchor[unit];
            const foot = top - placed.sink[unit];
            let feet = false;
            let tops = false;
            for (let k = i; k < next; k++) {
              if (position[k * 4 + 2] <= footZ) {
                values[at + k] = foot;
                feet = true;
              } else {
                values[at + k] = top;
                tops = true;
              }
            }
            if (feet) {
              if (foot < min) min = foot;
              if (foot > max) max = foot;
            }
            if (tops) {
              if (top < min) min = top;
              if (top > max) max = top;
            }
          }
          i = next;
          unit++;
        }
        at += count;
      }
      if (instances) {
        for (let k = 0; k < instances.count; k++) {
          const u = (instances.data[k * 4] * instances.unitM) / tileSizeM;
          const v = (instances.data[k * 4 + 1] * instances.unitM) / tileSizeM;
          const lift = gridAt(grid, GROUND.grid, u, v);
          values[at + k] = lift;
          if (lift < min) min = lift;
          if (lift > max) max = lift;
        }
      }
      if (min > max) {
        min = 0;
        max = 0;
      }
      return { values, min, max };
    },
  };
}

/**
 * Upload an entry's terrain lifts (`groundTileFor`): new attributes over
 * slices of the result, or the same ones flagged for re-upload when the
 * grounder rewrote the buffer in place. Culling bounds follow the lift.
 */
export function applyGround(entry: TileEntry, result: GroundResult | null): void {
  // Whether a TSL mesh read no lift until now: its programs must be rebuilt
  // to read one (`BuildingMaterials.invalidate`). Measured on main: without
  // this, every tile drawn before it was grounded stayed at z = 0, under the
  // terrain — no trees on Passeig de Gràcia, and no buildings without the sky.
  let gainedBuildingLift = false;
  let gainedTreeLift = false;
  let at = 0;
  for (const mesh of entry.buildings) {
    const geometry = mesh.geometry;
    const count = (geometry.getAttribute('position') as THREE.BufferAttribute).count;
    if (result) {
      const attribute = geometry.getAttribute('ground') as THREE.BufferAttribute | undefined;
      const slice = result.values.subarray(at, at + count);
      if (
        attribute &&
        attribute.array.buffer === slice.buffer &&
        attribute.array.byteOffset === slice.byteOffset
      ) {
        if (result.changed) attribute.needsUpdate = true;
      } else {
        if (!attribute) gainedBuildingLift = true;
        geometry.setAttribute('ground', new THREE.BufferAttribute(slice, 1));
      }
    }
    const box = geometry.boundingBox;
    const bounds = entry.packed?.bounds;
    if (box && bounds) {
      box.min.z = bounds.min[2] + (result?.min ?? 0) * Z_UNITS_PER_METRE;
      box.max.z = bounds.max[2] + (result?.max ?? 0) * Z_UNITS_PER_METRE;
      geometry.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    }
    at += count;
  }
  if (gainedBuildingLift) entry.tsl.pass.buildings.invalidate();
  if (!result || !entry.instances) return;
  let from = 0;
  entry.instances.ranges.forEach((count) => {
    if (count === 0) return;
    const mesh = entry.trees.find((m) => (m.userData as { from?: number }).from === from);
    from += count;
    if (!mesh) return;
    const geometry = mesh.geometry;
    const start = at + (mesh.userData as { from: number }).from;
    const slice = result.values.subarray(start, start + count);
    const attribute = geometry.getAttribute('aGround') as
      | THREE.InstancedBufferAttribute
      | undefined;
    if (
      attribute &&
      attribute.array.buffer === slice.buffer &&
      attribute.array.byteOffset === slice.byteOffset
    ) {
      if (result.changed) attribute.needsUpdate = true;
    } else {
      if (!attribute) gainedTreeLift = true;
      geometry.setAttribute('aGround', new THREE.InstancedBufferAttribute(slice, 1));
    }
  });
  if (gainedTreeLift) entry.tsl.pass.trees.invalidate();
}

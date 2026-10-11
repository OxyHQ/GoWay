/**
 * What one cached tile is on the GPU: its building chunks at one level of
 * detail and, at levels 0 and 1, its instanced trees — one {@link TileEntry}.
 *
 * Reached only from `cityEngine.ts` (and so only through the lazy three.js
 * chunk; `components/__tests__/engine3dChunk.test.ts` pins that).
 *
 * Every entry owns two materials (buildings, trees) built from the engine's
 * shared uniforms — light, palette, zoom fade — plus its OWN fade pair
 * (`uFade`, `uFadeOut`), shared by both, so a level-of-detail cross-fade
 * dissolves a tile's buildings and trees together (`transitions.ts`). The
 * materials share one shader each, so three compiles each program once.
 */
import * as THREE from 'three';

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
import { TREE_FRAGMENT_SHADER, TREE_VERTEX_SHADER } from './treeShaders';

export interface TileEntry {
  /** The cache key (`lodKey`). */
  key: string;
  lod: Lod;
  buildings: THREE.Mesh[];
  /** Instanced trees: broadleaf, then conifers (each one draw call, when present). */
  trees: THREE.Mesh[];
  fade: { uFadeFrom: { value: number }; uFadeTo: { value: number } };
  /** Whether its materials carry the screen-door `discard` (see `setEntryFade`). */
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
  /** The CPU side kept for placing it on terrain (`groundTileFor`). */
  packed: PackedMesh | null;
  instances: TreeInstances | null;
}

/** What the engine shares with every entry it builds. */
export interface EntryContext {
  scene: THREE.Scene;
  /** The building material's uniforms (light, palette, zoom fade). */
  buildingUniforms: Record<string, THREE.IUniform>;
  /** The building shaders by source: OpenMapTiles buildings, GoWay city tiles (`osmShaders.ts`). */
  buildingShaders: Record<CityTileFormat, { vertexShader: string; fragmentShader: string }>;
  /** The tree material's shared uniforms (light, tree colours, zoom fade). */
  treeUniforms: Record<string, THREE.IUniform>;
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

/** Common material settings. */
function materialFor(
  vertexShader: string,
  fragmentShader: string,
  uniforms: Record<string, THREE.IUniform>,
  side: THREE.Side,
): THREE.RawShaderMaterial {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3,
    vertexShader,
    fragmentShader,
    uniforms,
    side,
    blending: THREE.CustomBlending,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneMinusSrcAlphaFactor,
    transparent: false,
  });
}

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
    packed: mesh,
    instances: lod < 2 ? instances : null,
  };

  if (mesh) {
    const material = materialFor(
      context.buildingShaders[format].vertexShader,
      context.buildingShaders[format].fragmentShader,
      { ...context.buildingUniforms, ...fade },
      SIDE.buildings,
    );
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
      // GoWay city tiles' surface colour and storey rhythm (`osmShaders.ts`).
      if (chunk.color)
        geometry.setAttribute('color', new THREE.BufferAttribute(chunk.color, 4, true));
      if (chunk.facade) geometry.setAttribute('facade', new THREE.BufferAttribute(chunk.facade, 4));
      geometry.boundingBox = box;
      geometry.boundingSphere = sphere;
      const part = hide(new THREE.Mesh(geometry, material));
      context.scene.add(part);
      entry.buildings.push(part);
    }
    entry.bytes += mesh.bytes;
    entry.vertices += mesh.vertices;
    entry.triangles += mesh.triangles;
  }

  // Trees at levels 0 and 1 only; level 2 is too far for a tree to show.
  if (instances && lod < 2) {
    const material = materialFor(
      TREE_VERTEX_SHADER,
      TREE_FRAGMENT_SHADER,
      {
        ...context.treeUniforms,
        ...fade,
        uUnitM: { value: instances.unitM },
      },
      SIDE.trees,
    );
    const forLevel = lod === 0 ? shapes.near : shapes.far;
    let from = 0;
    const ranges = instances.ranges.map((count, i) => {
      const range = { shape: forLevel[i], from, count };
      from += count;
      return range;
    });
    for (const { shape, from, count } of ranges) {
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
      // Which instances it draws, for its terrain lifts (`applyGround`).
      trees.userData = { from };
      // Its bounds are the instances', which three cannot see; the tile was
      // already chosen by the engine's own frustum test (`lod.ts`).
      trees.frustumCulled = false;
      context.scene.add(trees);
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
  for (const material of entryMaterials(entry)) {
    if (dither) material.defines = { ...material.defines, DITHER: 1 };
    else {
      const { DITHER: _, ...rest } = material.defines ?? {};
      material.defines = rest;
    }
    material.needsUpdate = true;
  }
}

function entryMaterials(entry: TileEntry): Set<THREE.RawShaderMaterial> {
  const materials = new Set<THREE.RawShaderMaterial>();
  for (const mesh of entry.buildings) materials.add(mesh.material as THREE.RawShaderMaterial);
  for (const mesh of entry.trees) materials.add(mesh.material as THREE.RawShaderMaterial);
  return materials;
}

export function setEntryVisible(entry: TileEntry, visible: boolean): void {
  for (const mesh of entry.buildings) mesh.visible = visible;
  for (const mesh of entry.trees) mesh.visible = visible;
}

/** Free an entry's GPU buffers and materials. */
export function disposeEntry(entry: TileEntry, scene: THREE.Scene): void {
  const materials = entryMaterials(entry);
  for (const mesh of entry.buildings) {
    scene.remove(mesh);
    mesh.geometry.dispose();
  }
  for (const mesh of entry.trees) {
    scene.remove(mesh);
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
  for (const material of materials) material.dispose();
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
      for (const chunk of chunks) {
        const count = chunk.position.length / 4;
        let unit = -1;
        for (let i = 0; i < count; i++) {
          const s = chunk.sourceIds ? chunk.sourceIds[i] : chunk.sourceStart + i;
          // Mostly the same unit as the last vertex, or the next one.
          if (unit < 0 || s < starts[unit] || (unit + 1 < starts.length && s >= starts[unit + 1])) {
            unit = unitOf(starts, s);
          }
          if (unit < 0) {
            values[at + i] = 0;
            continue;
          }
          const top = placed.anchor[unit];
          const foot = top - placed.sink[unit];
          const lift = chunk.position[i * 4 + 2] <= GROUND.footM * Z_UNITS_PER_METRE ? foot : top;
          values[at + i] = lift;
          if (lift < min) min = lift;
          if (lift > max) max = lift;
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
      geometry.setAttribute('aGround', new THREE.InstancedBufferAttribute(slice, 1));
    }
  });
}

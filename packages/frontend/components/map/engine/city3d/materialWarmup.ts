/**
 * The city's materials, built before the first tile needs them.
 *
 * A TSL material is built — its node graph turned into shaders, in JavaScript —
 * the first time a mesh draws with it, once per material and vertex layout.
 * Left to the first tiles, those builds all land in the frame the tiles arrive
 * in: measured on the frame-budget harness, 70–94 ms of builds inside frames
 * and a worst load frame of 44–56 ms (`docs/MAP_NATIVE_3D.md` → "Materials
 * built ahead of the tiles"). So the engine builds them while the tiles are still
 * being fetched and meshed in the workers: one warm-up mesh per material
 * variant the city will draw, handed to three's `compileAsync`
 * (`tsl/tslPass.ts` → `warm`), which builds each in slices between frames.
 *
 * The warm-up meshes are REAL tile entries (`cityMeshes.ts` →
 * `createTileEntry`) over a one-triangle mesh and one tree, so their
 * vertex layouts are exactly the tiles' — what three keys a build by — with
 * nothing restated here. One per tile format, settled and dithered; for terrain
 * a second set gains the lift through the same `applyGround` a tile does, and
 * is warmed for those variants. They live in the engine's scene on
 * {@link WARM_LAYER}, which only the warm-up's camera draws, and are kept for
 * the engine's life: three drops a build no mesh uses any more. That is also
 * why the grounded set is a second set and not the first one lifted: lifting
 * a mesh changes its layout, and the settled builds would lose their only
 * user before a tile drew with them.
 */
import { WARM_LAYER } from './frameSelection';
import {
  applyGround,
  createTileEntry,
  disposeEntry,
  type EntryContext,
  setEntryFade,
  type TileEntry,
  type TreeShapes,
} from './cityMeshes';
import type { PackedMesh } from './packing';
import type { CityTileFormat } from './protocol';
import { TREE_SHAPES, type TreeInstances } from './trees';

export interface MaterialWarmup {
  /**
   * Add warm-up meshes with the terrain lift (the grounded variants), beside
   * the others; `true` the first time, when there is something new to build.
   */
  ground(): boolean;
  dispose(): void;
}

/** A one-triangle tile mesh with `format`'s lanes, all zero: drawn, it covers no pixel. */
function warmMesh(format: CityTileFormat): PackedMesh {
  return {
    chunks: [
      {
        position: new Uint16Array(12),
        normal: new Int8Array(12),
        index: new Uint16Array([0, 1, 2]),
        // GoWay city tiles' surface lanes (`packing.ts`).
        ...(format === 'goway' ? { color: new Uint8Array(12), facade: new Uint16Array(12) } : {}),
      },
    ],
    unitM: 1,
    originM: [0, 0],
    vertices: 3,
    triangles: 1,
    bytes: 0,
    bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    polygons: 1,
    polygonStarts: new Uint32Array([0]),
    polygonBoxes: new Float32Array(4),
    polygonHeightDefault: new Uint8Array(1),
  };
}

/**
 * One tree, of zero height: every shape draws with the same material and
 * vertex layout, so one builds them all, and each warm-up mesh costs
 * `compileAsync` a turn of the event loop.
 */
function warmTrees(): TreeInstances {
  return {
    data: new Uint16Array(4),
    // Crown base and diameter: the same vertex layout as every tile's trees.
    form: new Uint16Array(2),
    count: 1,
    ranges: TREE_SHAPES.map((_, i) => (i === 0 ? 1 : 0)),
    unitM: 1,
  };
}

/** One warm-up entry per format, settled and dithered, with the trees once. */
function warmEntries(
  context: EntryContext,
  shapes: TreeShapes,
  formats: readonly CityTileFormat[],
  variant: string,
): TileEntry[] {
  const entries: TileEntry[] = [];
  formats.forEach((format, f) => {
    for (const dithered of [false, true]) {
      const entry = createTileEntry(
        context,
        shapes,
        `warmup:${variant}:${format}:${dithered}`,
        0,
        warmMesh(format),
        // The trees' materials do not depend on the format: warmed once.
        f === 0 ? warmTrees() : null,
        format,
      );
      if (!entry) continue;
      // The fading variant: the dithered materials (`setEntryFade`).
      if (dithered) setEntryFade(entry, 0.5, 1);
      for (const mesh of [...entry.buildings, ...entry.trees]) {
        mesh.visible = true;
        mesh.frustumCulled = false;
        // Only the warm-up's camera: never the map's, never the sun's.
        mesh.layers.set(WARM_LAYER);
      }
      entries.push(entry);
    }
  });
  return entries;
}

export function createMaterialWarmup(
  context: EntryContext,
  shapes: TreeShapes,
  formats: readonly CityTileFormat[],
): MaterialWarmup {
  const entries = warmEntries(context, shapes, formats, 'flat');
  let grounded = false;

  return {
    ground() {
      if (grounded) return false;
      grounded = true;
      for (const entry of warmEntries(context, shapes, formats, 'grounded')) {
        let lifts = entry.instances?.count ?? 0;
        for (const chunk of entry.packed?.chunks ?? []) lifts += chunk.position.length / 4;
        applyGround(entry, { values: new Float32Array(lifts), min: 0, max: 0, changed: false });
        entries.push(entry);
      }
      return true;
    },
    dispose() {
      for (const entry of entries) disposeEntry(entry);
      entries.length = 0;
    },
  };
}

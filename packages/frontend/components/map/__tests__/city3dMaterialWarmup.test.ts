/**
 * The material warm-up (`engine/city3d/materialWarmup.ts`): one real tile
 * entry per format, settled and dithered, with the trees once; drawn by no
 * camera but the warm-up's; a grounded set added through the tiles' own
 * `applyGround` once. What it buys — no material built in a frame — is
 * measured on the frame-budget harness (`docs/MAP_NATIVE_3D.md` → "Materials
 * built ahead of the tiles"); this pins what it builds.
 */
import { describe, expect, test } from 'bun:test';
import { type Material, MeshBasicMaterial, type Mesh, Scene } from 'three';

import { createTreeShapes, type EntryContext } from '@/components/map/engine/city3d/cityMeshes';
import { SHADOW_CASTER_LAYER, WARM_LAYER } from '@/components/map/engine/city3d/frameSelection';
import { createMaterialWarmup } from '@/components/map/engine/city3d/materialWarmup';

/** Materials that say which variant they are, and count invalidations. */
function harness() {
  const scene = new Scene();
  const made = new Map<string, Material>();
  const variant = (key: string) => {
    let material = made.get(key);
    if (!material) {
      material = new MeshBasicMaterial({ name: key });
      made.set(key, material);
    }
    return material;
  };
  const invalidated = { buildings: 0, trees: 0 };
  const context = {
    tsl: {
      scene,
      buildings: {
        get: (format: string, dithered: boolean) => variant(`${format}:${dithered}`),
        invalidate: () => invalidated.buildings++,
        dispose() {},
      },
      trees: {
        get: (dithered: boolean) => variant(`trees:${dithered}`),
        invalidate: () => invalidated.trees++,
        dispose() {},
      },
    },
  } as unknown as EntryContext;
  return { scene, context, invalidated };
}

const meshesOf = (scene: Scene) => scene.children as Mesh[];

describe('createMaterialWarmup', () => {
  test('every format, settled and dithered, and the trees once', () => {
    const { scene, context } = harness();
    createMaterialWarmup(context, createTreeShapes(), ['openmaptiles', 'goway']);
    const names = meshesOf(scene).map((mesh) => (mesh.material as Material).name);
    expect(names.sort()).toEqual([
      'goway:false',
      'goway:true',
      'openmaptiles:false',
      'openmaptiles:true',
      'trees:false',
      'trees:true',
    ]);
  });

  test('the meshes are the tiles’ own layouts', () => {
    const { scene, context } = harness();
    createMaterialWarmup(context, createTreeShapes(), ['openmaptiles', 'goway']);
    const byName = new Map(meshesOf(scene).map((m) => [(m.material as Material).name, m]));
    const attributes = (name: string) =>
      Object.keys(byName.get(name)?.geometry.attributes ?? {}).sort();
    expect(attributes('openmaptiles:false')).toEqual(['normal', 'position']);
    expect(attributes('goway:false')).toEqual(['color', 'facade', 'normal', 'position']);
    expect(attributes('trees:false')).toEqual(['aForm', 'aTree', 'normal', 'part', 'position']);
    for (const mesh of meshesOf(scene)) expect(mesh.geometry.index).not.toBeNull();
  });

  test('drawn by no camera but the warm-up’s: not the map’s, not the sun’s', () => {
    const { scene, context } = harness();
    createMaterialWarmup(context, createTreeShapes(), ['openmaptiles']);
    for (const mesh of meshesOf(scene)) {
      expect(mesh.layers.mask).toBe(1 << WARM_LAYER);
      expect(mesh.layers.isEnabled(0)).toBe(false);
      expect(mesh.layers.isEnabled(SHADOW_CASTER_LAYER)).toBe(false);
      expect(mesh.visible).toBe(true);
      expect(mesh.frustumCulled).toBe(false);
    }
  });

  test('grounded once, through the tiles’ own lift, beside the flat set', () => {
    const { scene, context, invalidated } = harness();
    const warmup = createMaterialWarmup(context, createTreeShapes(), ['openmaptiles']);
    const flat = [...meshesOf(scene)];
    expect(warmup.ground()).toBe(true);
    const lifted = meshesOf(scene).filter((mesh) => !flat.includes(mesh));
    expect(lifted.map((mesh) => (mesh.material as Material).name).sort()).toEqual(
      flat.map((mesh) => (mesh.material as Material).name).sort(),
    );
    const lift = (mesh: Mesh) =>
      mesh.geometry.getAttribute(
        (mesh.material as Material).name.startsWith('trees') ? 'aGround' : 'ground',
      );
    for (const mesh of lifted) {
      expect(lift(mesh)).toBeDefined();
      expect(mesh.layers.mask).toBe(1 << WARM_LAYER);
    }
    // The flat set keeps its layout: its builds keep a user until a tile draws with them.
    for (const mesh of flat) expect(lift(mesh)).toBeUndefined();
    expect(invalidated.buildings).toBeGreaterThan(0);
    expect(invalidated.trees).toBeGreaterThan(0);
    expect(warmup.ground()).toBe(false);
    expect(meshesOf(scene).length).toBe(flat.length * 2);
  });

  test('disposed, it leaves the scene', () => {
    const { scene, context } = harness();
    const warmup = createMaterialWarmup(context, createTreeShapes(), ['openmaptiles', 'goway']);
    warmup.ground();
    warmup.dispose();
    expect(scene.children).toEqual([]);
  });
});

/**
 * A still, untextured model as one or two draws (`engine/city3d/modelBatch.ts`):
 * the shipped landmarks batch, a tintable vehicle does not, and nothing of
 * the look is lost on the way — shape, colour, roughness, the night glow, the
 * floodlight wash and the decals' depth bias.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as THREE from 'three';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { createGltfLoader } from '@/components/map/engine/city3d/gltf';
import { batchable, batchAsset } from '@/components/map/engine/city3d/modelBatch';

const PUBLIC = join(import.meta.dir, '..', '..', '..', 'public');

async function load(path: string): Promise<GLTF> {
  const bytes = readFileSync(join(PUBLIC, path));
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  return new Promise((resolve, reject) => createGltfLoader().parse(buffer, '', resolve, reject));
}

function triangles(object: THREE.Object3D): number {
  let n = 0;
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh)
      n += (mesh.geometry.index?.count ?? mesh.geometry.getAttribute('position').count) / 3;
  });
  return n;
}

describe('model batches', () => {
  test('every shipped landmark batches into at most two draws, its shape and size kept', async () => {
    const files = readdirSync(join(PUBLIC, 'landmarks')).filter((f) => f.endsWith('.glb'));
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      const gltf = await load(`landmarks/${file}`);
      expect(batchable(gltf.scene, gltf.animations)).toBe(true);
      const batched = batchAsset(gltf.scene, { value: 0 });
      expect(batched.children.length).toBeLessThanOrEqual(2);
      expect(triangles(batched)).toBe(triangles(gltf.scene));
      const before = new THREE.Box3().setFromObject(gltf.scene);
      const after = new THREE.Box3().setFromObject(batched);
      expect(after.min.distanceTo(before.min)).toBeLessThan(1e-3);
      expect(after.max.distanceTo(before.max)).toBeLessThan(1e-3);
    }
  });

  test('a tintable model stays mesh by mesh (a tint is per instance)', async () => {
    const gltf = await load('models/library/vehicle.sedan.glb');
    expect(batchable(gltf.scene, gltf.animations)).toBe(false);
  });

  test('the look is baked per vertex: colour, night glow, wash, and decals apart', () => {
    const mesh = (material: THREE.MeshStandardMaterial, y: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), material);
      m.position.y = y;
      return m;
    };
    const stone = new THREE.MeshStandardMaterial({ color: 0x808080, roughness: 0.9 });
    stone.userData = { goway: { uplight: { color: [1, 0.5, 0.25], reach: 40, strength: 2 } } };
    const window = new THREE.MeshStandardMaterial({ color: 0x101010, roughness: 0.2 });
    window.userData = { goway: { night: { color: [1, 0.8, 0.5], strength: 3 }, decal: true } };
    const root = new THREE.Group();
    root.add(mesh(stone, 0), mesh(window, 2));
    const batched = batchAsset(root, { value: 0 });
    expect(batched.children).toHaveLength(2);
    const [plain, decal] = batched.children as THREE.Mesh[];
    const at = (m: THREE.Mesh, name: string) =>
      Array.from(m.geometry.getAttribute(name).array.slice(0, 4));
    expect(at(plain, 'mColor')[0]).toBeCloseTo(stone.color.r);
    expect(at(plain, 'mPbr')[0]).toBeCloseTo(0.9);
    expect(at(plain, 'mUplight')).toEqual([2, 1, 0.5, 40]);
    expect(at(plain, 'mNight').slice(0, 3)).toEqual([0, 0, 0]);
    // A night material glows by its own colour × strength, and only at night.
    expect(
      at(decal, 'mNight')
        .slice(0, 3)
        .map((v) => Number(v.toFixed(3))),
    ).toEqual([3, 2.4, 1.5]);
    expect(at(decal, 'mEmissive').slice(0, 3)).toEqual([0, 0, 0]);
    expect((decal.material as THREE.Material).polygonOffset).toBe(true);
    expect((plain.material as THREE.Material).polygonOffset).toBe(false);
    // The decal batch stands where its mesh did (2 m up).
    decal.geometry.computeBoundingBox();
    expect(decal.geometry.boundingBox?.min.y).toBeCloseTo(1.5);
  });
});

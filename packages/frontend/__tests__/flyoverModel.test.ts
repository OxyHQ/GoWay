/**
 * The flyover's vehicle follows the model asset profile of
 * `docs/SDK_MAP_MODELS.md`, and the committed GLB is exactly what its
 * generator writes (so the licence — GoWay's own work, CC0 — is the licence
 * of the bytes that ship).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildCarGlb, CAR_GLB_PATH } from '../scripts/build-flyover-model';

interface Accessor {
  count: number;
  min?: number[];
  max?: number[];
}

function parseGlb(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);
  expect(view.getUint32(4, true)).toBe(2);
  expect(view.getUint32(8, true)).toBe(bytes.byteLength);
  const jsonLength = view.getUint32(12, true);
  expect(view.getUint32(16, true)).toBe(0x4e4f534a);
  return JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + jsonLength))) as {
    asset: { version: string };
    extensionsUsed?: string[];
    materials: Array<{ name: string }>;
    meshes: Array<{ primitives: Array<{ attributes: { POSITION: number }; material: number }> }>;
    accessors: Accessor[];
  };
}

describe('goway-car.glb', () => {
  const committed = new Uint8Array(readFileSync(CAR_GLB_PATH));
  const gltf = parseGlb(committed);
  const primitives = gltf.meshes.flatMap((m) => m.primitives);
  const positions = primitives.map((p) => gltf.accessors[p.attributes.POSITION]);

  test('is what the generator writes, byte for byte', () => {
    expect(Buffer.from(buildCarGlb()).equals(Buffer.from(committed))).toBe(true);
  });

  test('is glTF 2.0 with no extensions, within the lite budget', () => {
    expect(gltf.asset.version).toBe('2.0');
    expect(gltf.extensionsUsed ?? []).toEqual([]);
    expect(committed.byteLength).toBeLessThan(200 * 1024);
    const triangles = positions.reduce((sum, a) => sum + a.count / 3, 0);
    expect(triangles).toBeLessThan(5_000);
  });

  test('origin at the base centre: it stands on y = 0', () => {
    const minY = Math.min(...positions.map((a) => a.min?.[1] ?? 0));
    expect(Math.abs(minY)).toBeLessThan(0.02);
    const minX = Math.min(...positions.map((a) => a.min?.[0] ?? 0));
    const maxX = Math.max(...positions.map((a) => a.max?.[0] ?? 0));
    expect(Math.abs(minX + maxX)).toBeLessThan(0.01);
  });

  test('front faces +Z: the headlights are at the front, the taillights at the back', () => {
    const at = (name: string) => {
      const index = gltf.materials.findIndex((m) => m.name === name);
      return gltf.accessors[
        primitives.find((p) => p.material === index)?.attributes.POSITION ?? -1
      ];
    };
    expect(at('headlight').min?.[2]).toBeGreaterThan(1.9);
    expect(at('taillight').max?.[2]).toBeLessThan(-1.9);
  });

  test('the body is tintable (materials named paint…)', () => {
    expect(gltf.materials.filter((m) => m.name.startsWith('paint')).length).toBeGreaterThan(0);
  });

  test('its licence is recorded beside it', () => {
    const licence = readFileSync(join(CAR_GLB_PATH, '..', 'LICENSE.md'), 'utf8');
    expect(licence).toContain('goway-car.glb');
    expect(licence).toContain('CC0-1.0');
  });
});

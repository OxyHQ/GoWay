/**
 * The native-3D phase 1 seam (`docs/MAP_NATIVE_3D.md`): the tile meshing every
 * host calls (`tileMeshing.ts`) and the TSL building material that draws its
 * output on WebGL2 and on WebGPU (`tsl/osmBuildingMaterial.ts`).
 *
 * What a GPU run cannot check cheaply is checked here: that the vertex lanes
 * keep the layout WebGPU accepts (every stride a multiple of 4 bytes, no
 * 3-component 8/16-bit formats), and that the TSL material reads the SAME
 * uniforms as the GLSL one, so one uniform set drives both renderers.
 */
import { describe, expect, test } from 'bun:test';

import { MATERIAL_GLSL } from '@/components/map/engine/city3d/materials';
import { OSM_FRAGMENT_SHADER, OSM_VERTEX_SHADER } from '@/components/map/engine/city3d/osmShaders';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';
import { meshCityTile } from '@/components/map/engine/city3d/tileMeshing';
import { createOsmBuildingMaterial } from '@/components/map/engine/city3d/tsl/osmBuildingMaterial';
import { encodeCityTile, type TilePoint } from '@/scripts/citygen/mvtEncode';

const TILE = { z: 15, x: 16580, y: 12236 };

function square(x: number, y: number, side: number): TilePoint[] {
  return [
    [x, y],
    [x + side, y],
    [x + side, y + side],
    [x, y + side],
    [x, y],
  ];
}

function tileBytes(): ArrayBuffer {
  const bytes = encodeCityTile([
    {
      id: 10,
      polygons: [{ outer: square(1000, 1000, 200), holes: [] }],
      properties: { render_height: 22, render_min_height: 0, levels: 6, colour: '#aa5533' },
    },
    {
      id: 20,
      polygons: [{ outer: square(2000, 2000, 120), holes: [] }],
      properties: { render_height: 5, render_min_height: 0 },
    },
  ]);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe('tile meshing, shared by the web worker and the native host', () => {
  test('a city tile meshes with the lanes the TSL material reads', () => {
    const { mesh, footprints } = meshCityTile(tileBytes(), tileSizeMetres(TILE), undefined);
    expect(footprints.list).toHaveLength(2);
    expect(mesh).not.toBeNull();
    for (const chunk of mesh?.chunks ?? []) {
      const vertices = chunk.position.length / 4;
      expect(chunk.position).toBeInstanceOf(Uint16Array);
      expect(chunk.normal).toBeInstanceOf(Int8Array);
      expect(chunk.color).toBeInstanceOf(Uint8Array);
      expect(chunk.facade).toBeInstanceOf(Uint16Array);
      expect(chunk.normal.length / 4).toBe(vertices);
      expect((chunk.color?.length ?? 0) / 4).toBe(vertices);
      expect((chunk.facade?.length ?? 0) / 4).toBe(vertices);
    }
  });

  test('every lane the material binds has a WebGPU-legal stride', () => {
    const { mesh } = meshCityTile(tileBytes(), tileSizeMetres(TILE), undefined);
    const chunk = mesh?.chunks[0];
    if (!chunk?.color || !chunk.facade) throw new Error('no lanes');
    // uint16x4, snorm8x4, unorm8x4, uint16x4: WebGPU wants strides % 4 === 0.
    for (const lane of [chunk.position, chunk.normal, chunk.color, chunk.facade]) {
      expect((lane.BYTES_PER_ELEMENT * 4) % 4).toBe(0);
    }
  });

  test('an empty tile is nothing to draw, not an error', () => {
    const empty = new ArrayBuffer(0);
    expect(meshCityTile(empty, tileSizeMetres(TILE), undefined).mesh).toBeNull();
  });
});

describe('the TSL building material', () => {
  const ramp = {
    low: [0.9, 0.9, 0.85],
    tall: [0.8, 0.8, 0.75],
    veryTall: [0.7, 0.7, 0.65],
    tallM: 60,
    veryTallM: 180,
  } as const;
  const light = { position: [0.5, 0.5, 1] as const, intensity: 0.2, color: [1, 1, 1] as const };

  test('reads every uniform the GLSL material declares, except the ones not ported yet', () => {
    const { uniforms } = createOsmBuildingMaterial(ramp, light);
    const declared = new Set(
      [...`${OSM_VERTEX_SHADER}${OSM_FRAGMENT_SHADER}`.matchAll(/uniform \w+ (u\w+);/g)].map(
        (m) => m[1],
      ),
    );
    // Phase 2 (`docs/MAP_NATIVE_3D.md`): the terrain lift and the LOD dither;
    // and the detailed look's material (`materials.ts`), which is drawn only
    // in the city sky's light, so it is ported with the sky.
    const notYet = new Set([
      'uGrounded',
      'uFadeFrom',
      'uFadeTo',
      ...[...MATERIAL_GLSL.matchAll(/uniform \w+ (u\w+);/g)].map((m) => m[1]),
    ]);
    const expected = [...declared].filter((name) => !notYet.has(name)).sort();
    expect(Object.keys(uniforms).sort()).toEqual(expected);
  });

  test('builds a position and a colour node over the packed lanes', () => {
    const { material, uniforms } = createOsmBuildingMaterial(ramp, light);
    expect(material.positionNode).toBeTruthy();
    expect(material.colorNode).toBeTruthy();
    expect(uniforms.uLightIntensity.value).toBe(0.2);
    expect(uniforms.uLow.value.toArray()).toEqual([0.9, 0.9, 0.85]);
  });
});

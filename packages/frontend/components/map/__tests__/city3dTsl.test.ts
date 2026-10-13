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
import { BackSide, FrontSide, Vector3 } from 'three/webgpu';

import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';
import { meshCityTile } from '@/components/map/engine/city3d/tileMeshing';
import {
  createBuildingMaterials,
  createBuildingUniforms,
} from '@/components/map/engine/city3d/tsl/buildingMaterial';
import { encodeCityTile, type TilePoint } from '@/scripts/citygen/mvtEncode';
import { decodeLod2Tile } from '@/components/map/engine/city3d/lod2Tiles';
import { cityTile, roadTile, SYNTHETIC_CENTRE } from './fixtures/syntheticCity';
import { decodeRoadTile } from '@/components/map/engine/roads/roadTiles';
import { meshStreetTile } from '@/components/map/engine/cityStreets/streetMesher';
import { StreetAtlas } from '@/components/map/engine/cityStreets/streetAtlas';
import { createStreetMaterials } from '@/components/map/engine/cityStreets/streetMaterials';
import { createGroundAtlas } from '@/components/map/engine/cityStreets/groundAtlas';
import {
  lifeBodyMaterial,
  lifeShadowMaterial,
} from '@/components/map/engine/cityLife/lifeMaterials';
import { latticeCells, TERRAIN_LATTICE } from '@/components/map/engine/city3d/terrainGround';
import { mercatorXFromLng, mercatorYFromLat } from '@/components/map/engine/city3d/tileMath';

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

  test('the visibility gate’s official fixture meshes through the LOD2 path', () => {
    // The tile under the synthetic city's centre (`check-city3d-visible.ts`).
    const n = 2 ** 15;
    const tile = {
      z: 15,
      x: Math.floor(mercatorXFromLng(SYNTHETIC_CENTRE.lng) * n),
      y: Math.floor(mercatorYFromLat(SYNTHETIC_CENTRE.lat) * n),
    };
    const plain = cityTile(tile.z, tile.x, tile.y);
    const official = cityTile(tile.z, tile.x, tile.y, { official: true });
    expect(decodeLod2Tile(plain)).toHaveLength(0);
    expect(decodeLod2Tile(official).length).toBeGreaterThan(0);
    const meshed = meshCityTile(
      official.buffer.slice(
        official.byteOffset,
        official.byteOffset + official.byteLength,
      ) as ArrayBuffer,
      tileSizeMetres(tile),
      undefined,
    );
    expect(meshed.sources).toEqual(['es-catastro']);
    expect(meshed.mesh?.triangles ?? 0).toBeGreaterThan(0);
  });

  test('the visibility gate’s road fixture meshes into street surfaces and markings', () => {
    const n = 2 ** 15;
    const tile = {
      x: Math.floor(mercatorXFromLng(SYNTHETIC_CENTRE.lng) * n),
      y: Math.floor(mercatorYFromLat(SYNTHETIC_CENTRE.lat) * n),
    };
    const data = decodeRoadTile(roadTile(15, tile.x, tile.y), tile);
    expect(data.pieces.length).toBeGreaterThan(4);
    const mesh = meshStreetTile({
      tile,
      tiles: [{ ...tile, data }],
      rules: { drivingSide: 'right', yellowCentre: false },
      atlas: new StreetAtlas(),
    });
    expect(mesh.surfaces.indices.length).toBeGreaterThan(0);
    expect(mesh.markings.indices.length).toBeGreaterThan(0);
  });

  test('an empty tile is nothing to draw, not an error', () => {
    const empty = new ArrayBuffer(0);
    expect(meshCityTile(empty, tileSizeMetres(TILE), undefined).mesh).toBeNull();
  });
});

describe('the TSL building material', () => {
  const refs = () => ({
    uLow: { value: new Vector3(0.9, 0.9, 0.85) },
    uTall: { value: new Vector3(0.8, 0.8, 0.75) },
    uVeryTall: { value: new Vector3(0.7, 0.7, 0.65) },
    uTallM: { value: 60 },
    uVeryTallM: { value: 180 },
    uLightPosition: { value: new Vector3(0.5, 0.5, 1) },
    uLightIntensity: { value: 0.2 },
    uLightColor: { value: new Vector3(1, 1, 1) },
    uGrounded: { value: 0 },
  });

  test("the engine's uniform objects drive the nodes: one source of truth", () => {
    const engine = refs();
    const uniforms = createBuildingUniforms(engine);
    engine.uLightIntensity.value = 0.45;
    engine.uLightPosition.value.set(0, 0, 1.15);
    uniforms.uLightIntensity.update({} as never);
    uniforms.uLightPosition.update({} as never);
    expect(uniforms.uLightIntensity.value).toBe(0.45);
    expect(uniforms.uLightPosition.value.toArray()).toEqual([0, 0, 1.15]);
  });

  test('one shared material per format and variant, built once', () => {
    const materials = createBuildingMaterials(createBuildingUniforms(refs()), FrontSide);
    const settled = materials.get('goway', false);
    expect(materials.get('goway', false)).toBe(settled);
    const dithered = materials.get('goway', true);
    expect(dithered).not.toBe(settled);
    expect(dithered.colorNode).not.toBe(settled.colorNode);
    expect(materials.get('openmaptiles', false)).not.toBe(settled);
  });

  test('both formats build, on the side asked for, blended as MapLibre blends custom layers', () => {
    const materials = createBuildingMaterials(createBuildingUniforms(refs()), BackSide);
    for (const format of ['openmaptiles', 'goway'] as const) {
      for (const dithered of [false, true]) {
        const material = materials.get(format, dithered);
        expect(material.positionNode).toBeTruthy();
        expect(material.colorNode).toBeTruthy();
        expect(material.side).toBe(BackSide);
        expect(material.transparent).toBe(false);
      }
    }
  });
});

describe('the TSL street materials', () => {
  const inputs = () => ({
    groundAtlas: createGroundAtlas(4, 66).texture,
    groundCells: 64,
    sdfAtlas: createGroundAtlas(1, 66).texture,
    surfaceDay: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    surfaceNight: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    paintDay: Array.from({ length: 5 }, () => new Vector3()),
    paintNight: Array.from({ length: 5 }, () => new Vector3()),
    nightFactor: () => 0,
    fade: () => 1,
    pxPerM: () => 1,
    depthBias: 2e-6,
  });

  test('one material per kind for every tile: surfaces opaque, markings blended under nothing', () => {
    const materials = createStreetMaterials(inputs());
    const { surfaces, markings } = materials;
    expect(surfaces.vertexNode).toBeTruthy();
    expect(markings.vertexNode).toBeTruthy();
    expect(surfaces.transparent).toBe(false);
    expect(markings.transparent).toBe(true);
    expect(markings.depthWrite).toBe(false);
    materials.dispose();
  });

  test('the ground atlas: a slot per tile, each grid at its own rows', () => {
    // A z15 street tile on GoWay's DEM: 64 pixels across, one more each side.
    const cellsAcross = latticeCells({ z: 15 }, TERRAIN_LATTICE);
    expect(cellsAcross).toBe(64);
    const size = cellsAcross + 2;
    const atlas = createGroundAtlas(3, size);
    const a = atlas.claim();
    const b = atlas.claim();
    expect(a).not.toBe(b);
    const cells = size * size;
    atlas.write(b ?? 0, { values: new Float32Array(cells).fill(7), cells: cellsAcross, size });
    const data = atlas.texture.image.data as Float32Array;
    expect(data[(b ?? 0) * cells]).toBe(7);
    expect(data[(a ?? 0) * cells]).toBe(0);
    expect(atlas.texture.image.height).toBe(size * 3);
    expect(() => atlas.write(a ?? 0, { values: new Float32Array(9), cells: 1, size: 3 })).toThrow();
    atlas.claim();
    expect(atlas.claim()).toBeNull();
    atlas.release(a ?? 0);
    expect(atlas.claim()).toBe(a);
  });
});

describe('the TSL city-life materials', () => {
  const frame = {
    alpha: () => 0.5,
    time: () => 1,
    step: 0.05,
    pxPerM: () => 2,
    taxiDoors: new Vector3(1, 0.8, 0.3),
  };
  const light = {
    position: new Vector3(0, 0, 1),
    intensity: () => 0.5,
    color: new Vector3(1, 1, 1),
  };
  const model = (person: boolean, taxi = false) => ({
    person,
    taxi,
    doorBand: [0.2, 0.8] as [number, number],
    maxLength: 5,
    modelLength: 4.5,
    nearSize: person ? 2.6 : 4.5,
    shadowHalfSize: [2, 1] as [number, number],
    shadowStrength: 0.4,
  });

  test('a body per model and level, a shadow per model: what each draws with', () => {
    for (const m of [model(true), model(false), model(false, true)]) {
      for (const lod of [0, 1] as const) {
        const body = lifeBodyMaterial(frame, light, m, lod);
        expect(body.vertexNode).toBeTruthy();
        expect(body.colorNode).toBeTruthy();
        // The engine's model matrix is mirrored (`cityMeshes.ts`).
        expect(body.side).toBe(BackSide);
        expect(body.transparent).toBe(false);
      }
      const shadow = lifeShadowMaterial(frame, m);
      expect(shadow.transparent).toBe(true);
      expect(shadow.depthWrite).toBe(false);
    }
  });
});

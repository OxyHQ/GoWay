/**
 * The ground GoWay stands things on IS the terrain MapLibre draws
 * (`terrainGround.ts`, `city3dGround.web.ts`; `docs/MAP_TERRAIN_GLOBE.md` →
 * "Everything on the drawn ground").
 *
 * Against MapLibre's OWN terrain code — its `Terrain`, `TerrainTileManager`
 * and `DEMData` from the installed `maplibre-gl` sources, not a copy — over a
 * DEM served at two zooms the way Mapterhorn serves it (the z11 tile is the
 * z12 surface at half the resolution):
 *
 *  - the host's sampler reads the DEM tile the terrain is drawn from, which is
 *    not the one at the DEM's max zoom (`getElevationForLngLatZoom` takes a
 *    terrain tile's zoom, a DEM zoom plus `deltaZoom`);
 *  - a tile's grid, read anywhere, gives the height of MapLibre's terrain mesh
 *    at its vertices — terrain tiles at every street-level zoom — and between
 *    them to within the bilinear twist the 128-cell mesh flattens.
 *
 * Born of the Mallorca–Marina report (terrain triangles over the street
 * detail): on main the sampler read the z11 tile and a 33² grid, and both
 * assertions fail by metres.
 */
import { describe, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';

import { followTerrain } from '@/components/map/city3dGround.web';
import {
  createGround,
  type GroundLattice,
  type GroundSampler,
  gridAt,
} from '@/components/map/engine/city3d/terrainGround';
import { latFromMercatorY } from '@/components/map/engine/city3d/tileMath';

// MapLibre's own sources (the package ships them; its `exports` map does not,
// so they are reached by path).
const SRC = join(dirname(require.resolve('maplibre-gl/package.json')), 'src');
const { Terrain } = await import(join(SRC, 'render/terrain.ts'));
const { DEMData } = await import(join(SRC, 'data/dem_data.ts'));
const { OverscaledTileID } = await import(join(SRC, 'tile/tile_id.ts'));
const { RGBAImage } = await import(join(SRC, 'util/image.ts'));
const { LngLat } = await import(join(SRC, 'geo/lng_lat.ts'));
const { Pos3dArray, TriangleIndexArray } = await import(join(SRC, 'data/array_types.g.ts'));
const { StructArray } = await import(join(SRC, 'util/struct_array.ts'));

// Bun compiles MapLibre's sources with define-semantics class fields (its own
// build does not): a field a class only DECLARES is set to `undefined` on the
// instance, shadowing what MapLibre puts on the prototype (`bytesPerElement`)
// or made in the base constructor (a layout's typed views). Undone for the
// two arrays the terrain mesh is built in, before they allocate or write.
type Struct = { _refreshViews(): void; bytesPerElement?: number; uint8?: Uint8Array };
const reserve = StructArray.prototype.reserve;
StructArray.prototype.reserve = function (this: Struct, n: number) {
  if (Object.hasOwn(this, 'bytesPerElement') && this.bytesPerElement === undefined) {
    delete this.bytesPerElement;
  }
  return reserve.call(this, n);
};
for (const Layout of [Pos3dArray, TriangleIndexArray]) {
  const layout = Object.getPrototypeOf(Layout.prototype);
  const emplace = layout.emplace;
  layout.emplace = function (this: Struct, ...args: number[]) {
    if (!this.uint8) this._refreshViews();
    return emplace.apply(this, args);
  };
}

const EXTENT = 8192;
const DEM_SIZE = 512;
const DEM_ZOOM = 12;
/** The z12 DEM tile over Barcelona's Eixample, and a z15 street tile well inside it. */
const DEM_TILE = { x: 2072, y: 1529 };
const STREET_TILE = { z: 15, x: 16580, y: 12236 };

/**
 * Bare-earth-like ground in metres at a mercator point: a 3% slope to the
 * sea, a few hundred-metre swells, and 25 cm folds four to five DEM pixels
 * across — the detail a coarser copy of the surface loses.
 */
function surface(mx: number, my: number): number {
  const m = mx * 40_075_016.7 * Math.cos((41.4 * Math.PI) / 180);
  const n = my * 40_075_016.7 * Math.cos((41.4 * Math.PI) / 180);
  return (
    35 +
    0.03 * (n % 10_000) +
    4 * Math.sin(m / 190) * Math.cos(n / 230) +
    0.25 * Math.sin(m / 11 + 1) * Math.sin(n / 9)
  );
}

/** A Terrarium DEM tile of {@link surface}, its pixels at their centres, MapLibre's 2 px border round it. */
function demTile(z: number, x: number, y: number) {
  const stride = DEM_SIZE + 4;
  const image = new RGBAImage({ width: stride, height: stride });
  for (let j = 0; j < DEM_SIZE; j++) {
    for (let i = 0; i < DEM_SIZE; i++) {
      const h = surface((x + (i + 0.5) / DEM_SIZE) / 2 ** z, (y + (j + 0.5) / DEM_SIZE) / 2 ** z);
      const v = Math.round((h + 32768) * 256) / 256;
      const at = ((j + 2) * stride + i + 2) * 4;
      image.data[at] = Math.floor(v / 256);
      image.data[at + 1] = Math.floor(v) % 256;
      image.data[at + 2] = Math.round((v % 1) * 256);
      image.data[at + 3] = 255;
    }
  }
  const tileID = new OverscaledTileID(z, 0, z, x, y);
  return { tileID, dem: new DEMData(`${z}/${x}/${y}`, image, 'terrarium') };
}

/** MapLibre's terrain over two DEM tiles: the z12 one, and its z11 parent. */
function mapLibreTerrain() {
  const tiles = new Map<string, ReturnType<typeof demTile>>();
  for (const t of [
    demTile(DEM_ZOOM, DEM_TILE.x, DEM_TILE.y),
    demTile(DEM_ZOOM - 1, DEM_TILE.x >> 1, DEM_TILE.y >> 1),
  ]) {
    tiles.set(t.tileID.key, t);
  }
  const tileManager = {
    _source: { tileSize: DEM_SIZE, minzoom: 0, maxzoom: DEM_ZOOM },
    getTileByID: (key: string) => tiles.get(key),
    _outOfViewCache: { getByKey: () => undefined },
  };
  const painter = {
    style: { projection: { transitionState: 0 } },
    context: {
      createVertexBuffer: (array: unknown) => ({ array }),
      createIndexBuffer: (array: unknown) => ({ array }),
    },
  };
  return new Terrain(painter, tileManager, { source: 'dem', exaggeration: 1 }, 'none');
}

/** The sampler and lattice the host hands the engine, through the real host code. */
function hostGround(terrain: ReturnType<typeof mapLibreTerrain>) {
  let handed: { sample: GroundSampler; lattice?: GroundLattice } | null = null;
  const map = {
    terrain,
    getTerrain: () => ({ source: 'dem' }),
    getSource: () => ({ maxzoom: DEM_ZOOM, tileSize: DEM_SIZE }),
    getCenter: () => new LngLat(0, 0),
    on() {},
    off() {},
  };
  const stop = followTerrain(map as never, {
    setGround(sample, lattice) {
      handed = sample ? { sample, lattice } : null;
    },
  });
  stop();
  if (!handed) throw new Error('no ground handed over');
  return handed as { sample: GroundSampler; lattice?: GroundLattice };
}

/**
 * MapLibre's terrain mesh for one terrain tile, as the GPU draws it: its
 * vertices at `get_elevation` (the CPU twin, `Terrain.getElevation`), and a
 * point read off the triangle it falls in.
 */
function drawnMesh(terrain: ReturnType<typeof mapLibreTerrain>, z: number, x: number, y: number) {
  const tileID = new OverscaledTileID(z, 0, z, x, y);
  const mesh = terrain.getTerrainMesh(tileID);
  const positions = mesh.vertexBuffer.array.int16 as Int16Array;
  const indices = mesh.indexBuffer.array.uint16 as Uint16Array;
  const count = mesh.vertexBuffer.array.length as number;
  const height = new Float64Array(count);
  for (let v = 0; v < count; v++) {
    height[v] = terrain.getElevation(tileID, positions[v * 3], positions[v * 3 + 1], EXTENT);
  }
  return { tileID, positions, indices, height, count };
}

/** Mercator of a terrain-tile coordinate. */
const mercatorOf = (z: number, x: number, y: number, px: number, py: number) => [
  (x + px / EXTENT) / 2 ** z,
  (y + py / EXTENT) / 2 ** z,
];

/** Our ground at a mercator point, read from the street tile's grid as everything reads it. */
function oursAt(grid: ReturnType<ReturnType<typeof createGround>['grid']>, mx: number, my: number) {
  const n = 2 ** STREET_TILE.z;
  return gridAt(grid, mx * n - STREET_TILE.x, my * n - STREET_TILE.y);
}

describe('the drawn ground', () => {
  const terrain = mapLibreTerrain();
  const host = hostGround(terrain);
  const ground = createGround(host.sample, host.lattice);
  const grid = ground.grid(STREET_TILE);

  test('the host samples the DEM tile the terrain draws, not the coarser one at its max zoom', () => {
    expect(host.lattice).toEqual({ zoom: DEM_ZOOM, tileSize: DEM_SIZE });
    // A z15 terrain tile reads the z12 DEM tile — the one MapLibre draws at street level.
    const drawn = new OverscaledTileID(15, 0, 15, STREET_TILE.x, STREET_TILE.y);
    let ours = 0;
    let coarse = 0;
    for (let j = 0; j <= 40; j++) {
      for (let i = 0; i <= 40; i++) {
        const lng = ((STREET_TILE.x + i / 40) / 2 ** 15) * 360 - 180;
        const lat = latFromMercatorY((STREET_TILE.y + j / 40) / 2 ** 15);
        const expected = terrain.getElevation(drawn, (i / 40) * EXTENT, (j / 40) * EXTENT, EXTENT);
        ours = Math.max(ours, Math.abs(host.sample(lng, lat) - expected));
        // What `getElevationForLngLatZoom(…, maxzoom)` reads: the z11 tile.
        const z11 = terrain.getElevationForLngLatZoom(new LngLat(lng, lat), DEM_ZOOM);
        coarse = Math.max(coarse, Math.abs(z11 - expected));
      }
    }
    expect(ours).toBeLessThan(1e-6);
    expect(coarse).toBeGreaterThan(0.1);
  });

  test("a street tile's grid is the DEM on its own pixel centres: 64 across, one past each edge", () => {
    expect(grid.cells).toBe(64);
    expect(grid.size).toBe(66);
  });

  for (const z of [15, 16, 17, 18]) {
    test(`equals MapLibre's z${z} terrain mesh at its vertices, and between them to within the mesh's own flattening`, () => {
      // The terrain tile at z over the street tile's north-west quarter.
      const scale = 2 ** (z - STREET_TILE.z);
      const tx = STREET_TILE.x * scale + (scale >> 2);
      const ty = STREET_TILE.y * scale + (scale >> 2);
      const mesh = drawnMesh(terrain, z, tx, ty);
      let atVertices = 0;
      for (let v = 0; v < mesh.count; v++) {
        const [mx, my] = mercatorOf(z, tx, ty, mesh.positions[v * 3], mesh.positions[v * 3 + 1]);
        atVertices = Math.max(atVertices, Math.abs(oursAt(grid, mx, my) - mesh.height[v]));
      }
      // Float32 grid values of a ~40 m surface: micrometres.
      expect(atVertices).toBeLessThan(1e-3);

      // Inside every triangle: its centroid and the middle of each edge, as the GPU interpolates them.
      let between = 0;
      for (let t = 0; t < mesh.indices.length; t += 3) {
        const [a, b, c] = [mesh.indices[t], mesh.indices[t + 1], mesh.indices[t + 2]];
        for (const [wa, wb, wc] of [
          [1 / 3, 1 / 3, 1 / 3],
          [0.5, 0.5, 0],
          [0, 0.5, 0.5],
          [0.5, 0, 0.5],
        ]) {
          const px =
            mesh.positions[a * 3] * wa + mesh.positions[b * 3] * wb + mesh.positions[c * 3] * wc;
          const py =
            mesh.positions[a * 3 + 1] * wa +
            mesh.positions[b * 3 + 1] * wb +
            mesh.positions[c * 3 + 1] * wc;
          const drawn = mesh.height[a] * wa + mesh.height[b] * wb + mesh.height[c] * wc;
          const [mx, my] = mercatorOf(z, tx, ty, px, py);
          between = Math.max(between, Math.abs(oursAt(grid, mx, my) - drawn));
        }
      }
      // What is left is MapLibre's mesh against its own bilinear surface: at
      // z15 two vertices per DEM pixel, at z18 sixteen. Under the street
      // detail's lift (`meshBuffers.ts` → STREET_LIFT_M, 6 cm) at every zoom
      // the street detail is drawn at.
      expect(between).toBeLessThan(z >= 17 ? 0.01 : 0.04);
    });
  }
});

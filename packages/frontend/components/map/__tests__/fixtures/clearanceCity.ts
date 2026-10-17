/**
 * Buildings for the camera-clearance tests (`cameraClearance.test.ts`,
 * `cameraClearanceHost.test.ts`): rectangles placed in metres on one z15 tile,
 * through the REAL path — the mesher, the packer, the mesh worker's volume
 * index — and the engine's field over them.
 */
import type { ClearanceField } from '@/components/map/engine/camera/clearance';
import {
  createVolumeField,
  type ModelVolumes,
  type TileVolumes,
} from '@/components/map/engine/camera/field';
import { meshVolumes, type VolumeLimits } from '@/components/map/engine/camera/volumes';
import {
  type BuildingFeature,
  meshBuildings,
  type Point2,
} from '@/components/map/engine/city3d/mesher';
import { packMesh } from '@/components/map/engine/city3d/packing';
import type { createGround } from '@/components/map/engine/city3d/terrainGround';
import { tileSizeMetres } from '@/components/map/engine/city3d/tileMath';
import { latitudeFromMercatorY, longitudeFromMercatorX } from '@goway.to/sdk/geo';

export const TILE = { z: 15, x: 16580, y: 12236 };
export const N = 2 ** TILE.z;
export const SIZE = tileSizeMetres(TILE);
const EXTENT = 4096;
/** Mercator units per metre in the test tile. */
export const K = 1 / SIZE / N;
export const FLAT = () => 0;

/** A mercator point of the test tile, from metres east and south of its north-west corner. */
export const at = (east: number, south: number) => ({
  x: (TILE.x + east / SIZE) / N,
  y: (TILE.y + south / SIZE) / N,
});

/** The same point as longitude and latitude. */
export const lngLatOf = (point: { x: number; y: number }) => ({
  lng: longitudeFromMercatorX(point.x),
  lat: latitudeFromMercatorY(point.y),
});

/** A footprint of `corners` metres (east, south) around a mercator point, turned `angle`° clockwise. */
export function footprint(
  centre: { x: number; y: number },
  corners: Array<[number, number]>,
  height: number,
  angle = 0,
): BuildingFeature {
  const cx = (centre.x * N - TILE.x) * EXTENT;
  const cy = (centre.y * N - TILE.y) * EXTENT;
  const perM = EXTENT / SIZE;
  const a = (angle * Math.PI) / 180;
  const ring: Point2[] = corners.map(([x, y]) => [
    cx + (x * Math.cos(a) - y * Math.sin(a)) * perM,
    cy + (x * Math.sin(a) + y * Math.cos(a)) * perM,
  ]);
  return {
    rings: [[...ring, ring[0]]],
    properties: { render_height: height, render_min_height: 0 },
  };
}

/** A rectangular building, `w` × `d` metres, centred on a mercator point, turned `angle`° clockwise. */
export function building(
  centre: { x: number; y: number },
  w: number,
  d: number,
  height: number,
  angle = 0,
): BuildingFeature {
  return footprint(
    centre,
    [
      [-w / 2, -d / 2],
      [w / 2, -d / 2],
      [w / 2, d / 2],
      [-w / 2, d / 2],
    ],
    height,
    angle,
  );
}

/** The real path: mesher → packed mesh → the worker's volume index. */
export function tileVolumes(features: BuildingFeature[], limits?: VolumeLimits): TileVolumes {
  const mesh = meshBuildings(features, { extent: EXTENT, tileSizeMetres: SIZE });
  if (!mesh) throw new Error('nothing meshed');
  const packed = packMesh(mesh, SIZE);
  return { tile: TILE, volumes: meshVolumes(packed, limits) };
}

/** The engine's field over these tiles; `setTiles` changes them (a new version). */
export function field(
  tiles: TileVolumes[],
  options: { models?: ModelVolumes[]; ground?: ReturnType<typeof createGround> | null } = {},
): ClearanceField & { setTiles(next: TileVolumes[]): void } {
  let version = 1;
  let held = tiles;
  const f = createVolumeField({
    version: () => version,
    tiles: () => held,
    models: () => options.models ?? [],
    ground: () => options.ground ?? null,
  });
  return Object.assign(f, {
    setTiles(next: TileVolumes[]) {
      held = next;
      version++;
    },
  });
}

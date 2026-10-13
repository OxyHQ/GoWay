/**
 * The city engine's buildings as the camera rule's height field
 * (`clearance.ts` → `ClearanceField`): every tile mesh it holds and every
 * landmark it draws, as prisms (`volumes.ts`), standing on the ground the
 * engine stands them on (`terrainGround.ts`).
 *
 * Reads only what the engine already keeps: each cached tile's volume index
 * (built by the mesh worker beside the mesh, `tileMeshing.ts`) and each drawn
 * landmark's columns (measured by the same worker, `models.ts`). Nothing is
 * downloaded and no geometry is copied.
 *
 * Pure: no three.js. The engine hands it its tiles, landmarks and ground.
 */
import { EARTH_CIRCUMFERENCE_M } from '@/lib/map/geo';

import { type Ground, type GroundGrid, gridAt } from '../city3d/terrainGround';
import { type TileId, tileSizeMetres } from '../city3d/tileMath';
import type { ClearanceField } from './clearance';
import { type Clearance, type VolumeIndex, requiredHeight } from './volumes';

/** One tile mesh's prisms, as the engine holds them. */
export interface TileVolumes {
  tile: TileId;
  volumes: VolumeIndex;
}

/** One drawn model's prisms, placed. */
export interface ModelVolumes {
  /** Its anchor, mercator `[0, 1]`, and the anchor's latitude. */
  x: number;
  y: number;
  latitude: number;
  /** The height its base stands at, metres (the drawn ground plus its altitude). */
  baseM: number;
  /** Degrees clockwise from north, as `ModelPlacement.orientation.heading`. */
  heading: number;
  scale: number;
  /** In the asset's metres, x east and y north at heading 0 (`surfaceVolumes`). */
  volumes: VolumeIndex;
}

export interface VolumeSource {
  /** Changes whenever `tiles()`, `models()` or `ground()` may answer differently. */
  version(): number;
  /** The tiles held, one mesh per tile (the finest level held). */
  tiles(): readonly TileVolumes[];
  models(): readonly ModelVolumes[];
  ground(): Ground | null;
}

const DEG = Math.PI / 180;
/** Stored units across a mesh's frame (`packing.ts`). */
const SPAN = 65_535;
/**
 * Past a tile's prisms by its tallest top, the margin and this, nothing in it
 * can reach the eye: the ramp falls at least a metre per metre
 * (`CAMERA_CLEARANCE.slope`), so this covers a building standing this much
 * above the eye's own ground.
 */
const NEAR_ENOUGH_M = 300;

/** The highest ground of a tile's grid, cached per grid (grids are kept by `Ground`). */
const gridMax = new WeakMap<GroundGrid, number>();
function highest(grid: GroundGrid): number {
  let max = gridMax.get(grid);
  if (max === undefined) {
    max = -Infinity;
    for (const value of grid.values) if (value > max) max = value;
    gridMax.set(grid, max);
  }
  return max;
}

export function createVolumeField(source: VolumeSource): ClearanceField {
  return {
    get version() {
      return source.version();
    },
    requiredHeight(x: number, y: number, clearance: Clearance, floor: number): number {
      let best = floor;
      const ground = source.ground();
      for (const { tile, volumes } of source.tiles()) {
        const n = 2 ** tile.z;
        const sizeM = tileSizeMetres(tile);
        // The nearest world copy of the point, relative to the tile.
        let dx = x * n - tile.x;
        dx -= n * Math.round((dx - 0.5) / n);
        // Local metres: x east from the west edge, y NORTH from the north edge.
        const lx = dx * sizeM;
        const ly = -(y * n - tile.y) * sizeM;
        const sx = (lx - volumes.originM[0]) / volumes.unitM;
        const sy = (volumes.originM[1] - ly) / volumes.unitM;
        // Far from every prism of the tile (whatever its ground): not looked
        // at, and its ground grid is not sampled for it.
        const reach = (clearance.marginM + volumes.maxTop + NEAR_ENOUGH_M) / volumes.unitM;
        if (sx < -reach || sy < -reach || sx > SPAN + reach || sy > SPAN + reach) continue;
        const grid = ground ? ground.grid(tile) : null;
        best = requiredHeight(
          volumes,
          {
            x: sx,
            y: sy,
            unitM: volumes.unitM,
            topScale: 1,
            anchorMax: grid ? highest(grid) : 0,
            // Where the grounder stands the unit: the drawn ground at the
            // centre of its footprint's box (`terrainGround.ts` →
            // `polygonGround`, there from the mesher's box of the same
            // vertices), read from the same grid.
            anchorOf: grid
              ? (u) => {
                  const { box, unitM, originM } = volumes;
                  const east = originM[0] + ((box[u * 4] + box[u * 4 + 2]) / 2) * unitM;
                  const north = originM[1] - ((box[u * 4 + 1] + box[u * 4 + 3]) / 2) * unitM;
                  return gridAt(grid, east / sizeM, -north / sizeM);
                }
              : () => 0,
          },
          clearance,
          best,
        );
      }
      for (const model of source.models()) {
        const perMetre = 1 / (EARTH_CIRCUMFERENCE_M * Math.cos(model.latitude * DEG));
        let dx = x - model.x;
        dx -= Math.round(dx);
        const east = dx / perMetre;
        const north = -(y - model.y) / perMetre;
        // Into the asset's frame: undo the heading (clockwise), then the scale.
        const h = model.heading * DEG;
        const ax = (Math.cos(h) * east - Math.sin(h) * north) / model.scale;
        const ay = (Math.sin(h) * east + Math.cos(h) * north) / model.scale;
        const { volumes } = model;
        best = requiredHeight(
          volumes,
          {
            x: (ax - volumes.originM[0]) / volumes.unitM,
            y: (volumes.originM[1] - ay) / volumes.unitM,
            unitM: volumes.unitM * model.scale,
            topScale: model.scale,
            anchorMax: model.baseM,
            anchorOf: () => model.baseM,
          },
          clearance,
          best,
        );
      }
      return best;
    },
  };
}

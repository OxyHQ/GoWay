/**
 * The web-mercator arithmetic of the imagery build: cells, their bounds, and
 * the coverage tree of a set of cells (`docs/MAP_SATELLITE.md` → Cells).
 *
 * A CELL is one tile of a set's `cellZoom`. Every tile a set publishes at a
 * zoom ≥ `cellZoom` lies in exactly one cell, so one archive per cell
 * partitions the set with no tile twice — and the archive for a tile is
 * computed from the tile, never looked up in a list.
 */
import {
  buildCoverageTree,
  EMPTY,
  FULL,
  MIXED,
  type CoverageNode,
} from '@goway/map-service/coverageTree.js';

/** Half the web-mercator world's width, in metres (EPSG:3857). */
export const MERCATOR_HALF = 20037508.342789244;

export interface Cell {
  z: number;
  x: number;
  y: number;
}

export type LonLatBox = [west: number, south: number, east: number, north: number];

export function lonToTileX(lon: number, z: number): number {
  return ((lon + 180) / 360) * 2 ** z;
}

export function latToTileY(lat: number, z: number): number {
  const clamped = Math.max(-85.0511287798, Math.min(85.0511287798, lat));
  const r = (clamped * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z;
}

export function tileXToLon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

export function tileYToLat(y: number, z: number): number {
  return (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;
}

/** Every cell at `z` that a lon/lat box touches, row by row. */
export function cellsInBox(box: LonLatBox, z: number): Cell[] {
  const n = 2 ** z;
  const x0 = Math.max(0, Math.floor(lonToTileX(box[0], z)));
  const x1 = Math.min(n - 1, Math.floor(lonToTileX(box[2], z) - 1e-9));
  const y0 = Math.max(0, Math.floor(latToTileY(box[3], z)));
  const y1 = Math.min(n - 1, Math.floor(latToTileY(box[1], z) - 1e-9));
  const out: Cell[] = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z, x, y });
  return out;
}

/** A cell's lon/lat box. */
export function cellLonLat(cell: Cell): LonLatBox {
  return [
    tileXToLon(cell.x, cell.z),
    tileYToLat(cell.y + 1, cell.z),
    tileXToLon(cell.x + 1, cell.z),
    tileYToLat(cell.y, cell.z),
  ];
}

/** A cell's EPSG:3857 box: `[minX, minY, maxX, maxY]`. */
export function cellMercator(cell: Cell): [number, number, number, number] {
  const size = (2 * MERCATOR_HALF) / 2 ** cell.z;
  return [
    -MERCATOR_HALF + cell.x * size,
    MERCATOR_HALF - (cell.y + 1) * size,
    -MERCATOR_HALF + (cell.x + 1) * size,
    MERCATOR_HALF - cell.y * size,
  ];
}

/** Metres per pixel, at the equator, of a `tileSize` tile at zoom `z`. */
export function mercatorResolution(z: number, tileSize: number): number {
  return (2 * MERCATOR_HALF) / (tileSize * 2 ** z);
}

/** The tiles of zoom `z` inside a cell (`z ≥ cell.z`): `[x0, y0, x1, y1]`, inclusive. */
export function cellTileRange(cell: Cell, z: number): [number, number, number, number] {
  if (z < cell.z) throw new Error(`zoom ${z} is coarser than cell ${cellKey(cell)}`);
  const k = 2 ** (z - cell.z);
  return [cell.x * k, cell.y * k, (cell.x + 1) * k - 1, (cell.y + 1) * k - 1];
}

export function cellKey(cell: Cell): string {
  return `${cell.z}/${cell.x}/${cell.y}`;
}

export function parseCellKey(key: string): Cell {
  const match = /^(\d{1,2})\/(\d{1,9})\/(\d{1,9})$/.exec(key);
  if (!match) throw new Error(`"${key}" is not a cell (z/x/y)`);
  const [z, x, y] = match.slice(1).map(Number);
  if (x >= 2 ** z || y >= 2 ** z) throw new Error(`cell ${key} is outside the world`);
  return { z, x, y };
}

/** The coverage tree (`coverageTree.js`) holding exactly these cells, all of one zoom. */
export function cellsTree(cells: readonly Cell[], z: number): CoverageNode {
  const levels: Set<string>[] = Array.from({ length: z + 1 }, () => new Set());
  for (const cell of cells) {
    if (cell.z !== z) throw new Error(`cell ${cellKey(cell)} is not at zoom ${z}`);
    for (let level = z; level >= 0; level--) {
      const k = 2 ** (z - level);
      levels[level].add(`${Math.floor(cell.x / k)}/${Math.floor(cell.y / k)}`);
    }
  }
  return buildCoverageTree(
    z,
    (lz: number, x: number, y: number) => {
      if (!levels[lz].has(`${x}/${y}`)) return { state: EMPTY, context: null };
      return { state: lz === z ? FULL : MIXED, context: null };
    },
    null,
  );
}

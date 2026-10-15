/**
 * The web-mercator pixel grids of the terrain build: a window of whole pixels
 * of one zoom's 512 px tiles, the grid every source is warped to, every
 * footprint burnt into, and every tile cut from.
 *
 * Pixel `(px, py)` of zoom `z` covers global pixel `[px, px + 1) × [py, py + 1)`
 * of the `512 · 2^z` pixel world, and its value is the height at its CENTRE
 * — MapLibre's reading of a DEM pixel (`DEMData.get` is sampled between pixel
 * centres), so a tile cut from the grid is drawn where the grid says.
 */
import { latToTileY, lonToTileX, type LonLatBox, MERCATOR_HALF } from '../imagery/cells';

export const TERRAIN_TILE_SIZE = 512;

/** A window of one zoom's pixel world: origin and size in whole pixels. */
export interface PixelWindow {
  zoom: number;
  x0: number;
  y0: number;
  width: number;
  height: number;
}

/** Metres per pixel along the mercator axes (true ground metres × cos(latitude)). */
export function pixelMercatorM(zoom: number): number {
  return (2 * MERCATOR_HALF) / (TERRAIN_TILE_SIZE * 2 ** zoom);
}

/** The window of whole pixels at `zoom` that covers a lon/lat box, grown by `margin` pixels. */
export function windowOfBox(box: LonLatBox, zoom: number, margin = 0): PixelWindow {
  const scale = TERRAIN_TILE_SIZE;
  const x0 = Math.floor(lonToTileX(box[0], zoom) * scale) - margin;
  const x1 = Math.ceil(lonToTileX(box[2], zoom) * scale) + margin;
  const y0 = Math.floor(latToTileY(box[3], zoom) * scale) - margin;
  const y1 = Math.ceil(latToTileY(box[1], zoom) * scale) + margin;
  return { zoom, x0, y0, width: x1 - x0, height: y1 - y0 };
}

/** The window of a tile (or a block of tiles `span` wide) at a deeper `zoom`, grown by `margin`. */
export function windowOfTile(
  tile: { z: number; x: number; y: number },
  zoom: number,
  margin = 0,
): PixelWindow {
  if (zoom < tile.z) throw new Error(`zoom ${zoom} is coarser than tile ${tile.z}`);
  const size = TERRAIN_TILE_SIZE * 2 ** (zoom - tile.z);
  return {
    zoom,
    x0: tile.x * size - margin,
    y0: tile.y * size - margin,
    width: size + 2 * margin,
    height: size + 2 * margin,
  };
}

/** A window's EPSG:3857 bounds: `[minX, minY, maxX, maxY]` (pixel edges, not centres). */
export function windowMercator(window: PixelWindow): [number, number, number, number] {
  const res = pixelMercatorM(window.zoom);
  return [
    -MERCATOR_HALF + window.x0 * res,
    MERCATOR_HALF - (window.y0 + window.height) * res,
    -MERCATOR_HALF + (window.x0 + window.width) * res,
    MERCATOR_HALF - window.y0 * res,
  ];
}

/** A lon/lat → the window's pixel coordinates (continuous; a pixel's centre is at +0.5). */
export function lonLatToWindow(window: PixelWindow, lon: number, lat: number): [number, number] {
  const scale = TERRAIN_TILE_SIZE;
  return [
    lonToTileX(lon, window.zoom) * scale - window.x0,
    latToTileY(lat, window.zoom) * scale - window.y0,
  ];
}

/** The latitude of a window row's centre (the ground metres of a pixel are `pixelMercatorM · cos`). */
export function rowLatitude(window: PixelWindow, row: number): number {
  const n = TERRAIN_TILE_SIZE * 2 ** window.zoom;
  const y = (window.y0 + row + 0.5) / n;
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Average `factor × factor` blocks: a grid of zoom `z` → `z − log2(factor)`.
 * A block with some `NaN` averages its finite pixels; all `NaN` stays `NaN`.
 * The coarser pixel's centre is the block's centre, so the pyramid stays on
 * the same pixel-area registration at every zoom.
 */
export function downsample(
  data: Float32Array,
  width: number,
  height: number,
  factor: number,
): { data: Float32Array; width: number; height: number } {
  if (width % factor || height % factor)
    throw new Error(`${width}×${height} is not a multiple of ${factor}`);
  const w = width / factor;
  const h = height / factor;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * width + x * factor;
        for (let dx = 0; dx < factor; dx++) {
          const v = data[row + dx];
          if (!Number.isNaN(v)) {
            sum += v;
            n++;
          }
        }
      }
      out[y * w + x] = n ? sum / n : Number.NaN;
    }
  }
  return { data: out, width: w, height: h };
}

/**
 * Terrarium tiles as MapLibre draws them, sampled onto a finer pixel window:
 * every window pixel's centre read bilinearly between the DEM's pixel centres
 * (`DEMData.get` + the terrain mesh's interpolation), across tile edges as if
 * the tiles were one image — what the map's ground is at that point.
 *
 * Used by the contamination gate on what goway.to serves today, and by the
 * build to read the fallback (Mapterhorn) where a set has no data.
 */
import { TERRAIN_TILE_SIZE, type PixelWindow } from './grid';
import { decodeTerrarium } from './terrarium';
import { decodeWebp } from './webp';

/** Bytes of one DEM tile, or `null` where the server has none (open sea). */
export type TileFetcher = (z: number, x: number, y: number) => Promise<Uint8Array | null>;

/** A fetcher over a `{z}/{x}/{y}` URL template, retried; 404 is "none". */
export function templateFetcher(template: string, userAgent: string): TileFetcher {
  return async (z, x, y) => {
    const url = template
      .replace('{z}', String(z))
      .replace('{x}', String(x))
      .replace('{y}', String(y));
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await fetch(url, { headers: { 'User-Agent': userAgent } });
        if (response.status === 404 || response.status === 204) return null;
        if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
        return new Uint8Array(await response.arrayBuffer());
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
      }
    }
  };
}

/**
 * The heights of the DEM tiles of zoom `demZoom` at every pixel centre of
 * `window` (a zoom ≥ `demZoom`), bilinear between DEM pixel centres. A pixel
 * whose four DEM neighbours are not all present is `NaN` — no tile, no ground.
 */
export async function sampleServed(
  fetchTile: TileFetcher,
  demZoom: number,
  window: PixelWindow,
  concurrency = 8,
): Promise<Float32Array> {
  if (window.zoom < demZoom) throw new Error(`window zoom ${window.zoom} < DEM zoom ${demZoom}`);
  const scale = 2 ** (window.zoom - demZoom);
  const S = TERRAIN_TILE_SIZE;
  // DEM pixel-centre coordinates of the window's first and last pixel centres.
  const u0 = (window.x0 + 0.5) / scale - 0.5;
  const v0 = (window.y0 + 0.5) / scale - 0.5;
  const u1 = (window.x0 + window.width - 0.5) / scale - 0.5;
  const v1 = (window.y0 + window.height - 0.5) / scale - 0.5;
  const px0 = Math.floor(u0);
  const py0 = Math.floor(v0);
  const px1 = Math.floor(u1) + 1;
  const py1 = Math.floor(v1) + 1;
  const mw = px1 - px0 + 1;
  const mh = py1 - py0 + 1;
  const mosaic = new Float32Array(mw * mh).fill(Number.NaN);

  const n = 2 ** demZoom;
  const tiles: [number, number][] = [];
  for (let ty = Math.floor(py0 / S); ty <= Math.floor(py1 / S); ty++) {
    for (let tx = Math.floor(px0 / S); tx <= Math.floor(px1 / S); tx++) {
      if (ty >= 0 && ty < n) tiles.push([tx, ty]);
    }
  }
  let next = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const [tx, ty] = tiles[next++];
      const wrapped = ((tx % n) + n) % n;
      const bytes = await fetchTile(demZoom, wrapped, ty);
      if (!bytes) continue;
      const image = await decodeWebp(bytes);
      if (image.width !== S || image.height !== S) {
        throw new Error(
          `DEM tile ${demZoom}/${wrapped}/${ty} is ${image.width}×${image.height}, not ${S}`,
        );
      }
      const heights = decodeTerrarium(image.data);
      for (let y = 0; y < S; y++) {
        const my = ty * S + y - py0;
        if (my < 0 || my >= mh) continue;
        for (let x = 0; x < S; x++) {
          const mx = tx * S + x - px0;
          if (mx < 0 || mx >= mw) continue;
          mosaic[my * mw + mx] = heights[y * S + x];
        }
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const out = new Float32Array(window.width * window.height);
  for (let wy = 0; wy < window.height; wy++) {
    const v = (window.y0 + wy + 0.5) / scale - 0.5 - py0;
    const iy = Math.floor(v);
    const fy = v - iy;
    for (let wx = 0; wx < window.width; wx++) {
      const u = (window.x0 + wx + 0.5) / scale - 0.5 - px0;
      const ix = Math.floor(u);
      const fx = u - ix;
      const a = mosaic[iy * mw + ix];
      const b = mosaic[iy * mw + ix + 1];
      const c = mosaic[(iy + 1) * mw + ix];
      const d = mosaic[(iy + 1) * mw + ix + 1];
      out[wy * window.width + wx] =
        (a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy;
    }
  }
  return out;
}

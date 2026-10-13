/** One terrain data worker: decode, reconstruct obscured ground, encode losslessly. */
import { decodeRoadTile, type RoadPiece } from '../roads/roadTiles';
import { bridgeGround, terrainBridges } from './bridgeGround';

interface Job {
  id: number;
  url: string;
  roads: string;
  cacheTiles: number;
}
const scope = globalThis as unknown as {
  onmessage: ((e: MessageEvent<Job | { cancel: number } | { cacheTiles: number }>) => void) | null;
  postMessage(data: unknown, transfer?: Transferable[]): void;
};
interface Raster {
  bytes: ArrayBuffer;
  pixels: Uint8ClampedArray;
  size: number;
}
const rasters = new Map<string, Promise<Raster | null>>();
const roads = new Map<string, Promise<RoadPiece[]>>();
const completed = new Map<string, Promise<ArrayBuffer>>();
const cancelled = new Set<number>();
const active = new Set<number>();
let queue = Promise.resolve();

function memo<T>(
  cache: Map<string, Promise<T>>,
  key: string,
  limit: number,
  read: () => Promise<T>,
) {
  const existing = cache.get(key);
  if (existing) {
    cache.delete(key);
    cache.set(key, existing);
    return existing;
  }
  const pending = read();
  cache.set(key, pending);
  pending.catch(() => cache.delete(key));
  while (cache.size > limit) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return pending;
}
const tileUrl = (template: string, z: number, x: number, y: number) =>
  template.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y));

async function run(job: Job): Promise<ArrayBuffer> {
  const match = /\/(\d+)\/(\d+)\/(\d+)\.webp(?:\?.*)?$/.exec(job.url);
  if (!match) throw new Error('Invalid terrain tile URL');
  const z = Number(match[1]),
    x = Number(match[2]),
    y = Number(match[3]);
  const template = job.url.replace(match[0], '/{z}/{x}/{y}.webp');
  const readRaster = (tx: number, ty: number) =>
    memo(rasters, `${template}/${z}/${tx}/${ty}`, job.cacheTiles, async () => {
      if (tx < 0 || ty < 0 || tx >= 2 ** z || ty >= 2 ** z) return null;
      const response = await fetch(tileUrl(template, z, tx, ty));
      if (response.status === 404 || response.status === 204) return null;
      if (!response.ok)
        throw Object.assign(new Error('Terrain request failed'), { status: response.status });
      const bytes = await response.arrayBuffer();
      const image = await createImageBitmap(new Blob([bytes]), { colorSpaceConversion: 'none' });
      const canvas = new OffscreenCanvas(image.width, image.height),
        ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Terrain image decoder unavailable');
      ctx.drawImage(image, 0, 0);
      image.close();
      return {
        bytes,
        pixels: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
        size: canvas.width,
      };
    });
  const raster = await readRaster(x, y);
  if (!raster)
    throw Object.assign(new Error('No elevation tile at this resolution'), { status: 404 });
  if (z < 15) return raster.bytes.slice(0);
  const scale = 2 ** (z - 15),
    pieces: RoadPiece[] = [];
  const requests: Promise<void>[] = [];
  // Neighbouring roads complete a span crossing the DEM boundary.
  for (let tx = Math.floor((x - 1) / scale); tx <= Math.floor((x + 2) / scale); tx++)
    for (let ty = Math.floor((y - 1) / scale); ty <= Math.floor((y + 2) / scale); ty++) {
      if (tx < 0 || ty < 0 || tx >= 32768 || ty >= 32768) continue;
      const url = tileUrl(job.roads, 15, tx, ty);
      requests.push(
        memo(roads, url, job.cacheTiles, async () => {
          const response = await fetch(url);
          if (response.status === 404 || response.status === 204) return [];
          if (!response.ok) throw new Error(`Road terrain masks: ${response.status}`);
          return decodeRoadTile(await response.arrayBuffer(), { x: tx, y: ty }).pieces;
        }).then((p) => {
          pieces.push(...p);
        }),
      );
    }
  await Promise.all(requests);
  const size = raster.size;
  const bridges = terrainBridges(pieces, { z, x, y }, size).filter(
    (b) =>
      Math.max(...b.line.xs) + b.halfWidth > 0 &&
      Math.min(...b.line.xs) - b.halfWidth < size &&
      Math.max(...b.line.ys) + b.halfWidth > 0 &&
      Math.min(...b.line.ys) - b.halfWidth < size,
  );
  if (!bridges.length) return raster.bytes.slice(0);
  for (const b of bridges)
    b.bounds = [
      Math.min(...b.line.xs) - b.halfWidth,
      Math.min(...b.line.ys) - b.halfWidth,
      Math.max(...b.line.xs) + b.halfWidth,
      Math.max(...b.line.ys) + b.halfWidth,
    ];
  const halo = new Map<string, Raster | null>();
  await Promise.all(
    Array.from({ length: 9 }, async (_, i) => {
      const dx = (i % 3) - 1,
        dy = Math.floor(i / 3) - 1;
      halo.set(`${dx}/${dy}`, await readRaster(x + dx, y + dy));
    }),
  );
  const pixel = (px: number, py: number) => {
    const dx = Math.floor(px / size),
      dy = Math.floor(py / size),
      r = halo.get(`${dx}/${dy}`);
    if (!r) return NaN;
    const i = ((py - dy * size) * size + px - dx * size) * 4;
    return r.pixels[i] * 256 + r.pixels[i + 1] + r.pixels[i + 2] / 256 - 32768;
  };
  const sample = (px: number, py: number) => {
    // Pixel coordinates address cell boundaries, data lives at cell centres.
    const ix = Math.floor(px - 0.5),
      iy = Math.floor(py - 0.5),
      fx = px - 0.5 - ix,
      fy = py - 0.5 - iy;
    return (
      pixel(ix, iy) * (1 - fx) * (1 - fy) +
      pixel(ix + 1, iy) * fx * (1 - fy) +
      pixel(ix, iy + 1) * (1 - fx) * fy +
      pixel(ix + 1, iy + 1) * fx * fy
    );
  };
  const output = new Uint8ClampedArray(raster.pixels);
  let changed = false;
  for (let row = 0; row < size; row++)
    for (let col = 0; col < size; col++) {
      const h = bridgeGround(col + 0.5, row + 0.5, bridges, sample),
        i = (row * size + col) * 4;
      const encoded = Math.round((h + 32768) * 256);
      if (!Number.isFinite(h)) continue;
      if (encoded === output[i] * 65536 + output[i + 1] * 256 + output[i + 2]) continue;
      output[i] = (encoded >> 16) & 255;
      output[i + 1] = (encoded >> 8) & 255;
      output[i + 2] = encoded & 255;
      changed = true;
    }
  if (!changed) return raster.bytes.slice(0);
  const canvas = new OffscreenCanvas(size, size),
    ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Terrain image decoder unavailable');
  ctx.putImageData(new ImageData(output, size, size), 0, 0);
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
}

scope.onmessage = ({ data }) => {
  if ('cancel' in data) {
    if (active.has(data.cancel)) cancelled.add(data.cancel);
    return;
  }
  if (!('id' in data)) {
    for (const cache of [rasters, roads, completed]) {
      while (cache.size > data.cacheTiles) {
        const key = cache.keys().next().value;
        if (key === undefined) break;
        cache.delete(key);
      }
    }
    return;
  }
  active.add(data.id);
  queue = queue.then(async () => {
    try {
      if (cancelled.delete(data.id)) return;
      const result = await memo(completed, data.url, data.cacheTiles, () => run(data));
      const bytes = result.slice(0);
      if (!cancelled.delete(data.id)) scope.postMessage({ id: data.id, bytes }, [bytes]);
    } catch (error) {
      if (!cancelled.delete(data.id))
        scope.postMessage({
          id: data.id,
          error: String(error),
          status: (error as { status?: number }).status,
        });
    } finally {
      active.delete(data.id);
      cancelled.delete(data.id);
    }
  });
};

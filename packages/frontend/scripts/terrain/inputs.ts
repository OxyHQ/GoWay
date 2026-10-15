/**
 * A terrain set's heights on one pixel window, in EGM2008, `NaN` where the
 * set has none — whatever the source's own form (`catalogue.ts` →
 * `TerrainInput`). Every byte comes from the producer's own bulk endpoint
 * (a COG read by range, an index of COGs, the département archives of an
 * ATOM feed, the published tile pyramid), with retries and a User-Agent
 * naming GoWay; downloads are cached under `cache` and reused.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { TerrainSetDefinition } from './catalogue';
import {
  type PixelWindow,
  pixelMercatorM,
  rowLatitude,
  TERRAIN_TILE_SIZE,
  windowMercator,
} from './grid';
import { decodeGsiHeights, decodePngRgb } from './gsi';
import { type GdalRun, PLAUSIBLE_HEIGHT_M, warpToWindow } from './warp';

export const USER_AGENT = 'goway-terrain-tiles (+https://goway.to; https://github.com/OxyHQ/GoWay)';

export interface InputContext {
  gdal: GdalRun;
  /** Downloads kept between windows and runs (département archives, indexes). */
  cache: string;
}

function run(
  command: string,
  args: string[],
  env: Record<string, string>,
  cwd?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, cwd });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stdout)
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)),
    );
  });
}

async function fetchRetried(url: string): Promise<Response | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response;
    } catch (error) {
      if (attempt >= 6) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
    }
  }
}

/** Download a URL to a cache path once (atomically: a partial download is never reused). */
async function cached(url: string, path: string): Promise<string> {
  if (existsSync(path)) return path;
  await mkdir(join(path, '..'), { recursive: true });
  const partial = `${path}.partial`;
  for (let attempt = 0; ; attempt++) {
    const response = await fetchRetried(url);
    if (!response) throw new Error(`${url}: not found`);
    try {
      // Streamed to disk (a département's volume is 4 GiB), and retried whole
      // when the connection drops part-way.
      const written = await Bun.write(partial, response);
      const expected = Number(response.headers.get('content-length') ?? written);
      if (written !== expected) throw new Error(`${url}: ${written} of ${expected} bytes`);
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5000 * 2 ** attempt));
    }
  }
  await rename(partial, path);
  return path;
}

/** The window's ground pixel size at its middle row (m). */
export function windowGroundPixelM(window: PixelWindow): number {
  const lat = rowLatitude(window, Math.floor(window.height / 2));
  return pixelMercatorM(window.zoom) * Math.cos((lat * Math.PI) / 180);
}

function resamplingFor(set: TerrainSetDefinition, window: PixelWindow): 'average' | 'bilinear' {
  return set.pixelM < windowGroundPixelM(window) ? 'average' : 'bilinear';
}

/**
 * A set's heights on a window (EGM2008, `NaN` where it has none). Every
 * source pixel no terrain has is masked before the warp (`warp.ts` →
 * `withPlausibilityMask`); a height outside the range after it would be a
 * broken warp, and is an error naming where it is, never a tile.
 */
export async function readSetWindow(
  set: TerrainSetDefinition,
  window: PixelWindow,
  context: InputContext,
): Promise<Float32Array> {
  // A whole window is read again when the producer's server drops it (GDAL
  // retries each request; a refused connection still fails the warp): a
  // window that cannot be read fails the cell, never a silently empty block.
  let heights: Float32Array | null = null;
  for (let attempt = 0; heights === null; attempt++) {
    try {
      heights = await readSetWindowUnchecked(set, window, context);
    } catch (error) {
      if (attempt >= 4) throw error;
      console.warn(
        `${set.id}: read failed (${String(error).slice(0, 160)}); again in ${15 * 2 ** attempt} s`,
      );
      await new Promise((resolve) => setTimeout(resolve, 15_000 * 2 ** attempt));
    }
  }
  for (let i = 0; i < heights.length; i++) {
    const h = heights[i];
    if (h < PLAUSIBLE_HEIGHT_M[0] || h > PLAUSIBLE_HEIGHT_M[1]) {
      const n = TERRAIN_TILE_SIZE * 2 ** window.zoom;
      const lon = ((window.x0 + (i % window.width) + 0.5) / n) * 360 - 180;
      const y = (window.y0 + Math.floor(i / window.width) + 0.5) / n;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
      throw new Error(
        `${set.id}: a height of ${h} m at ${lat.toFixed(5)},${lon.toFixed(5)}: not terrain`,
      );
    }
  }
  return heights;
}

async function readSetWindowUnchecked(
  set: TerrainSetDefinition,
  window: PixelWindow,
  context: InputContext,
): Promise<Float32Array> {
  const input = set.input;
  const warp = (datasets: string[], crs = set.crs) =>
    warpToWindow(
      { datasets, crs, resampling: resamplingFor(set, window), transform: set.transform },
      window,
      context.gdal,
    );
  const empty = () => new Float32Array(window.width * window.height).fill(Number.NaN);
  switch (input.kind) {
    case 'raster':
      return warp([`/vsicurl/${input.url}`]);
    case 'usgs-index': {
      const links = await usgsTilesInWindow(input.index, input.layer, window, context);
      return links.length ? warp(links.map((link) => `/vsicurl/${link}`)) : empty();
    }
    case 'ign-atom': {
      const vrts = await ignDepartementsInWindow(input.feed, input.product, window, context);
      return vrts.length ? warp(vrts) : empty();
    }
    case 'gsi-tiles':
      return gsiWindow(set, input.templates, window, context);
  }
}

/** The 3DEP COG tiles (download links) the index lists over a window. */
async function usgsTilesInWindow(
  index: string,
  layer: string,
  window: PixelWindow,
  context: InputContext,
): Promise<string[]> {
  const local = await cached(index, join(context.cache, 'usgs', index.split('/').pop() as string));
  const [minX, minY, maxX, maxY] = windowMercator(window);
  const csv = await run(
    join(context.gdal.bin, 'ogr2ogr'),
    [
      '-f',
      'CSV',
      '/vsistdout/',
      local,
      layer,
      '-spat',
      String(minX),
      String(minY),
      String(maxX),
      String(maxY),
      '-spat_srs',
      'EPSG:3857',
      '-select',
      'dataset_link',
    ],
    context.gdal.env,
  );
  return csv
    .split('\n')
    .slice(1)
    .map((line) => line.trim().replace(/^"|"$/g, ''))
    .filter((link) => link.startsWith('https://'))
    .sort();
}

/**
 * IGN's RGE ALTI over a window: the départements whose envelope meets it
 * (IGN's ADMIN EXPRESS, through its WFS), each département's latest archive
 * of the product from the ATOM feed, downloaded and extracted once, and a
 * VRT of its tiles.
 */
async function ignDepartementsInWindow(
  feed: string,
  product: string,
  window: PixelWindow,
  context: InputContext,
): Promise<string[]> {
  const [w, s, e, n] = windowLonLatBox(window);
  const wfs =
    'https://data.geopf.fr/wfs/ows?SERVICE=WFS&VERSION=2.0.0&REQUEST=GetFeature' +
    '&TYPENAMES=ADMINEXPRESS-COG.LATEST:departement&PROPERTYNAME=code_insee&OUTPUTFORMAT=application/json' +
    `&BBOX=${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`;
  const response = await fetchRetried(wfs);
  if (!response) throw new Error('IGN WFS: no answer');
  const codes = (
    (await response.json()) as { features: { properties: { code_insee: string } }[] }
  ).features
    .map((f) => f.properties.code_insee)
    .sort();
  const vrts: string[] = [];
  for (const code of codes) {
    const zone = `D${code.padStart(3, '0')}`;
    const listing = await fetchRetried(`${feed}?zone=${zone}`);
    if (!listing) continue;
    const titles = [...(await listing.text()).matchAll(/<title>([^<]+)<\/title>/g)]
      .map((m) => m[1])
      .filter((title) => title.startsWith(`${product}_${zone}_`))
      .sort();
    const title = titles.at(-1);
    // A département with no such product (Corsica's datum is IGN78C, overseas
    // ones have their own): not this set's.
    if (!title) continue;
    const dir = join(context.cache, 'ign', title);
    const vrt = join(dir, 'tiles.vrt');
    if (!existsSync(vrt)) {
      // The resource lists the archive's download links: one `.7z`, or a big
      // département's volumes `.7z.001`, `.7z.002`, … (4 GiB each).
      const resource = await fetchRetried(`${feed}/${title}`);
      if (!resource) throw new Error(`${title}: no resource page`);
      const links = [
        ...(await resource.text()).matchAll(/href="([^"]+\/download\/[^"]+\.7z(?:\.\d{3})?)"/g),
      ]
        .map((m) => m[1])
        .sort();
      if (links.length === 0) throw new Error(`${title}: no archive to download`);
      const parts: string[] = [];
      for (const link of links) {
        parts.push(await cached(link, join(context.cache, 'ign', link.split('/').pop() as string)));
      }
      const extracted = join(dir, 'x');
      await rm(extracted, { recursive: true, force: true });
      await mkdir(extracted, { recursive: true });
      // 7z reads the volumes in order from the first.
      await run(join(context.gdal.bin, '7z'), ['x', '-y', `-o${extracted}`, parts[0]], {});
      const tifs = (await listFiles(extracted)).filter((f) => /_MNT_.*\.tif$/i.test(f)).sort();
      if (tifs.length === 0) throw new Error(`${title}: no MNT GeoTIFF in the archive`);
      await run(
        join(context.gdal.bin, 'gdalbuildvrt'),
        ['-q', `${vrt}.partial`, ...tifs],
        context.gdal.env,
      );
      await rename(`${vrt}.partial`, vrt);
      for (const part of parts) await rm(part, { force: true });
    }
    vrts.push(vrt);
  }
  return vrts;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    if ((await stat(path)).isDirectory()) out.push(...(await listFiles(path)));
    else out.push(path);
  }
  return out;
}

function windowLonLatBox(window: PixelWindow): [number, number, number, number] {
  const n = TERRAIN_TILE_SIZE * 2 ** window.zoom;
  const lon = (px: number) => (px / n) * 360 - 180;
  const lat = (py: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / n))) * 180) / Math.PI;
  return [
    lon(window.x0),
    lat(window.y0 + window.height),
    lon(window.x0 + window.width),
    lat(window.y0),
  ];
}

/**
 * GSI's tiles over a window: every tile of the first template that has one,
 * pixel for pixel, into a mosaic on the templates' own web-mercator grid,
 * written as a raw raster with its CRS (web mercator + JGD2011 heights), then
 * warped like any other source — PROJ does the datum, GDAL the resampling.
 */
async function gsiWindow(
  set: TerrainSetDefinition,
  templates: readonly { url: string; zoom: number }[],
  window: PixelWindow,
  context: InputContext,
): Promise<Float32Array> {
  const GSI = 256;
  const zoom = Math.max(...templates.map((t) => t.zoom));
  // The window on the finest template's grid (256 px tiles).
  const scale = (GSI * 2 ** zoom) / (TERRAIN_TILE_SIZE * 2 ** window.zoom);
  const gx0 = Math.floor(window.x0 * scale) - 2;
  const gy0 = Math.floor(window.y0 * scale) - 2;
  const gx1 = Math.ceil((window.x0 + window.width) * scale) + 2;
  const gy1 = Math.ceil((window.y0 + window.height) * scale) + 2;
  const mw = gx1 - gx0;
  const mh = gy1 - gy0;
  const mosaic = new Float32Array(mw * mh).fill(Number.NaN);
  const tiles: [number, number][] = [];
  for (let ty = Math.floor(gy0 / GSI); ty <= Math.floor((gy1 - 1) / GSI); ty++) {
    for (let tx = Math.floor(gx0 / GSI); tx <= Math.floor((gx1 - 1) / GSI); tx++)
      tiles.push([tx, ty]);
  }
  let next = 0;
  let found = 0;
  const worker = async () => {
    while (next < tiles.length) {
      const [tx, ty] = tiles[next++];
      for (const template of templates) {
        // A coarser template's tile covering this one, up-sampled by nearest
        // into the finest grid (GDAL's bilinear then smooths it like any source).
        const k = 2 ** (zoom - template.zoom);
        const ptx = Math.floor(tx / k);
        const pty = Math.floor(ty / k);
        const url = template.url
          .replace('{z}', String(template.zoom))
          .replace('{x}', String(ptx))
          .replace('{y}', String(pty));
        const response = await fetchRetried(url);
        if (!response) continue;
        const png = decodePngRgb(new Uint8Array(await response.arrayBuffer()));
        const heights = decodeGsiHeights(png.rgb);
        let any = false;
        for (let y = 0; y < GSI; y++) {
          const my = ty * GSI + y - gy0;
          if (my < 0 || my >= mh) continue;
          const sy = Math.floor(((ty - pty * k) * GSI + y) / k);
          for (let x = 0; x < GSI; x++) {
            const mx = tx * GSI + x - gx0;
            if (mx < 0 || mx >= mw) continue;
            const i = my * mw + mx;
            if (!Number.isNaN(mosaic[i])) continue;
            const sx = Math.floor(((tx - ptx * k) * GSI + x) / k);
            const h = heights[sy * GSI + sx];
            if (!Number.isNaN(h)) {
              mosaic[i] = h;
              any = true;
            }
          }
        }
        if (any) found++;
        // The finer template covers what it has; a coarser one only fills what is left.
        let missing = false;
        for (let y = 0; y < GSI && !missing; y++) {
          const my = ty * GSI + y - gy0;
          if (my < 0 || my >= mh) continue;
          for (let x = 0; x < GSI; x++) {
            const mx = tx * GSI + x - gx0;
            if (mx >= 0 && mx < mw && Number.isNaN(mosaic[my * mw + mx])) {
              missing = true;
              break;
            }
          }
        }
        if (!missing) break;
      }
    }
  };
  await Promise.all(Array.from({ length: 8 }, worker));
  if (found === 0) return new Float32Array(window.width * window.height).fill(Number.NaN);

  const dir = join(context.gdal.scratch ?? context.cache, `gsi-${process.pid}-${gx0}-${gy0}`);
  await mkdir(dir, { recursive: true });
  try {
    const raw = join(dir, 'mosaic.bin');
    await writeFile(raw, new Uint8Array(mosaic.buffer));
    const res = (2 * 20037508.342789244) / (GSI * 2 ** zoom);
    const originX = -20037508.342789244 + gx0 * res;
    const originY = 20037508.342789244 - gy0 * res;
    const vrt = join(dir, 'mosaic.vrt');
    await writeFile(
      vrt,
      `<VRTDataset rasterXSize="${mw}" rasterYSize="${mh}">
  <SRS>EPSG:3857</SRS>
  <GeoTransform>${originX}, ${res}, 0, ${originY}, 0, ${-res}</GeoTransform>
  <VRTRasterBand dataType="Float32" band="1" subClass="VRTRawRasterBand">
    <NoDataValue>nan</NoDataValue>
    <SourceFilename relativeToVRT="1">mosaic.bin</SourceFilename>
    <ImageOffset>0</ImageOffset>
    <PixelOffset>4</PixelOffset>
    <LineOffset>${mw * 4}</LineOffset>
    <ByteOrder>LSB</ByteOrder>
  </VRTRasterBand>
</VRTDataset>
`,
    );
    return await warpToWindow(
      {
        datasets: [vrt],
        crs: set.crs,
        resampling: resamplingFor(set, window),
        transform: set.transform,
      },
      window,
      context.gdal,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

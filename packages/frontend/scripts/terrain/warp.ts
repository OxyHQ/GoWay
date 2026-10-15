/**
 * Sources warped by GDAL onto a pixel window, read back as one array.
 *
 * Heights: `gdalwarp` to EPSG:3857 with EGM2008 heights (EPSG:3855), the
 * window's exact pixel edges, float32, `NaN` where the source has none. PROJ
 * converts every source's heights to EGM2008 from its compound CRS
 * (horizontal + its vertical datum, `catalogue.ts`) through the geoid grids
 * of `proj-data` (pinned in `scripts/terrain/environment.yml`): one datum for
 * every source, so two sources meet without a step
 * (`docs/MAP_TERRAIN_GLOBE.md` → "The archive" → One datum).
 *
 * Classes (the canopy signal, ESA WorldCover): nearest, bytes, 0 where none.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type PixelWindow, windowMercator } from './grid';

/** The target CRS of heights: web mercator, heights above EGM2008. */
export const TARGET_CRS = 'EPSG:3857+3855';

export interface WarpInput {
  /** GDAL dataset names (`/vsicurl/…`, a VRT, local files), mosaicked in order (later on top). */
  datasets: readonly string[];
  /** Their compound CRS, horizontal + vertical (`EPSG:25831+5782`), overriding what the files say. */
  crs: string;
  /** `average` when the source is finer than the window, `bilinear` when coarser. */
  resampling: 'average' | 'bilinear';
  /** A PROJ pipeline overriding PROJ's own choice of transformation (`catalogue.ts` → `transform`). */
  transform?: string;
}

export interface GdalRun {
  /** Directory of `gdalwarp` (the pinned environment's `bin`). */
  bin: string;
  /** Environment for GDAL/PROJ (HTTP retries, `PROJ_DATA`). */
  env: Record<string, string>;
  /** Scratch directory (a z14 window of a z10 tile is 290 MB of float32). */
  scratch?: string;
}

function run(command: string, args: string[], env: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, ...env } });
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve(stderr)
        : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`)),
    );
  });
}

/** The heights the Earth has (m), with room: the Mariana Trench to Everest. */
export const PLAUSIBLE_HEIGHT_M: readonly [number, number] = [-12_000, 9_000];

/**
 * A VRT document (`gdalbuildvrt`'s) rewritten so its pixels are valid only
 * where their height is one the Earth has: a mask band computed from the same
 * pixels (`data`, the original VRT), and no `NoDataValue` (the mask covers the
 * source's own no-data, which is far outside). Measured why: USGS's 3DEP
 * seamless tiles carry their own fill (−999 999) RESAMPLED into the pixels at
 * the edge of the data — −558,309 m off Rockaway — which no single no-data
 * value catches, and an average would smear into the shore.
 */
export function withPlausibilityMask(xml: string, data: string): string {
  if (!xml.includes('</VRTDataset>')) throw new Error('not a VRT document');
  const [low, high] = PLAUSIBLE_HEIGHT_M;
  // muparser, in an XML attribute.
  const expression = `((B1 &gt;= ${low}) &amp;&amp; (B1 &lt;= ${high})) ? 255 : 0`;
  const mask = `  <MaskBand>
    <VRTRasterBand dataType="Byte" subClass="VRTDerivedRasterBand">
      <PixelFunctionType>expression</PixelFunctionType>
      <PixelFunctionArguments expression="${expression}" dialect="muparser" />
      <SourceTransferType>Float32</SourceTransferType>
      <SimpleSource>
        <SourceFilename relativeToVRT="0">${data}</SourceFilename>
        <SourceBand>1</SourceBand>
      </SimpleSource>
    </VRTRasterBand>
  </MaskBand>
</VRTDataset>`;
  return xml.replace(/\s*<NoDataValue>[^<]*<\/NoDataValue>/g, '').replace('</VRTDataset>', mask);
}

async function warp(
  args: string[],
  datasets: readonly string[],
  window: PixelWindow,
  gdal: GdalRun,
  heights: boolean,
): Promise<{ bytes: Uint8Array }> {
  const dir = await mkdtemp(join(gdal.scratch ?? tmpdir(), 'warp-'));
  try {
    const out = join(dir, 'window.tif');
    const [minX, minY, maxX, maxY] = windowMercator(window);
    // The inputs mosaicked into ONE source (later on top), so the warp
    // resamples one raster under one mask; for heights, that mask also drops
    // every value no terrain has (`withPlausibilityMask`).
    let sources = datasets;
    if (datasets.length > 1 || heights) {
      const mosaic = join(dir, 'mosaic.vrt');
      await run(join(gdal.bin, 'gdalbuildvrt'), ['-q', mosaic, ...datasets], gdal.env);
      sources = [mosaic];
      if (heights) {
        const masked = join(dir, 'masked.vrt');
        await writeFile(masked, withPlausibilityMask(await readFile(mosaic, 'utf8'), mosaic));
        sources = [masked];
      }
    }
    await run(
      join(gdal.bin, 'gdalwarp'),
      [
        '-q',
        '-overwrite',
        ...args,
        '-te',
        String(minX),
        String(minY),
        String(maxX),
        String(maxY),
        '-ts',
        String(window.width),
        String(window.height),
        // Full resolution: a COG's overviews were made by its producer's
        // resampling (ICGC's are cubic), not this window's.
        '-ovr',
        'NONE',
        '-wo',
        'NUM_THREADS=ALL_CPUS',
        '-multi',
        // A plain uncompressed TIFF, read back by `readTiff` (GDAL's raw
        // drivers, ENVI and EHdr, fail on a compound target CRS).
        '-of',
        'GTiff',
        '-co',
        'COMPRESS=NONE',
        '-co',
        'BIGTIFF=NO',
        '-co',
        'TILED=NO',
        ...sources,
        out,
      ],
      gdal.env,
    );
    return { bytes: await readFile(out) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Warp a height source onto a window; `NaN` where it has no data. */
export async function warpToWindow(
  input: WarpInput,
  window: PixelWindow,
  gdal: GdalRun,
): Promise<Float32Array> {
  const { bytes } = await warp(
    [
      '-s_srs',
      input.crs,
      '-t_srs',
      TARGET_CRS,
      ...(input.transform ? ['-ct', input.transform] : []),
      '-r',
      input.resampling,
      '-ot',
      'Float32',
      '-dstnodata',
      'nan',
    ],
    input.datasets,
    window,
    gdal,
    true,
  );
  const data = readTiff(bytes, 'float32');
  if (data.length !== window.width * window.height) {
    throw new Error(
      `gdalwarp wrote ${data.length} pixels for a ${window.width}×${window.height} window`,
    );
  }
  return data as Float32Array;
}

/** Warp a class raster (bytes) onto a window, nearest; 0 where none. */
export async function warpClassesToWindow(
  datasets: readonly string[],
  window: PixelWindow,
  gdal: GdalRun,
): Promise<Uint8Array> {
  const { bytes } = await warp(
    ['-t_srs', 'EPSG:3857', '-r', 'near', '-ot', 'Byte', '-dstnodata', '0'],
    datasets,
    window,
    gdal,
    false,
  );
  const data = readTiff(bytes, 'uint8');
  if (data.length !== window.width * window.height) {
    throw new Error(
      `gdalwarp wrote ${data.length} pixels for a ${window.width}×${window.height} window`,
    );
  }
  return data as Uint8Array;
}

/**
 * The pixels of an uncompressed, stripped, single-band classic TIFF of
 * float32 or uint8 (what `warp` asks GDAL for), row-major. Anything else is
 * an error.
 */
export function readTiff(bytes: Uint8Array, kind: 'float32' | 'uint8'): Float32Array | Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Typed arrays are the machine's byte order: little-endian on every host the build runs on.
  if (bytes[0] !== 0x49) throw new Error('a big-endian TIFF');
  if (view.getUint16(2, true) !== 42) throw new Error('not a classic TIFF');
  const ifd = view.getUint32(4, true);
  const count = view.getUint16(ifd, true);
  // Only the layout tags, all SHORT or LONG; GeoTIFF's doubles and GDAL's text are skipped.
  const wanted = new Set([256, 257, 258, 259, 273, 277, 279, 339]);
  const tags = new Map<number, number[]>();
  for (let k = 0; k < count; k++) {
    const entry = ifd + 2 + k * 12;
    const tag = view.getUint16(entry, true);
    if (!wanted.has(tag)) continue;
    const type = view.getUint16(entry + 2, true);
    if (type !== 3 && type !== 4) throw new Error(`TIFF tag ${tag} has type ${type}`);
    const n = view.getUint32(entry + 4, true);
    const size = type === 3 ? 2 : 4;
    const at = n * size <= 4 ? entry + 8 : view.getUint32(entry + 8, true);
    const values: number[] = [];
    for (let i = 0; i < n; i++) {
      values.push(type === 3 ? view.getUint16(at + i * 2, true) : view.getUint32(at + i * 4, true));
    }
    tags.set(tag, values);
  }
  const width = tags.get(256)?.[0] ?? 0;
  const height = tags.get(257)?.[0] ?? 0;
  const bits = tags.get(258)?.[0];
  const format = tags.get(339)?.[0] ?? 1;
  if (kind === 'float32' && (bits !== 32 || format !== 3)) throw new Error('not float32');
  if (kind === 'uint8' && (bits !== 8 || format !== 1)) throw new Error('not uint8');
  if ((tags.get(259)?.[0] ?? 1) !== 1) throw new Error('compressed');
  if ((tags.get(277)?.[0] ?? 1) !== 1) throw new Error('more than one band');
  const offsets = tags.get(273) ?? [];
  const lengths = tags.get(279) ?? [];
  const out =
    kind === 'float32' ? new Float32Array(width * height) : new Uint8Array(width * height);
  const raw = new Uint8Array(out.buffer);
  let at = 0;
  for (let s = 0; s < offsets.length; s++) {
    raw.set(bytes.subarray(offsets[s], offsets[s] + lengths[s]), at);
    at += lengths[s];
  }
  if (at !== raw.byteLength) throw new Error(`strips hold ${at} bytes, not ${raw.byteLength}`);
  return out;
}

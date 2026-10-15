/**
 * THE TERRAIN CONTAMINATION GATE, as a tool (`docs/MAP_TERRAIN_GLOBE.md` →
 * "The archive" → Contamination): does a ground model rise under the
 * buildings the map draws on it, or under the trees around them?
 *
 * ```bash
 * bun run --cwd packages/frontend check:terrain-ground --area=<lon,lat,halfM | w,s,e,n> \
 *   --dem=served[=<{z}/{x}/{y} template>] | set:<catalogue id> | tiles:<dir of z/x/y.webp> \
 *        | gdal:<dataset>|<compound CRS>|<pixel m> \
 *   [--canopy] [--zoom=14] [--city=https://goway.to] [--gdal=<bin>] [--cache=<dir>] \
 *   [--json=<out.json>] [--worst=10]
 * ```
 *
 * `served` is what the map draws today (`/map/terrain/*` on goway.to:
 * Mapterhorn), `set:` a catalogue source read exactly as the build reads it,
 * `tiles:` a build's own output. Each is put on the same z14 analysis grid
 * (served tiles bilinear between pixel centres, as MapLibre draws them),
 * judged against GoWay's city-tile footprints (and, with `--canopy`, ESA
 * WorldCover's tree stands), and summarised: how many stand above the open
 * ground around them by 2, 5 and 10 m, and the worst, with coordinates.
 */
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { LonLatBox } from './imagery/cells';
import { MAX_STAND_M, worldCoverTiles } from './terrain/canopy';
import { catalogueSet, TERRAIN_ANALYSIS_ZOOM } from './terrain/catalogue';
import { footprintsInWindow } from './terrain/footprints';
import {
  type GateFootprint,
  type GateResult,
  gateWindow,
  labelWindow,
  ringBand,
} from './terrain/gate';
import { type PixelWindow, pixelMercatorM, TERRAIN_TILE_SIZE, windowOfBox } from './terrain/grid';
import { readSetWindow, USER_AGENT, windowGroundPixelM } from './terrain/inputs';
import { sampleServed, templateFetcher, type TileFetcher } from './terrain/served';
import { type GdalRun, warpClassesToWindow, warpToWindow } from './terrain/warp';

const DEFAULT_SERVED = 'https://goway.to/map/terrain/{z}/{x}/{y}.webp';

export function parseArea(value: string): LonLatBox {
  const parts = value.split(',').map(Number);
  if (parts.some((v) => !Number.isFinite(v))) throw new Error(`--area=${value}: not numbers`);
  if (parts.length === 4) return parts as LonLatBox;
  if (parts.length !== 3) throw new Error('--area is lon,lat,halfMetres or w,s,e,n');
  const [lon, lat, half] = parts;
  const dLat = half / 111_320;
  const dLon = half / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/** The environment GDAL and PROJ run with: the pinned build's own data, retries, no sidecar probes. */
export function gdalRun(bin: string, scratch?: string): GdalRun {
  return {
    bin,
    scratch,
    env: {
      PROJ_DATA: join(bin, '..', 'share', 'proj'),
      PROJ_NETWORK: 'OFF',
      GDAL_HTTP_MAX_RETRY: '20',
      GDAL_HTTP_RETRY_DELAY: '2',
      GDAL_HTTP_USERAGENT: USER_AGENT,
      GDAL_DISABLE_READDIR_ON_OPEN: 'EMPTY_DIR',
      GDAL_PAM_ENABLED: 'NO',
      CPL_VSIL_CURL_ALLOWED_EXTENSIONS: '.tif,.TIF,.vrt,.gpkg',
      CPL_VSIL_CURL_CHUNK_SIZE: '1048576',
      CPL_VSIL_CURL_CACHE_SIZE: '1000000000',
    },
  };
}

/** WorldCover classes on a window (only its tiles that exist: open sea has none). */
export async function canopyClasses(window: PixelWindow, gdal: GdalRun): Promise<Uint8Array> {
  const present: string[] = [];
  for (const url of worldCoverTiles(window)) {
    const head = await fetch(url, { method: 'HEAD', headers: { 'User-Agent': USER_AGENT } });
    if (head.ok) present.push(`/vsicurl/${url}`);
  }
  if (present.length === 0) return new Uint8Array(window.width * window.height);
  return warpClassesToWindow(present, window, gdal);
}

/** A local directory of `z/x/y.webp` tiles as a fetcher. */
function directoryFetcher(dir: string): TileFetcher {
  return async (z, x, y) => {
    const path = join(dir, String(z), String(x), `${y}.webp`);
    return existsSync(path) ? new Uint8Array(await readFile(path)) : null;
  };
}

/** One ground model on a window, and the ground pixel size it was made from (m). */
export async function groundOf(
  dem: string,
  window: PixelWindow,
  gdal: GdalRun,
  cache: string,
): Promise<{ ground: Float32Array; sourcePixelM: number }> {
  const groundPixel = windowGroundPixelM(window);
  const servedPixelM = (groundPixel / pixelMercatorM(window.zoom)) * pixelMercatorM(12);
  if (dem === 'served' || dem.startsWith('served=')) {
    const template = dem.includes('=') ? dem.slice(dem.indexOf('=') + 1) : DEFAULT_SERVED;
    return {
      ground: await sampleServed(templateFetcher(template, USER_AGENT), 12, window),
      sourcePixelM: servedPixelM,
    };
  }
  if (dem.startsWith('tiles:')) {
    return {
      ground: await sampleServed(directoryFetcher(dem.slice(6)), 12, window),
      sourcePixelM: servedPixelM,
    };
  }
  if (dem.startsWith('set:')) {
    const set = catalogueSet(dem.slice(4));
    return { ground: await readSetWindow(set, window, { gdal, cache }), sourcePixelM: set.pixelM };
  }
  if (dem.startsWith('gdal:')) {
    // A candidate not in the catalogue, for evaluation: `gdal:<dataset>|<compound CRS>|<pixel m>`.
    const [dataset, crs, pixel] = dem.slice(5).split('|');
    const sourcePixelM = Number(pixel);
    if (!dataset || !crs || !(sourcePixelM > 0))
      throw new Error(`--dem=${dem}: gdal:<dataset>|<crs>|<pixel m>`);
    const resampling = sourcePixelM < groundPixel ? 'average' : 'bilinear';
    return {
      ground: await warpToWindow({ datasets: [dataset], crs, resampling }, window, gdal),
      sourcePixelM,
    };
  }
  throw new Error(
    `--dem=${dem}: served[=template] | set:<id> | tiles:<dir> | gdal:<dataset>|<crs>|<pixel m>`,
  );
}

function lonLatOf(window: PixelWindow, index: number): [number, number] {
  const n = TERRAIN_TILE_SIZE * 2 ** window.zoom;
  const x = (window.x0 + (index % window.width) + 0.5) / n;
  const y = (window.y0 + Math.floor(index / window.width) + 0.5) / n;
  return [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
}

export interface GateReport {
  dem: string;
  area: LonLatBox;
  window: string;
  noDataShare: number;
  ring: { fromPx: number; toPx: number };
  buildings: KindReport;
  stands: KindReport | null;
}

interface KindReport {
  judged: number;
  unjudged: number;
  areaM2: number;
  over: { thresholdM: number; count: number; share: number; areaShare: number }[];
  worst: {
    edgeAboveM: number;
    p90AboveM: number;
    maxAboveM: number;
    areaM2: number;
    lat: number;
    lon: number;
  }[];
}

function kindReport(
  summary: GateResult['buildings'],
  window: PixelWindow,
  worst: number,
): KindReport {
  const judged = summary.judged.length;
  const top = [...summary.judged]
    .sort((a: GateFootprint, b: GateFootprint) => b.p90AboveM - a.p90AboveM)
    .slice(0, worst);
  return {
    judged,
    unjudged: summary.unjudged,
    areaM2: Math.round(summary.areaM2),
    over: summary.over.map((o) => ({
      thresholdM: o.thresholdM,
      count: o.count,
      share: judged ? +(o.count / judged).toFixed(5) : 0,
      areaShare: summary.areaM2 ? +(o.areaM2 / summary.areaM2).toFixed(5) : 0,
    })),
    worst: top.map((f) => {
      const [lon, lat] = lonLatOf(window, f.at);
      return {
        edgeAboveM: +f.edgeAboveM.toFixed(2),
        p90AboveM: +f.p90AboveM.toFixed(2),
        maxAboveM: +f.maxAboveM.toFixed(2),
        areaM2: Math.round(f.areaM2),
        lat: +lat.toFixed(6),
        lon: +lon.toFixed(6),
      };
    }),
  };
}

/** Run the gate over one area. */
export async function gateArea(options: {
  area: LonLatBox;
  dem: string;
  canopy: boolean;
  city: string;
  gdal: GdalRun;
  cache: string;
  zoom?: number;
  worst?: number;
}): Promise<GateReport> {
  const window = windowOfBox(options.area, options.zoom ?? TERRAIN_ANALYSIS_ZOOM);
  const [{ ground, sourcePixelM }, footprints, classes] = await Promise.all([
    groundOf(options.dem, window, options.gdal, options.cache),
    footprintsInWindow(options.city, window, USER_AGENT),
    options.canopy ? canopyClasses(window, options.gdal) : Promise.resolve(null),
  ]);
  const pixelM = windowGroundPixelM(window);
  const labels = labelWindow(window, footprints.polygons, classes, pixelM);
  const band = ringBand(pixelM, sourcePixelM);
  const gate = gateWindow(ground, window, labels, band);
  let noData = 0;
  for (const v of ground) if (Number.isNaN(v)) noData++;
  return {
    dem: options.dem,
    area: options.area,
    window: `${window.width}×${window.height} px at z${window.zoom} (${pixelM.toFixed(2)} m)`,
    noDataShare: +(noData / ground.length).toFixed(4),
    ring: { fromPx: band.fromPx, toPx: band.toPx },
    buildings: kindReport(gate.buildings, window, options.worst ?? 10),
    stands: options.canopy ? kindReport(gate.stands, window, options.worst ?? 10) : null,
  };
}

function line(name: string, kind: KindReport): string {
  const over = kind.over
    .map(
      (o) =>
        `>${o.thresholdM} m ${o.count} (${(o.share * 100).toFixed(2)}%, area ${(o.areaShare * 100).toFixed(2)}%)`,
    )
    .join(' · ');
  return `${name}: ${kind.judged} judged (${kind.unjudged} walled in) · ${over}`;
}

async function main(argv: string[]) {
  const value = (name: string) =>
    argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const area = value('area');
  const dem = value('dem');
  if (!area || !dem)
    throw new Error('usage: --area=<lon,lat,halfM | w,s,e,n> --dem=<served|set:id|tiles:dir>');
  const gdalBin = value('gdal') ?? '';
  const report = await gateArea({
    area: parseArea(area),
    dem,
    canopy: argv.includes('--canopy'),
    city: value('city') ?? 'https://goway.to',
    gdal: gdalRun(gdalBin, value('scratch')),
    cache: value('cache') ?? join(process.cwd(), '.terrain-cache'),
    zoom: value('zoom') ? Number(value('zoom')) : undefined,
    worst: value('worst') ? Number(value('worst')) : undefined,
  });
  console.log(
    `${report.dem} over ${report.area.map((v) => v.toFixed(4)).join(',')}: ${report.window}, no data ${(report.noDataShare * 100).toFixed(1)}%, ring ${report.ring.fromPx}–${report.ring.toPx} px`,
  );
  console.log(line('buildings', report.buildings));
  for (const w of report.buildings.worst) {
    console.log(
      `  +${w.p90AboveM} m (edge ${w.edgeAboveM}, max ${w.maxAboveM}) over ${w.areaM2} m² at ${w.lat},${w.lon}`,
    );
  }
  if (report.stands) {
    console.log(line(`tree stands (≤ ${MAX_STAND_M} m)`, report.stands));
    for (const w of report.stands.worst.slice(0, 5)) {
      console.log(
        `  +${w.p90AboveM} m (edge ${w.edgeAboveM}, max ${w.maxAboveM}) over ${w.areaM2} m² at ${w.lat},${w.lon}`,
      );
    }
  }
  const json = value('json');
  if (json) await writeFile(json, `${JSON.stringify(report, null, 2)}\n`);
}

if (import.meta.main) {
  await main(process.argv.slice(2));
}

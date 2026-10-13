/**
 * THE 3D CITY'S VISIBILITY GATE (`docs/MAP_NATIVE_3D.md` → "The visibility
 * gate"): what the engine says it drew must be on the screen.
 *
 *   bun run --cwd packages/frontend export:web --dev --output-dir /tmp/city3d-gate
 *   bun run --cwd packages/frontend check:city3d-visible --dist=/tmp/city3d-gate
 *
 * Born of a regression the GPU-free gates could not see (main @432fd6a): on 3D
 * terrain, every mesh the TSL pass drew before its tile was grounded stood at
 * z = 0, under the terrain — no trees on Passeig de Gràcia, no buildings without
 * the city sky — while the engine counted every one of them as drawn.
 *
 * ## What it runs, and why it is deterministic
 *
 * The real app — an `expo export --dev` build (a development build: the engine
 * publishes what it drew) that the gate serves itself — in headless Chromium
 * on SwiftShader, with NOTHING from the network:
 *
 *  - **Road tiles** (`/map/city-roads/…`): the synthetic city's streets, for
 *    the street detail (`cityStreets`, on in every city view).
 *  - **City tiles** (`/map/city/…`): the synthetic city (`__tests__/fixtures/
 *    syntheticCity.ts`) with official LOD2 data on its central blocks — the
 *    owner's configuration (OSM city tiles + Catastro), made up and committed.
 *    Served by the gate's own server, not by a browser route: the tiles are
 *    fetched inside Web Workers (MapLibre's, the mesh workers), which
 *    Playwright's routes do not see.
 *  - **Terrain**: a synthetic Terrarium tile at a constant 50 m. MapLibre's
 *    terrain comes on with the tilt, so: open flat (tiles drawn with no
 *    terrain), tilt (terrain on, its elevation HELD, tiles drawn ungrounded),
 *    then release it once the city has settled and wait until MapLibre reads
 *    over 40 m under the camera. The order that broke main, forced on a runner
 *    of any speed (each step waits for the engine, not for a fixed time).
 *  - **Basemap**: the fixture's OpenMapTiles buildings; GoWay's committed
 *    glyphs and sprite (`public/map`). Every other request is refused.
 *  - **Quality**: the high preset (`?quality=high`). SwiftShader alone would
 *    resolve to low, which draws no 3D terrain: nothing would be grounded.
 *  - **Clock**: local noon (the sky's light, the crowns' green); the night
 *    view at half past midnight.
 *  - **Camera**: opened flat at z19 over the city, then tilted to 60° in six
 *    eased 10° steps to ABSOLUTE pitches, each waited out: the keyboard's
 *    relative steps land short when frames are slower than the ease.
 *  - **Moving things off** (simulated traffic, live data, landmarks, flyover):
 *    they differ between page loads. Street detail off: no road fixture.
 *
 * ## What it asserts, per sky (on and off)
 *
 *  - **Trees**: the engine drew trees, and the map's canopy-green share is at
 *    least 1% and 3× the same view with trees off.
 *  - **Buildings**: the engine drew buildings, and the share of the map darker
 *    than the noon basemap (walls, windows) is at least 2% and 4× the same view
 *    with the 3D city off.
 *  - **Streets**: the street detail drew the fixture's road tiles (`roadTile`),
 *    and over a junction turning it on changes at least 3% of the view.
 *  - **Streets on a sloped, creased ground** (the `nosky` leg): the same
 *    junction on a terrain with swells and metre-scale folds a few DEM pixels
 *    across ({@link creasedMetres}), served at every zoom from one surface as
 *    Mapterhorn's tiles are. Turning the street detail on must change at least
 *    {@link CREASED_MIN_SHARE} of what it changes on flat ground: where the
 *    drawn terrain rose through the street meshes (the Mallorca–Marina
 *    report), the street was hidden under it and changed nothing there.
 *  - **Models** (the `objects` leg, sky off): the Sagrada Família, a landmark
 *    of the registry, changes at least 1% of the map against landmarks off.
 *  - **City life** (the `objects` leg, sky off, low preset): its simulated
 *    traffic on the fixture's streets changes at least 0.05% of the view from
 *    z17.5 over a junction (measured 0.10–0.13%; not drawn, 0%).
 *  - **No speckle at night** (the `sky` leg, or `--skies=night` alone): the
 *    city sky at night over OSM city-tile walls, where under
 *    {@link NIGHT_MAX_SPECKLE_PCT}% of the map may be a pixel standing out
 *    from all four neighbours ({@link speckle}). Born of #188: the building
 *    flags reached the fragment interpolated, and the floodlight's
 *    `mod(flags, 2)` lit every wall on half its pixels.
 *  - **A pan holds still** (the `sky` leg: its sun shadows): dragged north in
 *    steps from straight above, each frame is the one before moved by the
 *    drag — under {@link PAN_MAX_CHANGED_PCT} of the map differs once
 *    aligned. Born of the shadow map read through a matrix it was not drawn
 *    with on every north–south pan (`shadows.ts` → `SHADOW_LATITUDE_STEP_DEG`):
 *    the shadows slid and snapped back, the ground lit and unlit wholesale.
 *
 * Without #152's re-grounding it fails (three runs of three; the no-sky trees
 * are buried every time). Measured numbers: the doc.
 */
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { extname, join, resolve } from 'node:path';
import { type Browser, chromium, type Page, type Route } from 'playwright-core';

import { CITY_COVERAGE_PATH } from '../lib/map/cityTiles';
import { BUILDINGS_3D_FADE } from '../lib/map/style/buildings3d';
import { centreFor, landmarkPosition, sweepThrough } from './cameraClearanceDrive';
import { type PublishedStats, type SettledWants, unsettled } from './city3dSettled';
import {
  cityTile,
  openMapTilesTile,
  roadTile,
  SYNTHETIC_CENTRE,
  syntheticCoverage,
} from '../components/map/__tests__/fixtures/syntheticCity';

function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const VIEWPORT = { width: 1280, height: 800 };
/** The map, clear of the side panel and the time scrubber. */
const CLIP = { x: 410, y: 70, width: 860, height: 580 };
/** How long the elevation is held back AFTER the tilted city has settled. */
const TERRAIN_DELAY_MS = Number(process.env.GATE_TERRAIN_DELAY_MS ?? 2000);
/** How long a view may take to settle, and a screenshot to get its frame. */
const SETTLE_TIMEOUT_MS = Number(process.env.GATE_SETTLE_TIMEOUT_MS ?? 240_000);
const TERRAIN_M = 50;
/** The camera's pitch once tilted, degrees. */
const TILT = 60;
const NOON = new Date('2026-06-21T12:00:00+02:00');
/** The night view's clock: the sun far below the horizon, the windows and floodlights on. */
const MIDNIGHT = new Date('2026-06-21T00:30:00+02:00');
/**
 * Moving things off, as stored choices: they differ between page loads. And
 * street detail, on by default since the 3D city is: the fixture has no road
 * archive (the gate refuses `/map/city-roads/`), and what is under test is
 * the buildings and trees, not the street surface over the ground.
 */
const STILL = {
  cityLife: false,
  live: false,
  landmarks: false,
  flyover: false,
  cityStreets: false,
};
/**
 * The two skies. A development build honours the registry's query flags
 * (`lib/map/mapFeatures.ts`), so the export needs no build variables.
 */
const SKIES = {
  sky: { flags: 'city3d=1&cityTiles=1&cityStreets=1&citysky=1', choices: STILL },
  nosky: {
    flags: 'city3d=1&cityTiles=1&cityStreets=1',
    choices: { ...STILL, citySky: false, detailedCity: false },
  },
} as const;
const PUBLIC_MAP = resolve(import.meta.dir, '../public/map');
/** `--debug`: log the page's errors, the refused requests, and stop after one view. */
const DEBUG = process.argv.includes('--debug');

// --- Synthetic terrain: one Terrarium PNG at TERRAIN_M ----------------------

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** A solid RGB PNG: Terrarium height = R·256 + G + B/256 − 32768. */
function terrariumTile(metres: number, size = 512): Uint8Array {
  const v = metres + 32768;
  const rgb = [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)];
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(rgb, y * (size * 3 + 1) + 1 + x * 3);
  }
  return png24(raw, size);
}

/** An RGB PNG from filtered scanlines (a 0 filter byte, then `size` RGB triples, per row). */
function png24(raw: Uint8Array, size: number): Uint8Array {
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}
const TERRAIN_PNG = terrariumTile(TERRAIN_M);

/**
 * The creased ground, metres at a mercator point: TERRAIN_M with 3 m swells
 * ~250 m across and 0.5 m folds ~120 m across (four to nine DEM pixels at
 * z12) — bare-earth-like relief whose creases a coarser copy of the surface
 * misses (`city3dStreetLattice.test.ts` uses the same folds).
 */
function creasedMetres(mx: number, my: number): number {
  const metresPerUnit = 40_075_016.7 * Math.cos((SYNTHETIC_CENTRE.lat * Math.PI) / 180);
  const m = (mx - (SYNTHETIC_CENTRE.lng + 180) / 360) * metresPerUnit;
  const n = my * metresPerUnit;
  return (
    TERRAIN_M +
    3 * Math.sin(m / 45) * Math.cos(n / 38) +
    0.5 * Math.sin(m / 22 + 1) * Math.sin(n / 18)
  );
}

/** A Terrarium PNG of {@link creasedMetres} for one DEM tile, its pixels at their centres. */
const creasedTiles = new Map<string, Uint8Array>();
function creasedTile(z: number, x: number, y: number, size = 512): Uint8Array {
  const key = `${z}/${x}/${y}`;
  const known = creasedTiles.get(key);
  if (known) return known;
  const raw = new Uint8Array(size * (size * 3 + 1));
  for (let j = 0; j < size; j++) {
    const my = (y + (j + 0.5) / size) / 2 ** z;
    for (let i = 0; i < size; i++) {
      const v =
        Math.round((creasedMetres((x + (i + 0.5) / size) / 2 ** z, my) + 32768) * 256) / 256;
      raw.set(
        [Math.floor(v / 256), Math.floor(v) % 256, Math.round((v % 1) * 256)],
        j * (size * 3 + 1) + 1 + i * 3,
      );
    }
  }
  const png = png24(raw, size);
  creasedTiles.set(key, png);
  return png;
}

/** How much of the flat ground's street change the creased ground must keep. */
const CREASED_MIN_SHARE = 0.85;

// --- The app: a dev server, or an `expo export --dev` output served here ----

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  // MapLibre's worker is a module: a module script of any other type is refused.
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.pbf': 'application/x-protobuf',
  '.wasm': 'application/wasm',
};

function serveDist(dir: string) {
  const root = resolve(dir);
  const file = (path: string) => {
    const full = join(root, decodeURIComponent(path));
    return full.startsWith(root) && existsSync(full) && statSync(full).isFile() ? full : null;
  };
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    websocket: { message() {} },
    fetch(request, server) {
      const { pathname } = new URL(request.url);
      // A development build's runtime opens these and reloads the page while
      // they fail: accept them and say nothing.
      if ((pathname === '/hot' || pathname === '/message') && server.upgrade(request)) {
        return undefined;
      }
      if (DEBUG)
        console.error(`[server] ${pathname.replace(/\/\d+\/\d+\/\d+\.pbf$/, '/{z}/{x}/{y}.pbf')}`);
      const fixture = fixtureResponse(pathname);
      if (fixture) return fixture;
      const hit = file(pathname) ?? file(`${pathname}.html`) ?? join(root, 'index.html');
      return new Response(Bun.file(hit), {
        headers: { 'content-type': TYPES[extname(hit)] ?? 'application/octet-stream' },
      });
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

// --- The network, replaced ---------------------------------------------------

const TILE = /\/(\d+)\/(\d+)\/(\d+)\.pbf$/;

function pbf(bytes: Uint8Array): Response {
  return bytes.length === 0
    ? new Response(null, { status: 204 })
    : new Response(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
        headers: { 'content-type': 'application/x-protobuf' },
      });
}

/** The fixture's own paths, answered by the gate's server (workers fetch them). */
function fixtureResponse(path: string): Response | null {
  if (path === CITY_COVERAGE_PATH) {
    return Response.json({ archives: [{ coverage: syntheticCoverage()[0] }] });
  }
  const tile = TILE.exec(path);
  if (path.startsWith('/map/city/') && tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    return pbf(cityTile(z, x, y, { official: true }));
  }
  if (path.startsWith('/map/city-roads/') && tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    return pbf(roadTile(z, x, y));
  }
  if (path.startsWith('/__gate/empty/')) return new Response(null, { status: 204 });
  if (path.startsWith('/__gate/omt/') && tile) {
    const [z, x, y] = tile.slice(1).map(Number);
    return pbf(openMapTilesTile(z, x, y));
  }
  return null;
}

/** What the page asks of anyone else (main-thread requests: style parts, terrain). */
async function answer(
  route: Route,
  origin: string,
  basemap: 'buildings' | 'empty',
  terrain: Promise<void>,
  relief: 'flat' | 'creased' = 'flat',
): Promise<void> {
  const url = new URL(route.request().url());
  const path = url.pathname;
  if (url.origin === origin) {
    await route.continue();
    return;
  }
  if (path.endsWith('/map/tiles.json')) {
    const tileJson = JSON.parse(readFileSync(join(PUBLIC_MAP, 'tiles.json'), 'utf8'));
    tileJson.tiles = [
      `${origin}/__gate/${basemap === 'buildings' ? 'omt' : 'empty'}/{z}/{x}/{y}.pbf`,
    ];
    await route.fulfill({ json: tileJson });
    return;
  }
  if (path.includes('/map/terrain/')) {
    await terrain;
    const at = /\/(\d+)\/(\d+)\/(\d+)\.\w+$/.exec(path);
    const body =
      relief === 'creased' && at
        ? creasedTile(Number(at[1]), Number(at[2]), Number(at[3]))
        : TERRAIN_PNG;
    await route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from(body) });
    return;
  }
  for (const prefix of ['/map/fonts/', '/map/sprites/']) {
    if (!path.startsWith(prefix)) continue;
    const local = join(PUBLIC_MAP, decodeURIComponent(path.slice('/map/'.length)));
    if (existsSync(local)) {
      await route.fulfill({ status: 200, body: readFileSync(local) });
      return;
    }
    await route.fulfill({ status: 404 });
    return;
  }
  // Nothing else may reach the network: the gate must mean the same everywhere.
  if (DEBUG) console.error(`refused ${url.href}`);
  await route.abort();
}

// --- One view -------------------------------------------------------------------

interface View {
  png: Buffer;
  /** Whether the view settled before the screenshot (a city view that did not is a failure). */
  settled: boolean;
  /** The expected landmark's model failed to load. */
  landmarkFailed: boolean;
  /** What `inspect` measured. */
  inspected?: Record<string, number>;
  trees: number;
  triangles: number;
  streetTriangles: number;
  /**
   * With `backdrops`: the view again with only the 3D city drawn, over a
   * black and then a white backdrop (every other layer hidden, no sky).
   */
  backdrops: [Buffer, Buffer] | null;
}

/** The few members of the development build's MapLibre map the gate uses. */
interface ReliefMap {
  getTerrain(): unknown;
  areTilesLoaded(): boolean;
  isMoving(): boolean;
  getCenter(): unknown;
  queryTerrainElevation(at: unknown): number | null;
  jumpTo(options: { pitch: number }): void;
  easeTo(options: { pitch: number; duration: number }): void;
  once(event: 'moveend', listener: () => void): void;
}

/** In the page (an init script defines it): the development build's map. */
declare function reliefMap(): ReliefMap | undefined;

/** Whether `test` (run in the page) came true within the settle timeout. */
async function until(page: Page, test: () => boolean): Promise<boolean> {
  const by = Date.now() + SETTLE_TIMEOUT_MS;
  while (Date.now() < by) {
    if (await page.evaluate(test)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

/**
 * What the engine says it drew, once the view is SETTLED (`city3dSettled.ts`:
 * the city's tiles, the street detail's when it is on, and the expected
 * landmark); `null` if that never happens, with why on stderr. A slow runner
 * (two cores of SwiftShader) settles in minutes, not seconds.
 */
async function settled(
  page: Page,
  wants: SettledWants,
  name: string,
): Promise<{ trees: number; triangles: number; streetTriangles: number } | null> {
  const by = Date.now() + SETTLE_TIMEOUT_MS;
  let why: string | null = 'never read';
  while (Date.now() < by) {
    const published = await page.evaluate(() => {
      const scope = globalThis as {
        __gowayCity3d?: PublishedStats['city'] & { trees: number; triangles: number };
        __gowayCityStreets?: PublishedStats['streets'] & { triangles: number };
        __gowayLandmarks?: PublishedStats['landmarks'];
      };
      return {
        city: scope.__gowayCity3d,
        streets: scope.__gowayCityStreets,
        landmarks: scope.__gowayLandmarks,
      };
    });
    why = unsettled(published, wants);
    if (why === null && published.city) {
      return {
        trees: published.city.trees,
        triangles: published.city.triangles,
        streetTriangles: published.streets?.triangles ?? 0,
      };
    }
    await page.waitForTimeout(500);
  }
  console.error(`${name}: not settled after ${SETTLE_TIMEOUT_MS / 1000}s: ${why}`);
  return null;
}

async function view(
  browser: Browser,
  origin: string,
  flags: string,
  choices: Record<string, boolean>,
  outDir: string,
  name: string,
  /** `empty`: no basemap buildings either — the reference for a map with no 3D at all. */
  basemap: 'buildings' | 'empty' = 'buildings',
  /** Where the camera opens: the synthetic city's centre at z19 by default. */
  at: { lat: number; lng: number; zoom: number } = { ...SYNTHETIC_CENTRE, zoom: 19 },
  /** The quality preset (`lib/map/quality/profile.ts`); see `query` below. */
  quality: 'low' | 'high' = 'high',
  /** A landmark the view must have drawn (or failed) before it is settled. */
  landmark: string | null = null,
  /**
   * `ease`: tilt in six eased steps, as a person does (the buildings' and
   * trees' grounding order is the subject). `jump`: one jump to the tilt —
   * for the views whose subject is a model or the traffic: every eased frame
   * is a full 3D-terrain frame, and on two software-GL cores those queued
   * frames took the GPU 40–60 s to drain per view (measured).
   */
  tilt: 'ease' | 'jump' = 'ease',
  /** The page's clock: local noon, or the night view's midnight. */
  time: Date = NOON,
  /** The ground: flat at TERRAIN_M, or {@link creasedMetres}. */
  relief: 'flat' | 'creased' = 'flat',
  /** Something more to measure on the settled page, before it closes. */
  inspect?: (page: Page) => Promise<Record<string, number>>,
  /** Also shoot the city alone over black and white (see {@link View.backdrops}). */
  backdrops = false,
  /**
   * Once grounded, jump to this zoom and settle there (the city opens where
   * it is known to settle on software GL, then shows another zoom).
   */
  zoomTo: number | null = null,
): Promise<View> {
  const started = Date.now();
  // Per-view progress on stderr, so a CI log says WHICH view and WHICH step
  // a timeout was in (a screenshot that never came looked like any other).
  const step = async (what: string) => {
    console.error(`${name}: ${what} at ${Math.round((Date.now() - started) / 1000)}s`);
    // `GATE_DRAIN_EACH=1`: drain after every step too, to see where the
    // software rasteriser's time goes.
    if (process.env.GATE_DRAIN_EACH) {
      const t = Date.now();
      await drainGpu(page);
      console.error(`${name}:   drained ${Math.round((Date.now() - t) / 1000)}s`);
    }
  };
  const context = await browser.newContext({ viewport: VIEWPORT });
  let releaseTerrain = () => {};
  const terrain = new Promise<void>((done) => {
    releaseTerrain = done;
  });
  await context.route('**/*', (route) => answer(route, origin, basemap, terrain, relief));
  const page = await context.newPage();
  if (DEBUG) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning')
        console.error(`[page ${m.type()}] ${m.text().slice(0, 300)}`);
    });
    page.on('pageerror', (e) => console.error(`[pageerror] ${String(e).slice(0, 400)}`));
    page.on('requestfailed', (r) =>
      console.error(`[failed] ${r.url().slice(0, 160)} ${r.failure()?.errorText}`),
    );
    page.on('response', (r) => {
      if (!r.url().includes('/_expo/')) console.error(`[${r.status()}] ${r.url().slice(0, 160)}`);
    });
  }
  await page.clock.setFixedTime(time);
  // The map the relief layer attached to, published by a development build.
  await page.addInitScript(() => {
    const scope = globalThis as {
      reliefMap?: () => ReliefMap | undefined;
      __gowayReliefMap?: ReliefMap & { setPixelRatio?: (ratio: number) => void };
    };
    scope.reliefMap = () => scope.__gowayReliefMap;
    // The pixel ratio pinned: dynamic resolution would change it with the
    // runner's frame times, and with it the pixels the shares are counted on.
    const pin = setInterval(() => {
      const map = scope.__gowayReliefMap;
      if (!map) return;
      map.setPixelRatio = () => {};
      clearInterval(pin);
    }, 20);
  });
  await page.addInitScript(
    (stored) =>
      localStorage.setItem(
        'goway.mapFeatures',
        JSON.stringify({ v: 1, choices: stored, labs: true }),
      ),
    choices,
  );
  const { lat, lng, zoom } = at;
  // `quality=high`: SwiftShader resolves to the low preset, which draws no 3D
  // terrain — and then nothing is ever grounded and the gate tests nothing. A
  // real desktop GPU (the owner's) is high.
  const query = `lat=${lat}&lng=${lng}&zoom=${zoom}&quality=${quality}${flags ? `&${flags}` : ''}`;
  await page.goto(`${origin}/?${query}`, {
    waitUntil: 'load',
    timeout: 180_000,
  });
  // Flat first, as a person opens the map, while the terrain is held back:
  // the city tiles arrive and are drawn.
  const city = choices.city3d !== false;
  if (!(await until(page, () => reliefMap() !== undefined))) {
    throw new Error(`${name}: the map never came up`);
  }
  await step('map up');
  const wants: SettledWants = { streets: city && flags.includes('cityStreets=1'), landmark };
  if (city) await settled(page, wants, `${name} (flat)`);
  else await page.waitForTimeout(3000);
  await step('flat settled');
  // Then tilted: MapLibre's 3D terrain comes on with the tilt
  // (`lib/map/style/relief.ts` → `terrainWanted`), and its elevation is still
  // held back, so the tilted view's tiles are drawn ungrounded too. Eased
  // steps as a person tilts, but to ABSOLUTE pitches and each waited out: the
  // keyboard's relative steps land short when frames are slower than the
  // ease, and the camera would depend on the runner.
  for (let pitch = tilt === 'jump' ? TILT : 10; pitch <= TILT; pitch += 10) {
    await page.evaluate(
      ({ to, jump }) =>
        new Promise<void>((done) => {
          const map = reliefMap();
          if (!map) return done();
          map.once('moveend', () => done());
          map.easeTo({ pitch: to, duration: jump ? 0 : 300 });
        }),
      { to: pitch, jump: tilt === 'jump' },
    );
  }
  if (city) await settled(page, wants, `${name} (tilted)`);
  await step('tilted settled');
  if (!(await until(page, () => Boolean(reliefMap()?.getTerrain())))) {
    throw new Error(`${name}: 3D terrain never came on: the gate would test nothing`);
  }
  // Only now does the elevation come: every tile was drawn before it could be
  // grounded, the order that broke main, on a runner of any speed.
  await page.waitForTimeout(TERRAIN_DELAY_MS);
  releaseTerrain();
  // The elevation is under the city: MapLibre's terrain reads the released
  // tile (over 40 of its 50 m), so a run on a flat map cannot pass.
  const lifted = await until(page, () => {
    const map = reliefMap();
    const at = map?.queryTerrainElevation(map.getCenter()) ?? 0;
    return Boolean(map?.areTilesLoaded() && !map.isMoving() && at > 40);
  });
  if (!lifted)
    throw new Error(`${name}: the terrain never lifted the map: the gate would test nothing`);
  await step('terrain lifted');
  if (zoomTo !== null) {
    await page.evaluate(
      (zoom) =>
        new Promise<void>((done) => {
          const map = reliefMap();
          if (!map) return done();
          map.once('moveend', () => done());
          (map as unknown as { jumpTo(options: { zoom: number }): void }).jumpTo({ zoom });
        }),
      zoomTo,
    );
    await step(`at z${zoomTo}`);
  }
  const stats = city ? await settled(page, wants, name) : null;
  const landmarkFailed =
    landmark !== null &&
    (await page.evaluate(
      (id) =>
        (
          globalThis as { __gowayLandmarks?: { failed: string[] } }
        ).__gowayLandmarks?.failed.includes(id) ?? false,
      landmark,
    ));
  const settledS = Math.round((Date.now() - started) / 1000);
  // Fades, and the terrain's own refinement.
  await page.waitForTimeout(6000);
  // A development build shows the perf HUD over the map; it is an overlay, not
  // the map, and would count as dark pixels.
  await page.addStyleTag({ content: '[data-goway-perf-hud] { display: none !important; }' });
  if (DEBUG) {
    await page.screenshot({ path: join(outDir, `${name}-full.png`) });
    const probe = await page.evaluate(async () => ({
      canvases: document.querySelectorAll('.maplibregl-canvas').length,
      tile: await fetch('/__gate/omt/14/8290/6119.pbf').then((r) => r.status),
      city3d: Boolean((globalThis as { __gowayCity3d?: unknown }).__gowayCity3d),
      ground: (globalThis as { __gowayCity3dGround?: unknown }).__gowayCity3dGround ?? null,
      resources: performance
        .getEntriesByType('resource')
        .map((e) => e.name.replace(location.origin, ''))
        .filter((n) => !n.includes('/_expo/static/css'))
        .slice(0, 40),
    }));
    console.error(`[probe] ${JSON.stringify(probe)}`);
  }
  await step(`settled; ${await framesNow(page)}`);
  await drainGpu(page);
  await step('GPU drained');
  // A screenshot waits for a fresh frame, and on two software-GL cores a frame
  // with the sky's passes takes seconds.
  const png = await page.screenshot({
    clip: CLIP,
    path: join(outDir, `${name}.png`),
    timeout: SETTLE_TIMEOUT_MS,
  });
  const inspected = inspect ? await inspect(page) : undefined;
  const overBackdrops = backdrops
    ? ([
        await overBackdrop(page, '#000000', join(outDir, `${name}-over-black.png`)),
        await overBackdrop(page, '#ffffff', join(outDir, `${name}-over-white.png`)),
      ] as [Buffer, Buffer])
    : null;
  await context.close();
  // A view that never settled was measured mid-load: whatever it shows, the
  // gate cannot vouch for it, and a timeout is a finding, not a pass.
  if (city && stats === null) unsettledViews.push(name);
  console.error(
    `${name}: ${city ? (stats ? `settled at ${settledS}s` : 'NOT settled') : 'no city'}, shot at ${Math.round((Date.now() - started) / 1000)}s`,
  );
  return {
    png,
    settled: !city || stats !== null,
    landmarkFailed,
    backdrops: overBackdrops,
    trees: stats?.trees ?? 0,
    triangles: stats?.triangles ?? 0,
    streetTriangles: stats?.streetTriangles ?? 0,
    ...(inspected ? { inspected } : {}),
  };
}

/**
 * Wait until the GPU has done every frame already asked of it. A screenshot
 * waits for the compositor's NEXT frame, and on two software-GL cores that
 * comes only after the whole queue: every frame drawn while the view loaded
 * and the terrain lifted (one tile is re-grounded per frame, each a full 3D
 * terrain frame) — 1–4 minutes of rasterising that the screenshot's own
 * timeout then ran out on (#186). A 1-px read of the map's context returns
 * only once its queue is done; after it the screenshot takes a second.
 */
async function drainGpu(page: Page): Promise<void> {
  await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
    const gl = canvas?.getContext('webgl2');
    gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  });
}

/**
 * How the page is drawing right now, for the log: frames in 3 s (0: the page
 * is producing none, so a screenshot would wait), and the engine's own
 * numbers — what is still uploading, grounding or rendering.
 */
async function framesNow(page: Page): Promise<string> {
  const frames = await page
    .evaluate(
      () =>
        new Promise<number>((done) => {
          let n = 0;
          const end = performance.now() + 3000;
          const tick = () => {
            n++;
            if (performance.now() < end) requestAnimationFrame(tick);
            else done(n);
          };
          requestAnimationFrame(tick);
          setTimeout(() => done(n), 6000);
        }),
    )
    .catch(() => -1);
  const engine = await page.evaluate(() => {
    const scope = globalThis as {
      __gowayCity3d?: Record<string, unknown>;
      __gowayCity3dGround?: Record<string, unknown>;
    };
    const c = scope.__gowayCity3d;
    return c
      ? {
          frameCpuMs: Math.round(Number(c.frameCpuMs)),
          triangles: c.triangles,
          treeTriangles: c.treeTriangles,
          uploadsQueued: c.uploadsQueued,
          grounded: scope.__gowayCity3dGround?.tilesGrounded,
        }
      : null;
  });
  // How often the MAP renders: a map at rest renders nothing.
  const renders = await page
    .evaluate(
      () =>
        new Promise<number>((done) => {
          const map = (
            globalThis as {
              __gowayReliefMap?: {
                on: (e: string, f: () => void) => void;
                off: (e: string, f: () => void) => void;
              };
            }
          ).__gowayReliefMap;
          if (!map) return done(-1);
          let n = 0;
          const count = () => {
            n++;
          };
          map.on('render', count);
          setTimeout(() => {
            map.off('render', count);
            done(n);
          }, 3000);
        }),
    )
    .catch(() => -2);
  return `${frames} frames and ${renders} map renders in 3 s, engine ${JSON.stringify(engine)}`;
}

/** Share of `png`'s pixels that `test` accepts, in %. */
async function share(browser: Browser, png: Buffer, kind: 'canopy' | 'dark'): Promise<number> {
  const page = await browser.newPage();
  const value = await page.evaluate(
    async ([data, which]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const px = g.getImageData(0, 0, img.width, img.height).data;
      let n = 0;
      for (let i = 0; i < px.length; i += 4) {
        const [r, gr, b] = [px[i], px[i + 1], px[i + 2]];
        // Canopy: green over red and blue. Dark: below the noon basemap.
        if (which === 'canopy' ? gr > r + 12 && gr > b + 6 : Math.max(r, gr, b) < 170) n++;
      }
      return (100 * n) / (px.length / 4);
    },
    [png.toString('base64'), kind] as const,
  );
  await page.close();
  return Number(value.toFixed(2));
}

/**
 * Speckle, in % of the map: pixels brighter or darker than ALL four of their
 * neighbours by more than {@link SPECKLE_LEVELS} (luma, 0–255). A window, an
 * edge or a shadow is a run of pixels and is never that; a value that changes
 * pixel by pixel across a wall is. Over the view's shot ({@link CLIP}).
 */
async function speckle(browser: Browser, png: Buffer): Promise<number> {
  const page = await browser.newPage();
  const value = await page.evaluate(
    async ([data, levels]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${data}`;
      await img.decode();
      const canvas = new OffscreenCanvas(img.width, img.height);
      const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
      g.drawImage(img, 0, 0);
      const { width: w, height: h } = img;
      const px = g.getImageData(0, 0, w, h).data;
      const luma = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++)
        luma[i] = 0.2126 * px[4 * i] + 0.7152 * px[4 * i + 1] + 0.0722 * px[4 * i + 2];
      let n = 0;
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const v = luma[i];
          const around = [luma[i - 1], luma[i + 1], luma[i - w], luma[i + w]];
          if (around.every((a) => v - a > levels) || around.every((a) => a - v > levels)) n++;
        }
      }
      return (100 * n) / ((w - 2) * (h - 2));
    },
    [png.toString('base64'), SPECKLE_LEVELS] as const,
  );
  await page.close();
  return Number(value.toFixed(3));
}

/**
 * Four blocks east of the centre, clear of the official (LOD2) blocks, whose
 * walls carry no class or era: OSM city-tile walls with a facade style and a
 * non-zero flag byte, as a real city's.
 */
const NIGHT_VIEW = { lat: SYNTHETIC_CENTRE.lat, lng: SYNTHETIC_CENTRE.lng + 0.006, zoom: 18 };

/** How far a pixel must stand out from all four neighbours to count as speckle. */
const SPECKLE_LEVELS = 24;
/**
 * The night view's most speckle, %. Measured on SwiftShader: 0.003% with the
 * flags flat, 0.74% with them interpolated (#188, main @660a706).
 */
const NIGHT_MAX_SPECKLE_PCT = 0.1;

/**
 * The view with only the 3D city drawn over a flat `colour`: every other
 * layer hidden, the sky off, the colour behind the map's canvas. Two of
 * these give each pixel's coverage by the city ({@link layeredPct}).
 */
async function overBackdrop(page: Page, colour: string, path: string): Promise<Buffer> {
  await page.evaluate(async (fill) => {
    const map = reliefMap() as unknown as {
      getStyle(): { layers: { id: string; type: string }[] };
      getLayoutProperty(id: string, name: string): unknown;
      setLayoutProperty(id: string, name: string, value: unknown): void;
      setSky(sky: unknown): void;
      triggerRepaint(): void;
      getCanvas(): HTMLCanvasElement;
      once(event: string, listener: () => void): void;
    };
    // Once: everything but the city hidden, so the map's own pixels are
    // transparent wherever the city does not cover them.
    const others = map
      .getStyle()
      .layers.filter((layer) => !(layer.type === 'custom' && layer.id.endsWith('city3d')));
    if (others.some((layer) => map.getLayoutProperty(layer.id, 'visibility') !== 'none')) {
      for (const layer of others) map.setLayoutProperty(layer.id, 'visibility', 'none');
      map.setSky(undefined);
      await new Promise<void>((done) => {
        map.once('idle', () => done());
        map.triggerRepaint();
      });
    }
    // The backdrop is the canvas element's own: the page composites the
    // map's frame over it, exactly as the city's coverage says.
    map.getCanvas().style.background = fill;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
  }, colour);
  await drainGpu(page);
  return page.screenshot({ clip: CLIP, path, timeout: SETTLE_TIMEOUT_MS });
}

/**
 * Of the pixels the city covers, the share (%) where it covers only PARTLY
 * but more than {@link FADE_MID_COVERAGE} would: more than one surface of it
 * blended over the pixel, so a wall or a street behind a building shows
 * through it. From the city alone over black and over white: a pixel's
 * coverage is 1 − (white − black) / 255. A solid layer covers each pixel
 * fully or not at all (a dither), or by the fade's one share (an alpha).
 */
async function layeredPct(browser: Browser, black: Buffer, white: Buffer): Promise<number> {
  const page = await browser.newPage();
  const value = await page.evaluate(
    async ([b, w, mid]) => {
      const pixels = async (data: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, img.width, img.height).data;
      };
      const [x, y] = await Promise.all([pixels(b), pixels(w)]);
      let covered = 0;
      let layered = 0;
      for (let i = 0; i < x.length; i += 4) {
        const through = (y[i] - x[i] + (y[i + 1] - x[i + 1]) + (y[i + 2] - x[i + 2])) / (3 * 255);
        const coverage = 1 - through;
        if (coverage < 0.05) continue;
        covered++;
        if (coverage > mid + 0.1 && coverage < 0.95) layered++;
      }
      return covered === 0 ? 0 : (100 * layered) / covered;
    },
    [black.toString('base64'), white.toString('base64'), FADE_MID_COVERAGE] as const,
  );
  await page.close();
  return Number(value.toFixed(2));
}

/**
 * Mid-fade, the most of the city's pixels that may show a surface through
 * another, %. Measured on SwiftShader at z16: 37% on main @52dde03 (every
 * surface blended at the fade's alpha: coverage 0.5, 0.8, 0.9 by the
 * surfaces behind), 0.3% with the fade dithered (coverage 0 or 1).
 */
const FADE_MAX_LAYERED_PCT = 2;

/** The zoom fade's share at the mid-fade view's zoom (`BUILDINGS_3D_FADE`). */
const FADE_MID_COVERAGE =
  (16 - BUILDINGS_3D_FADE.start) / (BUILDINGS_3D_FADE.end - BUILDINGS_3D_FADE.start);

/**
 * Over a junction of the synthetic grid (the one north-west of the central
 * block, `syntheticCity.ts` → `roadTile`), where the street detail fills the
 * view: crossings, lanes, stop lines.
 */
const JUNCTION = { lat: 41.39259, lng: 2.16388, zoom: 18.5 };
/** The same junction from higher up, where several streets' traffic is in view. */
const TRAFFIC = { ...JUNCTION, zoom: 17.5 };

/**
 * Share of pixels, in %, where two screenshots differ by more than
 * `threshold` in a channel — below the top `skipTop` rows, where the map's
 * chips sit (a layer's own, like "Landmarks", appears with it). With
 * `skipTop` 0, only the chips' corner (the top-right 240 × 100 px) is left out.
 */
async function differs(
  browser: Browser,
  a: Buffer,
  b: Buffer,
  threshold = 24,
  skipTop = 110,
): Promise<number> {
  const page = await browser.newPage();
  const value = await page.evaluate(
    async ([one, two, limit, top]) => {
      const pixels = async (data: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        return {
          data: g.getImageData(0, top, img.width, img.height - top).data,
          width: img.width,
        };
      };
      const [{ data: x, width }, { data: y }] = await Promise.all([pixels(one), pixels(two)]);
      let n = 0;
      let counted = 0;
      for (let i = 0; i < x.length; i += 4) {
        const px = (i / 4) % width;
        const py = Math.floor(i / 4 / width) + top;
        if (top === 0 && px >= width - 240 && py < 100) continue;
        counted++;
        const d = Math.max(
          Math.abs(x[i] - y[i]),
          Math.abs(x[i + 1] - y[i + 1]),
          Math.abs(x[i + 2] - y[i + 2]),
        );
        if (d > limit) n++;
      }
      return (100 * n) / counted;
    },
    [a.toString('base64'), b.toString('base64'), threshold, skipTop] as const,
  );
  await page.close();
  return Number(value.toFixed(2));
}

/**
 * The pan: from straight above (no 3D terrain, so a drag moves the whole map
 * by exactly the pointer's travel, give or take the buildings' parallax), in
 * the morning (long shadows), dragged {@link PAN_STEPS} times by
 * {@link PAN_STEP_PX} towards the top of the screen.
 */
const PAN = { ...SYNTHETIC_CENTRE, zoom: 18 };
const PAN_STEPS = 5;
const PAN_STEP_PX = 30;
const PAN_MORNING = new Date('2026-06-21T09:00:00+02:00');
/**
 * The most of the map, in %, that may differ between two frames of the pan
 * once aligned. Measured (SwiftShader): 0.04–0.06% per step; the shadow map read
 * through a stale matrix (before `SHADOW_LATITUDE_STEP_DEG`): 4.5–25.6% on every
 * step after the first.
 */
const PAN_MAX_CHANGED_PCT = 0.5;
/** How many rows a pixel may move beyond the drag and still match, for the parallax. */
const PAN_SLACK_PX = 4;

/**
 * Share of pixels, in %, where `b` differs from `a` moved up by `dy` (more
 * than `threshold` in a channel), over the rows both cover below `skipTop`.
 * Each pixel is matched within ±{@link PAN_SLACK_PX} rows of the drag: the
 * roofs and crowns move a few pixels more than the ground they stand on (the
 * camera's parallax), a shadow sliding off its caster moves tens.
 */
async function differsMoved(
  browser: Browser,
  a: Buffer,
  b: Buffer,
  dy: number,
  threshold = 24,
  skipTop = 110,
): Promise<number> {
  const page = await browser.newPage();
  const value = await page.evaluate(
    async ([one, two, shift, slack, limit, top]) => {
      const pixels = async (data: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = new OffscreenCanvas(img.width, img.height);
        const g = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        const { data: px } = g.getImageData(0, 0, img.width, img.height);
        return { px, w: img.width, h: img.height };
      };
      const [x, y] = await Promise.all([pixels(one), pixels(two)]);
      let n = 0;
      let total = 0;
      for (let row = top + slack; row + shift + slack < x.h; row++) {
        for (let col = 0; col < x.w; col++) {
          const i = (row * x.w + col) * 4;
          let best = 255;
          for (let s = shift - slack; s <= shift + slack && best > limit; s++) {
            const j = ((row + s) * x.w + col) * 4;
            best = Math.min(
              best,
              Math.max(
                Math.abs(x.px[j] - y.px[i]),
                Math.abs(x.px[j + 1] - y.px[i + 1]),
                Math.abs(x.px[j + 2] - y.px[i + 2]),
              ),
            );
          }
          if (best > limit) n++;
          total++;
        }
      }
      return (100 * n) / total;
    },
    [a.toString('base64'), b.toString('base64'), dy, PAN_SLACK_PX, threshold, skipTop] as const,
  );
  await page.close();
  return Number(value.toFixed(2));
}

/** The pan's frames' changed shares, in %, one per step. */
async function panSteps(
  browser: Browser,
  origin: string,
  flags: string,
  choices: Record<string, boolean>,
  outDir: string,
): Promise<number[]> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.route('**/*', (route) => answer(route, origin, 'buildings', Promise.resolve()));
  const page = await context.newPage();
  await page.clock.setFixedTime(PAN_MORNING);
  await page.addInitScript(() => {
    const scope = globalThis as {
      reliefMap?: () => ReliefMap | undefined;
      __gowayReliefMap?: ReliefMap & { setPixelRatio?: (ratio: number) => void };
    };
    scope.reliefMap = () => scope.__gowayReliefMap;
    const pin = setInterval(() => {
      const map = scope.__gowayReliefMap;
      if (!map) return;
      map.setPixelRatio = () => {};
      clearInterval(pin);
    }, 20);
  });
  await page.addInitScript(
    (stored) =>
      localStorage.setItem(
        'goway.mapFeatures',
        JSON.stringify({ v: 1, choices: stored, labs: true }),
      ),
    choices,
  );
  const query = `lat=${PAN.lat}&lng=${PAN.lng}&zoom=${PAN.zoom}&quality=high&${flags}`;
  await page.goto(`${origin}/?${query}`, { waitUntil: 'load', timeout: 180_000 });
  if (!(await until(page, () => reliefMap() !== undefined))) {
    throw new Error('pan: the map never came up');
  }
  const still = async () => {
    await settled(page, { streets: false, landmark: null }, 'pan');
    await until(page, () => Boolean(reliefMap()?.areTilesLoaded()));
    // The shadow map's caster redraw is throttled (`sky.ts`), and fades end.
    await page.waitForTimeout(1500);
    await drainGpu(page);
  };
  await still();
  await page.addStyleTag({ content: '[data-goway-perf-hud] { display: none !important; }' });
  const shot = (i: number) =>
    page.screenshot({ clip: CLIP, path: join(outDir, `pan-${i}.png`), timeout: SETTLE_TIMEOUT_MS });
  const x = CLIP.x + CLIP.width / 2;
  let y = CLIP.y + CLIP.height / 2 + (PAN_STEPS * PAN_STEP_PX) / 2;
  const frames = [await shot(0)];
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= PAN_STEPS; i++) {
    // Held down between steps: no inertia, the map is exactly where it was dragged.
    y -= PAN_STEP_PX;
    await page.mouse.move(x, y, { steps: 3 });
    await still();
    frames.push(await shot(i));
  }
  await page.mouse.up();
  await context.close();
  const changed: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    changed.push(await differsMoved(browser, frames[i - 1], frames[i], PAN_STEP_PX));
  }
  return changed;
}

/**
 * A landmark of the registry (`public/landmarks/registry.json`) inside the
 * synthetic city: the Sagrada Família stands where it really does, its spires
 * far above the made-up blocks. Looked at from 110 m north of it at z17.5,
 * the camera's usual tilt and bearing: it stands in the middle of the view.
 */
const LANDMARK = { id: 'sagrada-familia', lat: 41.4046, lng: 2.174347, zoom: 17.5 };

/**
 * The camera rule's CI leg (`docs/MAP_CAMERA_CLEARANCE.md`): on the settled
 * landmark view, the camera is jumped through the Sagrada Família's model at
 * 60° (the ceiling without the city sky) and z19, where its eye stands ~70 m
 * up among towers of up to 172 m — every drawn eye checked against the
 * prisms (`cameraClearanceDrive.ts`). Waits for the model's columns (measured
 * on the mesh worker as it loads) before it sweeps: until the camera asked
 * for at bearing 0 is inside it, the sweep would test nothing.
 */
async function clearanceSweep(page: Page): Promise<Record<string, number>> {
  const target = landmarkPosition(LANDMARK.id);
  const camera = { zoom: 19, pitch: 60, centre: centreFor(target, 19, 60, VIEWPORT.height) };
  const by = Date.now() + 60_000;
  while (Date.now() < by) {
    const probe = await sweepThrough(page, camera, [0]);
    if (probe.askedInside > 0) break;
    await page.waitForTimeout(1000);
  }
  const bearings = Array.from({ length: 41 }, (_, i) => -40 + i * 2);
  const sweep = await sweepThrough(page, camera, bearings);
  console.error(`camera clearance: ${JSON.stringify(sweep)}`);
  return { ...sweep };
}

// --- Run -------------------------------------------------------------------------

const outDir = resolve(arg('out', '.city3d-visible'));
mkdirSync(outDir, { recursive: true });
const dist = arg('dist');
if (!dist) throw new Error('--dist=<an `expo export --platform web --dev` output> is required');
const served = serveDist(dist);
const origin = served.origin;

const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const results: Record<string, Record<string, number>> = {};
const failures: string[] = [];
/** City views that never settled (`settled` → `null`). */
const unsettledViews: string[] = [];
try {
  // `--skies=sky,nosky,objects` (all by default): CI runs one per job. The
  // `objects` leg holds the views that are not per sky (models, city life).
  const skies = arg('skies', 'sky,nosky,objects').split(',');
  for (const [label, { flags, choices }] of Object.entries(SKIES)) {
    if (!skies.includes(label)) continue;
    const withTrees = await view(browser, origin, flags, choices, outDir, `${label}-trees`);
    if (DEBUG) {
      console.error(
        JSON.stringify({ label, trees: withTrees.trees, triangles: withTrees.triangles }),
      );
      break;
    }
    const noTrees = await view(
      browser,
      origin,
      `${flags}&city3dTrees=0`,
      choices,
      outDir,
      `${label}-notrees`,
    );
    // The streets from over a junction (the centre view looks at a wall).
    const streets = await view(
      browser,
      origin,
      flags,
      choices,
      outDir,
      `${label}-streets`,
      'buildings',
      JUNCTION,
    );
    const noStreets = await view(
      browser,
      origin,
      flags.replace('&cityStreets=1', ''),
      choices,
      outDir,
      `${label}-nostreets`,
      'buildings',
      JUNCTION,
    );
    const noCity = await view(
      browser,
      origin,
      flags.replace('city3d=1&cityTiles=1', ''),
      // A stored choice outranks a build default (`mapFeatures.ts`), so the
      // reference is right whatever the export was built with.
      { ...choices, city3d: false },
      outDir,
      `${label}-nocity`,
      // Without the 3D city MapLibre extrudes the basemap's buildings itself;
      // the reference is a map with no buildings standing at all.
      'empty',
    );
    const r: Record<string, number> = {
      trees: withTrees.trees,
      triangles: noTrees.triangles,
      canopyPct: await share(browser, withTrees.png, 'canopy'),
      canopyPctWithoutTrees: await share(browser, noTrees.png, 'canopy'),
      darkPct: await share(browser, noTrees.png, 'dark'),
      darkPctWithoutCity: await share(browser, noCity.png, 'dark'),
      streetTriangles: streets.streetTriangles,
      streetsChangedPct: await differs(browser, streets.png, noStreets.png),
    };
    results[label] = r;
    if (label === 'nosky') {
      // The same junction on a sloped, creased ground.
      const creased = (name: string, withStreets: boolean) =>
        view(
          browser,
          origin,
          withStreets ? flags : flags.replace('&cityStreets=1', ''),
          choices,
          outDir,
          name,
          'buildings',
          JUNCTION,
          'high',
          null,
          'ease',
          NOON,
          'creased',
        );
      const on = await creased(`${label}-creased-streets`, true);
      const off = await creased(`${label}-creased-nostreets`, false);
      const pct = await differs(browser, on.png, off.png);
      r.creasedStreetTriangles = on.streetTriangles;
      r.creasedStreetsChangedPct = pct;
      if (on.streetTriangles === 0)
        failures.push(`${label}: no streets drawn on the creased ground`);
      else if (pct < CREASED_MIN_SHARE * r.streetsChangedPct)
        failures.push(
          `${label}: on a creased ground the streets change ${pct}% of the view, on flat ground ${r.streetsChangedPct}%: the terrain covers the street detail`,
        );
    }
    if (r.trees === 0)
      failures.push(`${label}: the engine drew no trees (the fixture is not reaching it)`);
    else if (r.canopyPct < Math.max(1, 3 * r.canopyPctWithoutTrees))
      failures.push(
        `${label}: ${r.trees} trees drawn, canopy ${r.canopyPct}% (${r.canopyPctWithoutTrees}% without trees)`,
      );
    if (r.triangles === 0)
      failures.push(`${label}: the engine drew no buildings (the fixture is not reaching it)`);
    else if (r.darkPct < Math.max(2, 4 * r.darkPctWithoutCity))
      failures.push(
        `${label}: ${r.triangles} building triangles drawn, ${r.darkPct}% of the map dark (${r.darkPctWithoutCity}% without the 3D city)`,
      );
    if (r.streetTriangles === 0)
      failures.push(`${label}: the engine drew no streets (the fixture is not reaching it)`);
    else if (r.streetsChangedPct < 3)
      failures.push(
        `${label}: ${r.streetTriangles} street triangles drawn, but streets on change ${r.streetsChangedPct}% of the view over a junction`,
      );
  }
  if (!DEBUG && skies.includes('sky')) {
    const { flags, choices } = SKIES.sky;
    const changed = await panSteps(browser, origin, flags, choices, outDir);
    results.pan = { maxChangedPct: Math.max(...changed), steps: changed.length };
    console.error(`pan: changed ${changed.join(', ')}% per step`);
    if (Math.max(...changed) > PAN_MAX_CHANGED_PCT)
      failures.push(
        `pan: a frame differs ${Math.max(...changed)}% from the one before once aligned (over ${PAN_MAX_CHANGED_PCT}%): the map changes under a pan`,
      );
  }
  if (!DEBUG && (skies.includes('sky') || skies.includes('night'))) {
    // The city sky at night, looking at the synthetic city's walls: windows
    // lit, floodlights on, no sun. Born of #188: an interpolated building
    // flag lit every wall's floodlight on half its pixels, pixel by pixel.
    const { flags, choices } = SKIES.sky;
    const night = await view(
      browser,
      origin,
      flags,
      choices,
      outDir,
      'sky-night',
      'buildings',
      NIGHT_VIEW,
      'high',
      null,
      'jump',
      MIDNIGHT,
    );
    const speckled = await speckle(browser, night.png);
    results.night = { triangles: night.triangles, specklePct: speckled };
    console.error(`night: speckle ${speckled}% of the map`);
    if (night.triangles === 0)
      failures.push('night: the engine drew no buildings (the fixture is not reaching it)');
    else if (speckled > NIGHT_MAX_SPECKLE_PCT)
      failures.push(
        `night: ${speckled}% of the map is speckle (over ${NIGHT_MAX_SPECKLE_PCT}%): a surface value changes pixel by pixel`,
      );
  }
  if (!DEBUG && (skies.includes('nosky') || skies.includes('fade'))) {
    // Mid-fade, at a resting zoom inside `BUILDINGS_3D_FADE`: the city must
    // draw as ONE solid layer, never a wall or a street behind a building
    // showing through it. Born of main @cd11022: every surface was blended at
    // the fade's alpha, so walls and streets showed through the blocks. Without
    // the sky, whose passes draw over the backdrop; trees off (their contact
    // shadows are blended by design).
    const { flags, choices } = SKIES.nosky;
    // Street detail off: it starts above this zoom, and would never settle.
    const mid = await view(
      browser,
      origin,
      `${flags.replace('&cityStreets=1', '')}&city3dTrees=0`,
      choices,
      outDir,
      'fade-mid',
      'buildings',
      { ...SYNTHETIC_CENTRE, zoom: 18 },
      // At z16 the high preset draws a city of tiles that two software-GL
      // cores take minutes a frame over; what is under test is the blend.
      'low',
      null,
      'jump',
      NOON,
      'flat',
      undefined,
      true,
      16,
    );
    const [black, white] = mid.backdrops ?? [mid.png, mid.png];
    const layered = await layeredPct(browser, black, white);
    results.fade = { triangles: mid.triangles, layeredPct: layered };
    console.error(`fade: ${layered}% of the city's pixels show a surface behind another`);
    if (mid.triangles === 0)
      failures.push('fade: the engine drew no buildings mid-fade (the fixture is not reaching it)');
    else if (layered > FADE_MAX_LAYERED_PCT)
      failures.push(
        `fade: ${layered}% of the city's pixels show a surface behind another (over ${FADE_MAX_LAYERED_PCT}%): walls and streets show through the buildings`,
      );
  }
  if (!DEBUG && skies.includes('objects')) {
    // Models (`models.ts`, drawn by the TSL pass): the landmark on and off,
    // without the sky (models are drawn the same way under either).
    const { flags: skyless, choices } = SKIES.nosky;
    // Trees off on both sides of the comparison: they are the other legs'
    // subject, and at this zoom they are 1.5 M of the view's 1.8 M triangles —
    // on two software-GL cores the frames queued while the view settles took
    // the GPU minutes to drain, and the screenshot (which waits for the next
    // frame) timed out behind them (#186's first CI run).
    const flags = `${skyless}&city3dTrees=0`;
    const withLandmark = await view(
      browser,
      origin,
      `${flags}&landmarks=1`,
      { ...choices, landmarks: true },
      outDir,
      'landmark',
      'buildings',
      LANDMARK,
      'low',
      LANDMARK.id,
      'jump',
      NOON,
      'flat',
      // The camera rule (`docs/MAP_CAMERA_CLEARANCE.md`): swept through the
      // model, the drawn eye is never inside it.
      clearanceSweep,
    );
    const without = await view(
      browser,
      origin,
      flags,
      choices,
      outDir,
      'nolandmark',
      'buildings',
      LANDMARK,
      'low',
      null,
      'jump',
    );
    const changed = await differs(browser, withLandmark.png, without.png);
    results.landmark = { changedPct: changed };
    const sweep = withLandmark.inspected;
    if (sweep) results.clearance = sweep;
    if (!sweep || sweep.askedInside === 0)
      failures.push(
        `camera clearance: the sweep never asked for an eye inside ${LANDMARK.id}: it tests nothing`,
      );
    else if (sweep.inside > 0 || sweep.drawnInside > 0)
      failures.push(
        `camera clearance: ${sweep.inside} of ${sweep.steps} cameras drew the eye inside ${LANDMARK.id} (${sweep.maxDepthM.toFixed(1)} m deep)`,
      );
    if (withLandmark.landmarkFailed)
      failures.push(`landmark: ${LANDMARK.id}'s model failed to load (its buildings stayed)`);
    else if (changed < 1)
      failures.push(
        `landmark: ${LANDMARK.id} changes ${changed}% of the map (on against off): it is not on the screen`,
      );
  }
  if (!DEBUG && skies.includes('objects')) {
    // City life (`cityLife/`, drawn by the TSL pass): its simulated traffic on
    // the fixture's streets, on and off, over the junction, without the sky
    // (the agents are drawn the same way under either, and city life keeps
    // the map rendering: on software GL a frame with the sky's passes takes
    // seconds, and a screenshot waits for one). The simulation is seeded and
    // the clock fixed, but the agents move with real time: the share is a
    // floor, not a match.
    const { flags: skyless, choices } = SKIES.nosky;
    // Trees off on both sides of the comparison: they are the other legs'
    // subject, and at this zoom they are 1.5 M of the view's 1.8 M triangles —
    // on two software-GL cores the frames queued while the view settles took
    // the GPU minutes to drain, and the screenshot (which waits for the next
    // frame) timed out behind them (#186's first CI run).
    const flags = `${skyless}&city3dTrees=0`;
    // The low preset's 300 cars and 300 people (`profile.ts` → `life`): the
    // high one's 2,400 agents keep two software-GL cores from ever finishing
    // a frame for the screenshot. From z17.5 over the junction several
    // streets are in view, so their traffic shows whenever the shot is taken;
    // the whole frame counts but the chips' corner.
    const withLife = await view(
      browser,
      origin,
      `${flags}&cityLife=1`,
      { ...choices, cityLife: true },
      outDir,
      'life',
      'buildings',
      TRAFFIC,
      'low',
      null,
      'jump',
    );
    const without = await view(
      browser,
      origin,
      flags,
      choices,
      outDir,
      'nolife',
      'buildings',
      TRAFFIC,
      'low',
      null,
      'jump',
    );
    const changed = await differs(browser, withLife.png, without.png, 24, 0);
    results.life = { changedPct: changed };
    if (changed < 0.05)
      failures.push(`city life: its agents change ${changed}% of the view: not on the screen`);
  }
} finally {
  await browser.close();
  served.stop();
}
for (const name of unsettledViews) {
  failures.push(
    `${name}: never settled within ${SETTLE_TIMEOUT_MS / 1000}s (see the reason above)`,
  );
}
console.log(JSON.stringify({ results, screenshots: outDir }, null, 2));
if (failures.length > 0) {
  console.error(`city3d visibility gate FAILED:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.error('city3d visibility gate: PASS');

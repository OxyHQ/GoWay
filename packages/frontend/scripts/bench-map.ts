/**
 * The map's performance benchmark: fixed camera paths over the heaviest
 * scenes GoWay draws, every 3D feature on, measured the same way on any
 * commit (`docs/MAP_PERFORMANCE.md` → "The benchmark").
 *
 *   bun run --cwd packages/frontend bench:map --url=http://localhost:8119 \
 *     [--scenes=eixample,manhattan] [--device=desktop|laptop|laptop-2x|pixel6a|iphone12] \
 *     [--dpr=3] [--gpu=real|software] [--quality=low|medium|high] [--tier=…] \
 *     [--style=standard|streets|…[:day|night|dawn|dusk]] [--no-counters] [--profile] [--out=bench.json]
 *
 * `--style` stores a map style and light as the picker would
 * (`docs/MAP_STYLES.md`), so every style is measured on the same paths.
 *
 * Time a production export served with the city and road archives
 * (`scripts/serve-map-build.ts`, `docs/MAP_PERFORMANCE.md` → "The
 * benchmark"); the dev server's numbers are not what users run.
 *
 * The GPU timer: WebGL 2 allows one timer query at a time, and a build with
 * the perf runtime times every 3D frame itself (dynamic resolution reads it).
 * The benchmark then reads the map's results instead of opening its own, and
 * records whose timer measured (`gpuTimedBy`).
 *
 * ## What is measured, and how
 *
 * Nothing in the page is asked to cooperate, so `main` measures exactly like
 * a branch: an init script instruments every MapLibre WebGL2 context with
 * `components/map/perf/glCounters.ts` (the HUD's and the CI gate's own
 * instrument, injected by `toString`) and wraps `requestAnimationFrame` to
 * time each frame's main-thread work and, where the GPU exposes
 * `EXT_disjoint_timer_query_webgl2`, its GPU time. The camera moves by real
 * input (drag, ctrl-drag, wheel), so MapLibre renders as it does for a person.
 *
 * ## Real GPU or not
 *
 * `--gpu=real` (the default) launches Chromium on ANGLE's GL backend; under
 * WSL2 with `GALLIUM_DRIVER=d3d12` that is the machine's real GPU through
 * Mesa's D3D12 driver. Every result records the renderer string WebGL
 * reports, so a run that fell back to SwiftShader says so; `--gpu=software`
 * asks for SwiftShader on purpose (the CI case). The device profiles emulate a
 * laptop or a phone's VIEWPORT, PIXEL RATIO, TOUCH and CPU (CDP CPU
 * throttling) — never its GPU: GPU milliseconds are always the host GPU's.
 */
import { writeFileSync } from 'node:fs';
import { type Browser, type BrowserContext, chromium, type Page } from 'playwright-core';

import { createGlCounterState, instrumentWebGl2 } from '../components/map/perf/glCounters';
import { summarise } from '../components/map/perf/frameStats';
import { MAP_FEATURES, type MapFeatureDefinition } from '../lib/map/mapFeatures';

/** `--style=streets` or `--style=streets:night`: the stored style and light mode. */
function styleArg(): { style: string; light: string } | null {
  const hit = process.argv.find((a) => a.startsWith('--style='));
  if (!hit) return null;
  const [style, light = 'day'] = hit.slice('--style='.length).split(':');
  return { style, light };
}

interface Device {
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  mobile: boolean;
  cpuThrottle: number;
  note: string;
}

/** Emulated devices: viewport, pixel ratio, touch and CPU. The GPU is never emulated. */
export const DEVICES: Record<string, Device> = {
  desktop: {
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    mobile: false,
    cpuThrottle: 1,
    note: '1080p desktop, host CPU',
  },
  laptop: {
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 2,
    mobile: false,
    cpuThrottle: 4,
    note: '1366×768 @2x, CPU ÷4 (integrated-GPU laptop CPU class)',
  },
  'laptop-2x': {
    viewport: { width: 1366, height: 768 },
    deviceScaleFactor: 2,
    mobile: false,
    cpuThrottle: 2,
    note: '1366×768 @2x, CPU ÷2 (an i5-1135G7 / M1 against this i9-14900K, single-thread)',
  },
  pixel6a: {
    viewport: { width: 412, height: 915 },
    deviceScaleFactor: 2.75,
    mobile: true,
    cpuThrottle: 5,
    note: 'Pixel 6a-class: 412×915 @2.75, touch, CPU ÷5',
  },
  iphone12: {
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    mobile: true,
    cpuThrottle: 4,
    note: 'iPhone 12-class: 390×844 @3, touch, CPU ÷4',
  },
};

type Path = 'orbit' | 'pan' | 'zoomOut' | 'still';

interface Scene {
  id: string;
  title: string;
  camera: { lat: number; lng: number; zoom: number; pitch: number; bearing: number };
  /**
   * The map-feature registry's development query parameters. A development
   * server reads them from the address; a production export is handed them as
   * stored choices (`sceneChoices`).
   */
  flags: Record<string, string>;
  path: Path;
  durationMs: number;
  /** Fake clock for the sky (UTC ISO), e.g. a night. */
  at?: string;
  /** Wait for city life's agents before measuring. */
  life?: boolean;
}

const ALL_3D = {
  city3d: '1',
  cityTiles: '1',
  citysky: '1',
  detailedCity: '1',
  city3dTrees: '1',
  cityLife: '1',
  landmarks: '1',
  globe: '1',
  terrain: '1',
};

/** The fixed scenes. Cameras are real places; every feature is on. */
export const SCENES: Scene[] = [
  {
    id: 'eixample',
    title: 'Eixample, tilted, orbiting (Sagrada Família in view)',
    camera: { lat: 41.3995, lng: 2.1665, zoom: 16.3, pitch: 62, bearing: 30 },
    flags: ALL_3D,
    path: 'orbit',
    durationMs: 6000,
    at: '2026-06-21T15:00:00Z',
  },
  {
    id: 'manhattan',
    title: 'Lower Manhattan towers, steep, orbiting',
    camera: { lat: 40.7075, lng: -74.0105, zoom: 16.2, pitch: 72, bearing: -20 },
    flags: ALL_3D,
    path: 'orbit',
    durationMs: 6000,
    at: '2026-06-21T18:00:00Z',
  },
  {
    id: 'montserrat',
    title: 'Montserrat terrain, tilted, panning',
    camera: { lat: 41.5935, lng: 1.8376, zoom: 13.4, pitch: 70, bearing: 140 },
    flags: ALL_3D,
    path: 'pan',
    durationMs: 6000,
    at: '2026-06-21T10:00:00Z',
  },
  {
    // Render on demand: nothing moves and nothing animates at this zoom, so a
    // still map should draw (almost) no frames at all.
    id: 'terrain-still',
    title: 'Montserrat terrain, untouched for 10 s',
    camera: { lat: 41.5935, lng: 1.8376, zoom: 13.4, pitch: 70, bearing: 140 },
    flags: ALL_3D,
    path: 'still',
    durationMs: 10_000,
    at: '2026-06-21T10:00:00Z',
  },
  {
    id: 'globe',
    title: 'Zoom out from Barcelona to the globe',
    camera: { lat: 41.3925, lng: 2.164, zoom: 15.5, pitch: 0, bearing: 0 },
    flags: ALL_3D,
    path: 'zoomOut',
    durationMs: 6000,
  },
  {
    id: 'traffic',
    title: 'Passeig de Gràcia at z18, city life, map still',
    camera: { lat: 41.3932, lng: 2.1636, zoom: 18, pitch: 55, bearing: 30 },
    flags: ALL_3D,
    path: 'still',
    durationMs: 6000,
    life: true,
    at: '2026-06-21T11:00:00Z',
  },
  {
    // The battery case: city life on screen and nobody touching the map. The
    // map should stop redrawing once the animation clock's idle pause runs out.
    id: 'idle',
    title: 'Passeig de Gràcia, city life, untouched for 30 s',
    camera: { lat: 41.3932, lng: 2.1636, zoom: 17.5, pitch: 55, bearing: 30 },
    flags: ALL_3D,
    path: 'still',
    durationMs: 30_000,
    life: true,
    at: '2026-06-21T11:00:00Z',
  },
  {
    id: 'night',
    title: 'Eixample at night, sky on, orbiting',
    camera: { lat: 41.3925, lng: 2.164, zoom: 16.5, pitch: 70, bearing: 0 },
    flags: ALL_3D,
    path: 'orbit',
    durationMs: 6000,
    at: '2026-01-15T22:30:00Z',
  },
];

/** A scene's development flags as the map-feature choices they stand for. */
function sceneChoices(scene: Scene): Record<string, boolean> {
  const choices: Record<string, boolean> = {};
  for (const feature of MAP_FEATURES as readonly MapFeatureDefinition[]) {
    const value = feature.query ? scene.flags[feature.query] : undefined;
    if (value !== undefined) choices[feature.id] = value === '1';
  }
  return choices;
}

/**
 * Installed in every page before any of its scripts. Self-contained: it gets
 * the counter's source and the scene's choices, and nothing else.
 */
function pageProbe(args: {
  counterSource: string;
  stateSource: string;
  at: string | null;
  tier: string | null;
  choices: Record<string, boolean>;
  /** The stored style and light, or `null` for the defaults. */
  style: { style: string; light: string } | null;
  counters: boolean;
}) {
  const w = window as unknown as Record<string, unknown>;
  if (args.at) {
    // The sky reads the device clock: move it, keep it running.
    const offset = Date.parse(args.at) - Date.now();
    const RealDate = Date;
    class ShiftedDate extends RealDate {
      constructor(...a: unknown[]) {
        if (a.length === 0) super(RealDate.now() + offset);
        else super(...(a as [number]));
      }
      static now() {
        return RealDate.now() + offset;
      }
    }
    w.Date = ShiftedDate;
  }
  // After the clock is moved: the record's date must not be in the scene's future.
  // A production build ignores the address (`?city3d=1`, `?quality=`), so the
  // scene's features are stored as the person's choices, exactly as the
  // settings modal stores them (`lib/map/mapFeatureStore.ts`).
  let gpu: Record<string, unknown> | undefined;
  if (args.tier) {
    // A GPU record for THIS renderer at the tier asked for, as the map's own
    // benchmark would write it, so Auto resolves it (`lib/map/quality/gpuTier.ts`).
    try {
      const probe = document.createElement('canvas').getContext('webgl2');
      const info = probe?.getExtension('WEBGL_debug_renderer_info');
      const renderer =
        probe && info ? String(probe.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
      probe?.getExtension('WEBGL_lose_context')?.loseContext();
      const mpx = args.tier === 'high' ? 10 : args.tier === 'medium' ? 1 : 0.1;
      gpu = { v: 1, renderer, megapixelsPerMs: mpx, tier: args.tier, at: Date.now() };
    } catch {
      // No WebGL 2 probe: Auto decides.
    }
  }
  try {
    localStorage.setItem(
      'goway.mapFeatures',
      JSON.stringify({
        v: 1,
        choices: args.choices,
        labs: false,
        ...(args.style ?? {}),
        ...(gpu ? { gpu } : {}),
      }),
    );
  } catch {
    // No storage: only a development build's address switches features on.
  }
  // The benchmark injects its own instrument, by source.
  const instrument = new Function(`return (${args.counterSource})`)() as (
    gl: WebGL2RenderingContext,
    state: unknown,
  ) => boolean;
  const createState = new Function(`return (${args.stateSource})`)() as () => {
    frame: Record<string, number>;
    memory: Record<string, number>;
  };
  const state = createState();
  let mapGl: WebGL2RenderingContext | null = null;
  let timer: {
    TIME_ELAPSED_EXT: number;
    GPU_DISJOINT_EXT: number;
  } | null = null;
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    ...rest: unknown[]
  ) {
    const context = (getContext as (...a: unknown[]) => unknown).call(this, type, ...rest);
    if (type === 'webgl2' && context && this.classList.contains('maplibregl-canvas') && !mapGl) {
      mapGl = context as WebGL2RenderingContext;
      // `--no-counters`: time frames without the per-call instrument's own
      // cost — only draw calls are counted (a tick with none drew no frame).
      if (args.counters) instrument(mapGl, state);
      else {
        const target = mapGl as unknown as Record<string, (...a: unknown[]) => unknown>;
        for (const name of [
          'drawElements',
          'drawArrays',
          'drawElementsInstanced',
          'drawArraysInstanced',
        ]) {
          const original = target[name];
          target[name] = (...a: unknown[]) => {
            state.frame.draws++;
            return original.apply(mapGl, a);
          };
        }
      }
      timer = mapGl.getExtension('EXT_disjoint_timer_query_webgl2') as typeof timer;
      if (timer) observeMapTimer(mapGl, timer.TIME_ELAPSED_EXT);
    }
    return context;
  } as typeof getContext;

  interface FrameRecord {
    t: number;
    cpu: number;
    gpu: number | null;
    gl: Record<string, number>;
    /** The frame's callbacks: the first one's start and the last one's end (performance.now). */
    from: number;
    to: number;
    /** The canvas's width in device pixels: dynamic resolution's doing, frame by frame. */
    width: number;
  }
  const frames: FrameRecord[] = [];
  // Main-thread work OUTSIDE the frame callbacks (worker replies, tile
  // parsing, GC): long tasks, summed while measuring.
  let longTaskMs = 0;
  let longTasks = 0;
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTaskMs += entry.duration;
        longTasks++;
      }
    }).observe({ type: 'longtask', buffered: false });
  } catch {
    // No long-task timing in this browser: reported as 0.
  }
  let tick = -1;
  let cpu = 0;
  let from = 0;
  let to = 0;
  let query: WebGLQuery | null = null;
  let tickQueries: WebGLQuery[] = [];
  const pending: Array<{ query: WebGLQuery; frame: FrameRecord }> = [];
  // WebGL 2 allows ONE timer query at a time (`docs/MAP_PERFORMANCE.md` →
  // "One GPU timer per frame"). A build with the perf runtime times every
  // frame of the 3D map itself — the measurement dynamic resolution reads — so
  // the benchmark must not open a second one: it reads the map's results as
  // the map reads them, and times a frame itself only when the map does not
  // (a build without the runtime, or a frame it left untimed).
  let mapQueries: WebGLQuery[] = [];
  let mapTimedLastTick = false;
  const mapResults = new Map<WebGLQuery, FrameRecord>();
  let gpuSource: { map: number; bench: number } = { map: 0, bench: 0 };
  // The context's own query calls: the benchmark's timer uses these, so only
  // the PAGE's calls go through the observer below.
  let rawBegin: ((target: number, q: WebGLQuery) => void) | null = null;
  let rawRead: ((q: WebGLQuery, name: number) => unknown) | null = null;
  function observeMapTimer(gl: WebGL2RenderingContext, timeElapsed: number) {
    const begin = gl.beginQuery.bind(gl);
    const end = gl.endQuery.bind(gl);
    const read = gl.getQueryParameter.bind(gl);
    rawBegin = begin;
    rawRead = read;
    gl.beginQuery = (target: number, q: WebGLQuery) => {
      if (target === timeElapsed) {
        // The map's own timer: ours, if open, gives way (and is discarded).
        if (query) {
          end(timeElapsed);
          gl.deleteQuery(query);
          query = null;
        }
        mapQueries.push(q);
      }
      begin(target, q);
    };
    gl.getQueryParameter = ((q: WebGLQuery, name: number) => {
      const value = read(q, name);
      const frame = mapResults.get(q);
      if (frame && name === gl.QUERY_RESULT) {
        frame.gpu = (frame.gpu ?? 0) + (value as number) / 1e6;
        mapResults.delete(q);
      }
      return value;
    }) as typeof gl.getQueryParameter;
  }

  const closeTick = () => {
    if (tick < 0) return;
    const record: FrameRecord = {
      t: tick,
      cpu,
      gpu: null,
      gl: { ...state.frame },
      from,
      to,
      width: mapGl?.drawingBufferWidth ?? 0,
    };
    for (const key of Object.keys(state.frame)) state.frame[key] = 0;
    for (const q of mapQueries) mapResults.set(q, record);
    mapTimedLastTick = mapQueries.length > 0;
    if (record.gl.draws > 0) {
      if (mapTimedLastTick) gpuSource.map++;
      else if (tickQueries.length > 0) gpuSource.bench++;
    }
    mapQueries = [];
    for (const q of tickQueries) pending.push({ query: q, frame: record });
    tickQueries = [];
    if (record.gl.draws > 0) frames.push(record);
    cpu = 0;
  };
  const pollQueries = () => {
    if (!mapGl || !timer) return;
    const disjoint = mapGl.getParameter(timer.GPU_DISJOINT_EXT);
    const read = rawRead ?? mapGl.getQueryParameter.bind(mapGl);
    while (pending.length > 0) {
      const { query: q, frame } = pending[0];
      if (!read(q, mapGl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      if (!disjoint) frame.gpu = (frame.gpu ?? 0) + (read(q, mapGl.QUERY_RESULT) as number) / 1e6;
      mapGl.deleteQuery(q);
    }
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback: FrameRequestCallback) =>
    raf((t) => {
      if (t !== tick) {
        closeTick();
        pollQueries();
        tick = t;
        from = 0;
      }
      // The benchmark's own timer, where the map has none: around each frame
      // callback, kept only for the callbacks that drew (the map's render) —
      // never across the gap between frames or around a callback that sends
      // the GPU nothing: measured, those read the GPU's idle waits (a
      // Montserrat orbit 10.8 ms a frame against the map's own 1.65 ms).
      if (mapGl && timer && !mapTimedLastTick && pending.length + tickQueries.length < 16) {
        query = mapGl.createQuery();
        if (query) (rawBegin ?? mapGl.beginQuery.bind(mapGl))(timer.TIME_ELAPSED_EXT, query);
      }
      const started = performance.now();
      if (from === 0) from = started;
      const drawsBefore = state.frame.draws ?? 0;
      try {
        callback(t);
      } finally {
        to = performance.now();
        cpu += to - started;
        // Still ours (the map's own timer did not take over): close it.
        if (query && mapGl && timer) {
          mapGl.endQuery(timer.TIME_ELAPSED_EXT);
          if ((state.frame.draws ?? 0) > drawsBefore) tickQueries.push(query);
          else mapGl.deleteQuery(query);
          query = null;
        }
      }
    });

  w.__bench = {
    /**
     * Busy for a few ms under a name the profile can find: where its first
     * sample lands gives the profile's clock against performance.now().
     */
    marker: function __benchClockMarker() {
      const at = performance.now();
      while (performance.now() - at < 6) {
        // spin
      }
      return at;
    },
    reset() {
      closeTick();
      frames.length = 0;
      gpuSource = { map: 0, bench: 0 };
      longTaskMs = 0;
      longTasks = 0;
    },
    take() {
      closeTick();
      pollQueries();
      return { frames: frames.splice(0), longTaskMs, longTasks, gpuSource };
    },
    memory() {
      const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
      const canvas = mapGl?.canvas as HTMLCanvasElement | undefined;
      return {
        gl: { ...state.memory },
        canvas: canvas ? { width: canvas.width, height: canvas.height } : null,
        jsHeapBytes: heap?.usedJSHeapSize ?? null,
      };
    },
    renderer() {
      if (!mapGl) return null;
      const info = mapGl.getExtension('WEBGL_debug_renderer_info');
      return info ? String(mapGl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'masked';
    },
  };
}

function sceneUrl(base: string, scene: Scene, quality: string | null): string {
  const params = new URLSearchParams({
    lat: String(scene.camera.lat),
    lng: String(scene.camera.lng),
    zoom: String(scene.camera.zoom),
    pitch: String(scene.camera.pitch),
    bearing: String(scene.camera.bearing),
    ...scene.flags,
    // The HUD counts every GL call; a timing run (`--no-counters`) leaves it off.
    ...(process.argv.includes('--no-counters') ? {} : { perf: '1' }),
  });
  if (quality) params.set('quality', quality);
  return `${base}/?${params}`;
}

async function settle(page: Page, scene: Scene, timeoutMs = 90_000): Promise<string[]> {
  const notes: string[] = [];
  const started = Date.now();
  let quietSince = 0;
  while (Date.now() - started < timeoutMs) {
    const status = await page.evaluate(() => {
      const g = globalThis as unknown as Record<string, Record<string, unknown> | undefined>;
      return {
        city: g.__gowayCity3d
          ? {
              pending: g.__gowayCity3d.tilesPending as number,
              wanted: g.__gowayCity3d.tilesWanted as number,
            }
          : null,
        agents: g.__gowayCityLife
          ? (() => {
              const stats = (g.__gowayCityLife as { stats?: { cars?: number; people?: number } })
                .stats;
              return (stats?.cars ?? 0) + (stats?.people ?? 0);
            })()
          : null,
      };
    });
    // A production build publishes no engine statistics: there, 25 s of loading.
    const blind = status.city === null && Date.now() - started > 25_000;
    const cityQuiet =
      status.city === null ? scene.camera.zoom < 15 || blind : status.city.pending === 0;
    const lifeReady = !scene.life || (status.agents ?? 0) > 0 || blind;
    if (cityQuiet && lifeReady) {
      if (quietSince === 0) quietSince = Date.now();
      if (Date.now() - quietSince > 2500) return notes;
    } else {
      quietSince = 0;
    }
    await page.waitForTimeout(250);
  }
  notes.push(`did not settle in ${timeoutMs / 1000}s`);
  return notes;
}

/** Real input, paced like a hand: a step every ~16 ms. */
async function runPath(page: Page, path: Path, durationMs: number, viewport: Device['viewport']) {
  // On the ground, never the sky (a drag on the sky above a tilted map moves
  // nothing) and never the phone's place sheet (it covers the lower half).
  const cx = viewport.width / 2;
  const cy = viewport.height * (viewport.width < 600 ? 0.25 : 0.62);
  const steps = Math.round(durationMs / 16);
  if (path === 'still') {
    await page.waitForTimeout(durationMs);
    return;
  }
  if (path === 'zoomOut') {
    await page.mouse.move(cx, cy);
    for (let i = 0; i < steps; i++) {
      await page.mouse.wheel(0, 14);
      await page.waitForTimeout(16);
    }
    return;
  }
  await page.mouse.move(cx, cy);
  if (path === 'orbit') await page.keyboard.down('Control');
  await page.mouse.down();
  const span = Math.min(viewport.width, viewport.height) * (path === 'orbit' ? 0.8 : 0.5);
  for (let i = 1; i <= steps; i++) {
    const f = i / steps;
    // There and back, so the camera ends where it began.
    const x = cx + span * Math.sin(f * Math.PI * 2) * 0.5;
    const y = path === 'pan' ? cy + span * 0.25 * Math.sin(f * Math.PI * 4) : cy;
    await page.mouse.move(x, y);
    await page.waitForTimeout(16);
  }
  await page.mouse.up();
  if (path === 'orbit') await page.keyboard.up('Control');
}

interface FrameRecord {
  t: number;
  cpu: number;
  gpu: number | null;
  gl: Record<string, number>;
  from: number;
  to: number;
  width: number;
}

function report(frames: FrameRecord[], durationMs: number) {
  const intervals: number[] = [];
  for (let i = 1; i < frames.length; i++) intervals.push(frames[i].t - frames[i - 1].t);
  const gpu = frames.map((f) => f.gpu).filter((v): v is number => v !== null);
  const gl = (key: string) => summarise(frames.map((f) => f.gl[key] ?? 0));
  const round = (s: ReturnType<typeof summarise>, digits = 2) => ({
    p50: Number(s.p50.toFixed(digits)),
    p95: Number(s.p95.toFixed(digits)),
    max: Number(s.max.toFixed(digits)),
    mean: Number(s.mean.toFixed(digits)),
  });
  return {
    frames: frames.length,
    fps: Number(((frames.length * 1000) / durationMs).toFixed(1)),
    intervalMs: round(summarise(intervals)),
    cpuMs: round(summarise(frames.map((f) => f.cpu))),
    gpuMs: gpu.length > 0 ? round(summarise(gpu)) : null,
    gpuSamples: gpu.length,
    // The canvas's width over the path (device pixels): first, last, least.
    canvasWidth:
      frames.length > 0
        ? {
            first: frames[0].width,
            last: frames[frames.length - 1].width,
            min: Math.min(...frames.map((f) => f.width)),
          }
        : null,
    perFrame: {
      draws: round(gl('draws'), 0),
      triangles: round(gl('triangles'), 0),
      instances: round(gl('instances'), 0),
      uploadBytes: round(gl('uploadBytes'), 0),
      offscreenPasses: round(gl('offscreenPasses'), 1),
      programSwitches: round(gl('programSwitches'), 0),
    },
  };
}

async function benchScene(
  context: BrowserContext,
  base: string,
  scene: Scene,
  device: Device,
  quality: string | null,
) {
  const page = await context.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));
  await page.addInitScript(pageProbe, {
    counterSource: instrumentWebGl2.toString(),
    stateSource: createGlCounterState.toString(),
    at: scene.at ?? null,
    tier: arg('tier', '') || null,
    choices: sceneChoices(scene),
    style: styleArg(),
    counters: !process.argv.includes('--no-counters'),
  });
  const cdp = await context.newCDPSession(page);
  // Profiling: every script's URL and source map, by id — lazy chunks can be
  // evaluated without a URL of their own, but never without a script id.
  const scripts = new Map<string, { url: string; sourceMapURL: string }>();
  if (process.argv.includes('--profile')) {
    cdp.on(
      'Debugger.scriptParsed',
      (event: { scriptId: string; url: string; sourceMapURL?: string }) => {
        scripts.set(event.scriptId, { url: event.url, sourceMapURL: event.sourceMapURL ?? '' });
      },
    );
    await cdp.send('Debugger.enable');
  }
  await page.goto(sceneUrl(base, scene, quality), { waitUntil: 'load', timeout: 120_000 });
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 60_000 });
  // Load at full speed; throttle only what is measured.
  const notes = await settle(page, scene);
  // `--setup=<js>`: an experiment's change, evaluated once loaded (e.g. hide a
  // layer through the dev build's `__gowayReliefMap`), then a moment to settle.
  const setup = arg('setup', '');
  if (setup) {
    await page.evaluate(setup);
    await page.waitForTimeout(3000);
  }
  // A still scene is measured from a touch, as a person's would be: loading
  // takes longer than the low preset's 20 s idle pause, which would otherwise
  // stop the map before the measurement starts. A Shift key on the map: the
  // clock counts it as interaction, and nothing on the map moves.
  if (scene.path === 'still') {
    await page.evaluate(() =>
      document
        .querySelector('canvas.maplibregl-canvas')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true })),
    );
  }
  if (device.cpuThrottle > 1)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: device.cpuThrottle });
  await page.evaluate(() =>
    (globalThis as unknown as { __bench: { reset(): void } }).__bench.reset(),
  );
  const profiling = process.argv.includes('--profile');
  if (profiling) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  const markedAt = profiling
    ? await page.evaluate(() =>
        (globalThis as unknown as { __bench: { marker(): number } }).__bench.marker(),
      )
    : 0;
  // The engine's grounding count before the path (development builds publish
  // it), so the result says how many tiles were lifted DURING it.
  const groundBefore = await page.evaluate(
    () =>
      (
        globalThis as unknown as {
          __gowayCity3dGround?: { tilesGrounded: number; tilesUploaded: number };
        }
      ).__gowayCity3dGround ?? null,
  );
  const started = Date.now();
  await runPath(page, scene.path, scene.durationMs, device.viewport);
  const elapsed = Date.now() - started;
  const cpuProfile = profiling
    ? ((await cdp.send('Profiler.stop')) as { profile: CpuProfile }).profile
    : null;
  const taken = await page.evaluate(
    () =>
      (globalThis as unknown as { __bench: { take(): unknown } }).__bench.take() as {
        frames: FrameRecord[];
        longTaskMs: number;
        longTasks: number;
        gpuSource: { map: number; bench: number };
      },
  );
  const frames = taken.frames;
  const profile = cpuProfile
    ? await attribute(cpuProfile, elapsed, scripts, base, { frames, markedAt })
    : null;
  if (device.cpuThrottle > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const after = await page.evaluate(() => {
    const g = globalThis as unknown as Record<string, unknown> & {
      __bench: { memory(): unknown; renderer(): string | null };
    };
    return {
      memory: g.__bench.memory(),
      renderer: g.__bench.renderer(),
      city: g.__gowayCity3d ?? null,
      life: g.__gowayCityLife ?? null,
      ground: g.__gowayCity3dGround ?? null,
      perf: g.__gowayPerf ?? null,
    };
  });
  await page.close();
  return {
    scene: scene.id,
    title: scene.title,
    path: scene.path,
    notes,
    errors,
    ...report(frames, elapsed),
    // Whose GPU timer measured the frames: the map's own (the perf runtime's,
    // what dynamic resolution reads) or the benchmark's, where the map has none.
    gpuTimedBy: taken.gpuSource,
    ...(process.argv.includes('--raw') ? { raw: frames } : {}),
    ...(profile ? { profile } : {}),
    // Share of the measured time the main thread spent in long tasks (> 50 ms).
    longTasks: {
      count: taken.longTasks,
      ms: Math.round(taken.longTaskMs),
      share: Number((taken.longTaskMs / elapsed).toFixed(2)),
    },
    ...after,
    groundDuringPath:
      groundBefore && after.ground
        ? {
            grounded:
              (after.ground as { tilesGrounded: number }).tilesGrounded -
              groundBefore.tilesGrounded,
            uploaded:
              (after.ground as { tilesUploaded: number }).tilesUploaded -
              groundBefore.tilesUploaded,
          }
        : null,
  };
}

interface CpuProfile {
  nodes: Array<{
    id: number;
    children?: number[];
    callFrame: {
      functionName: string;
      scriptId: string;
      url: string;
      lineNumber: number;
      columnNumber: number;
    };
  }>;
  samples: number[];
  timeDeltas: number[];
  startTime: number;
}

/**
 * Which part of the app a sampled frame's code belongs to, by its source URL
 * (the dev server serves modules by path; a production bundle by chunk name,
 * so there the split is by function name only).
 */
export function subsystemOf(source: string, functionName: string): string {
  if (functionName === '(garbage collector)') return 'gc';
  if (functionName === '(idle)') return 'idle';
  if (functionName === '(program)' || functionName === '(root)') return 'browser';
  if (/maplibre-gl/.test(source)) return 'maplibre';
  if (/node_modules\/three\//.test(source)) return 'three';
  if (/engine\/city3d|city3dLayer|city3dGround|engine\/quality/.test(source)) return 'city engine';
  if (/engine\/cityLife/.test(source)) return 'city life';
  if (/engine\/live3d|liveLayer|features\/live|lib\/live/.test(source)) return 'live';
  if (/components\/map\/perf/.test(source)) return 'perf runtime';
  if (
    /react-dom|react-native-web|node_modules\/react\/|scheduler|reanimated|nativewind|react-native-css/.test(
      source,
    )
  ) {
    return 'react';
  }
  if (/node_modules\//.test(source)) return 'other libraries';
  if (source === '') return 'unmapped';
  return 'app';
}

/** Source maps of the served scripts, so a sample is attributed to its source file. */
async function sourceMapper(
  scripts: Map<string, { url: string; sourceMapURL: string }>,
  base: string,
) {
  const { TraceMap, originalPositionFor } = await import('@jridgewell/trace-mapping');
  const maps = new Map<string, InstanceType<typeof TraceMap> | null>();
  const mapUrl = (scriptId: string, url: string) => {
    const script = scripts.get(scriptId);
    const named = script?.sourceMapURL;
    if (named)
      return named.startsWith('data:') || /^https?:/.test(named)
        ? named
        : new URL(named, script?.url || base).href;
    const at = url || script?.url || '';
    if (!at.startsWith('http')) return '';
    // The dev server's `x.bundle?…` → `x.map?…`; an export's `x.js` → `x.js.map`.
    return /\.js(\?|$)/.test(at)
      ? at.replace(/\.js(\?|$)/, '.js.map$1')
      : at.replace(/\.bundle(\?|$)/, '.map$1');
  };
  const mapFor = async (key: string) => {
    if (!key) return null;
    if (!maps.has(key)) {
      try {
        const text = key.startsWith('data:')
          ? Buffer.from(
              key.slice(key.indexOf(',') + 1),
              key.includes(';base64') ? 'base64' : 'utf8',
            ).toString()
          : await (await fetch(key)).text();
        maps.set(key, new TraceMap(text));
      } catch {
        maps.set(key, null);
      }
    }
    return maps.get(key) ?? null;
  };
  return async (scriptId: string, url: string, line: number, column: number) => {
    const map = await mapFor(mapUrl(scriptId, url));
    const fallback = url || scripts.get(scriptId)?.url || '';
    if (!map) return fallback;
    return originalPositionFor(map, { line: line + 1, column }).source ?? fallback;
  };
}

/**
 * Self time per subsystem (ms, and share of the measured wall time), and the
 * top functions — over the whole path and over its slowest frames alone. A
 * native function (a WebGL call: no URL) is charged to the nearest caller
 * that has one, so `bufferSubData` counts against whoever uploaded.
 */
async function attribute(
  profile: CpuProfile,
  elapsedMs: number,
  scripts: Map<string, { url: string; sourceMapURL: string }>,
  base: string,
  timing: { frames: FrameRecord[]; markedAt: number },
) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const node of profile.nodes)
    for (const child of node.children ?? []) parent.set(child, node.id);
  const locate = await sourceMapper(scripts, base);
  const owner = new Map<number, { subsystem: string; label: string }>();
  const ownerOf = async (id: number) => {
    const cached = owner.get(id);
    if (cached) return cached;
    const self = nodes.get(id);
    let at: number | undefined = id;
    let frame = self?.callFrame;
    // A native function (a WebGL call) has script id 0: charge its caller.
    while (
      frame &&
      frame.scriptId === '0' &&
      !frame.functionName.startsWith('(') &&
      at !== undefined
    ) {
      at = parent.get(at);
      frame = at === undefined ? undefined : nodes.get(at)?.callFrame;
    }
    const fn = self?.callFrame.functionName ?? '';
    const source =
      frame && frame.scriptId !== '0'
        ? await locate(frame.scriptId, frame.url, frame.lineNumber, frame.columnNumber)
        : '';
    const result = {
      subsystem: subsystemOf(source, frame?.functionName.startsWith('(') ? frame.functionName : fn),
      label: `${fn || '(anonymous)'} ${source.split('/').slice(-2).join('/')}`,
    };
    owner.set(id, result);
    return result;
  };
  const bySubsystem = new Map<string, number>();
  const byFunction = new Map<string, number>();
  // The same split for the SLOW frames alone — those at or over the path's
  // p95 of main-thread time, what a p95 is made of: the samples inside their
  // callbacks, placed on the page's clock by the marker's first sample.
  const slowBySubsystem = new Map<string, number>();
  const slowByFunction = new Map<string, number>();
  const cpus = timing.frames.map((f) => f.cpu).sort((a, b) => a - b);
  const threshold = cpus[Math.floor(cpus.length * 0.95)] ?? Number.POSITIVE_INFINITY;
  const slow = timing.frames.filter((f) => f.cpu >= threshold && f.from > 0);
  const times: number[] = [];
  let clock = profile.startTime;
  for (let i = 0; i < profile.samples.length; i++) {
    clock += profile.timeDeltas[i] ?? 0;
    times.push(clock / 1000);
  }
  const markerSample = profile.samples.findIndex(
    (id) => nodes.get(id)?.callFrame.functionName === '__benchClockMarker',
  );
  const offset = markerSample < 0 ? null : times[markerSample] - timing.markedAt;
  const add = (map: Map<string, number>, key: string, ms: number) =>
    map.set(key, (map.get(key) ?? 0) + ms);
  let next = 0;
  for (let i = 0; i < profile.samples.length; i++) {
    const ms = (profile.timeDeltas[i] ?? 0) / 1000;
    const { subsystem, label } = await ownerOf(profile.samples[i]);
    add(bySubsystem, subsystem, ms);
    if (subsystem === 'idle') continue;
    const key = `${subsystem} · ${label}`;
    add(byFunction, key, ms);
    if (offset === null) continue;
    const at = times[i] - offset;
    while (next < slow.length && slow[next].to < at) next++;
    if (next < slow.length && at >= slow[next].from) {
      add(slowBySubsystem, subsystem, ms);
      add(slowByFunction, key, ms);
    }
  }
  const round = (v: number) => Number(v.toFixed(1));
  const table = (map: Map<string, number>, total: number) =>
    Object.fromEntries(
      [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => [k, { ms: round(v), share: Number((v / total).toFixed(3)) }]),
    );
  const ranked = (map: Map<string, number>) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([k, v]) => `${round(v)} ms  ${k}`);
  const slowMs = [...slowBySubsystem.values()].reduce((sum, v) => sum + v, 0);
  return {
    subsystems: table(bySubsystem, elapsedMs),
    top: ranked(byFunction),
    slowFrames:
      offset === null
        ? null
        : {
            count: slow.length,
            thresholdMs: round(threshold),
            // Per slow frame, by subsystem: sampled self time inside its callbacks.
            perFrameMs: Object.fromEntries(
              [...slowBySubsystem.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => [k, round(v / Math.max(1, slow.length))]),
            ),
            subsystems: table(slowBySubsystem, slowMs || 1),
            top: ranked(slowByFunction),
          },
  };
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

export async function main() {
  const base = arg('url', 'http://localhost:8117').replace(/\/$/, '');
  const deviceName = arg('device', 'desktop');
  const named = DEVICES[deviceName];
  if (!named)
    throw new Error(`unknown device ${deviceName}; one of ${Object.keys(DEVICES).join(', ')}`);
  // `--dpr=`: the device at another pixel ratio (a fill-rate experiment).
  const dpr = Number(arg('dpr', '')) || null;
  const device = dpr ? { ...named, deviceScaleFactor: dpr } : named;
  const gpu = arg('gpu', 'real');
  const qualityArg = arg('quality', '');
  const quality = qualityArg === '' ? null : qualityArg;
  const wanted = arg('scenes', 'all');
  const scenes = wanted === 'all' ? SCENES : SCENES.filter((s) => wanted.split(',').includes(s.id));
  if (scenes.length === 0) throw new Error(`no scene matches ${wanted}`);

  const browser: Browser = await chromium.launch({
    headless: !process.argv.includes('--headed'),
    args:
      gpu === 'real'
        ? ['--use-angle=gl', '--ignore-gpu-blocklist', '--enable-gpu-rasterization']
        : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    // WSL2: Mesa's D3D12 driver is the way to the host GPU; harmless elsewhere.
    env: { ...process.env, ...(gpu === 'real' ? { GALLIUM_DRIVER: 'd3d12' } : {}) },
  });
  const results = [];
  for (const scene of scenes) {
    const context = await browser.newContext({
      viewport: device.viewport,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.mobile,
      hasTouch: device.mobile,
    });
    try {
      const result = await benchScene(context, base, scene, device, quality);
      results.push(result);
      console.error(
        `${scene.id.padEnd(10)} ${String(result.fps).padStart(5)} fps  cpu p50 ${result.cpuMs.p50} p95 ${result.cpuMs.p95}  gpu p50 ${result.gpuMs?.p50 ?? '—'} p95 ${result.gpuMs?.p95 ?? '—'}  draws ${result.perFrame.draws.p50}  tris ${result.perFrame.triangles.p50}  gpu timer ${result.gpuTimedBy.map > 0 ? 'map' : 'bench'}  ${result.renderer}`,
      );
    } catch (cause) {
      results.push({ scene: scene.id, error: String(cause).slice(0, 400) });
      console.error(`${scene.id}: ${String(cause).slice(0, 200)}`);
    } finally {
      await context.close();
    }
  }
  await browser.close();
  const output = {
    at: new Date().toISOString(),
    url: base,
    device: { name: deviceName, ...device },
    gpu,
    quality,
    results,
  };
  const out = arg('out', '');
  if (out) writeFileSync(out, `${JSON.stringify(output, null, 2)}\n`);
  else console.log(JSON.stringify(output, null, 2));
}

if (import.meta.main) {
  main().catch((cause) => {
    console.error(cause);
    process.exit(1);
  });
}

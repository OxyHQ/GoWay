/**
 * The map's performance benchmark: fixed camera paths over the heaviest
 * scenes GoWay draws, every 3D feature on, measured the same way on any
 * commit (`docs/MAP_PERFORMANCE.md` → "The benchmark").
 *
 *   bun run --cwd packages/frontend bench:map --url=http://localhost:8117 \
 *     [--scenes=eixample,manhattan] [--device=desktop|laptop|pixel6a|iphone12] \
 *     [--gpu=real|software] [--quality=auto|low|medium|high] [--out=bench.json]
 *
 * The page needs the dev server (query flags are honoured only in a
 * development build) with the city and road archives served
 * (`GOWAY_CITY_TILES_ARCHIVE`, see `docs/MAP_CITY_LIFE.md` → Turning it on).
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
  /** Development query flags (the map-feature registry's dev parameters). */
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

/**
 * Installed in every page before any of its scripts. Self-contained: it gets
 * the counter's source and nothing else.
 */
function pageProbe(args: { counterSource: string; stateSource: string; at: string | null }) {
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
      instrument(mapGl, state);
      timer = mapGl.getExtension('EXT_disjoint_timer_query_webgl2') as typeof timer;
    }
    return context;
  } as typeof getContext;

  interface FrameRecord {
    t: number;
    cpu: number;
    gpu: number | null;
    gl: Record<string, number>;
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
  let query: WebGLQuery | null = null;
  const pending: Array<{ query: WebGLQuery; frame: FrameRecord }> = [];

  const closeTick = () => {
    if (tick < 0) return;
    const record: FrameRecord = { t: tick, cpu, gpu: null, gl: { ...state.frame } };
    for (const key of Object.keys(state.frame)) state.frame[key] = 0;
    if (mapGl && timer && query) {
      mapGl.endQuery(timer.TIME_ELAPSED_EXT);
      pending.push({ query, frame: record });
      query = null;
    }
    if (record.gl.draws > 0) frames.push(record);
    cpu = 0;
  };
  const pollQueries = () => {
    if (!mapGl || !timer) return;
    const disjoint = mapGl.getParameter(timer.GPU_DISJOINT_EXT);
    while (pending.length > 0) {
      const { query: q, frame } = pending[0];
      if (!mapGl.getQueryParameter(q, mapGl.QUERY_RESULT_AVAILABLE)) break;
      pending.shift();
      if (!disjoint) frame.gpu = mapGl.getQueryParameter(q, mapGl.QUERY_RESULT) / 1e6;
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
        if (mapGl && timer && !query && pending.length < 8) {
          query = mapGl.createQuery();
          if (query) mapGl.beginQuery(timer.TIME_ELAPSED_EXT, query);
        }
      }
      const started = performance.now();
      try {
        callback(t);
      } finally {
        cpu += performance.now() - started;
      }
    });

  w.__bench = {
    reset() {
      closeTick();
      frames.length = 0;
      longTaskMs = 0;
      longTasks = 0;
    },
    take() {
      closeTick();
      pollQueries();
      return { frames: frames.splice(0), longTaskMs, longTasks };
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
    perf: '1',
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
    const cityQuiet = status.city === null ? scene.camera.zoom < 15 : status.city.pending === 0;
    const lifeReady = !scene.life || (status.agents ?? 0) > 0;
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
  });
  const cdp = await context.newCDPSession(page);
  await page.goto(sceneUrl(base, scene, quality), { waitUntil: 'load', timeout: 120_000 });
  await page.waitForSelector('canvas.maplibregl-canvas', { timeout: 60_000 });
  // Load at full speed; throttle only what is measured.
  const notes = await settle(page, scene);
  if (device.cpuThrottle > 1)
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: device.cpuThrottle });
  await page.evaluate(() =>
    (globalThis as unknown as { __bench: { reset(): void } }).__bench.reset(),
  );
  const started = Date.now();
  await runPath(page, scene.path, scene.durationMs, device.viewport);
  const elapsed = Date.now() - started;
  const taken = await page.evaluate(
    () =>
      (globalThis as unknown as { __bench: { take(): unknown } }).__bench.take() as {
        frames: FrameRecord[];
        longTaskMs: number;
        longTasks: number;
      },
  );
  const frames = taken.frames;
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
    ...(process.argv.includes('--raw') ? { raw: frames } : {}),
    // Share of the measured time the main thread spent in long tasks (> 50 ms).
    longTasks: {
      count: taken.longTasks,
      ms: Math.round(taken.longTaskMs),
      share: Number((taken.longTaskMs / elapsed).toFixed(2)),
    },
    ...after,
  };
}

function arg(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

export async function main() {
  const base = arg('url', 'http://localhost:8117').replace(/\/$/, '');
  const deviceName = arg('device', 'desktop');
  const device = DEVICES[deviceName];
  if (!device)
    throw new Error(`unknown device ${deviceName}; one of ${Object.keys(DEVICES).join(', ')}`);
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
        `${scene.id.padEnd(10)} ${String(result.fps).padStart(5)} fps  cpu p50 ${result.cpuMs.p50} p95 ${result.cpuMs.p95}  gpu p50 ${result.gpuMs?.p50 ?? '—'} p95 ${result.gpuMs?.p95 ?? '—'}  draws ${result.perFrame.draws.p50}  tris ${result.perFrame.triangles.p50}  ${result.renderer}`,
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

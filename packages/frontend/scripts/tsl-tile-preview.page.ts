/**
 * The browser host of the native-3D phase 1 prototype: a canvas, the tile's
 * bytes, and `createCityTileView` — the shared module the Android prototype
 * runs too (`docs/MAP_NATIVE_3D.md`). Served by `tsl-tile-preview.ts`.
 *
 * `?backend=webgl` draws through three's WebGL2 backend, `?backend=webgpu`
 * through the browser's WebGPU; `?appearance=dark`; `?frames=N`. The result
 * lands in `window.__tilePreview` (and on the page) for the driver to read.
 */
import { createCityTileView } from '@/components/map/engine/city3d/tsl/cityTileView';

interface Result {
  ok: boolean;
  error?: string;
  backend?: string;
  meshMs?: number;
  initMs?: number;
  firstFrameMs?: number;
  frameCpuMs?: { p50: number; p95: number };
  frameIntervalMs?: { p50: number; p95: number };
  vertices?: number;
  triangles?: number;
  draws?: number;
  bytes?: number;
}

function percentiles(values: number[]): { p50: number; p95: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) =>
    Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))].toFixed(2));
  return { p50: at(0.5), p95: at(0.95) };
}

async function main(): Promise<Result> {
  const params = new URLSearchParams(window.location.search);
  const backend = params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl';
  const appearance = params.get('appearance') === 'dark' ? 'dark' : 'light';
  const frames = Math.max(1, Number(params.get('frames') ?? 120));
  const [z, x, y] = (params.get('tile') ?? '15/16580/12236').split('/').map(Number);

  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
  document.body.append(canvas);
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * ratio);
  canvas.height = Math.round(window.innerHeight * ratio);

  const bytes = await (await fetch('/tile.mvt')).arrayBuffer();
  const view = await createCityTileView({
    canvas,
    forceWebGL: backend === 'webgl',
    width: canvas.width,
    height: canvas.height,
    bytes,
    tile: { z, x, y },
    appearance,
    now: () => performance.now(),
  });

  const firstFrameMs = view.frame(30);
  const cpu: number[] = [];
  const intervals: number[] = [];
  let last = performance.now();
  for (let i = 0; i < frames; i++) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const now = performance.now();
    intervals.push(now - last);
    last = now;
    cpu.push(view.frame(30 + (i * 360) / frames));
  }
  // End on the reference view, so a screenshot is comparable across hosts.
  view.frame(30);
  return {
    ok: true,
    ...view.stats,
    meshMs: Number(view.stats.meshMs.toFixed(1)),
    initMs: Number(view.stats.initMs.toFixed(1)),
    firstFrameMs: Number(firstFrameMs.toFixed(1)),
    frameCpuMs: percentiles(cpu),
    frameIntervalMs: percentiles(intervals),
  };
}

const target = window as unknown as { __tilePreview?: Result };
main()
  .then((result) => {
    target.__tilePreview = result;
  })
  .catch((cause: unknown) => {
    target.__tilePreview = { ok: false, error: String(cause) };
  })
  .finally(() => {
    const pre = document.createElement('pre');
    pre.style.cssText =
      'position:fixed;left:8px;top:8px;margin:0;font:11px monospace;background:#fffc;padding:4px';
    pre.textContent = JSON.stringify(target.__tilePreview, null, 1);
    pre.id = 'result';
    document.body.append(pre);
  });

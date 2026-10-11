/**
 * The map's performance runtime on the web (`docs/MAP_PERFORMANCE.md`): one
 * per MapLibre map, loaded as its own small lazy chunk once the map is ready.
 *
 *  - **Pixel ratio**: the quality profile's clamp, and dynamic resolution
 *    (`dynamicResolution.ts`) while the 3D city is attached — the basemap
 *    alone keeps its ratio, so a flat map's labels never go soft.
 *  - **GPU tier**: the renderer string, read from the map's own context, and
 *    once per device the warm-up benchmark (`gpuBenchmark.web.ts`) when the 3D
 *    city first attaches, handed to the map-feature store to keep.
 *  - **The perf HUD** (development builds, or `?perf=1` in any build): FPS,
 *    frame time, main-thread time per part of the frame, GPU time where the
 *    browser has a timer, draw calls, triangles, uploads, passes, GPU memory
 *    (estimated) and the JS heap — the same counters the benchmark and the CI
 *    gate use (`glCounters.ts`). Also published on `globalThis.__gowayPerf`.
 *
 * The animation clock is NOT here: it must exist before any feature that
 * animates attaches, so `MapCanvas.web.tsx` creates it with the map
 * (`animationClock.ts`) and hands it to this runtime and to the layers.
 *
 * MapLibre-specific, and only reached by `import()` from `MapCanvas.web.tsx`.
 * It times frames by wrapping the map's own `_render` — an internal method,
 * guarded: on a MapLibre without it the runtime keeps the clamp and the GPU
 * tier and simply measures nothing.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

import {
  combineGpuEvidence,
  GPU_RECORD_VERSION,
  type GpuTierRecord,
} from '@/lib/map/quality/gpuTier';
import { clampPixelRatio, type QualityProfile } from '@/lib/map/quality/profile';

import type { FrameProbe } from '../engine/city3d/cityEngine';
import type { AnimationClock } from './animationClock';
import { DynamicResolution } from './dynamicResolution';
import { SectionTimer, summarise, Window } from './frameStats';
import {
  createGlCounterState,
  type GlFrameCounts,
  instrumentWebGl2,
  resetGlFrame,
} from './glCounters';
import { rendererOf, runGpuBenchmark } from './gpuBenchmark.web';

export interface MapRuntimeOptions {
  quality: QualityProfile;
  clock: AnimationClock;
  /** Show the HUD and count every GL call (development, `?perf=1`). */
  hud: boolean;
  /** What the store holds for this device's GPU (`mapFeatureStore`), or `null`. */
  gpuRecord: GpuTierRecord | null;
  /** Keep a new GPU record (the store persists it; the profile follows). */
  onGpuRecord: (record: GpuTierRecord) => void;
}

export interface MapRuntime {
  /** The probe the city engine brackets its frame parts with; `null` without the HUD. */
  readonly probe: FrameProbe | null;
  setQuality(profile: QualityProfile): void;
  /** The 3D city attached or detached: dynamic resolution and the GPU benchmark follow it. */
  set3d(active: boolean): void;
  dispose(): void;
}

export interface PerfSnapshot {
  quality: { tier: string; reason: string };
  /** The map context's renderer: whether these numbers are a real GPU's. */
  renderer: string;
  pixelRatio: number;
  fps: number;
  frameMs: { p50: number; p95: number };
  cpuMs: { p50: number; p95: number };
  gpuMs: { p50: number; p95: number } | null;
  sectionsMs: Record<string, number>;
  gl: GlFrameCounts | null;
  glBySection: Record<string, GlFrameCounts>;
  memory: { gpuBytes: number | null; jsHeapBytes: number | null };
  clock: { paused: boolean; animating: string[] };
}

interface TimerQueryExtension {
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
}

/** Below this gap the map is rendering continuously; above it, it was idle. */
const CONTINUOUS_GAP_MS = 250;

export function attachMapRuntime(map: MapLibreMap, options: MapRuntimeOptions): MapRuntime {
  let quality = options.quality;
  let threeD = false;
  let disposed = false;
  let gpuRecord = options.gpuRecord;
  const devicePixelRatio = () => (typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1);
  const baseRatio = () => clampPixelRatio(devicePixelRatio(), quality);

  const drs = new DynamicResolution({
    min: Math.min(quality.render.minPixelRatio, baseRatio()),
    max: baseRatio(),
    targetMs: quality.render.targetFrameMs,
    now: () => performance.now(),
  });
  // A new pixel ratio resizes the canvas, and a resize during a gesture
  // drops it — measured: with a ratio change mid-drag the map stopped
  // following the pointer, and followed it again with the change held back.
  // So a change waits until no pointer is down, nothing has been touched for
  // QUIET_MS and the camera is at rest; the latest one wins.
  const QUIET_MS = 400;
  let wantedRatio: number | null = null;
  let pointerDown = false;
  let lastInput = 0;
  const container = map.getContainer();
  const onInput = () => {
    lastInput = performance.now();
  };
  const onDown = () => {
    pointerDown = true;
    onInput();
  };
  const onUp = () => {
    pointerDown = false;
    onInput();
  };
  for (const type of ['pointermove', 'wheel', 'touchmove', 'keydown'] as const) {
    container.addEventListener(type, onInput, { passive: true, capture: true });
  }
  container.addEventListener('pointerdown', onDown, { passive: true, capture: true });
  window.addEventListener('pointerup', onUp, { passive: true, capture: true });
  window.addEventListener('pointercancel', onUp, { passive: true, capture: true });
  const settleRatio = () => {
    if (disposed || wantedRatio === null) return;
    if (pointerDown || performance.now() - lastInput < QUIET_MS || map.isMoving()) {
      setTimeout(settleRatio, QUIET_MS / 2);
      return;
    }
    const ratio = wantedRatio;
    wantedRatio = null;
    if (Math.abs(map.getPixelRatio() - ratio) >= 0.01) map.setPixelRatio(ratio);
  };
  const applyRatio = (ratio: number) => {
    const waiting = wantedRatio !== null;
    wantedRatio = ratio;
    // Never inside MapLibre's own frame either: a resize there re-enters it.
    if (!waiting) setTimeout(settleRatio, 0);
  };
  applyRatio(baseRatio());

  // ── GL: the map's own context ──
  const gl = map.getCanvas().getContext('webgl2');
  const renderer = gl ? rendererOf(gl) : '';
  const glState = options.hud && gl ? createGlCounterState() : null;
  if (glState && gl) instrumentWebGl2(gl, glState);
  const timer = gl
    ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerQueryExtension | null)
    : null;

  // The renderer string alone, at once: a known GPU resolves its tier before
  // any benchmark; a new GPU (or driver mask) replaces an older record.
  if (renderer && (!gpuRecord || gpuRecord.renderer !== renderer)) {
    gpuRecord = {
      v: GPU_RECORD_VERSION,
      renderer,
      megapixelsPerMs: null,
      tier: combineGpuEvidence({ renderer, megapixelsPerMs: null }),
      at: Date.now(),
    };
    options.onGpuRecord(gpuRecord);
  }
  let benchmarkScheduled = false;
  const maybeBenchmark = () => {
    if (benchmarkScheduled || !gpuRecord || gpuRecord.megapixelsPerMs !== null) return;
    benchmarkScheduled = true;
    // When the map has nothing left to load, off the critical path.
    map.once('idle', () => {
      const run = () => {
        if (disposed) return;
        const result = runGpuBenchmark();
        if (!result || !gpuRecord) return;
        // Its own context landed on another adapter (a software fallback
        // beside a busy GPU): not a measurement of the map's GPU.
        if (result.renderer !== gpuRecord.renderer) return;
        gpuRecord = {
          ...gpuRecord,
          megapixelsPerMs: result.megapixelsPerMs,
          tier: combineGpuEvidence({
            renderer: gpuRecord.renderer,
            megapixelsPerMs: result.megapixelsPerMs,
          }),
          at: Date.now(),
        };
        options.onGpuRecord(gpuRecord);
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 2000 });
      else setTimeout(run, 200);
    });
  };

  // ── Frame timing: wrap the map's render ──
  const sections = new SectionTimer(() => performance.now());
  const intervals = new Window(120);
  const cpu = new Window(120);
  const gpu = new Window(120);
  let lastFrameEnd = 0;
  let lastGl: GlFrameCounts | null = null;
  const pendingQueries: WebGLQuery[] = [];

  const pollQueries = () => {
    if (!gl || !timer) return;
    const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT);
    while (pendingQueries.length > 0) {
      const query = pendingQueries[0];
      if (!gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE)) break;
      pendingQueries.shift();
      if (!disjoint) gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      gl.deleteQuery(query);
    }
  };

  const internal = map as unknown as { _render?: (time?: number) => unknown };
  const originalRender = internal._render;
  if (typeof originalRender === 'function') {
    internal._render = function (this: unknown, time?: number) {
      const started = performance.now();
      // GPU time of the whole frame, where the browser offers a timer, while
      // it matters: the HUD, or dynamic resolution with the 3D city on.
      const timing = gl && timer && (glState !== null || threeD) && pendingQueries.length < 6;
      const query = timing ? gl.createQuery() : null;
      if (query && timer) gl?.beginQuery(timer.TIME_ELAPSED_EXT, query);
      try {
        return originalRender.call(this, time);
      } finally {
        if (query && timer && gl) {
          gl.endQuery(timer.TIME_ELAPSED_EXT);
          pendingQueries.push(query);
        }
        const ended = performance.now();
        const frameCpu = ended - started;
        cpu.push(frameCpu);
        const gap = lastFrameEnd > 0 ? ended - lastFrameEnd : Number.POSITIVE_INFINITY;
        lastFrameEnd = ended;
        const continuous = gap < CONTINUOUS_GAP_MS;
        if (continuous) intervals.push(gap);
        pollQueries();
        sections.endFrame();
        if (glState) {
          lastGl = { ...glState.frame };
          resetGlFrame(glState.frame);
          for (const counts of Object.values(glState.bySection)) resetGlFrame(counts);
        }
        if (threeD && quality.render.dynamicResolution) {
          const gpuLast = gpu.samples[gpu.samples.length - 1];
          const next = drs.sample({
            intervalMs: continuous ? gap : null,
            costMs: timer && gpuLast !== undefined ? Math.max(frameCpu, gpuLast) : null,
          });
          if (next !== null) applyRatio(next);
        }
      }
    };
  }

  // ── The probe: frame parts for the HUD ──
  const probe: FrameProbe | null = glState
    ? {
        enter(section) {
          sections.enter(section);
          glState.section = section;
        },
        leave() {
          sections.leave();
          glState.section = sections.current;
        },
      }
    : null;

  // ── The HUD ──
  const snapshot = (): PerfSnapshot => {
    const frame = summarise(intervals.samples);
    const main = summarise(cpu.samples);
    const gpuSummary = gpu.samples.length > 0 ? summarise(gpu.samples) : null;
    const sectionsMs: Record<string, number> = {};
    let inSections = 0;
    for (const [name, window] of sections.windows) {
      const mean = summarise(window.samples).mean;
      sectionsMs[name] = mean;
      inSections += mean;
    }
    sectionsMs.maplibre = Math.max(0, main.mean - inSections);
    const heap = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
    const memory = glState?.memory;
    const canvas = map.getCanvas();
    return {
      quality: { tier: quality.tier, reason: quality.reason },
      renderer,
      pixelRatio: map.getPixelRatio(),
      fps: frame.n > 0 ? 1000 / frame.mean : 0,
      frameMs: { p50: frame.p50, p95: frame.p95 },
      cpuMs: { p50: main.p50, p95: main.p95 },
      gpuMs: gpuSummary ? { p50: gpuSummary.p50, p95: gpuSummary.p95 } : null,
      sectionsMs,
      gl: lastGl,
      glBySection: glState ? { ...glState.bySection } : {},
      memory: {
        // Buffers, textures and renderbuffers, plus the canvas's own
        // (colour ×2 for double buffering, depth-stencil).
        gpuBytes: memory
          ? memory.buffers +
            memory.textures +
            memory.renderbuffers +
            canvas.width * canvas.height * 12
          : null,
        jsHeapBytes: heap?.usedJSHeapSize ?? null,
      },
      clock: { paused: options.clock.paused, animating: options.clock.animating() },
    };
  };

  let hud: HTMLElement | null = null;
  let hudTimer: ReturnType<typeof setInterval> | null = null;
  if (options.hud && typeof document !== 'undefined') {
    hud = document.createElement('pre');
    hud.setAttribute('aria-hidden', 'true');
    hud.dataset.gowayPerfHud = '';
    Object.assign(hud.style, {
      // Bottom right, above the location button and the credit: clear of the
      // mark, the search panel, the top-right stack and the time scrubber.
      position: 'absolute',
      right: '8px',
      bottom: '128px',
      zIndex: '5',
      margin: '0',
      padding: '6px 8px',
      font: '11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace',
      // A diagnostic overlay, not product UI: legible on any map.
      background: 'rgba(0, 0, 0, 0.72)',
      color: '#e8f0e8',
      borderRadius: '6px',
      pointerEvents: 'none',
      whiteSpace: 'pre',
    });
    map.getContainer().appendChild(hud);
    const mb = (bytes: number | null) =>
      bytes === null ? '—' : `${(bytes / 1048576).toFixed(0)} MB`;
    const ms = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : '—');
    hudTimer = setInterval(() => {
      const s = snapshot();
      (globalThis as { __gowayPerf?: PerfSnapshot }).__gowayPerf = s;
      if (!hud) return;
      const parts = Object.entries(s.sectionsMs)
        .filter(([, v]) => v >= 0.05)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${ms(v)}`)
        .join('  ');
      const g = s.gl;
      hud.textContent = [
        `${s.quality.tier.toUpperCase()} · ${s.quality.reason} · dpr ${s.pixelRatio.toFixed(2)}`,
        s.renderer.slice(0, 64),
        `${s.fps.toFixed(0)} fps · frame p50 ${ms(s.frameMs.p50)} p95 ${ms(s.frameMs.p95)} ms`,
        `cpu p50 ${ms(s.cpuMs.p50)} p95 ${ms(s.cpuMs.p95)} · gpu ${s.gpuMs ? `p50 ${ms(s.gpuMs.p50)} p95 ${ms(s.gpuMs.p95)}` : 'no timer'}`,
        `cpu ms: ${parts}`,
        g
          ? `draws ${g.draws} · tris ${(g.triangles / 1e6).toFixed(2)} M · inst ${g.instances} · passes ${g.offscreenPasses} · up ${(g.uploadBytes / 1024).toFixed(0)} KB`
          : '',
        `gpu mem ~${mb(s.memory.gpuBytes)} · js heap ${mb(s.memory.jsHeapBytes)}`,
        `clock ${s.clock.paused ? 'PAUSED' : 'running'}${s.clock.animating.length ? ` · ${s.clock.animating.join(', ')}` : ''}`,
      ]
        .filter(Boolean)
        .join('\n');
    }, 250);
  }

  return {
    probe,
    setQuality(profile) {
      quality = profile;
      const base = baseRatio();
      const next = drs.configure({
        min: Math.min(profile.render.minPixelRatio, base),
        max: base,
        targetMs: profile.render.targetFrameMs,
      });
      applyRatio(threeD && next !== null ? next : threeD ? drs.ratio : base);
    },
    set3d(active) {
      if (threeD === active) return;
      threeD = active;
      if (active) maybeBenchmark();
      // Leaving 3D: the flat map's own ratio again.
      applyRatio(active ? drs.ratio : baseRatio());
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (typeof originalRender === 'function') internal._render = originalRender;
      for (const type of ['pointermove', 'wheel', 'touchmove', 'keydown'] as const) {
        container.removeEventListener(type, onInput, { capture: true });
      }
      container.removeEventListener('pointerdown', onDown, { capture: true });
      window.removeEventListener('pointerup', onUp, { capture: true });
      window.removeEventListener('pointercancel', onUp, { capture: true });
      if (hudTimer) clearInterval(hudTimer);
      hud?.remove();
      hud = null;
      for (const query of pendingQueries) gl?.deleteQuery(query);
      pendingQueries.length = 0;
    },
  };
}

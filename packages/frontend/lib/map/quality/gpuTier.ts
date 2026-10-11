/**
 * Which quality tier a GPU can hold, from two pieces of evidence: the
 * renderer string WebGL reports (`WEBGL_debug_renderer_info`) and a short
 * warm-up benchmark (`components/map/perf/gpuBenchmark.web.ts`). Pure: the
 * strings and the timings come in, a tier goes out — the web map, native and
 * the benchmark script share it.
 *
 * Neither piece is trusted alone. A renderer string can be masked ("Apple
 * GPU" names every Apple chip from the A9 to the M4; Firefox and Safari round
 * it down), and a benchmark can be unlucky (a thermal throttle, a background
 * tab). So: a software rasteriser is always `low`; otherwise the benchmark
 * decides, and the renderer string caps or lifts it by at most one tier.
 */
import type { DeviceClass, QualityTier } from './profile';

/** CPU rasterisers: SwiftShader (headless Chromium), llvmpipe, Microsoft Basic Render. */
const SOFTWARE_RENDERER = /swiftshader|llvmpipe|softpipe|basic render|software/i;

/** What the renderer string says, before any benchmark. `null`: it does not say. */
export function tierFromRenderer(renderer: string): QualityTier | null {
  const r = renderer.toLowerCase();
  if (SOFTWARE_RENDERER.test(r)) return 'low';
  // Discrete desktop GPUs.
  if (/(geforce|nvidia).*(rtx|gtx 1[06-9]|gtx 16)|radeon (rx|pro)|quadro|\barc a\d/.test(r)) {
    return 'high';
  }
  // Apple silicon laptops and desktops: M1 base and up hold the medium budget;
  // Pro/Max/Ultra the high one.
  if (/apple m\d (pro|max|ultra)/.test(r)) return 'high';
  if (/apple m\d/.test(r)) return 'medium';
  // Integrated laptop GPUs of 2020+.
  if (/iris\(r\) xe|iris xe|radeon(\(tm\))? (graphics|vega)|radeon 7\d0m|intel.*arc/.test(r)) {
    return 'medium';
  }
  // Older Intel integrated, phone GPUs (Adreno, Mali, PowerVR, Xclipse).
  if (/intel.*(uhd|hd) graphics|adreno|mali|powervr|xclipse|immortalis/.test(r)) return 'low';
  return null;
}

/**
 * The benchmark's verdict: megapixels of the reference shader filled per
 * millisecond (`gpuBenchmark.web.ts` draws a fixed fragment load and times
 * it to completion). Thresholds are from `docs/MAP_PERFORMANCE.md` → "GPU
 * tier": a medium laptop must fill the map's heaviest per-pixel pass (the
 * sky's ground pass with shadows) for a 1080p frame in ≈ 2 ms.
 */
export const BENCHMARK_MPX_PER_MS = { medium: 0.6, high: 3 } as const;

export function tierFromBenchmark(megapixelsPerMs: number): QualityTier {
  if (!Number.isFinite(megapixelsPerMs) || megapixelsPerMs <= 0) return 'low';
  if (megapixelsPerMs >= BENCHMARK_MPX_PER_MS.high) return 'high';
  if (megapixelsPerMs >= BENCHMARK_MPX_PER_MS.medium) return 'medium';
  return 'low';
}

const ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

/**
 * Combine both: a software rasteriser is `low` whatever it scores; otherwise
 * the benchmark, moved at most one tier toward what the renderer string says.
 */
export function combineGpuEvidence(input: {
  renderer: string;
  megapixelsPerMs: number | null;
}): QualityTier | null {
  if (SOFTWARE_RENDERER.test(input.renderer)) return 'low';
  const named = tierFromRenderer(input.renderer);
  if (input.megapixelsPerMs === null) return named;
  const measured = tierFromBenchmark(input.megapixelsPerMs);
  if (!named) return measured;
  const a = ORDER.indexOf(measured);
  const b = ORDER.indexOf(named);
  return ORDER[a + Math.sign(b - a)];
}

/**
 * The device class from what a page can see. Pure (the caller reads the
 * values): a coarse pointer with a short side under 600 CSS px is a phone,
 * under 1,100 a tablet; anything with a fine pointer is a desktop.
 */
export function deviceClassOf(input: {
  coarsePointer: boolean;
  shortSidePx: number;
  /** `navigator.userAgent`, for the iPad that reports a desktop UA and a coarse pointer. */
  userAgent?: string;
}): DeviceClass {
  if (!input.coarsePointer) return 'desktop';
  if (input.shortSidePx < 600 || /iphone|android.*mobile/i.test(input.userAgent ?? '')) {
    return 'phone';
  }
  if (input.shortSidePx < 1100) return 'tablet';
  return 'desktop';
}

/**
 * What is cached on the device after one benchmark, so later visits resolve
 * their tier before the first frame. Keyed by the renderer string and the
 * benchmark's version: a new GPU, driver mask or benchmark measures again.
 */
export interface GpuTierRecord {
  v: number;
  renderer: string;
  megapixelsPerMs: number | null;
  tier: QualityTier | null;
  /** `Date.now()` when measured; a record older than {@link GPU_RECORD_MAX_AGE_MS} is re-measured. */
  at: number;
}

export const GPU_RECORD_VERSION = 1;
export const GPU_RECORD_MAX_AGE_MS = 30 * 24 * 3600 * 1000;

export function parseGpuRecord(raw: unknown, now: number): GpuTierRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<GpuTierRecord>;
  if (r.v !== GPU_RECORD_VERSION || typeof r.renderer !== 'string' || typeof r.at !== 'number') {
    return null;
  }
  if (now - r.at > GPU_RECORD_MAX_AGE_MS || r.at > now + 60_000) return null;
  const tier = r.tier === null || ORDER.includes(r.tier as QualityTier) ? (r.tier ?? null) : null;
  const mpx = typeof r.megapixelsPerMs === 'number' ? r.megapixelsPerMs : null;
  return { v: GPU_RECORD_VERSION, renderer: r.renderer, megapixelsPerMs: mpx, tier, at: r.at };
}

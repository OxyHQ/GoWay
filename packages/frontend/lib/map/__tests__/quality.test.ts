/**
 * The quality profile (`lib/map/quality/profile.ts`) and the GPU tier
 * (`gpuTier.ts`): which preset a choice, a device and a GPU resolve to, and
 * that the presets are ordered (`docs/MAP_PERFORMANCE.md`).
 */
import { describe, expect, test } from 'bun:test';

import {
  BENCHMARK_MPX_PER_MS,
  combineGpuEvidence,
  deviceClassOf,
  tierFromBenchmark,
  tierFromRenderer,
} from '@/lib/map/quality/gpuTier';
import {
  clampPixelRatio,
  parsePerformanceMode,
  QUALITY_PRESETS,
  type QualityTier,
  qualityFromSearch,
  resolveQuality,
} from '@/lib/map/quality/profile';

describe('resolveQuality', () => {
  test('auto: a phone is never high, whatever its GPU', () => {
    expect(resolveQuality({ mode: 'auto', device: 'phone', gpuTier: 'high' }).tier).toBe('medium');
    expect(resolveQuality({ mode: 'auto', device: 'phone', gpuTier: 'low' }).tier).toBe('low');
    expect(resolveQuality({ mode: 'auto', device: 'phone', gpuTier: null }).tier).toBe('low');
  });

  test('auto: a desktop follows its GPU, medium before it is measured', () => {
    for (const tier of ['low', 'medium', 'high'] as QualityTier[]) {
      expect(resolveQuality({ mode: 'auto', device: 'desktop', gpuTier: tier }).tier).toBe(tier);
    }
    expect(resolveQuality({ mode: 'auto', device: 'desktop', gpuTier: null }).tier).toBe('medium');
  });

  test('the person’s choice wins over the device', () => {
    expect(resolveQuality({ mode: 'high', device: 'phone', gpuTier: 'low' }).tier).toBe('high');
    const battery = resolveQuality({ mode: 'battery', device: 'desktop', gpuTier: 'high' });
    expect(battery.tier).toBe('low');
    // Slower and quicker to pause than the plain low preset.
    expect(battery.frame.animationHz).toBeLessThan(QUALITY_PRESETS.low.frame.animationHz);
    expect(battery.frame.idlePauseMs).toBeLessThan(QUALITY_PRESETS.low.frame.idlePauseMs);
    expect(battery.reason).toContain('battery');
  });

  test('every budget grows from low to high (no preset is accidentally cheaper above)', () => {
    const { low, medium, high } = QUALITY_PRESETS;
    const numbers = (p: typeof low) => [
      p.render.maxPixelRatio,
      p.city.drawBytes,
      p.city.drawVertices,
      p.city.cacheBytes,
      p.city.maxTiles,
      p.city.maxFullTiles,
      p.city.uploadBytesPerFrame,
      p.city.maxWorkers,
      p.city.treeBudget,
      p.city.treeRoadTiles,
      p.sky.shadowMapSize,
      p.life.cars,
      p.life.people,
      p.live.maxEntities,
      p.landmarks.max,
      p.streets.maxTiles,
      p.streets.drawTriangles,
      p.camera.volumeBytesPerTile,
      p.camera.footprintVertices,
      p.frame.animationHz,
    ];
    const [a, b, c] = [numbers(low), numbers(medium), numbers(high)];
    for (let i = 0; i < a.length; i++) {
      expect(a[i], `field ${i}`).toBeLessThanOrEqual(b[i]);
      expect(b[i], `field ${i}`).toBeLessThanOrEqual(c[i]);
    }
    // And the LOD tolerance shrinks (coarser on low).
    expect(low.city.pixelTolerance).toBeGreaterThan(medium.city.pixelTolerance);
    expect(medium.city.pixelTolerance).toBeGreaterThan(high.city.pixelTolerance);
  });

  test('phones hold the low budget inside iOS Safari’s memory (GPU cache well under 1 GB)', () => {
    const low = QUALITY_PRESETS.low;
    expect(low.city.cacheBytes).toBeLessThanOrEqual(96 * 1024 * 1024);
    expect(low.sky.shadowMapSize).toBe(0);
    expect(low.render.targetFrameMs).toBeCloseTo(33.3, 1);
  });

  test('the pixel ratio is clamped, never raised', () => {
    const low = resolveQuality({ mode: 'auto', device: 'phone', gpuTier: null });
    expect(clampPixelRatio(3, low)).toBe(low.render.maxPixelRatio);
    expect(clampPixelRatio(1, low)).toBe(1);
    expect(clampPixelRatio(Number.NaN, low)).toBe(1);
  });

  test('a stored mode is read leniently', () => {
    expect(parsePerformanceMode('battery')).toBe('battery');
    expect(parsePerformanceMode('turbo')).toBe('auto');
    expect(parsePerformanceMode(undefined)).toBe('auto');
  });

  test('?quality= forces a known preset, in any build', () => {
    expect(qualityFromSearch('?quality=low')).toBe('low');
    expect(qualityFromSearch('?perf=1&quality=high')).toBe('high');
    expect(qualityFromSearch('?quality=ultra')).toBeNull();
    expect(qualityFromSearch('')).toBeNull();
  });
});

describe('the GPU tier', () => {
  test('renderer strings', () => {
    const cases: Array<[string, QualityTier | null]> = [
      ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'low'],
      ['ANGLE (Mesa, llvmpipe (LLVM 19.1.7 256 bits), OpenGL ES 3.2)', 'low'],
      ['ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 5090), OpenGL 4.6)', 'high'],
      ['ANGLE (Intel, Intel(R) Iris(R) Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'medium'],
      ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'low'],
      ['Apple M1', 'medium'],
      ['Apple M2 Pro', 'high'],
      ['Adreno (TM) 642L', 'low'],
      ['Mali-G78', 'low'],
      ['Apple GPU', null],
      ['', null],
    ];
    for (const [renderer, tier] of cases) expect(tierFromRenderer(renderer), renderer).toBe(tier);
  });

  test('the benchmark’s thresholds', () => {
    expect(tierFromBenchmark(0.02)).toBe('low');
    expect(tierFromBenchmark(BENCHMARK_MPX_PER_MS.medium)).toBe('medium');
    expect(tierFromBenchmark(BENCHMARK_MPX_PER_MS.high)).toBe('high');
    expect(tierFromBenchmark(Number.NaN)).toBe('low');
  });

  test('a software rasteriser is low whatever it scores', () => {
    expect(combineGpuEvidence({ renderer: 'SwiftShader', megapixelsPerMs: 999 })).toBe('low');
  });

  test('the renderer string moves the benchmark at most one tier', () => {
    // A masked Apple GPU: the benchmark alone decides.
    expect(combineGpuEvidence({ renderer: 'Apple GPU', megapixelsPerMs: 5 })).toBe('high');
    // A named phone GPU that benchmarks high is pulled one tier down, not two.
    expect(combineGpuEvidence({ renderer: 'Adreno (TM) 740', megapixelsPerMs: 5 })).toBe('medium');
    // A discrete GPU that benchmarked low (unlucky run) is lifted one tier.
    expect(combineGpuEvidence({ renderer: 'NVIDIA GeForce RTX 4060', megapixelsPerMs: 0.1 })).toBe(
      'medium',
    );
    // Not benchmarked yet: the name, or nothing.
    expect(combineGpuEvidence({ renderer: 'Apple M1', megapixelsPerMs: null })).toBe('medium');
    expect(combineGpuEvidence({ renderer: 'Apple GPU', megapixelsPerMs: null })).toBeNull();
  });

  test('device classes', () => {
    expect(deviceClassOf({ coarsePointer: false, shortSidePx: 400 })).toBe('desktop');
    expect(deviceClassOf({ coarsePointer: true, shortSidePx: 390 })).toBe('phone');
    expect(deviceClassOf({ coarsePointer: true, shortSidePx: 820 })).toBe('tablet');
    expect(
      deviceClassOf({
        coarsePointer: true,
        shortSidePx: 900,
        userAgent: 'Mozilla (Linux; Android 14) Mobile',
      }),
    ).toBe('phone');
  });
});

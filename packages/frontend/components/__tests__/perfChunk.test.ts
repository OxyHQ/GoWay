/**
 * The performance runtime stays off the first paint (`docs/MAP_PERFORMANCE.md`).
 *
 * `MapCanvas.web.tsx` keeps only what must exist before the first frame in the
 * entry bundle — the quality profile (its pixel-ratio clamp and MSAA are
 * construction options) and the animation clock (every animating layer joins
 * it). Everything else — dynamic resolution, the GPU benchmark, the HUD and
 * its GL counters — is one lazy chunk, `perf/mapRuntime.web.ts`. Two ways to
 * break that pass every type check: a static import of the runtime, or one of
 * its parts imported by a second chunk (Expo hoists a shared module into the
 * first-paint `__common`; see `docs/MAP_3D_CITY.md`). Pinned from the source:
 */
import { describe, expect, test } from 'bun:test';

import { SOURCE_FILES as files } from './sourceScan';

function specifiers(text: string): { statics: string[]; dynamics: string[] } {
  const statics = [
    ...text.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+['"]([^'"]+)['"]/gm),
  ].map((m) => m[1]);
  const dynamics = [...text.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  return { statics, dynamics };
}

const RUNTIME = /(^|\/)perf\/mapRuntime\.web$/;
/** The runtime's own parts: only it may load them (and the scripts, which are not scanned). */
const PARTS = /(^|\/)(perf\/)?(gpuBenchmark\.web|glCounters|dynamicResolution|frameStats)$/;
const CLOCK = /(^|\/)perf\/animationClock$/;

describe('the perf runtime chunk', () => {
  test('the scan sees the perf modules (a vacuity check)', () => {
    for (const path of [
      'components/map/perf/mapRuntime.web.ts',
      'components/map/perf/animationClock.ts',
      'components/map/perf/glCounters.ts',
      'components/map/MapCanvas.web.tsx',
    ]) {
      expect(
        files.some((f) => f.path === path),
        path,
      ).toBe(true);
    }
  });

  test('the runtime is only ever imported dynamically, by MapCanvas.web.tsx', () => {
    const statics = files.filter((f) => specifiers(f.text).statics.some((s) => RUNTIME.test(s)));
    expect(statics.map((f) => f.path)).toEqual([]);
    const dynamics = files.filter((f) => specifiers(f.text).dynamics.some((s) => RUNTIME.test(s)));
    expect(dynamics.map((f) => f.path)).toEqual(['components/map/MapCanvas.web.tsx']);
  });

  test('its parts are reached at runtime only from the runtime', () => {
    const reachers = files
      .filter((f) => !f.path.startsWith('components/map/perf/'))
      .filter((f) => {
        const { statics, dynamics } = specifiers(f.text);
        return [...statics, ...dynamics].some((s) => PARTS.test(s));
      })
      .map((f) => f.path);
    expect(reachers).toEqual([]);
  });

  test('the clock is loaded at runtime by MapCanvas alone; the layers take it as a type', () => {
    const reachers = files
      .filter((f) => specifiers(f.text).statics.some((s) => CLOCK.test(s)))
      .map((f) => f.path);
    expect(reachers).toEqual(['components/map/MapCanvas.web.tsx']);
  });
});

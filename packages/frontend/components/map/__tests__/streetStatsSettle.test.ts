/**
 * The street detail's statistics settle when its tiles do — on a map that
 * draws a frame ONLY when something asks for one, as MapLibre does.
 *
 * The visibility gate's landmark views never settled (CI, #181: 250 s against
 * a 240 s timeout): the street renderer reported its counts at most every
 * 500 ms, the frame that drew its last tiles fell inside that window, and a
 * map at rest draws nothing after it — so `__gowayCityStreets.pending` read 2
 * for good while both tiles were on the screen. Counts are now reported the
 * frame they change (`statsDue`). The real engine, the real street renderer
 * and its real worker, over the synthetic city.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { createCityEngine } from '@/components/map/engine/city3d/cityEngine';
import {
  type CityStreetsStats,
  createCityStreets,
  STREET_STATS_INTERVAL_MS,
  statsDue,
} from '@/components/map/engine/cityStreets/streetRenderer';
import { cityMaterials } from '@/components/map/city3dStyle';
import { streetPaletteInput } from '@/lib/map/style/streetPalette';
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';

import { camera } from './fixtures/mapCamera';
import { createFakeWebGl2 } from './fixtures/fakeWebGl2';
import { SYNTHETIC_CENTRE, serveSyntheticCity, syntheticCoverage } from './fixtures/syntheticCity';

let server: ReturnType<typeof serveSyntheticCity>;
beforeAll(() => {
  server = serveSyntheticCity();
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.requestAnimationFrame ??= (fn: (t: number) => void) =>
    setTimeout(() => fn(performance.now()), 16);
  scope.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});
afterAll(() => server.stop());

describe('statsDue', () => {
  test('a changed count is reported at once; unchanged ones at most every interval', () => {
    expect(statsDue('4|4|0', '4|2|2', 1000, 999)).toBe(true);
    expect(statsDue('4|4|0', '4|4|0', 1000, 999)).toBe(false);
    expect(statsDue('4|4|0', '4|4|0', 1000 + STREET_STATS_INTERVAL_MS + 1, 1000)).toBe(true);
  });
});

describe('the street detail on a map at rest', () => {
  test('its last report says every wanted tile is in, with no frame after it', async () => {
    const { gl, canvas } = createFakeWebGl2(1280, 800);
    let streets: CityStreetsStats | null = null;
    let dirty = true;
    // A virtual clock, 1 ms per drawn frame: the whole load fits in
    // far under the statistics' interval, so a report that waits for the
    // interval never comes, deterministically (the bug's shape, made exact).
    const clock = { ms: 0 };
    const requestRepaint = () => {
      dirty = true;
    };
    const engine = createCityEngine({
      gl,
      canvas: canvas as unknown as HTMLCanvasElement,
      tileUrlTemplate: `${server.origin}/omt/{z}/{x}/{y}.pbf`,
      tileZoom: 14,
      sourceLayer: 'building',
      city: {
        tileUrlTemplate: `${server.origin}/city/{z}/{x}/{y}.pbf`,
        tileZoom: 15,
        sourceLayer: 'building',
        treeLayer: 'tree',
        coverage: syntheticCoverage(),
      },
      trees: null,
      palette: { low: '#e8e4dc', tall: '#d8d2c8', veryTall: '#c8c0b4', tallM: 60, veryTallM: 180 },
      light: { position: [1.15, 0, 0.5], intensity: 0.5, color: [1, 1, 1] },
      fade: { start: 15.5, end: 16.5 },
      requestRepaint,
      now: () => clock.ms,
      quality: { ...QUALITY_PRESETS.high, reason: 'gate' },
      sky: { appearance: 'light' },
      material: cityMaterials(),
      overlays: [
        createCityStreets({
          roadTileTemplate: `${server.origin}/roads/{z}/{x}/{y}.pbf`,
          roadCoverage: syntheticCoverage(),
          glyphTemplate: `${server.origin}/fonts/{fontstack}/{range}.pbf`,
          fontstack: 'Inter Bold',
          palette: streetPaletteInput(),
          quality: QUALITY_PRESETS.high.streets,
          requestRepaint,
          now: () => clock.ms,
          onStats: (s) => {
            streets = s;
          },
        }),
      ],
    });
    const c = camera({
      lng: SYNTHETIC_CENTRE.lng,
      lat: SYNTHETIC_CENTRE.lat,
      zoom: 18,
      pitch: 0,
      bearing: 0,
      width: 1280,
      height: 800,
    });
    const view = {
      mercatorToClip: c.mercatorToClip,
      zoom: c.zoom,
      center: c.center,
      bounds: c.bounds,
    };
    try {
      // A frame only when asked for one; stop once nothing has asked for 1.5 s.
      let quietSince = performance.now();
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline && performance.now() - quietSince < 1_500) {
        if (dirty) {
          dirty = false;
          clock.ms += 1;
          engine.prerender(view);
          engine.render(view);
          quietSince = performance.now();
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      // Fewer frames than the interval holds: only a report on change got here.
      expect(clock.ms).toBeLessThan(STREET_STATS_INTERVAL_MS);
      const last = streets as CityStreetsStats | null;
      expect(last).not.toBeNull();
      expect(last?.tilesWanted).toBeGreaterThan(0);
      expect(last?.pending).toBe(0);
      expect(last?.tilesSettled).toBe(last?.tilesWanted);
      expect(last?.tilesDrawn).toBeGreaterThan(0);
    } finally {
      engine.dispose();
    }
  }, 40_000);
});

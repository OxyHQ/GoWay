/**
 * When a city tile's trees arrive, against the REAL engine and mesh workers on
 * the synthetic city (`fixtures/syntheticCity.ts`, the frame-budget gate's) —
 * the PR #203 review:
 *
 *  - a tile's buildings are drawn while the road tiles its trees are read
 *    against are still downloading: the trees follow, never the other way;
 *  - a road-archive outage asks for the trees again at 2, 8 and 30 s ALONE —
 *    the buildings are not meshed (nor uploaded) again — then stops;
 *  - only the profile's `city.treeRoadTiles` nearest tiles read the road
 *    archive.
 */
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';

import type { CityEngineStats, CityView } from '@/components/map/engine/city3d/cityEngine';
import { createCityEngine } from '@/components/map/engine/city3d/cityEngine';
import {
  createGlCounterState,
  instrumentWebGl2,
  resetGlFrame,
} from '@/components/map/perf/glCounters';
import { QUALITY_PRESETS } from '@/lib/map/quality/profile';

import { createFakeWebGl2 } from './fixtures/fakeWebGl2';
import { camera } from './fixtures/mapCamera';
import { SYNTHETIC_CENTRE, serveSyntheticCity, syntheticCoverage } from './fixtures/syntheticCity';

const FRAME_MS = 1000 / 60;
const WIDTH = 1280;
const HEIGHT = 720;

beforeAll(() => {
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.requestAnimationFrame ??= (fn: (t: number) => void) =>
    setTimeout(() => fn(performance.now()), 16);
  scope.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function streetView(dLng = 0): CityView {
  const c = camera({
    lng: SYNTHETIC_CENTRE.lng + dLng,
    lat: SYNTHETIC_CENTRE.lat,
    zoom: 17.6,
    pitch: 55,
    bearing: 0,
    width: WIDTH,
    height: HEIGHT,
  });
  return { mercatorToClip: c.mercatorToClip, zoom: c.zoom, center: c.center, bounds: c.bounds };
}

/** An engine on the synthetic city, its road archive behind `roads`. */
function start(
  roads: Parameters<typeof serveSyntheticCity>[0],
  quality: Partial<(typeof QUALITY_PRESETS)['low']['city']> = {},
) {
  const server = serveSyntheticCity(roads);
  const { gl, canvas } = createFakeWebGl2(WIDTH, HEIGHT);
  const counters = createGlCounterState();
  instrumentWebGl2(gl, counters);
  const clock = { ms: 0 };
  let stats: CityEngineStats | null = null;
  const preset = QUALITY_PRESETS.low;
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
      roadTileUrlTemplate: `${server.origin}/roads/{z}/{x}/{y}.pbf`,
      coverage: syntheticCoverage(),
    },
    trees: {
      sourceLayers: {
        landcover: 'landcover',
        landuse: 'landuse',
        water: 'water',
        transportation: 'transportation',
        building: 'building',
      },
    },
    palette: { low: '#e8e4dc', tall: '#d8d2c8', veryTall: '#c8c0b4', tallM: 60, veryTallM: 180 },
    light: { position: [1.15, 0, 0.5], intensity: 0.5, color: [1, 1, 1] },
    fade: { start: 15.5, end: 16.5 },
    requestRepaint: () => {},
    now: () => clock.ms,
    quality: { ...preset, city: { ...preset.city, ...quality }, reason: 'test' },
    onStats: (s) => {
      stats = s;
    },
  });
  stops.push(() => {
    engine.dispose();
    server.stop();
  });
  /** One frame `ms` after the last; returns the bytes it uploaded. */
  const frame = (v: CityView, ms = FRAME_MS) => {
    clock.ms += ms;
    resetGlFrame(counters.frame);
    engine.prerender(v);
    engine.render(v);
    return counters.frame.uploadBytes;
  };
  const current = (): CityEngineStats => {
    if (!stats) throw new Error('no stats yet');
    return stats;
  };
  /** Frames (real time passing for the workers) until `done`, or give up. */
  const until = async (v: CityView, done: () => boolean, limit = 600) => {
    for (let i = 0; i < limit; i++) {
      frame(v);
      if (stats && done()) return true;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return false;
  };
  const roadRequests = () => server.requests.filter((path) => path.startsWith('/roads/'));
  return { engine, frame, until, stats: current, server, roadRequests };
}

describe('a city tile’s trees arrive after its buildings, never before', () => {
  test('buildings are drawn while the road tiles are still downloading; the trees follow', async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const city = start({ wait: () => held });
    const v = streetView();
    // The road archive has not answered a single tile.
    expect(await city.until(v, () => city.stats().triangles > 0)).toBe(true);
    expect(city.stats().trees).toBe(0);
    expect(city.stats().tilesPending).toBeGreaterThan(0);
    release();
    expect(
      await city.until(v, () => city.stats().trees > 0 && city.stats().tilesPending === 0),
    ).toBe(true);
    expect(city.stats().treeSettings.street).toBeGreaterThan(0);
  }, 60_000);

  test('a road-archive outage: the trees alone are asked again at 2, 8 and 30 s, then left', async () => {
    const city = start({ status: () => 503 });
    const v = streetView();
    expect(
      await city.until(
        v,
        () => city.stats().trees > 0 && city.stats().tilesPending === 0 && city.stats().tilesLoaded > 0,
      ),
    ).toBe(true);
    const first = city.roadRequests().length;
    const ownTiles = new Set(city.roadRequests()).size;
    expect(first).toBeGreaterThan(0);
    // What the buildings weigh: a re-mesh would upload all of it again.
    const buildingBytes = city.stats().gpuBytes;

    let uploaded = 0;
    for (const wait of [2_000, 8_000, 30_000]) {
      // Just before it is due: nothing is asked.
      const before = city.roadRequests().length;
      uploaded += city.frame(v, wait - 100);
      await new Promise((resolve) => setTimeout(resolve, 30));
      uploaded += city.frame(v);
      expect(city.roadRequests().length).toBe(before);
      // Due: the road tiles are asked for again, and the answer drawn.
      uploaded += city.frame(v, 200);
      const settled = await city.until(
        v,
        () => city.roadRequests().length >= before + ownTiles && city.stats().tilesPending === 0,
      );
      if (process.env.TEST_DEBUG) console.log(wait, before, city.roadRequests().length, ownTiles, city.stats().tilesPending);
      expect(settled).toBe(true);
    }
    // The trees' bytes only, never the buildings' again.
    expect(uploaded).toBeLessThan(buildingBytes / 4);
    // And then it stops.
    const last = city.roadRequests().length;
    city.frame(v, 120_000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    city.frame(v);
    await new Promise((resolve) => setTimeout(resolve, 50));
    city.frame(v);
    expect(city.roadRequests().length).toBe(last);
  }, 60_000);
});

describe('the profile decides which tiles read the road archive', () => {
  test('none at 0; the nearest only at 1, and a tile reads them once it becomes the nearest', async () => {
    const none = start({}, { treeRoadTiles: 0 });
    expect(await none.until(streetView(), () => none.stats().trees > 0 && none.stats().tilesPending === 0)).toBe(true);
    expect(none.roadRequests()).toEqual([]);

    const one = start({}, { treeRoadTiles: 1 });
    const v = streetView();
    expect(await one.until(v, () => one.stats().trees > 0 && one.stats().tilesPending === 0)).toBe(true);
    // Its own road tile, and its neighbours' where its trees come near their edge.
    const own = (path: string) => path.split('/').slice(2).join('/');
    const asked = new Set(one.roadRequests().map(own));
    expect(asked.size).toBeGreaterThan(0);
    expect(asked.size).toBeLessThanOrEqual(9);

    // A tile's width east (z15 at 41.39°: ~0.011° of longitude): another is nearest.
    const moved = streetView(360 / 2 ** 15);
    const before = one.roadRequests().length;
    expect(
      await one.until(
        moved,
        () => one.roadRequests().length > before && one.stats().tilesPending === 0,
      ),
    ).toBe(true);
    const now = new Set(one.roadRequests().map(own));
    expect(now.size).toBeGreaterThan(asked.size);
  }, 60_000);
});

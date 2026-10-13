/**
 * THE MAP'S FRAME BUDGET GATE (`docs/MAP_PERFORMANCE.md` → "The CI gate").
 *
 * The real city engine and the real three.js renderer draw a synthetic city
 * (`fixtures/syntheticCity.ts`, served to the real mesh workers) on a
 * stand-in WebGL 2 context (`fixtures/fakeWebGl2.ts`), and the map's own GL
 * counters (`perf/glCounters.ts`) count what every frame asks of the GPU:
 * draw calls, triangles, offscreen passes (the shadow map), bytes uploaded.
 * Those counts are deterministic — no GPU, no clock, no network — so they can
 * be held to budgets, per fixed scene and quality preset (`FRAME_BUDGETS`
 * below). A change that makes a frame draw more than its budget fails here.
 *
 * Raising a budget is allowed and visible: edit the number in the same PR,
 * with the reason. The budgets are the measured counts plus ~10% headroom
 * (`docs/MAP_PERFORMANCE.md` records the measurement); mutation-tested — see
 * the doc for the mutations that fail it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { CityEngine, CityView } from '@/components/map/engine/city3d/cityEngine';
import { createCityEngine } from '@/components/map/engine/city3d/cityEngine';
import { createCityStreets } from '@/components/map/engine/cityStreets/streetRenderer';
import { streetPaletteInput } from '@/lib/map/style/streetPalette';
import { cityMaterials } from '@/components/map/city3dStyle';
import type { GroundSampler } from '@/components/map/engine/city3d/terrainGround';
import {
  createGlCounterState,
  type GlFrameCounts,
  instrumentWebGl2,
  resetGlFrame,
} from '@/components/map/perf/glCounters';
import { QUALITY_PRESETS, type QualityTier } from '@/lib/map/quality/profile';

import { camera } from './fixtures/mapCamera';
import { createFakeWebGl2 } from './fixtures/fakeWebGl2';
import { SYNTHETIC_CENTRE, serveSyntheticCity, syntheticCoverage } from './fixtures/syntheticCity';

/** One frame of a 60 Hz display, ms: the virtual clock's step. */
const FRAME_MS = 1000 / 60;

const WIDTH = 1920;
const HEIGHT = 1080;

interface Scene {
  id: string;
  /** Draw the street detail too (`MAP_STREETS.md`), from the synthetic road tiles. */
  streets?: boolean;
  /** Camera keyframes: the frames after loading are drawn along them. */
  path: Array<{ zoom: number; pitch: number; bearing: number; dLng?: number; dLat?: number }>;
}

/** Fixed scenes over the synthetic city. */
const SCENES: Scene[] = [
  {
    id: 'tilt-orbit',
    path: Array.from({ length: 12 }, (_, i) => ({ zoom: 16.3, pitch: 62, bearing: 30 + i * 9 })),
  },
  {
    id: 'street',
    path: Array.from({ length: 4 }, (_, i) => ({ zoom: 17.6, pitch: 55, bearing: i * 2 })),
  },
  {
    // The street view again, with the street detail on: its line in the budget.
    id: 'street-detail',
    streets: true,
    path: Array.from({ length: 4 }, (_, i) => ({ zoom: 17.6, pitch: 55, bearing: i * 2 })),
  },
  {
    id: 'skyline',
    path: Array.from({ length: 4 }, (_, i) => ({ zoom: 15.9, pitch: 75, bearing: -20 + i * 3 })),
  },
];

interface Measured {
  /** Per drawn frame along the path, the worst frame. */
  draws: number;
  triangles: number;
  offscreenPasses: number;
  /** Over the whole path (after loading): bytes handed to the GPU. */
  uploadBytes: number;
  /** While the first view loads: every byte handed to the GPU, and the most in one frame. */
  loadUploadBytes: number;
  maxFrameUploadBytes: number;
  /** Offscreen passes along the whole path: the shadow map's redraws (the engine's only offscreen pass). */
  shadowRedraws: number;
  /** GPU bytes held once loaded — every buffer, texture and renderbuffer the engine made (the shadow map included). */
  gpuBytes: number;
  /** Per loading frame: tiles lifted onto the terrain and bytes uploaded (on terrain only). */
  loadFrames: Array<{ lifted: number; uploadBytes: number }>;
}

function view(step: Scene['path'][number]): CityView {
  const c = camera({
    lng: SYNTHETIC_CENTRE.lng + (step.dLng ?? 0),
    lat: SYNTHETIC_CENTRE.lat + (step.dLat ?? 0),
    zoom: step.zoom,
    pitch: step.pitch,
    bearing: step.bearing,
    width: WIDTH,
    height: HEIGHT,
  });
  return { mercatorToClip: c.mercatorToClip, zoom: c.zoom, center: c.center, bounds: c.bounds };
}

let server: ReturnType<typeof serveSyntheticCity>;
beforeAll(() => {
  server = serveSyntheticCity();
  // three's animation loop binds to `self`; bun has no frame callbacks.
  const scope = globalThis as unknown as Record<string, unknown>;
  scope.requestAnimationFrame ??= (fn: (t: number) => void) =>
    setTimeout(() => fn(performance.now()), 16);
  scope.cancelAnimationFrame ??= (id: number) => clearTimeout(id);
});
afterAll(() => server.stop());

/** Draw frames until the engine has nothing pending (or give up); `onFrame` after each. */
async function settle(
  engine: CityEngine,
  v: CityView,
  stats: () => { pending: number },
  clock: { ms: number },
  onFrame: () => void = () => {},
) {
  for (let i = 0; i < 400; i++) {
    clock.ms += FRAME_MS;
    engine.prerender(v);
    engine.render(v);
    onFrame();
    if (i > 2 && stats().pending === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  return false;
}

async function measure(
  scene: Scene,
  tier: QualityTier,
  ground: GroundSampler | null = null,
  /** Called once loaded, with the engine and a frame function: an extra check of the run. */
  afterLoad?: (engine: CityEngine, frame: () => GlFrameCounts) => void,
): Promise<Measured> {
  const { gl, canvas } = createFakeWebGl2(WIDTH, HEIGHT);
  const counters = createGlCounterState();
  instrumentWebGl2(gl, counters);
  let pending = 1;
  // The street renderer reports its own pending tiles (until it has: one).
  let streetsPending = scene.streets ? 1 : 0;
  const overlays = scene.streets
    ? [
        createCityStreets({
          roadTileTemplate: `${server.origin}/roads/{z}/{x}/{y}.pbf`,
          // As production asks: only the road tiles the coverage covers.
          roadCoverage: syntheticCoverage(),
          glyphTemplate: `${server.origin}/fonts/{fontstack}/{range}.pbf`,
          fontstack: 'Inter Bold',
          palette: streetPaletteInput(),
          quality: QUALITY_PRESETS[tier].streets,
          requestRepaint: () => {},
          onStats: (s) => {
            streetsPending = s.pending + (s.tilesDrawn === 0 ? 1 : 0);
          },
        }),
      ]
    : [];
  // The engine runs on a virtual clock: the same counts every run.
  const clock = { ms: 0 };
  let lifted = 0;
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
    trees: {
      sourceLayers: {
        landcover: 'landcover',
        landuse: 'landuse',
        water: 'water',
        transportation: 'transportation',
        building: 'building',
      },
      fillWoods: false,
    },
    palette: { low: '#e8e4dc', tall: '#d8d2c8', veryTall: '#c8c0b4', tallM: 60, veryTallM: 180 },
    light: { position: [1.15, 0, 0.5], intensity: 0.5, color: [1, 1, 1] },
    fade: { start: 15.5, end: 16.5 },
    requestRepaint: () => {},
    now: () => clock.ms,
    quality: { ...QUALITY_PRESETS[tier], reason: 'gate' },
    sky: { appearance: 'light' },
    overlays,
    // The detailed look, as goway.to draws it by default (`detailedCity`).
    material: cityMaterials(),
    onStats: (s) => {
      if (process.env.GATE_DEBUG) console.log(JSON.stringify(s));
      pending = s.tilesPending + s.uploadsQueued;
    },
    onGroundStats: (s) => {
      lifted = s.tilesGrounded;
    },
  });
  try {
    // A midsummer afternoon: shadows on.
    engine.setSun({ azimuthDeg: 240, altitudeDeg: 40 });
    if (ground) engine.setGround(ground);
    const first = view(scene.path[0]);
    let loadUploadBytes = 0;
    let maxFrameUploadBytes = 0;
    const loadFrames: Measured['loadFrames'] = [];
    let liftedBefore = lifted;
    const loaded = await settle(
      engine,
      first,
      () => ({ pending: pending + streetsPending }),
      clock,
      () => {
        loadUploadBytes += counters.frame.uploadBytes;
        maxFrameUploadBytes = Math.max(maxFrameUploadBytes, counters.frame.uploadBytes);
        if (ground) {
          loadFrames.push({
            lifted: lifted - liftedBefore,
            uploadBytes: counters.frame.uploadBytes,
          });
          liftedBefore = lifted;
        }
        resetGlFrame(counters.frame);
      },
    );
    expect(loaded, `${scene.id}/${tier} loaded`).toBe(true);
    afterLoad?.(engine, () => {
      clock.ms += FRAME_MS;
      resetGlFrame(counters.frame);
      engine.prerender(first);
      engine.render(first);
      return { ...counters.frame };
    });
    // Settle the path's own tiles too (an orbit reveals more), then measure it.
    for (const step of scene.path)
      await settle(engine, view(step), () => ({ pending: pending + streetsPending }), clock);
    // A second at rest on the first view: anything deferred (the shadow map's
    // catch-up) is drawn, so every run starts the path from the same state.
    clock.ms += 1000;
    engine.prerender(first);
    engine.render(first);
    let upload = 0;
    let shadowRedraws = 0;
    const worst: GlFrameCounts = { ...counters.frame };
    resetGlFrame(worst);
    for (const step of scene.path) {
      // Frames a 60 Hz display apart, on the engine's virtual clock: what
      // time-based rules (the shadow map's redraw throttle) see in a browser.
      clock.ms += FRAME_MS;
      resetGlFrame(counters.frame);
      const v = view(step);
      engine.prerender(v);
      engine.render(v);
      worst.draws = Math.max(worst.draws, counters.frame.draws);
      worst.triangles = Math.max(worst.triangles, counters.frame.triangles);
      worst.offscreenPasses = Math.max(worst.offscreenPasses, counters.frame.offscreenPasses);
      upload += counters.frame.uploadBytes;
      shadowRedraws += counters.frame.offscreenPasses;
    }
    return {
      draws: worst.draws,
      triangles: worst.triangles,
      offscreenPasses: worst.offscreenPasses,
      uploadBytes: upload,
      loadUploadBytes,
      maxFrameUploadBytes,
      shadowRedraws,
      gpuBytes: Math.round(
        counters.memory.buffers + counters.memory.textures + counters.memory.renderbuffers,
      ),
      loadFrames,
    };
  } finally {
    engine.dispose();
  }
}

/** What a scene may cost at a preset (the path's worst frame, and its load). */
type Budget = Omit<Measured, 'uploadBytes' | 'maxFrameUploadBytes' | 'loadFrames'>;

/**
 * The budgets, per scene and preset: the counts measured on this branch
 * (`docs/MAP_PERFORMANCE.md` → "The CI gate") plus 10%, and 25% for the one
 * timing-dependent count — the bytes uploaded while loading, which depend on
 * which fallback levels arrive first; shadow redraws and offscreen passes
 * exactly. Raise one only with the reason in the PR.
 */
const FRAME_BUDGETS: Record<string, Record<QualityTier, Budget>> = {
  'tilt-orbit': {
    low: {
      draws: 36,
      triangles: 816_230,
      offscreenPasses: 0,
      loadUploadBytes: 11_207_580,
      shadowRedraws: 0,
      gpuBytes: 10_329_311,
    },
    medium: {
      draws: 46,
      triangles: 1_188_248,
      offscreenPasses: 0,
      loadUploadBytes: 15_077_970,
      shadowRedraws: 0,
      gpuBytes: 20_845_073,
    },
    high: {
      draws: 95,
      triangles: 2_805_517,
      offscreenPasses: 0,
      loadUploadBytes: 21_555_785,
      shadowRedraws: 0,
      gpuBytes: 46_565_143,
    },
  },
  street: {
    low: {
      draws: 29,
      triangles: 784_747,
      offscreenPasses: 0,
      loadUploadBytes: 10_440_068,
      shadowRedraws: 0,
      gpuBytes: 9_187_260,
    },
    medium: {
      draws: 39,
      triangles: 1_156_010,
      offscreenPasses: 0,
      loadUploadBytes: 10_474_508,
      shadowRedraws: 0,
      gpuBytes: 14_984_735,
    },
    high: {
      draws: 39,
      triangles: 1_156_010,
      offscreenPasses: 0,
      loadUploadBytes: 10_474_508,
      shadowRedraws: 0,
      gpuBytes: 32_286_239,
    },
  },
  // The street view with the street detail on (`MAP_STREETS.md`): +8 draws
  // (4 road tiles, 2 each), ~61 k triangles, ~4 MB over 'street'.
  // Raised with the terrain lattice (`cityStreets/groundLattice.ts`): the
  // street meshes are cut where the drawn terrain creases, so they no longer
  // dip under it — +7% triangles at low and medium, +11% at high (cut at half
  // pixels too), the same draws; the ground grids are the DEM's own pixels
  // (66² a slot, was 33²). Measured on this branch, plus 10% / 25% as above.
  'street-detail': {
    low: {
      draws: 38,
      triangles: 914_580,
      offscreenPasses: 0,
      loadUploadBytes: 20_056_520,
      shadowRedraws: 0,
      gpuBytes: 16_461_469,
    },
    medium: {
      draws: 48,
      triangles: 1_285_843,
      offscreenPasses: 0,
      loadUploadBytes: 20_389_085,
      shadowRedraws: 0,
      gpuBytes: 22_495_647,
    },
    high: {
      draws: 48,
      triangles: 1_359_576,
      offscreenPasses: 0,
      loadUploadBytes: 22_894_875,
      shadowRedraws: 0,
      gpuBytes: 42_004_992,
    },
  },
  skyline: {
    low: {
      draws: 37,
      triangles: 806_892,
      offscreenPasses: 0,
      loadUploadBytes: 7_162_668,
      shadowRedraws: 0,
      gpuBytes: 9_851_691,
    },
    medium: {
      draws: 47,
      triangles: 1_178_910,
      offscreenPasses: 0,
      loadUploadBytes: 11_757_628,
      shadowRedraws: 0,
      gpuBytes: 16_319_246,
    },
    high: {
      draws: 96,
      triangles: 2_878_027,
      offscreenPasses: 0,
      loadUploadBytes: 26_922_583,
      shadowRedraws: 0,
      gpuBytes: 46_760_545,
    },
  },
};

const results = new Map<string, Measured>();

describe('frame budget gate', () => {
  for (const scene of SCENES) {
    for (const tier of ['low', 'medium', 'high'] as QualityTier[]) {
      test(`${scene.id} at ${tier}`, async () => {
        const measured = await measure(scene, tier);
        results.set(`${scene.id}/${tier}`, measured);
        if (process.env.GATE_DEBUG) console.log(`${scene.id}/${tier}`, JSON.stringify(measured));
        const budget = FRAME_BUDGETS[scene.id][tier];
        for (const key of Object.keys(budget) as (keyof Budget)[]) {
          expect(measured[key], `${scene.id}/${tier} ${key}`).toBeLessThanOrEqual(budget[key]);
        }
        // Loading never hands the GPU more in one frame than the preset's
        // upload budget (every synthetic mesh is smaller than it, so the
        // engine's "at least one mesh" rule never applies here).
        expect(
          measured.maxFrameUploadBytes,
          `${scene.id}/${tier} upload/frame`,
        ).toBeLessThanOrEqual(QUALITY_PRESETS[tier].city.uploadBytesPerFrame);
      }, 120_000);
    }
  }

  test('a lower preset is never the dearer one (each scene, triangles and draws)', () => {
    for (const scene of SCENES) {
      const [low, medium, high] = (['low', 'medium', 'high'] as const).map((tier) =>
        results.get(`${scene.id}/${tier}`),
      );
      // Vacuity: the scenes above ran.
      expect(low && medium && high, scene.id).toBeTruthy();
      if (!low || !medium || !high) continue;
      expect(low.triangles).toBeLessThanOrEqual(medium.triangles);
      expect(medium.triangles).toBeLessThanOrEqual(high.triangles);
      expect(low.draws).toBeLessThanOrEqual(medium.draws);
      expect(medium.draws).toBeLessThanOrEqual(high.draws);
      // Low draws no shadow map at all.
      expect(low.offscreenPasses).toBe(0);
    }
  });

  test('the street detail is drawn, and within its preset’s budget (vacuity of its line)', () => {
    for (const tier of ['low', 'medium', 'high'] as const) {
      const plain = results.get(`street/${tier}`);
      const detailed = results.get(`street-detail/${tier}`);
      expect(plain && detailed, tier).toBeTruthy();
      if (!plain || !detailed) continue;
      // Two draws per road tile; at least one tile drawn.
      expect(detailed.draws - plain.draws).toBeGreaterThanOrEqual(2);
      expect(detailed.triangles - plain.triangles).toBeGreaterThan(0);
      expect(detailed.triangles - plain.triangles).toBeLessThanOrEqual(
        QUALITY_PRESETS[tier].streets.drawTriangles,
      );
    }
  });

  test('on terrain, no frame both lifts a tile and uploads one (the two largest pieces of an arrival)', async () => {
    // A hillside under the synthetic city: every tile is lifted before it is drawn.
    const hill: GroundSampler = (lng, lat) =>
      120 + 3000 * (lng - SYNTHETIC_CENTRE.lng) + 2000 * (lat - SYNTHETIC_CENTRE.lat);
    const measured = await measure(SCENES[0], 'medium', hill);
    const lifting = measured.loadFrames.filter((f) => f.lifted > 0);
    // Vacuity: tiles were lifted, and uploaded.
    expect(lifting.length).toBeGreaterThan(2);
    expect(measured.loadFrames.some((f) => f.uploadBytes > 0)).toBe(true);
    // A lifting frame uploads at most a few uniforms (bytes), never a mesh
    // (MBs): each object drawn for the first time adds its uniform buffers
    // (~150 B), and a frame may draw a few — a tile's meshes come in hundreds
    // of kilobytes.
    for (const frame of lifting) expect(frame.uploadBytes).toBeLessThan(4096);
    expect(measured.draws).toBeGreaterThan(0);
  }, 120_000);

  test('terrain arriving under a city already drawn does not hold its tiles back a frame', async () => {
    // Loaded flat, as when the map is tilted after the city was drawn: each
    // tile's mesh is on the GPU already, so it is drawn the frame it is lifted.
    const hill: GroundSampler = () => 140;
    let lifted: GlFrameCounts | null = null;
    await measure(SCENES[0], 'medium', null, (engine, frame) => {
      engine.setGround(hill);
      lifted = frame();
    });
    // Vacuity: a frame was drawn. A tile is thousands of triangles; the
    // frame's other passes are a few.
    expect(lifted).not.toBeNull();
    expect((lifted as GlFrameCounts | null)?.triangles ?? 0).toBeGreaterThan(1000);
  }, 120_000);

  test('the counts are deterministic (the same scene twice, the same frame)', async () => {
    const [a, b] = [await measure(SCENES[0], 'high'), await measure(SCENES[0], 'high')];
    expect(b.draws).toBe(a.draws);
    expect(b.triangles).toBe(a.triangles);
    expect(b.shadowRedraws).toBe(a.shadowRedraws);
    expect(b.offscreenPasses).toBe(a.offscreenPasses);
  }, 120_000);
});

/**
 * The map's QUALITY PROFILE: one plain object every drawing feature reads its
 * budgets from — the 3D city, trees, sky and shadows, city life, live data,
 * landmarks, the canvas resolution and the animation rate. Design note:
 * `docs/MAP_PERFORMANCE.md` (budgets, presets, the contract).
 *
 * Platform-neutral on purpose: no DOM, no WebGL, no React, no MapLibre. The
 * web map resolves it in `MapCanvas.web.tsx`; native reads the SAME profile
 * (its own detection feeds {@link resolveQuality}); the engine and the
 * benchmark take it as data. It is small and dependency-free because the web
 * map resolves it before its first frame (the DPR clamp and MSAA are
 * construction options), so it is on the first-paint path.
 *
 * ## The contract (every feature honours it)
 *
 *  - Read your caps from the profile you are GIVEN; never detect the device
 *    yourself and never hard-code a second budget beside it.
 *  - A cap is a ceiling, not a target: draw less when the view needs less.
 *  - Animate only through the host's animation clock at
 *    {@link QualityProfile.frame}`.animationHz`, and stop when the clock says
 *    paused (tab hidden, map idle). Never call a repaint in a loop of your own.
 *  - A new feature with a cost adds its knob HERE, with a value for all three
 *    tiers, and a line in `docs/MAP_PERFORMANCE.md`.
 */

/** The three presets. `low` is the floor every supported device must hold at 30 fps. */
export type QualityTier = 'low' | 'medium' | 'high';

/**
 * What the person chose in Settings → Performance. `auto` follows the
 * device; `battery` is the low preset plus a slower animation clock and
 * shorter idle pause; `high` is the high preset whatever the device.
 */
export type PerformanceMode = 'auto' | 'battery' | 'high';

export const PERFORMANCE_MODES: readonly PerformanceMode[] = ['auto', 'battery', 'high'];

/** What kind of device the map runs on; decides the ceiling `auto` may pick. */
export type DeviceClass = 'phone' | 'tablet' | 'desktop';

export interface QualityProfile {
  tier: QualityTier;
  /** Why this tier: the person's choice, the device, or a fallback. Shown in the HUD. */
  reason: string;
  render: {
    /** The canvas never renders above this device-pixel ratio. */
    maxPixelRatio: number;
    /** Dynamic resolution may lower the ratio to this, never below. */
    minPixelRatio: number;
    /** Lower the ratio while frames are over {@link QualityProfile.render.targetFrameMs}. */
    dynamicResolution: boolean;
    /** The frame time the map aims for (16.7 = 60 fps, 33.3 = 30 fps). */
    targetFrameMs: number;
    /** Multisampling of the map's canvas (a construction option: a new map). */
    msaa: boolean;
  };
  frame: {
    /** The one animation clock: city life, live data and animated models tick at most this often. */
    animationHz: number;
    /** With no interaction for this long, animations pause (the city freezes; the map stays). */
    idlePauseMs: number;
  };
  city: {
    /** Bytes and vertices of buildings drawn per frame (`lod.ts` → `fitBudget`). */
    drawBytes: number;
    drawVertices: number;
    /** GPU bytes the tile cache may hold (drawn + slack + fallback levels). */
    cacheBytes: number;
    /** Tiles drawn per frame, and at full detail (`LodPolicy`). */
    maxTiles: number;
    maxFullTiles: number;
    /** A level is drawn while its geometric error is under this many pixels (`LodPolicy`). */
    pixelTolerance: number;
    /** Bytes of new meshes handed to the GPU per frame. */
    uploadBytesPerFrame: number;
    /** Mesh workers at most (`workerPool.ts` still leaves a core to the page). */
    maxWorkers: number;
    /** Tree instances drawn per frame; 0 draws no trees. */
    treeBudget: number;
  };
  sky: {
    /** Sun shadows: the map's side in texels, 0 for none (no shadow pass, no shadow map). */
    shadowMapSize: 0 | 1024 | 2048;
    /** PCF taps per shadowed fragment (ignored without a shadow map). */
    shadowTaps: 4 | 8 | 12;
  };
  life: {
    /** Simulated agents at full density (`MAP_CITY_LIFE.md`). */
    cars: number;
    people: number;
  };
  live: {
    /** Real-time entities drawn at most (`MAP_LIVE.md`), nearest first. */
    maxEntities: number;
  };
  landmarks: {
    /** Landmark models held in the scene at once. */
    max: number;
  };
  streets: {
    /** Geometric terrain error and smallest adaptive edge, metres. */
    groundErrorM: number;
    groundMinEdgeM: number;
    /** Street meshes grounded against the terrain source in one frame. */
    groundsPerFrame: number;
    /** Road tiles drawn with street detail, two draw calls each (`MAP_STREETS.md`). */
    maxTiles: number;
    /**
     * Street triangles drawn per frame: past it the farthest tiles fall back to
     * the simplified level (no kerb faces, arrows, words or names), then out.
     */
    drawTriangles: number;
  };
  relief: {
    /**
     * 3D terrain while the camera is tilted (`docs/MAP_TERRAIN_GLOBE.md`).
     * `false` keeps the hillshade and the globe and skips MapLibre's terrain
     * mesh — but then MapLibre redraws every 2D layer per tile on every frame
     * instead of caching them in its terrain textures: measured, twice the
     * draw calls and twice MapLibre's main-thread time. So every preset keeps
     * it; the knob is for a device that cannot.
     */
    terrain3d: boolean;
    /** Decoded DEM tiles retained by the single terrain preparation worker. */
    demCacheTiles: number;
    /**
     * The side of MapLibre's terrain textures (the 2D layers cached per
     * terrain tile), as a multiple of the terrain tile's 1,024 px: 2 is
     * MapLibre's own (2,048², ~22 MB each, mipmapped — 478 MB on a tilted
     * city on the phone profile), 1 is a quarter of the memory at half the
     * resolution of the roads and fills draped on the terrain (labels are not
     * in them).
     */
    terrainTextureScale: 1 | 2;
    /**
     * Day and night on the globe (`components/map/globeNightLayer.web.ts`):
     * one full-screen pass of a ray–sphere test per pixel below z13, nothing
     * above. Cheaper than the hillshade under it, so every preset keeps it;
     * the knob is for a device that cannot.
     */
    globeNight: boolean;
  };
}

const MiB = 1024 * 1024;

/**
 * The presets. Every number is a budget from `docs/MAP_PERFORMANCE.md` →
 * "Budgets": `high` is what the engine drew before this profile existed (so
 * a capable machine loses nothing), `medium` a 2021 integrated laptop GPU
 * (Iris Xe, Apple M1) at 1080p, `low` a mid-range phone (Adreno 6xx, A14)
 * held at 30 fps sustained, inside iOS Safari's memory.
 */
export const QUALITY_PRESETS: Readonly<Record<QualityTier, Omit<QualityProfile, 'reason'>>> = {
  low: {
    tier: 'low',
    render: {
      maxPixelRatio: 2,
      minPixelRatio: 1,
      dynamicResolution: true,
      targetFrameMs: 33.3,
      msaa: false,
    },
    frame: { animationHz: 20, idlePauseMs: 20_000 },
    city: {
      drawBytes: 48 * MiB,
      drawVertices: 2_000_000,
      cacheBytes: 80 * MiB,
      maxTiles: 20,
      maxFullTiles: 3,
      pixelTolerance: 2.5,
      uploadBytesPerFrame: 4 * MiB,
      maxWorkers: 1,
      treeBudget: 6_000,
    },
    sky: { shadowMapSize: 0, shadowTaps: 4 },
    life: { cars: 300, people: 300 },
    live: { maxEntities: 500 },
    landmarks: { max: 2 },
    streets: {
      groundErrorM: 0.015,
      groundMinEdgeM: 0.25,
      groundsPerFrame: 1,
      maxTiles: 6,
      drawTriangles: 400_000,
    },
    relief: { terrain3d: true, terrainTextureScale: 1, globeNight: true, demCacheTiles: 16 },
  },
  medium: {
    tier: 'medium',
    render: {
      maxPixelRatio: 2,
      minPixelRatio: 1,
      dynamicResolution: true,
      targetFrameMs: 16.7,
      msaa: false,
    },
    frame: { animationHz: 30, idlePauseMs: 45_000 },
    city: {
      drawBytes: 80 * MiB,
      drawVertices: 4_000_000,
      cacheBytes: 128 * MiB,
      maxTiles: 32,
      maxFullTiles: 4,
      pixelTolerance: 1.5,
      uploadBytesPerFrame: 8 * MiB,
      maxWorkers: 2,
      treeBudget: 16_000,
    },
    sky: { shadowMapSize: 1024, shadowTaps: 8 },
    life: { cars: 700, people: 700 },
    live: { maxEntities: 2_000 },
    landmarks: { max: 4 },
    streets: {
      groundErrorM: 0.015,
      groundMinEdgeM: 0.25,
      groundsPerFrame: 1,
      maxTiles: 10,
      drawTriangles: 900_000,
    },
    relief: { terrain3d: true, terrainTextureScale: 2, globeNight: true, demCacheTiles: 32 },
  },
  high: {
    tier: 'high',
    render: {
      maxPixelRatio: 3,
      minPixelRatio: 1.25,
      dynamicResolution: true,
      targetFrameMs: 16.7,
      msaa: true,
    },
    frame: { animationHz: 30, idlePauseMs: 120_000 },
    city: {
      drawBytes: 128 * MiB,
      drawVertices: 8_000_000,
      cacheBytes: 192 * MiB,
      maxTiles: 48,
      maxFullTiles: 6,
      pixelTolerance: 1,
      uploadBytesPerFrame: 12 * MiB,
      maxWorkers: 3,
      treeBudget: 40_000,
    },
    sky: { shadowMapSize: 2048, shadowTaps: 12 },
    life: { cars: 1200, people: 1200 },
    live: { maxEntities: 5_000 },
    landmarks: { max: 8 },
    streets: {
      groundErrorM: 0.015,
      groundMinEdgeM: 0.25,
      groundsPerFrame: 1,
      maxTiles: 16,
      drawTriangles: 2_000_000,
    },
    relief: { terrain3d: true, terrainTextureScale: 2, globeNight: true, demCacheTiles: 32 },
  },
};

/** What `auto` may pick at most per device class: a phone is never `high`. */
const AUTO_CEILING: Readonly<Record<DeviceClass, QualityTier>> = {
  phone: 'medium',
  tablet: 'medium',
  desktop: 'high',
};

/** What `auto` picks before anything is known about the GPU. */
const AUTO_UNKNOWN: Readonly<Record<DeviceClass, QualityTier>> = {
  phone: 'low',
  tablet: 'medium',
  desktop: 'medium',
};

const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high'];

function minTier(a: QualityTier, b: QualityTier): QualityTier {
  return TIER_ORDER[Math.min(TIER_ORDER.indexOf(a), TIER_ORDER.indexOf(b))];
}

export interface QualityInput {
  mode: PerformanceMode;
  device: DeviceClass;
  /** The GPU's tier as detected (`gpuTier.ts`), or `null` when not known yet. */
  gpuTier: QualityTier | null;
}

/**
 * The profile for a choice and a device. Pure; the answer for the same input
 * is the same object shape every time (tests pin each branch).
 */
export function resolveQuality(input: QualityInput): QualityProfile {
  if (input.mode === 'high') {
    return { ...QUALITY_PRESETS.high, reason: 'chosen: high quality' };
  }
  if (input.mode === 'battery') {
    const low = QUALITY_PRESETS.low;
    return {
      ...low,
      reason: 'chosen: battery saver',
      // The battery saver also slows the clock and pauses sooner.
      frame: { animationHz: 15, idlePauseMs: 10_000 },
      render: { ...low.render, maxPixelRatio: 1.5 },
    };
  }
  const tier = input.gpuTier
    ? minTier(input.gpuTier, AUTO_CEILING[input.device])
    : AUTO_UNKNOWN[input.device];
  const reason = input.gpuTier
    ? `auto: ${input.device}, GPU ${input.gpuTier}`
    : `auto: ${input.device}, GPU not measured`;
  return { ...QUALITY_PRESETS[tier], reason };
}

/**
 * The canvas's pixel ratio for a device: never above the profile's clamp.
 * A device below the floor keeps its own ratio (a 1× screen is not upscaled).
 */
export function clampPixelRatio(devicePixelRatio: number, profile: QualityProfile): number {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.min(dpr, profile.render.maxPixelRatio);
}

/** Read a stored mode leniently: anything unknown is `auto`. */
export function parsePerformanceMode(value: unknown): PerformanceMode {
  return PERFORMANCE_MODES.includes(value as PerformanceMode) ? (value as PerformanceMode) : 'auto';
}

/**
 * A forced preset from the page's address (`?quality=low|medium|high`), in any
 * build, for this tab only (never stored): how the benchmark and screenshot
 * harnesses draw a chosen preset whatever GPU they run on — a headless
 * SwiftShader Chromium otherwise gets Auto's low.
 */
export function qualityFromSearch(search: string): QualityTier | null {
  const value = new URLSearchParams(search).get('quality');
  return value === 'low' || value === 'medium' || value === 'high' ? value : null;
}

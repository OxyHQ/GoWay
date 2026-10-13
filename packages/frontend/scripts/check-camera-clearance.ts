/**
 * The map's eye never inside a building, in a real build
 * (`docs/MAP_CAMERA_CLEARANCE.md`).
 *
 * Drives the camera of a served DEVELOPMENT export (only a development build
 * publishes the map, `__gowayReliefMap`, and the rule's probe,
 * `__gowayClearance`) at the Sagrada Família (a landmark model, 172 m) and
 * One Vanderbilt (a city-tile tower, 427 m), at street-level pitch, with real
 * input — Ctrl-drag rotations and tilts, the wheel — and one programmatic
 * orbit (`easeTo`, the path flyovers and tours take). On every frame MapLibre
 * draws, it samples the DRAWN eye against the prisms the engine holds (no
 * margin, no ramp: inside or not), and MapLibre's own eye beside the rule's.
 *
 *   bun run --cwd packages/frontend export:web --dev --output-dir /tmp/clearance
 *   bun scripts/serve-map-build.ts --dir=/tmp/clearance --port=8167 --upstream=https://goway.to
 *   bun scripts/check-camera-clearance.ts --url=http://localhost:8167 \
 *     [--scenes=sagrada,manhattan] [--out=dir] [--video] [--label=after] \
 *     [--playwright=/path/to/playwright/index.mjs]
 *
 * Fails when a drawn frame has its eye inside a building, except while data
 * that just arrived under the eye is being settled (`clearance.ts` →
 * `settleMs`), which it reports apart. Needs the network (goway.to's tiles),
 * so it is a local check, not a CI job.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Browser, Page } from 'playwright-core';

import { centreFor, landmarkPosition } from './cameraClearanceDrive';
import { type PublishedStats, unsettled } from './city3dSettled';

function arg(name: string, fallback = ''): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

const VIEWPORT = { width: 1280, height: 720 };
const NOON = new Date('2026-06-21T12:00:00+02:00');
const SETTLE_TIMEOUT_MS = Number(process.env.CLEARANCE_SETTLE_TIMEOUT_MS ?? 300_000);
/** A frame inside a building this soon after new data under the eye is the rule settling it. */
const SETTLING_MS = 600;
/** The preset: `low` keeps the 3D terrain and the sky, without the shadow map SwiftShader pays most for. */
const QUALITY = arg('quality', 'low');
const log = (line: string) => console.error(`${new Date().toISOString().slice(11, 19)} ${line}`);

interface Scene {
  id: string;
  name: string;
  target: { lat: number; lng: number };
  landmark: string | null;
  zoom: number;
  pitch: number;
}

const SCENES: Scene[] = [
  {
    id: 'sagrada',
    name: 'Sagrada Família',
    target: landmarkPosition('sagrada-familia'),
    landmark: 'sagrada-familia',
    zoom: 18.2,
    pitch: 76,
  },
  {
    id: 'manhattan',
    name: 'One Vanderbilt',
    target: { lat: 40.75298, lng: -73.97873 },
    landmark: null,
    zoom: 17.4,
    pitch: 76,
  },
];

/** Moving things off, as stored choices: they cost frames and are not the subject. */
const CHOICES = {
  city3d: true,
  cityTiles: true,
  citySky: true,
  landmarks: true,
  terrain: true,
  globe: true,
  city3dTrees: false,
  city3dTreeFill: false,
  cityLife: false,
  cityStreets: false,
  live: false,
  flyover: false,
};

/** The same, for a development build's address (it reads both). */
const FLAGS = Object.entries(CHOICES)
  .map(([id, on]) => `${id}=${on ? 1 : 0}`)
  .join('&');

interface Sample {
  t: number;
  inside: boolean;
  depthM: number;
  version: number | null;
  hasField: boolean;
  eye: { longitude: number; latitude: number; altitudeM: number };
  requiredM: number;
  camera: { zoom: number; pitch: number; bearing: number };
  /** MapLibre's own eye, for the cross-check. */
  maplibre: { lng: number; lat: number; altitudeM: number } | null;
}

async function waitSettled(page: Page, landmark: string | null, name: string): Promise<void> {
  const by = Date.now() + SETTLE_TIMEOUT_MS;
  let why: string | null = 'never read';
  while (Date.now() < by) {
    // The app may still replace the page's address while it boots.
    const published = await page
      .evaluate(() => {
        const scope = globalThis as {
          __gowayCity3d?: PublishedStats['city'];
          __gowayLandmarks?: PublishedStats['landmarks'];
        };
        return { city: scope.__gowayCity3d, landmarks: scope.__gowayLandmarks };
      })
      .catch(() => ({}) as PublishedStats);
    why = unsettled(published, { streets: false, landmark });
    if (why === null) return;
    await page.waitForTimeout(1000);
  }
  const seen = await page
    .evaluate(() => {
      const scope = globalThis as Record<string, unknown>;
      return JSON.stringify({ city: scope.__gowayCity3d, landmarks: scope.__gowayLandmarks });
    })
    .catch(() => 'unreadable');
  throw new Error(`${name}: never settled (${why}): ${seen.slice(0, 600)}`);
}

/**
 * Resolves after the map has drawn `frames` more frames (or 3 s), and the GPU
 * has finished them: a 1-px `readPixels` of the map's own context returns
 * only when its queue is done. A software rasteriser otherwise falls minutes
 * behind the page (`check-city3d-visible.ts` → `drainGpu`), and the video
 * with it.
 */
async function frames(page: Page, count = 2): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((done) => {
        const map = (
          globalThis as {
            __gowayReliefMap?: {
              on(type: string, f: () => void): void;
              off(type: string, f: () => void): void;
              triggerRepaint(): void;
            };
          }
        ).__gowayReliefMap;
        if (!map) return done();
        let left = n;
        const timer = setTimeout(finish, 3000);
        function finish() {
          clearTimeout(timer);
          map?.off('render', tick);
          const canvas = document.querySelector<HTMLCanvasElement>('.maplibregl-canvas');
          const gl = canvas?.getContext('webgl2');
          gl?.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
          done();
        }
        function tick() {
          if (--left <= 0) finish();
        }
        map.on('render', tick);
        map.triggerRepaint();
      }),
    count,
  );
}

async function ctrlDrag(page: Page, dx: number, dy: number, steps: number): Promise<void> {
  const cx = VIEWPORT.width / 2;
  const cy = VIEWPORT.height / 2 + 80;
  await page.mouse.move(cx, cy);
  await page.keyboard.down('Control');
  await page.mouse.down();
  for (let i = 1; i <= steps; i++) {
    await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
    await frames(page, 1);
  }
  await page.mouse.up();
  await page.keyboard.up('Control');
  await frames(page, 3);
}

async function runScene(
  browser: Browser,
  origin: string,
  scene: Scene,
  outDir: string,
  label: string,
  video: boolean,
) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    ...(video ? { recordVideo: { dir: outDir, size: VIEWPORT } } : {}),
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error(`[pageerror] ${String(e).slice(0, 300)}`));
  await page.clock.setFixedTime(NOON);
  await page.addInitScript(
    (stored) =>
      localStorage.setItem(
        'goway.mapFeatures',
        JSON.stringify({ v: 1, choices: stored, labs: true }),
      ),
    CHOICES,
  );
  const centre = centreFor(scene.target, scene.zoom, scene.pitch, VIEWPORT.height);
  // MapLibre's Ctrl-drag turns 0.8° a pixel: 75 px brings the eye onto the target.
  const startBearing = -60;
  const query = `lat=${centre.lat}&lng=${centre.lng}&zoom=${scene.zoom}&pitch=60&bearing=${startBearing}&quality=${QUALITY}&${FLAGS}`;
  await page.goto(`${origin}/?${query}`, { waitUntil: 'load', timeout: 180_000 });
  await page.waitForFunction(
    () => {
      const scope = globalThis as { __gowayReliefMap?: unknown; __gowayClearance?: unknown };
      return Boolean(scope.__gowayReliefMap && scope.__gowayClearance);
    },
    undefined,
    { timeout: 180_000 },
  );
  log(`${scene.id}: map up`);
  await waitSettled(page, scene.landmark, `${scene.id} (opened)`);
  log(`${scene.id}: settled`);
  // Street-level pitch, once the sky lifted the ceiling past 60°.
  await page.evaluate(
    ({ pitch, zoom, centre, bearing }) => {
      const map = (globalThis as { __gowayReliefMap?: { jumpTo(o: object): void } })
        .__gowayReliefMap;
      map?.jumpTo({ center: [centre.lng, centre.lat], zoom, pitch, bearing });
    },
    { pitch: scene.pitch, zoom: scene.zoom, centre, bearing: startBearing },
  );
  await waitSettled(page, scene.landmark, `${scene.id} (tilted)`);
  await frames(page, 3);
  log(`${scene.id}: tilted to ${scene.pitch}°, driving`);

  // Every frame MapLibre draws: the drawn eye against the prisms.
  await page.evaluate(() => {
    const scope = globalThis as {
      __gowayReliefMap?: {
        on(type: string, f: () => void): void;
        _camera?: {
          transform?: {
            getCameraAltitude(): number;
            getCameraLngLat(): { lng: number; lat: number };
          };
        };
      };
      __gowayClearance?: { probe(): Record<string, unknown> };
      __samples?: unknown[];
    };
    const samples: unknown[] = [];
    scope.__samples = samples;
    scope.__gowayReliefMap?.on('render', () => {
      const probe = scope.__gowayClearance?.probe();
      if (!probe) return;
      const tr = scope.__gowayReliefMap?._camera?.transform;
      const eye = tr?.getCameraLngLat();
      samples.push({
        t: performance.now(),
        ...probe,
        maplibre:
          tr && eye ? { lng: eye.lng, lat: eye.lat, altitudeM: tr.getCameraAltitude() } : null,
      });
    });
  });

  // 1. A slow rotation onto the target (the eye reaches it at bearing 0).
  await ctrlDrag(page, 75, 0, 30);
  log(`${scene.id}: rotated onto the target`);
  // 2. Tilts there: towards the horizon (into the building) and back, twice.
  await ctrlDrag(page, 0, -60, 15);
  await ctrlDrag(page, 0, 120, 20);
  await ctrlDrag(page, 0, -60, 15);
  // 3. On past it, then all the way back round through it.
  await ctrlDrag(page, 100, 0, 30);
  await ctrlDrag(page, -420, 0, 80);
  log(`${scene.id}: tilted and rotated back`);
  // 4. A programmatic orbit (easeTo: the flyover's and the tours' path).
  await page.evaluate(
    ({ bearing }) =>
      new Promise<void>((done) => {
        const map = (
          globalThis as {
            __gowayReliefMap?: { easeTo(o: object): void; once(t: string, f: () => void): void };
          }
        ).__gowayReliefMap;
        if (!map) return done();
        map.once('moveend', () => done());
        map.easeTo({ bearing, duration: 6000 });
      }),
    // From where the drags left it (104°) back through 0: across the target again.
    { bearing: -30 },
  );
  log(`${scene.id}: orbited`);
  // 5. The wheel, in at the centre.
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  for (let i = 0; i < 8; i++) {
    await page.mouse.wheel(0, -120);
    await frames(page, 2);
  }
  await page.waitForTimeout(1500);
  await frames(page, 3);

  const samples = (await page.evaluate(
    () => (globalThis as { __samples?: unknown[] }).__samples ?? [],
  )) as Sample[];
  const stats = await page.evaluate(
    () => (globalThis as { __gowayClearance?: { stats: unknown } }).__gowayClearance?.stats ?? null,
  );
  const videoPath = video ? await page.video()?.path() : undefined;
  await context.close();

  // Frames inside, and which of them followed new data under the eye.
  let lastVersion: number | null = null;
  let changedAt = -Infinity;
  let inside = 0;
  let settling = 0;
  let maxDepth = 0;
  let eyeError = 0;
  let altitudeError = 0;
  for (const s of samples) {
    if (s.version !== lastVersion) {
      changedAt = s.t;
      lastVersion = s.version;
    }
    if (s.inside) {
      if (s.t - changedAt < SETTLING_MS) settling++;
      else inside++;
      maxDepth = Math.max(maxDepth, s.depthM);
    }
    if (s.maplibre) {
      const k = 111_320;
      eyeError = Math.max(
        eyeError,
        Math.hypot(
          (s.eye.longitude - s.maplibre.lng) * k * Math.cos((s.maplibre.lat * Math.PI) / 180),
          (s.eye.latitude - s.maplibre.lat) * k,
        ),
      );
      altitudeError = Math.max(altitudeError, Math.abs(s.eye.altitudeM - s.maplibre.altitudeM));
    }
  }
  if (videoPath && existsSync(videoPath)) {
    const named = join(outDir, `${scene.id}-${label}.webm`);
    renameSync(videoPath, named);
  }
  return {
    scene: scene.id,
    label,
    frames: samples.length,
    framesWithBuildings: samples.filter((s) => s.hasField).length,
    insideFrames: inside,
    settlingFrames: settling,
    maxDepthM: Math.round(maxDepth * 10) / 10,
    lowestEyeM: Math.round(Math.min(...samples.map((s) => s.eye.altitudeM)) * 10) / 10,
    pitchRange: [
      Math.round(Math.min(...samples.map((s) => s.camera.pitch)) * 10) / 10,
      Math.round(Math.max(...samples.map((s) => s.camera.pitch)) * 10) / 10,
    ],
    eyeVsMapLibre: {
      metres: Math.round(eyeError * 1000) / 1000,
      altitudeM: Math.round(altitudeError * 1000) / 1000,
    },
    stats,
  };
}

async function main(): Promise<void> {
  const origin = arg('url', 'http://localhost:8167').replace(/\/$/, '');
  const outDir = resolve(arg('out', 'camera-clearance'));
  const label = arg('label', 'after');
  const video = process.argv.includes('--video');
  const wanted = arg('scenes', 'sagrada,manhattan').split(',');
  mkdirSync(outDir, { recursive: true });
  const playwright = (await import(
    arg('playwright', 'playwright-core')
  )) as typeof import('playwright-core');
  const browser = await playwright.chromium.launch({
    headless: true,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const results = [];
  let failed = false;
  try {
    for (const scene of SCENES.filter((s) => wanted.includes(s.id))) {
      const result = await runScene(browser, origin, scene, outDir, label, video);
      console.log(JSON.stringify(result));
      results.push(result);
      if (result.framesWithBuildings === 0) {
        console.error(`${scene.id}: no frame had the buildings to check against`);
        failed = true;
      }
      if (result.insideFrames > 0) {
        console.error(`${scene.id}: ${result.insideFrames} frames drew the eye inside a building`);
        failed = true;
      }
    }
  } finally {
    await browser.close();
  }
  writeFileSync(join(outDir, `results-${label}.json`), JSON.stringify(results, null, 2));
  if (video) {
    for (const file of readdirSync(outDir).filter((f) => f.endsWith(`-${label}.webm`))) {
      try {
        execFileSync('ffmpeg', [
          '-y',
          '-loglevel',
          'error',
          '-i',
          join(outDir, file),
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          join(outDir, file.replace(/\.webm$/, '.mp4')),
        ]);
      } catch {
        console.error(`ffmpeg: ${file} not converted (the .webm stays)`);
      }
    }
  }
  if (failed && !process.argv.includes('--report-only')) process.exit(1);
}

await main();

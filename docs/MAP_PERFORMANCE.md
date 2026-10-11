# Map performance: budgets, adaptive quality, and the gate

GoWay has to run well on a laptop and a phone, not only on the machine it was
built on. This note is the map's performance contract: what a frame may cost
on the devices we target, how the map measures itself, how it adapts its
quality to the device it is on, which hotspots were measured and fixed, and
the CI gate that keeps a change from blowing the budget.

| Piece | Where |
| --- | --- |
| The quality profile (platform-neutral: web and native read the same one) | `packages/frontend/lib/map/quality/profile.ts` |
| GPU tier (renderer string + warm-up benchmark), device class | `lib/map/quality/gpuTier.ts`, `deviceClass(.web).ts`, `components/map/perf/gpuBenchmark.web.ts` |
| The live profile (Settings → Performance, the stored GPU record, `?quality=`) | `lib/map/quality/useMapQuality.ts`, kept by `lib/map/mapFeatureStore.ts` |
| The engine's reading of it | `components/map/engine/quality.ts` (`cityQuality`) |
| The one animation clock (render on demand, idle and hidden pause) | `components/map/perf/animationClock.ts` |
| The runtime: pixel-ratio clamp, dynamic resolution, GPU tier, the HUD | `components/map/perf/mapRuntime.web.ts` (lazy chunk), `dynamicResolution.ts`, `frameStats.ts` |
| The instrument (draws, triangles, passes, uploads, GPU memory) | `components/map/perf/glCounters.ts` — the HUD, the benchmark and the gate all use it |
| The benchmark | `packages/frontend/scripts/bench-map.ts` (`bun run bench:map`) |
| The CI gate | `components/map/__tests__/frameBudget.test.ts` (+ `fixtures/`) |
| Tests | `lib/map/__tests__/quality.test.ts`, `components/map/__tests__/perfRuntime.test.ts`, `components/__tests__/perfChunk.test.ts`, `reliefAttach.test.ts`, `city3dFrame.test.ts` |

## Measuring

### The HUD

Any development build, or `?perf=1` on any build (it only shows numbers):
a panel at the bottom right with the preset and why it was chosen, the
renderer (so you know whether you are looking at a real GPU), FPS, frame time
p50/p95, main-thread time p50/p95 and per part of the frame (MapLibre, the
city engine, the sky passes, the shadow map, city life, landmarks, models),
GPU time where the browser has `EXT_disjoint_timer_query_webgl2`, draw calls,
triangles, instances, offscreen passes, bytes uploaded, an estimate of the GPU
memory held (buffers, textures, renderbuffers and the canvas), the JS heap, and
the animation clock (running or paused, and who is animating). The same
numbers are on `globalThis.__gowayPerf`.

### The benchmark

```bash
# The dev server, with the city and road archives (docs/MAP_CITY_LIFE.md → Turning it on):
GOWAY_CITY_TILES_ARCHIVE=… bunx expo start --web --port 8117
bun run --cwd packages/frontend bench:map --url=http://localhost:8117 \
  [--device=desktop|laptop|pixel6a|iphone12] [--quality=low|medium|high] \
  [--scenes=eixample,manhattan,montserrat,globe,traffic,idle,night] [--gpu=real|software] [--out=bench.json]
```

Fixed camera paths, every 3D feature on (city, city tiles, sky, trees, city
life, landmarks, globe, terrain), driven by real input (drag, ctrl-drag,
wheel): Eixample tilted and orbiting, Lower Manhattan's towers, Montserrat's
terrain, a zoom out to the globe, Passeig de Gràcia at z18 with traffic, the
same street left untouched for 30 s (`idle`), and Eixample at night. Nothing in
the page is asked to cooperate — an init script instruments the map's WebGL
context with `glCounters.ts` and wraps `requestAnimationFrame` — so `main`
measures exactly like a branch. Per scene, JSON: frames, FPS, frame interval,
main-thread ms, GPU ms, draws, triangles, instances, uploads, passes, long
tasks, GPU memory estimate, JS heap, and the engine's own statistics.

**What is real and what is emulated.** `--gpu=real` puts Chromium on ANGLE's
GL backend; under WSL2 with `GALLIUM_DRIVER=d3d12` that is the machine's real
GPU (an RTX 5090) through Mesa's D3D12 driver, and every result records the
renderer string. Measured here: the renderer reads
`ANGLE (Microsoft Corporation, D3D12 (NVIDIA GeForce RTX 5090), OpenGL 4.6)`;
headless Chromium's default is SwiftShader (a CPU rasteriser), and so was every
number in the 3D notes before this one. Three things to know before reading a
number:

- **The GPU is never emulated.** The device profiles emulate a laptop's or a
  phone's viewport, pixel ratio, touch and CPU (CDP CPU throttling, ×4–×5) —
  not its GPU. GPU milliseconds are always the RTX 5090's, and a phone's GPU
  is 30–60× slower.
- **The path to the GPU is slow.** WSL's D3D12 translation costs per frame and
  per upload: frames here are capped well below what the same GPU does
  natively (Eixample orbits at ~20 fps with ~7 ms of main thread and ~7 ms of
  GPU per frame). Read the INTERVAL as pessimistic and the CPU and GPU
  milliseconds as the costs.
- **A GPU timer measures from the frame's first command to its last.** Under
  CPU throttling the GPU waits for the CPU between commands, so "GPU ms" there
  includes those waits.
- **Two Chromiums on the D3D12 driver at once fall back to SwiftShader.**
  Measured (a calibration run beside a benchmark read SwiftShader). Run one
  benchmark at a time and check the recorded renderer.

## Budgets

Targets (owner, 2026-10-11): **60 fps on an integrated laptop GPU at 1080p,
never under 30**; on a **mid-range phone, 30 fps sustained** — with thermal
headroom, so a phone that holds 30 fps for ten minutes, not one that peaks at
it — and **inside iOS Safari's memory**, which kills a tab at roughly
1–1.5 GB of GPU + JS.

| | Laptop (Intel Iris Xe, Apple M1 base), 1080p | Phone (Adreno 6xx, Apple A14), 390–412 CSS px wide |
| --- | --- | --- |
| Frame | 16.7 ms; floor 33.3 | 33.3 ms sustained |
| GPU per frame | ≤ 12 ms (4.7 ms for the compositor and thermal headroom) | ≤ 20 ms (40% headroom for heat) |
| Main thread per frame | ≤ 10 ms: MapLibre ≤ 5, city engine ≤ 2, city life + live ≤ 1 | ≤ 20 ms (a phone CPU is 4–5× slower): MapLibre ≤ 10, engine ≤ 4, life + live ≤ 2 |
| Pixels | ≤ 2× (dynamic resolution down to 1×) | ≤ 2× (a 3× phone draws 2.25× fewer pixels); down to 1× |
| Full-screen passes | 3 sky passes, shadowed ground (8 taps) | 3 sky passes, no shadow taps |
| Draw calls | ≤ 400 (ours ≤ 250) | ≤ 250 (ours ≤ 150) |
| Triangles | ≤ 3 M (buildings ≤ 4 M vertices ≈ 2.2 M triangles, trees ≤ 16,000) | ≤ 1.5 M (buildings ≤ 2 M vertices ≈ 1.1 M, trees ≤ 6,000) |
| Shadow map | 1024², 8-tap PCF; redrawn only when the sun, the box or the casters change (≤ 4 Hz while moving) | none |
| Uploads | ≤ 8 MiB a frame | ≤ 4 MiB a frame |
| Workers | ≤ 2 mesh workers, ≤ 60 ms a tile (levels 1–2), ≤ 200 ms (level 0), off the main thread | 1 mesh worker |
| GPU memory (ours) | tile cache ≤ 128 MiB, shadow map 5 MiB | tile cache ≤ 80 MiB, no shadow map, no 3D terrain (≈ 200 MiB of MapLibre's terrain textures, measured) |
| JS heap | ≤ 300 MB | ≤ 200 MB |
| Animation | 30 Hz, paused after 45 s untouched or when hidden | 20 Hz, paused after 20 s or when hidden |

These are the medium and low presets below; the per-scene counts the CI gate
holds are under [The CI gate](#the-ci-gate).

## Adaptive quality

### The presets

| Knob | Low (phones, battery) | Medium (integrated laptops) | High (discrete GPUs, Apple Pro/Max) |
| --- | --- | --- | --- |
| Pixel ratio clamp / dynamic-resolution floor | 2 / 1 (battery saver 1.5) | 2 / 1 | 3 / 1.25 |
| Frame target | 33.3 ms | 16.7 ms | 16.7 ms |
| MSAA | off | off | on (applies to the next map) |
| Buildings drawn (vertices / bytes) | 2 M / 48 MiB | 4 M / 80 MiB | 8 M / 128 MiB |
| Tile cache | 80 MiB | 128 MiB | 192 MiB |
| Tiles drawn / at full detail | 20 / 3 | 32 / 4 | 48 / 6 |
| LOD pixel tolerance | 2.5 px | 1.5 px | 1 px |
| Upload per frame | 4 MiB | 8 MiB | 12 MiB |
| Mesh workers | 1 | 2 | 3 |
| Trees per frame | 6,000 | 16,000 | 40,000 |
| Sun shadows | none (no shadow map, no PCF compiled) | 1024², 8 taps | 2048², 12 taps |
| City life (cars + people) | 300 + 300 | 700 + 700 | 1,200 + 1,200 |
| Live entities | 500 | 2,000 | 5,000 |
| Landmarks held | 2 | 4 | 8 |
| 3D terrain | off (hillshade and globe stay) | on | on |
| Animation clock | 20 Hz, idle pause 20 s (battery: 15 Hz, 10 s) | 30 Hz, 45 s | 30 Hz, 120 s |

High is exactly what the engine drew before this profile existed, so a
capable machine loses nothing.

### Who gets which

Settings → Performance: **Auto** (the default), **Battery saver** (low, with a
slower clock, a shorter idle pause and a 1.5× pixel clamp) or **High quality**
(high, whatever the device). In the settings dialog's Map section, labelled in
all twelve languages, kept on the device with the map-feature preferences
(`setPerformance`); it applies live — the clock, the pixel ratio and dynamic
resolution at once, a new tier by re-attaching the 3D city.

Auto (`resolveQuality`): the GPU's tier, capped by the device class — a phone
or tablet is never high. Before the GPU is known a phone is low, a tablet and
a desktop medium.

The GPU tier (`gpuTier.ts`) combines two pieces of evidence, neither trusted
alone. The renderer string, read from the map's own context
(`WEBGL_debug_renderer_info`): a software rasteriser is always low; discrete
NVIDIA/AMD and Apple M-Pro/Max are high; Iris Xe, Radeon integrated and Apple
M base are medium; older Intel UHD, Adreno, Mali, PowerVR are low; "Apple GPU"
(every iPhone and iPad, masked) says nothing. Then, once per device when the
3D city first attaches and the map is idle, a warm-up micro-benchmark
(`gpuBenchmark.web.ts`, its own small context, ~10–150 ms, 20 ms on a software
rasteriser before it gives up): megapixels per millisecond of a fragment load
shaped like the sky's shadowed ground pass. The benchmark decides; the name
moves it at most one tier toward itself; a benchmark whose context landed on a
different renderer (a fallback) is discarded. The result is stored with the
map's preferences (`gpu`: renderer, score, tier, date), so later visits pick
their tier before the first frame; a new GPU or 30 days re-measure.

`?quality=low|medium|high` forces a preset in a development build (the
benchmark's switch); a production build ignores it.

### Dynamic resolution

While the 3D city is attached, the runtime watches each frame — its main-thread
time and, where the browser has a GPU timer, its GPU time; else the interval
between frames — and lowers the canvas's pixel ratio by 15% when the 80th
percentile of frames is 20% over the preset's target, down to the preset's
floor (`dynamicResolution.ts`, `map.setPixelRatio`). It raises it by 10% when
measured frames cost under 60% of the target; without a GPU timer, where a
60 Hz screen hides headroom, it probes one step up after 4 s calm and backs the
next probe off ×2 (to a minute) whenever one had to be undone. The flat map
alone keeps its own ratio, so a 2D map's labels never go soft.

### Render on demand and the battery rule

MapLibre draws only when something asks. Everything that moves by itself —
simulated city life, live vehicles, an animated model — asks the map's ONE
animation clock (`animationClock.ts`) instead of a timer of its own:

- one repaint per tick at the preset's rate, however many features animate;
- nothing while nothing animates;
- everything pauses when the tab is hidden or nobody has touched the map
  (pointer, wheel, key, touch) for the preset's idle time, and the city life
  worker pauses with it; the next interaction resumes it, with one frame at
  once.

Before: city life repainted at its own 30 Hz for as long as agents were on
screen, and an animated model repainted on every animation frame. The clock is
created by `MapCanvas.web.tsx` with the map (it must exist before any layer
attaches), so it is in the entry bundle; it is ~1 KB.

## The QualityProfile contract

Every feature that draws on the map honours this (`AGENTS.md`):

1. **Read your caps from the profile you are given; never detect the device
   yourself, and never keep a budget of your own beside it.** The adapter
   receives `quality: QualityProfile` (`city3dLayer.web.ts` → `AttachCity3dOptions`)
   and hands it on; the engine reads it through `engine/quality.ts`.
2. **A cap is a ceiling, not a target.**
3. **Animate only through the clock.** `clock.join('<name>', onPausedChange)`
   gives a ticket: `setAnimating(true)` while you have motion to show, `false`
   when you stop; stop your worker in `onPausedChange(true)` and resume it in
   `(false)`. Never `requestAnimationFrame` or `triggerRepaint` in a loop.
4. **A new cost is a new knob in the profile**, with a value for all three
   tiers, a row in the presets table above, and — if it changes what a frame
   draws — a gate scene or a budget line in `frameBudget.test.ts`.
5. **Platform-neutral.** `lib/map/quality/` imports no DOM, WebGL, React or
   MapLibre (the device class is the one platform fork); native reads the same
   profile, resolved from its own device class and GPU.

The fields today, and who reads them: `render` (pixel ratio, dynamic
resolution, target, MSAA — the runtime), `frame` (clock rate, idle pause — the
clock), `city` (draw, cache, tiles, LOD tolerance, upload, workers, trees — the
city engine), `sky` (shadow map size, PCF taps — the sky), `life` (agents —
city life), `live` (entities — the live layer, #132: cap what you draw,
nearest first), `landmarks` (models held — the adapter), `relief` (3D terrain —
the relief adapter, live). For the work in flight: the **vehicle library**
reads `life` for its instance counts and draws through the city life overlay's
clock ticket (its VAT animation advances only on the clock's frames); **street
markings** are geometry in the city tiles' budget (count their triangles in
`city.drawVertices`, or add a `city.markings` knob); **live data** takes
`live.maxEntities` and joins the clock as `'live'` (dead-reckoning between
fixes is motion: animate while anything moves, stop when all are stale).

## Hotspots, measured and fixed

‹TBD: before/after tables›

## The CI gate

`components/map/__tests__/frameBudget.test.ts`, run by `bun run test:frontend`
(the CI job "Test the frontend's pure modules"), ~7 s.

The REAL city engine and the REAL three.js renderer draw a synthetic city —
an Eixample-like grid, 113 m blocks of twenty buildings with recorded storeys
and street trees every 9 m (`fixtures/syntheticCity.ts`): made up, no
OpenStreetMap data, nothing random — encoded with the city-tile compiler's own
encoder, served over local HTTP in both tile formats, decoded and meshed by
the real mesh workers. The renderer draws into a stand-in WebGL 2 context
(`fixtures/fakeWebGl2.ts`: the real constants and method surface, every
program linking, no pixels), instrumented by the same `glCounters.ts` the HUD
uses. The engine runs on a virtual clock (`CityEngineOptions.now`). So the
counts are deterministic — no GPU, no wall clock, no network — and the gate
asserts, per scene (an orbit at 62°, a street at z17.6, a 75° skyline) and per
preset, the worst frame's draw calls and triangles, offscreen passes, shadow
redraws along the path, bytes uploaded while loading, GPU memory held, and that
no loading frame uploads more than the preset's budget; that a lower preset
is never the dearer one; and that a scene measured twice gives the same counts.

The budgets are the measured counts plus 10% (redraws and passes exactly).
Raising one is allowed and visible: change the number in the PR, with why.

**It can fail** — mutations, each run against the gate and reverted:

| Mutation | Fails |
| --- | --- |
| The shadow-map redraw fix reverted (ordered key, every drawn tile a caster, no throttle) | orbit and skyline, medium and high: draws (the shadow pass on most frames) |
| Low's tree budget raised to high's (6,000 → 40,000) | every low scene: draws |
| Medium's shadow map 1024² → 2048² | every medium scene: GPU memory |
| The perf runtime (or one of its parts) imported statically by another module | `perfChunk.test.ts` |

What it does not see: MapLibre's own cost, fill rate and shader cost (a
stand-in context rasterises nothing), and city life. Those are the
benchmark's.

## Duplication found in the 3D stack

The owner's rule is no duplicated or unnecessary code. Found while profiling;
fixed where it was on a path this change touched:

| What | Where | Done |
| --- | --- | --- |
| Two repaint loops for things that move (city life's own 33 ms timer, the model layer's every-frame repaint) | `lifeRenderer.ts`, `models.ts` | **Fixed**: one clock |
| Budgets restated beside each other (`DRAW_BUDGET`, `TREE_BUDGET`, `MAX_CACHED_BYTES`, `UPLOAD_BYTES_PER_FRAME`, `CITY_LIFE_BUDGET`, `MAX_LANDMARKS`, `LOD_POLICY`'s tile caps, `SHADOW_MAP_SIZE`) | `cityEngine.ts`, `city3dLayer.web.ts`, `lod.ts`, `shadows.ts` | **Fixed**: the profile is the one source; `LOD_POLICY` and `SHADOW_MAP_SIZE` read the high preset |
| Mercator y → latitude written out again; pixels-per-metre written out again | `lifeRenderer.ts` (beside `tileMath.latFromMercatorY`, `lod.metresPerPixel`) | **Fixed** |
| The source scanner of the chunk tests, five copies | `components/__tests__/*` | **Fixed**: `sourceScan.ts` |
| The LOD tests' MapLibre camera, now also the gate's | `city3dLod.test.ts` | **Fixed**: `fixtures/mapCamera.ts` |
| Two ground samplers: city life keeps its own per-z15 grid cache beside the engine's `TileGrounder` (same sampler, same grid, sampled twice) | `lifeRenderer.ts` `groundAt`, `terrainGround.ts` | Not fixed: share the grounder's grids through `CityOverlay.setGround` |
| Mercator y → latitude, two more copies | `cityLife/sim/network.ts`, `lib/map/camera/plane.ts` | Not fixed (not on these paths) |
| Hex colour → RGB, four copies | `cityEngine.ts` (`hexToVector`), `city3dTrees.ts`, `city3dLight.ts`, `lib/map/style/buildings3d.ts` | Not fixed |
| The GPU LOD test of city life replayed on the CPU for its statistics | `lifeRenderer.ts` `countTriangles` | Deliberate (development statistics), noted |

## Limits

- **No phone and no laptop was measured.** Every GPU number is an RTX 5090
  behind WSL's D3D12 translation; laptops and phones are emulated in viewport,
  pixel ratio, touch and CPU only. The budgets above are derived from those
  GPUs' published throughput and the measured per-frame counts, and the first
  real-device run should re-check them (`bench:map` against a deployed build
  on the device, or the HUD with `?perf=1`).
- The benchmark's thresholds for the GPU tier (`BENCHMARK_MPX_PER_MS`) were
  calibrated on two points only (‹TBD›).
- Native (`MapCanvas.native.tsx`) does not read the profile yet; the profile is
  platform-neutral so it can.
- Fill rate is not gated: a new full-screen pass, more PCF taps or a heavier
  material changes no count the gate reads. The benchmark's GPU ms is the
  measure; a GPU-timer gate in CI needs a GPU runner.

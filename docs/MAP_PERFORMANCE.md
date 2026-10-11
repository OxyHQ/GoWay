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
| Draw calls | ≤ 400 (ours ≤ 250) | ≤ 450 — measured 424 in the Eixample at low, most of them MapLibre's 2D layers redrawn per tile without terrain textures (ours ≤ 150) |
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

**Low has no 3D terrain, on purpose, and it costs draw calls.** Measured on
the phone profile, Eixample tilted: with 3D terrain MapLibre held **478 MB**
of textures (its terrain render-to-texture tiles, 2048² and mipmapped, one per
visible terrain tile), against **11 MB** without — on a device whose browser
kills the tab at about 1–1.5 GB. The price: without terrain MapLibre draws its
2D layers per tile on every frame instead of caching them in those textures,
~230 more draw calls a frame there (264 → 490). Memory is the hard limit (a
killed tab), draw calls the soft one, so low keeps the hillshade and the globe
and drops the terrain mesh; Settings → High quality brings it back.

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

A new ratio resizes the canvas, and **a resize during a gesture drops it** —
measured on the phone profile: with a ratio change mid-drag the map stopped
following the pointer (the camera moved 0.001° instead of 0.008°), and
followed it again with the change held back. So a change is applied only with
no pointer down, 400 ms after the last input, with the camera at rest, and
never inside MapLibre's own frame.

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
city life), `live` (entities — the live layer: drawn at most, nearest the
centre first, `liveLayer.web.ts` → `nearestLivePoints`), `landmarks` (models
held — the adapter), `relief` (3D terrain — the relief adapter, live).

Who animates through the clock today: city life (`'cityLife'`, its worker
paused with the clock), GoWay Live (`'live'`: its source is re-set in the
clock's `onTick`, at most every 50–250 ms by zoom, and it stops asking when
nothing moves), animated models and landmarks (`'models'`, `'landmarks'`).
For the work in flight: a **vehicle or person animation** (VAT, walk cycles)
advances only on the frames its feature's ticket gets — never its own loop;
**street markings** are geometry in the city tiles' budget (count their
triangles in `city.drawVertices`, or add a `city.markings` knob).

## Hotspots, measured and fixed

Measured with `bench:map`, every scene with every 3D feature on (detailed
look, sky, trees, city tiles, city life, landmarks, globe, terrain), `main`
(`432fd6a`) against this branch on it, one after the other on the same
machine, 2026-10-11. **GPU: the RTX 5090 through WSL's D3D12 translation
(real, recorded per scene); laptop and phone: emulated viewport, pixel ratio,
touch and CPU (×4), never their GPU** — see [Measuring](#measuring). The
laptop runs this branch at the medium preset and the phone at the low one
(what Auto picks on an Iris Xe and on an Adreno or a 3× iPhone); the desktop
at Auto, which is high on this GPU. "Frames/s" is frames the map DREW over the
scene — on a camera path it is bounded by how fast this environment delivers
input, and on the still scenes it is the render-on-demand measure (lower is
better there). Main-thread and GPU milliseconds are per drawn frame (the GPU
timer measures from a frame's first command to its last, so under the ×4 CPU
throttle it includes the GPU waiting for the CPU). Shadow redraws are the
engine's count over the whole scene, load included.

#### Desktop, 1920×1080 @1× — before: main, after: this branch (Auto → high)
| scene | frames/s | main thread ms p50/p95 | GPU ms p50/p95 | draws | triangles | offscreen passes/frame | shadow redraws | GPU MB (est.) | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|
| eixample | 19.9 → 23.1 | 7.2/14.3 → 6.3/11.2 | 5.1/32.2 → 4.5/24.9 | 392 → 391 | 7.59 M → 7.37 M | 1.5 → 1.5 | 54 → 23 | 1304 → 1305 | 415 → 150 |
| manhattan | 25.8 → 24.4 | 5.9/11.4 → 5.8/14.9 | 5.3/19.0 → 5.3/14.5 | 292 → 293 | 3.43 M → 3.43 M | 1.3 → 1.3 | 60 → 28 | 957 → 954 | 307 → 159 |
| montserrat | 57.3 → 56.6 | 3.0/5.4 → 3.1/5.5 | 9.9/18.5 → 7.3/17.7 | 103 → 103 | 0.92 M → 0.92 M | 0.6 → 0.6 | 0 → 0 | 657 → 657 | 242 → 141 |
| terrain-still | no frames | | | | | | | | |
| globe | 33.1 → 31.9 | 3.4/6.6 → 3.5/6.7 | 6.8/31.2 → 8.1/34.8 | 336 → 336 | 0.48 M → 0.48 M | 0.1 → 0.1 | 0 → 0 | 342 → 345 | 441 → 133 |
| traffic | 20.5 → 30 | 7.0/11.6 → 7.4/12.0 | 7.4/16.4 → 10.8/16.6 | 315 → 315 | 4.43 M → 4.43 M | 0.0 → 0.0 | 16 → 8 | 799 → 799 | 228 → 141 |
| idle | 20.2 → 29.2 | 8.1/13.0 → 8.8/13.7 | 7.8/10.7 → 3.4/14.0 | 351 → 351 | 4.58 M → 4.58 M | 0.0 → 0.0 | 19 → 11 | 916 → 916 | 307 → 159 |
| night | 19.5 → 20.5 | 7.0/14.5 → 6.9/15.3 | 4.7/37.6 → 4.4/32.6 | 385 → 383 | 6.98 M → 6.94 M | 1.5 → 1.5 | 0 → 0 | 1184 → 1184 | 415 → 150 |

#### Laptop, 1366×768 @2×, CPU ÷4 — before: main, after: this branch (quality medium)
| scene | frames/s | main thread ms p50/p95 | GPU ms p50/p95 | draws | triangles | offscreen passes/frame | shadow redraws | GPU MB (est.) | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|
| eixample | 22.7 → 26.1 | 27.0/43.0 → 26.1/45.8 | 3.0/17.4 → 3.0/17.7 | 311 → 259 | 5.71 M → 4.11 M | 0.8 → 0.9 | 98 → 69 | 919 → 799 | 527 → 125 |
| manhattan | 26.8 → 32.3 | 21.6/36.5 → 21.0/36.2 | 3.2/6.4 → 2.7/6.2 | 210 → 201 | 2.67 M → 1.91 M | 0.7 → 0.7 | 103 → 63 | 676 → 616 | 228 → 159 |
| montserrat | 54.6 → 52.3 | 9.3/16.5 → 10.3/17.7 | 14.2/24.9 → 14.5/27.5 | 77 → 77 | 0.61 M → 0.61 M | 0.2 → 0.2 | 0 → 0 | 588 → 575 | 228 → 169 |
| terrain-still | — → 0.4 | — → 21.5/42.5 | — → 19.2/28.9 | — → 67 | — → 0.54 M | — → 0.0 | — → 0 | — → 566 | — → 141 |
| globe | 39.1 → 40.3 | 11.7/20.9 → 11.8/21.9 | 4.7/30.7 → 3.7/22.5 | 257 → 257 | 0.30 M → 0.30 M | 0.0 → 0.0 | 0 → 0 | 136 → 107 | 257 → 117 |
| traffic | 19.8 → 27.3 | 28.7/36.9 → 27.1/37.6 | 15.6/21.3 → 11.7/18.9 | 257 → 234 | 4.09 M → 3.44 M | 0.0 → 0.0 | 16 → 6 | 529 → 478 | 290 → 141 |
| idle | 20 → 27.6 | 26.0/36.3 → 27.0/36.1 | 6.9/20.5 → 11.2/18.8 | 273 → 250 | 4.23 M → 3.57 M | 0.0 → 0.0 | 19 → 10 | 645 → 593 | 307 → 125 |
| night | 21.9 → 23.5 | 28.6/43.1 → 27.4/49.2 | 2.9/13.9 → 2.7/14.0 | 327 → 271 | 5.75 M → 4.14 M | 0.7 → 0.9 | 0 → 0 | 942 → 844 | 391 → 125 |

#### Phone (iPhone 12 class), 390×844 @3×, touch, CPU ÷4 — before: main, after: this branch (quality low)
| scene | frames/s | main thread ms p50/p95 | GPU ms p50/p95 | draws | triangles | offscreen passes/frame | shadow redraws | GPU MB (est.) | JS heap MB |
|---|---|---|---|---|---|---|---|---|---|
| eixample | 27.7 → 43.9 | 19.7/31.3 → 13.6/23.7 | 2.5/9.2 → 3.8/5.0 | 214 → 424 | 4.32 M → 1.82 M | 0.4 → 0.0 | 32 → 0 | 658 → 85 | 415 → 133 |
| manhattan | 44.3 → 46.1 | 12.5/21.7 → 11.2/15.3 | 1.9/3.4 → 1.7/1.9 | 137 → 378 | 2.38 M → 0.57 M | 0.3 → 0.0 | 35 → 0 | 411 → 34 | 179 → 125 |
| montserrat | 55.6 → 45.6 | 8.1/14.7 → 10.1/13.9 | 14.6/24.7 → 2.5/5.9 | 51 → 415 | 0.61 M → 0.23 M | 0.3 → 0.0 | 0 → 0 | 571 → 34 | 215 → 141 |
| terrain-still | no frames | | | | | | | | |
| globe | 58.8 → 57.6 | 7.1/11.6 → 9.4/15.5 | 15.2/19.7 → 12.8/19.2 | 102 → 100 | 0.09 M → 0.09 M | 0.0 → 0.0 | 0 → 0 | 69 → 26 | 215 → 141 |
| traffic | 20.2 → 20 | 19.6/21.6 → 20.3/29.4 | 6.0/14.5 → 5.4/24.1 | 204 → 311 | 3.95 M → 2.29 M | 0.0 → 0.0 | 16 → 0 | 396 → 85 | 290 → 125 |
| idle | 20 → 9.3 | 20.3/28.0 → 14.7/23.1 | 6.2/15.4 → 5.3/16.2 | 209 → 282 | 4.02 M → 2.31 M | 0.0 → 0.0 | 19 → 0 | 453 → 86 | 242 → 125 |
| night | 28.6 → 51.6 | 18.5/33.4 → 12.2/17.0 | 2.3/10.1 → 3.4/4.1 | 222 → 391 | 4.18 M → 1.91 M | 0.4 → 0.0 | 0 → 0 | 519 → 77 | 441 → 133 |

What each change bought, from those numbers and the gate:

1. **The shadow map was redrawn on most frames of any camera motion.** Its
   cache key listed the drawn tiles in draw order (nearest first, which an
   orbit reorders every frame) and every drawn tile, also those far outside
   the shadow box. Now the key is the SET of tiles that can cast into the box
   (`shadows.ts` → `castsInto`), and a change of casters alone redraws at most
   every 250 ms while the camera moves (`SHADOW_CASTER_REDRAW_MS`), catching up
   when it rests. Desktop: Eixample 54 → 23 redraws, Lower Manhattan 60 → 28 (laptop at medium: 98 → 69, 103 → 63, a 1024² map); a main-thread p95 of 14.3 → 11.2 ms and a GPU p95 of 32 → 25 ms on the Eixample orbit. In the CI gate's 12-frame orbit
   (medium and high), the old rule's redraws are a mutation that fails it.
2. **City life redrew the whole map at 30 Hz for as long as agents were on
   screen, and an animated model on every animation frame, forever.** Both now
   tick on the one clock and stop with it: the `idle` scene (30 s untouched,
   traffic on screen) on the phone profile at low draws 9.3 frames a
   second averaged over the scene, and none after its 20 s pause; on main it
   draws ~20 a second for as long as the tab is open. GoWay Live's 60 Hz frame
   loop joined the same clock.
3. **No preset existed: a phone drew what a desktop GPU draws.** The phone
   profile at low: GPU memory (estimated) 658 → 85 MB in the Eixample and 411 → 34 MB in Manhattan, triangles 4.32 M → 1.82 M and 2.38 M → 0.57 M, no shadow map and no shadow redraws (32 → 0), main thread p95 31 → 24 ms. Draw calls go UP (214 → 424): that is MapLibre drawing its 2D layers without the terrain textures (the trade-off above).
4. **Trees kept their 98-triangle near shape at any distance on city tiles**
   (they have no far level): now a level-0 tile's trees switch to the
   20-triangle far shape past the full-detail distance (`setEntryTreeDetail`);
   alone, −19% triangles in the gate's medium orbit (1.85 M → 1.50 M).
5. **Twelve shadow taps on every pixel of the full-screen ground pass, sky
   included.** The pass now skips the taps above the horizon, and the taps are
   a preset knob (12 / 8 / none).
6. **A 3× phone drew 3× its CSS pixels** (1170 × 2532 for the iPhone 12
   profile): the clamp makes it 2×, and dynamic resolution lowers it further
   while the 3D city is over budget.
7. **The laptop at medium**: triangles 5.71 M → 4.11 M (Eixample) and 2.67 M → 1.91 M (Manhattan), draws 311 → 259, GPU memory (estimated) 919 → 799 MB, a 1024² shadow map with 8 taps.

## What it costs at first paint

`expo export --platform web --clear`, no map variables, `main` (`432fd6a`)
against this branch:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,999,319 B (1,759,794 gz) | 7,008,808 B (1,763,403 gz) | +9,489 B, **+3,609 B gz** (+0.2%): the profile and its resolution, the GPU record in the store, the clock, the map's wiring |
| `__common` (first paint) | 100,520 B | 100,520 B | identical |
| `mapRuntime` (lazy, after the map loads) | — | 16,820 B (6,903 gz) | dynamic resolution, GPU tier and benchmark, the HUD and its counters |
| `MapSettingsModal` (lazy, on first open) | 250,458 B | 258,951 B | the Performance row and its twelve-language copy |

`components/__tests__/perfChunk.test.ts` pins the boundary.

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

The budgets are the measured counts plus 10% (redraws and passes exactly;
25% for the bytes uploaded while loading, the one count that depends on which
fallback levels happen to arrive first).
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
- The benchmark's thresholds for the GPU tier (`BENCHMARK_MPX_PER_MS`: medium
  ≥ 0.6, high ≥ 3 Mpx/ms) rest on two measured points — the RTX 5090 through
  WSL: 12.6–15.7 Mpx/ms (24–28 ms of benchmark once warm; 226 ms the first
  time, compiling); SwiftShader: 0.03 (stopped after one pass) — and on
  published throughput for the laptop and phone GPUs between them. The first
  real Iris Xe, M1, Adreno and A14 runs should move them.
- The JS heap (Chrome's `performance.memory`) reads 2–3× lower on this branch
  in every scene (e.g. Eixample 415 → 150 MB); it is GC-timed and quantised,
  and the cause is not attributed — read it as observed, not as a win.
- Native (`MapCanvas.native.tsx`) does not read the profile yet; the profile is
  platform-neutral so it can.
- Fill rate is not gated: a new full-screen pass, more PCF taps or a heavier
  material changes no count the gate reads. The benchmark's GPU ms is the
  measure; a GPU-timer gate in CI needs a GPU runner.

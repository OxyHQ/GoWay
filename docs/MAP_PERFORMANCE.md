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
| The visibility gate (the 3D city is on the screen, terrain on; CI job `city3d`) | `packages/frontend/scripts/check-city3d-visible.ts` ([`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md) → The visibility gate) |
| Tests | `lib/map/__tests__/quality.test.ts`, `components/map/__tests__/perfRuntime.test.ts`, `components/__tests__/perfChunk.test.ts`, `reliefAttach.test.ts`, `city3dFrame.test.ts` |

## Measuring

### The HUD

`?perf=1`, on any build — never by default, development builds included (it
covers part of the map, and its GL counters cost main-thread time; it only
shows numbers):
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
# Time a PRODUCTION export — what users run (the dev server's numbers are not:
# see below), with source maps for --profile. The benchmark turns every 3D
# feature on itself, as stored choices (a production build ignores ?city3d=1);
# fixtures keep the places layer off the network:
cd packages/frontend
EXPO_PUBLIC_GOWAY_FIXTURES=1 bunx expo export --platform web --source-maps --output-dir dist-bench
# Serve it with the city and road archives (docs/MAP_CITY_LIFE.md → Turning it on):
GOWAY_CITY_TILES_ARCHIVE=… bun scripts/serve-map-build.ts --dir=dist-bench --port=8119
bun run bench:map --url=http://localhost:8119 \
  [--device=desktop|laptop|laptop-2x|pixel6a|iphone12] [--quality=low|medium|high] \
  [--scenes=eixample,manhattan,montserrat,globe,traffic,idle,night] [--gpu=real|software] \
  [--no-counters] [--profile] [--tier=low|medium|high] [--out=bench.json]
```

- `--no-counters` for timing: no HUD and no GL counters (they cost the main
  thread ~2 ms a frame at ×4); frames and draw calls are still counted.
- `--profile`: a CPU profile of the path, source-mapped and split by
  subsystem (MapLibre, three.js, the city engine, city life, live, React, GC,
  the browser), over the whole path and over its **slow frames** alone —
  those at or over its p95 of main-thread time, so you see what a p95 is made
  of, per frame.
- `--dpr=` runs a device at another pixel ratio (a fill-rate experiment).
- `--quality=` forces a preset (`?quality=`); `--tier=` instead stores a GPU
  record of that tier and lets Auto resolve, as a real visit would (and works
  on a build older than `?quality=` in production).
- `laptop-2x` is the laptop at CPU ÷2 — see "How slow is ÷4" below.

**Three traps, all measured.** The dev server is not the product: React in
development mode and, before `?perf=1` was needed, the HUD's GL counters put
the Eixample orbit's main-thread p95 at 43–46 ms on the laptop profile where a
production export measures 30–41 ms. Metro run with `CI=true` (as agents run
it) does not reload: an edit is invisible until the server restarts — check
the served bundle. And two benchmarks at once share the GPU path (below).

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
- **One GPU timer per frame.** WebGL 2 allows one `TIME_ELAPSED` query at a
  time, and the runtime's spans the whole frame. Nothing else may open one.
  Until this was found, the city engine timed its own draws in development
  builds. Its `endQuery` closed the runtime's query at the city's last draw,
  so the HUD, the benchmark and dynamic resolution read a frame cut short
  there. Measured on the Eixample orbit (desktop): GPU p50 4.5–4.7 ms cut
  short, 5.7–5.9 ms whole; p95 26–30 ms against 52–53 ms. Production builds
  never had the engine's timer. To compare one layer, benchmark the scene
  with that layer on and off.
- **The benchmark had a timer of its own, wrong twice.** It opened one query
  per frame, from one frame's start to the next: across the gap between
  frames it read the GPU's idle wait as work (a Montserrat orbit: 10.8–15.7 ms
  against the map's own 1.65 ms). And in a build with the perf runtime it was
  a second query: the runtime's `beginQuery` was refused, its `endQuery`
  closed the benchmark's, its own queries never resolved — so during every
  benchmark the HUD read "no timer" and dynamic resolution fell back to frame
  intervals (measured: Manhattan, the runtime's GPU time absent with the old
  benchmark, p50 2.9 ms with the new). Now the benchmark reads the map's own
  timer and opens one only where the map has none, around the frame
  callbacks that draw; the two agree (above). Every table here was
  re-measured that way, on production exports, after #156.
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
| Draw calls | ≤ 400 (ours ≤ 250) | ≤ 250 — measured 149 in the Eixample at low (ours ≤ 150) |
| Triangles | ≤ 3 M (buildings ≤ 4 M vertices ≈ 2.2 M triangles, trees ≤ 16,000) | ≤ 1.5 M (buildings ≤ 2 M vertices ≈ 1.1 M, trees ≤ 6,000) |
| Shadow map | 1024², 8-tap PCF; redrawn only when the sun, the box or the casters change (≤ 4 Hz while moving) | none |
| Uploads | ≤ 8 MiB a frame | ≤ 4 MiB a frame |
| Workers | ≤ 2 mesh workers, ≤ 60 ms a tile (levels 1–2), ≤ 200 ms (level 0), off the main thread | 1 mesh worker |
| GPU memory (ours) | tile cache ≤ 128 MiB, shadow map 5 MiB | tile cache ≤ 80 MiB, no shadow map, terrain textures at 1× (95–153 MB measured, against 478 MB at MapLibre's 2×) |
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
| Street detail: tiles / triangles per frame (`MAP_STREETS.md`) | 6 / 400 k | 10 / 900 k | 16 / 2 M |
| 3D terrain (textures: the 2D layers MapLibre caches per terrain tile) | on, textures 1× the terrain tile (1,024²) | on, 2× (2,048², MapLibre's own) | on, 2× |
| Animation clock | 20 Hz, idle pause 20 s (battery: 15 Hz, 10 s) | 30 Hz, 45 s | 30 Hz, 120 s |
| Basemap density (`MAP_STYLES.md` → Performance) | Standard's: a denser style (Streets) applies its `goway:quality-low` overrides | the style's | the style's |
| Camera volumes: bytes per tile / corners per footprint (`MAP_CAMERA_CLEARANCE.md`) | 256 KiB / 8 | 512 KiB / 12 | 1 MiB / 16 |

High is exactly what the engine drew before this profile existed, so a
capable machine loses nothing.

**Low keeps 3D terrain, with lighter textures.** With 3D terrain MapLibre
draws the 2D layers (fills, roads, hillshade) once per terrain tile into a
texture and re-uses it while the camera moves; without it, it draws every 2D
layer per tile on every frame. Those textures are 2× the 1,024 px terrain
tile by default — 2,048², ~22 MB each with mipmaps, one per visible terrain
tile: **478 MB** in the Eixample on the phone profile, on a browser that kills
the tab at about 1–1.5 GB. The first answer (#151) turned terrain off at low:
11 MB of textures, but twice the draw calls and MapLibre's work per frame.
Now low keeps the terrain and makes its textures 1× (`relief.terrainTextureScale`,
`reliefLayer.web.ts` → `applyTextureScale`; MapLibre's `Terrain.qualityFactor`,
pinned by `reliefTextureScale.test.ts`): a quarter of the memory per texture,
roads and fills draped at half the resolution, labels unaffected — they are
drawn after, not into the textures. Measured on the phone profile at low,
production build, terrain off (#151) → 1× terrain:

| scene | draw calls p50 | GPU MB (est.) — of it textures | main thread ms p50 / p95 |
| --- | --- | --- | --- |
| eixample | 423 → **149** | 82 → 223 — 9 → 131 | 11.8 / 15.6 → 11.5 / 17.4 |
| manhattan | 383 → **127** | 29 → 119 — 15 → 95 | 11.1 / 15.9 → 10.5 / 16.1 |
| montserrat | 419 → **54** | 19 → 166 — 16 → 153 | 9.1 / 20.8 → 8.9 / 15.5 |

Fewer draw calls than `main` drew with full textures (214 in the Eixample,
the table under [Hotspots](#hotspots-measured-and-fixed)), for a third of
`main`'s GPU memory there (655 MB) — under a quarter of the
tab's ceiling. The main thread is a wash on this host (MapLibre's per-tile
redraw is cheap JS and dear GPU work: the saving is the phone GPU's, which
this machine cannot measure).

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

`?quality=low|medium|high` forces a preset in any build, for that tab only
(nothing is stored): the switch of the benchmark and of screenshot harnesses,
whose headless SwiftShader Chromium Auto otherwise sends to low. It can make a
weak device draw more than it should — only the tab that asked, and no link
the app produces carries it.

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

A frame's cost is the larger of its main-thread time and its WHOLE GPU time
(the runtime's own query around MapLibre's frame, the only one since #156):
`perfRuntime.test.ts` → "dynamic resolution reads the frame GPU time" drives
the runtime with frames of 5 ms of main thread and 30 ms of GPU, and the ratio
drops; with 3 ms of GPU it holds (and fails if the runtime ignores the GPU
time). On this machine no scene is GPU-bound enough to move it — the desktop
Eixample at 3× (the canvas capped at 4,096 px): GPU p50 6.3 ms, the ratio held
at 3 — so the first device to exercise it is a real laptop or phone (`?perf=1`
shows the ratio).

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

## Default on (2026-10-12)

The 3D city and everything in it is on for everyone on goway.to
([`MAP_FEATURES.md`](./MAP_FEATURES.md) → Defaults). Nothing is switched off
by preset: every device draws every feature, and the profile decides how
much. What each preset gets:

| Feature | Low (phones, battery saver) | Medium | High |
| --- | --- | --- | --- |
| Engine fetched | once the camera reaches z14 or tilts 45° (all presets) | same | same |
| 3D city (buildings, city tiles where published) | 2 M vertices, 20 tiles (3 full), 80 MiB cache, 1 worker | 4 M, 32 (4), 128 MiB, 2 | 8 M, 48 (6), 192 MiB, 3 |
| Trees | 6,000 | 16,000 | 40,000 |
| Sky, haze, time of day | 3 sky passes, **no shadow map** | + 1024² shadows, 8 taps | + 2048², 12 taps |
| Detailed look | on: shading only — the CI gate counts the same draws, triangles and GPU bytes with and without it | on | on |
| Simulated traffic | 300 cars + 300 people, 20 Hz clock, paused after 20 s untouched (battery: 15 Hz, 10 s) | 700 + 700, 30 Hz, 45 s | 1,200 + 1,200, 30 Hz, 120 s |
| Street detail (where the road archive is published) | 6 tiles, 400 k triangles | 10, 900 k | 16, 2 M |
| Landmarks (over published city tiles) | 2 held | 4 | 8 |
| Flyover | on (no cost until a route is flown) | on | on |

Why Low keeps every feature: the phone budget rows above were measured
with the whole 3D set on (#151/#154/#156: Eixample at low, 149 draws, 225 MB
GPU estimate, against ≤ 250 draws and iOS Safari's ~1–1.5 GB), and the two
costs that had no measurement then are capped by the profile — street detail
(at most 12 draw calls and 400 k triangles on a phone) and the detailed look
(no count changes, in the gate). The sky stays because Low already budgets
its three passes without shadow taps; traffic stays because it pauses with
the clock and its agents are a quarter of a desktop's.

**Nothing until the camera is near.** The engine (three.js and the city
engine, 1,418,706 B gz), its mesh worker (32 KB gz) and the simulation worker
(31 KB gz) are fetched only once the camera has been at z14 or tilted 45°
(`lib/map/cityEngineGate.ts`). goway.to opens at z11, flat:
measured on the production export, that view loads none of them (JS heap
54 MB, as `main`; 87 MB when the engine attached at once).

**Measured** (2026-10-12, production exports served with `serve-map-build.ts
--upstream=https://goway.to`: goway.to's basemap, terrain and published
Catalonia / New York city and road tiles; phone profile at low, real GPU,
interleaved A B C / C B A runs, values per run). The machine was shared with
other agents' headless Chromiums (load average 14–21), so main-thread
milliseconds swing ±30% between runs of the same build; the counts do not:

| scene | build | main thread p50 / p95 ms | draws | triangles | GPU MB (est.) |
| --- | --- | --- | --- | --- | --- |
| eixample | `main` (globe + terrain, MapLibre's `building-3d`) | 23.7, 15.9 / 42.1, 28.3 | 111 | 1.14 M | 192 |
| eixample | this branch, everything on | 25.9, 22.0 / 48.1, 41.0 | 151 | 2.32–2.36 M | 229 |
| night | `main` | 19.9, 17.5 / 34.7, 28.3 | 94 | 0.96 M | 161–165 |
| night | this branch | 23.5, 24.0 / 37.9, 38.7 | 159 | 2.53 M | 215 |
| traffic (z18, agents moving) | this branch | 28.0, 25.6 / 38.4, 37.8 | 159–163 | 2.78 M | 171 |

Against the phone budgets: draws 151–163 of ≤ 250, GPU memory 170–230 MB of a
~1–1.5 GB tab, inside them; triangles 2.3–2.8 M are over the 1.5 M line, as
the whole-3D-set measurement was before this change (2.20 M at low, #156) —
the excess is terrain and basemap geometry beside the capped city, and the
first real-device run should settle whether the line or the count moves. The
main thread at CPU ÷4 is over 20 ms in every build here, `main` included: on
this loaded host it measures contention, not the phone. Street detail on and
off (a build with it switched off, interleaved, same scenes) drew the same
counts at the benchmark's cameras (151 / 114 / 159–163 draws).

**First paint** (`expo export --platform web --clear`, no map variables,
`main` at `8896de0` against this change on it): `entry` 7,067,870 → 7,068,442 B
(1,780,244 → 1,780,451 gz, **+207 B gz**: the registry's defaults and the
engine's zoom gate); `__common` and `global.css` identical. Lazy:
`city3dLayer` +319 B gz (the coverage document's road tree, the landmark
offer), `simWorker` +1,381 B gz (the coverage decoder), `MapSettingsModal`
+61 B gz.

## The street on the terrain's facets, on a real GPU (2026-10-13)

What #210 (the street detail cut to MapLibre's terrain facets,
`MAP_TERRAIN_GLOBE.md` → "Everything on the drawn ground") costs where it is
drawn: production exports served with `serve-map-build.ts
--upstream=https://goway.to`, `bench:map --gpu=real` — Chromium on ANGLE's GL
backend with `GALLIUM_DRIVER=d3d12`, i.e. **the host's real GPU (NVIDIA
GeForce RTX 5090) through WSLg's D3D12 driver**, renderer string checked in
every result — two rounds, order A B C then C B A, values per round. Builds:
**A** `main` before #198 (a078b93), **B0** `main` with the cut switched off
(5ad2f65, the street meshed uncut), **B** `main` (5ad2f65). GPU milliseconds are
the map's own timer queries; the host GPU is a desktop one, so they bound
nothing for a phone.

| Scene | Preset (device) | Build | GPU ms p50 | Draws | Triangles p50 | GL buffers MB |
| --- | --- | --- | --- | ---: | ---: | ---: |
| traffic (z18, 55°) | low (Pixel 6a profile) | A | 1.21, 3.43 | 137 | 2.851 M | 92.5 |
| | | B0 | 3.22, 3.52 | 144 | 2.869 / 2.851 M | 92.6 |
| | | B | 1.23, 3.51 | 135 | 2.877 M | 88.9 / 94.4 |
| | high (desktop) | A | 1.90, 1.85 | 239 | 4.662 M | 100.8 |
| | | B0 | 2.01, 2.07 | 274 | 4.664 M | 100.9 |
| | | B | 2.04, 2.11 | 274 | 5.532 M | 122.6 |
| eixample (z16.3, 62°) | low (Pixel 6a profile) | A | 1.34, 1.38 | 133 | 2.48 / 2.47 M | 92.7 |
| | | B0 | 1.36, 1.42 | 130 | 2.468 M | 92.1 |
| | | B | 2.79, 1.52 | 127 | 2.603 M | 97.4 / 105.8 |
| | high (desktop) | A | 3.97, 3.81 | 334 | 6.10 / 6.26 M | 281.7 |
| | | B0 | 3.73, 3.70 | 334 | 5.92 / 6.04 M | 281.8 |
| | | B | 3.55, 3.95 | 332 | 6.70 / 6.94 M | 324.7 |

- **Frame time: no change measurable on this GPU** — every difference is
  inside the run-to-run spread (the low runs are bimodal, 1.2 or 3.5 ms, in
  every build).
- **High pays in triangles and buffers:** +0.87 M triangles (+19%) and
  +22 MB buffers at traffic, +0.8 M (+13%) and +43 MB at eixample.
- **Low barely pays, because its budget caps the street detail:**
  +0.03–0.13 M triangles (+1–5%), buffers −4 to +13 MB; instead the street
  detail covers less — the same 400 k street triangles hold fewer cut tiles
  (draws 135 against 144 at traffic). That is the cost on a phone: coverage,
  not frames.
- A phone GPU's milliseconds are still unmeasured: that needs a device —
  Android Chrome over USB (`chrome://inspect`, the benchmark's script pointed
  at the device's DevTools endpoint) or a device farm.

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
held — the adapter), `streets` (street-detail tiles and triangles drawn — the
street renderer, farthest tiles simplified then dropped past the budget), `camera` (the bytes and footprint
corners of each tile's building volumes — the mesh worker, `MAP_CAMERA_CLEARANCE.md`), `relief` (3D terrain and its textures' scale — the
relief adapter, live).

Who animates through the clock today: city life (`'cityLife'`, its worker
paused with the clock), GoWay Live (`'live'`: its source is re-set in the
clock's `onTick`, at most every 50–250 ms by zoom, and it stops asking when
nothing moves), animated models and landmarks (`'models'`, `'landmarks'`).
For the work in flight: a **vehicle or person animation** (VAT, walk cycles)
advances only on the frames its feature's ticket gets — never its own loop;
**street markings** are geometry in the city tiles' budget (count their
triangles in `city.drawVertices`, or add a `city.markings` knob).

## Hotspots, measured and fixed

Measured with `bench:map` on **production exports**, every scene with every
3D feature on (detailed look, sky, trees, city tiles, city life, landmarks,
globe, terrain): `main` before the profile (`432fd6a`) against `main` after
#151, #154 and #156 (`319927f`), 2026-10-12, one Chromium at a time on a quiet
machine, the preset forced with `?quality=` (desktop high, laptop medium,
phone low — what Auto picks on this GPU, an Iris Xe and an Adreno or a 3×
iPhone). **GPU: the RTX 5090 through WSL's D3D12 translation (real, recorded
per scene); laptop and phone: emulated viewport, pixel ratio, touch and CPU
(×4), never their GPU** — see [Measuring](#measuring). "Frames/s" is frames
the map DREW over the scene — on a camera path it is bounded by how fast this
environment delivers input, and on the still scenes it is the render-on-demand
measure (lower is better there); a still scene is measured from a touch.
Main-thread and GPU milliseconds are per drawn frame. **GPU ms is the map's
own timer** (the perf runtime's, what dynamic resolution reads) where the
build has one, else the benchmark's around the frame's drawing — the two read
alike (Montserrat 1.68 / 1.66 ms, Eixample 6.18 / 5.90 ms); under the ×4 CPU
throttle it includes the GPU waiting for the CPU. These replace #151's
tables, which were development builds with a GPU column cut short or
stretched (see "One GPU timer per frame"); the shadow-redraw column is gone
(the engine publishes its statistics in development builds only), and #151's
development counts for it are quoted below.

#### Desktop, 1920×1080 @1× — before: `432fd6a`, after: `319927f` at high
| scene | frames/s | main thread ms p50/p95 | GPU ms p50/p95 | draws | triangles | offscreen passes/frame | GPU MB (est.) | JS heap MB |
|---|---|---|---|---|---|---|---|---|
| eixample | 23.5 → 23.7 | 5.9/11.2 → 6.1/10.9 | 5.5/53.4 → 5.8/51.4 | 393 → 393 | 7.59 M → 7.24 M | 1.5 → 1.5 | 1343 → 1343 | 491 → 116 |
| manhattan | 31.1 → 32.6 | 4.8/7.5 → 4.8/7.7 | 3.4/31.2 → 3.2/30.7 | 294 → 279 | 3.43 M → 3.43 M | 1.3 → 1.2 | 975 → 975 | 157 → 109 |
| montserrat | 59.7 → 59.9 | 2.3/3.4 → 2.4/3.4 | 1.6/7.2 → 1.7/6.8 | 103 → 103 | 0.92 M → 0.92 M | 0.6 → 0.6 | 665 → 664 | 188 → 97 |
| terrain-still | no frames (nothing moves: render on demand) | | | | | | | |
| globe | 38.9 → 42.1 | 2.7/4.4 → 2.9/4.5 | 2.5/24.3 → 4.9/24.3 | 333 → 326 | 0.48 M → 0.48 M | 0.1 → 0.1 | 331 → 334 | 435 → 81 |
| traffic | 20.3 → 30.2 | 5.7/6.2 → 5.8/6.5 | 11.5/11.7 → 3.3/12.1 | 315 → 315 | 4.43 M → 4.43 M | 0.0 → 0.0 | 813 → 813 | 254 → 109 |
| idle | 20.2 → 30.2 | 6.8/7.3 → 6.7/7.2 | 3.6/12.8 → 3.6/13.3 | 351 → 351 | 4.58 M → 4.58 M | 0.0 → 0.0 | 936 → 936 | 199 → 81 |
| night | 23.5 → 23.9 | 6/9.9 → 6.2/10 | 5.2/44.4 → 5.6/43.6 | 384 → 383 | 7.02 M → 6.91 M | 1.5 → 1.5 | 1217 → 1217 | 364 → 167 |

#### Laptop, 1366×768 @2×, CPU ÷4 — before: `432fd6a`, after: `319927f` at medium
| scene | frames/s | main thread ms p50/p95 | GPU ms p50/p95 | draws | triangles | offscreen passes/frame | GPU MB (est.) | JS heap MB |
|---|---|---|---|---|---|---|---|---|
| eixample | 29 → 33.5 | 21.9/31.9 → 19.8/31.4 | 4.1/30.2 → 3.4/28.7 | 317 → 264 | 5.94 M → 4.11 M | 1.1 → 1.0 | 915 → 822 | 410 → 97 |
| manhattan | 41.6 → 42.7 | 15.3/24.8 → 15.3/25 | 2.6/17.6 → 3.9/20.3 | 214 → 206 | 2.69 M → 1.94 M | 0.8 → 0.8 | 660 → 630 | 188 → 116 |
| montserrat | 58.9 → 59.1 | 8.1/12.4 → 8.1/12.6 | 1.5/6.1 → 1.5/6.2 | 79 → 79 | 0.61 M → 0.61 M | 0.5 → 0.5 | 566 → 551 | 148 → 81 |
| terrain-still | no frames (nothing moves: render on demand) | | | | | | | |
| globe | 45.3 → 46.2 | 9.5/14.7 → 9.3/14.5 | 2.0/6.8 → 2.5/9.5 | 257 → 257 | 0.30 M → 0.30 M | 0.0 → 0.0 | 92 → 76 | 212 → 116 |
| traffic | 20.2 → 30.2 | 19.4/21.7 → 17.9/20 | 9.4/9.6 → 2.6/9.1 | 257 → 234 | 4.09 M → 3.44 M | 0.0 → 0.0 | 505 → 489 | 286 → 123 |
| idle | 20.2 → 17.3 | 21.9/24.2 → 20.5/22.9 | 10.4/10.6 → 2.6/9.8 | 273 → 250 | 4.23 M → 3.57 M | 0.0 → 0.0 | 626 → 610 | 322 → 131 |
| night | 31.3 → 35.1 | 21.7/30.7 → 20.6/30.7 | 4.1/22.9 → 3.5/25.8 | 332 → 276 | 5.81 M → 4.14 M | 0.9 → 0.9 | 815 → 755 | 435 → 103 |

#### Phone (iPhone 12 class), 390×844 @3×, touch, CPU ÷4 — before: `432fd6a`, after: `319927f` at low
| scene | frames/s | main thread ms p50/p95 | GPU ms p50/p95 | draws | triangles | offscreen passes/frame | GPU MB (est.) | JS heap MB |
|---|---|---|---|---|---|---|---|---|
| eixample | 44.3 → 52.1 | 14.5/19.9 → 11.8/16.6 | 2.6/10.8 → 2.4/9.6 | 214 → 149 | 4.25 M → 2.20 M | 0.4 → 0.5 | 655 → 225 | 410 → 109 |
| manhattan | 56.6 → 59 | 11.2/16.3 → 10.4/15.6 | 3.2/5.3 → 2.2/4.8 | 141 → 126 | 2.42 M → 0.94 M | 0.3 → 0.4 | 396 → 120 | 131 → 103 |
| montserrat | 58.9 → 58.9 | 7.2/11.5 → 8.3/12.9 | 3.0/5.7 → 1.0/3.5 | 55 → 55 | 0.61 M → 0.54 M | 0.5 → 0.5 | 561 → 165 | 139 → 109 |
| terrain-still | no frames (nothing moves: render on demand) | | | | | | | |
| globe | 59.6 → 59.6 | 7.3/10.9 → 7.2/11.6 | 0.7/2.5 → 0.6/1.9 | 102 → 100 | 0.09 M → 0.09 M | 0.0 → 0.0 | 37 → 16 | 199 → 68 |
| traffic | 20.5 → 19.8 | 17.4/19.5 → 15.6/17.2 | 8.1/15.7 → 7.2/14.0 | 204 → 153 | 3.95 M → 2.55 M | 0.0 → 0.0 | 379 → 162 | 199 → 97 |
| idle | 20.1 → 13.3 | 18.6/21 → 16.2/18.8 | 8.6/8.9 → 7.6/14.7 | 209 → 158 | 4.02 M → 2.62 M | 0.0 → 0.0 | 440 → 178 | 188 → 92 |
| night | 43.5 → 57.4 | 14.6/20 → 11.4/16.8 | 2.9/11.3 → 2.0/8.0 | 222 → 159 | 4.17 M → 2.28 M | 0.4 → 0.4 | 509 → 172 | 269 → 123 |

What each change bought, from those numbers and the gate:

1. **The shadow map was redrawn on most frames of any camera motion.** Its
   cache key listed the drawn tiles in draw order (nearest first, which an
   orbit reorders every frame) and every drawn tile, also those far outside
   the shadow box. Now the key is the SET of tiles that can cast into the box
   (`shadows.ts` → `castsInto`), and a change of casters alone redraws at most
   every 250 ms while the camera moves (`SHADOW_CASTER_REDRAW_MS`), catching up
   when it rests. #151's development counts: desktop Eixample 54 → 23
   redraws, Lower Manhattan 60 → 28 (laptop at medium: 98 → 69, 103 → 63, a
   1024² map). On production exports the desktop Eixample orbit reads alike
   before and after (main thread p95 11.2 → 10.9 ms, GPU p95 53 → 51 ms): a
   2,048² shadow pass is cheap for this GPU, and the GPU p95 here is WSL's
   waits. In the CI gate's 12-frame orbit (medium and high), the old rule's
   redraws are a mutation that fails it.
2. **City life redrew the whole map at 30 Hz for as long as agents were on
   screen, and an animated model on every animation frame, forever.** Both now
   tick on the one clock and stop with it: the `idle` scene (30 s untouched,
   traffic on screen) on the phone profile at low draws 13.3 frames a
   second averaged over the scene, and none after its 20 s pause; `432fd6a`
   draws 20 a second for as long as the tab is open. GoWay Live's 60 Hz frame
   loop joined the same clock.
3. **No preset existed: a phone drew what a desktop GPU draws.** The phone
   profile at low: GPU memory (estimated) 655 → 225 MB in the Eixample and
   396 → 120 MB in Manhattan, triangles 4.25 M → 2.20 M and 2.42 M → 0.94 M,
   draws 214 → 149, no shadow map, main thread p95 19.9 → 16.6 ms. (In #151
   low had no 3D terrain and drew 424 calls; it now keeps lighter terrain
   textures — [the presets](#the-presets).)
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
7. **The laptop at medium**: triangles 5.94 M → 4.11 M (Eixample) and
   2.69 M → 1.94 M (Manhattan), draws 317 → 264, GPU memory (estimated)
   915 → 822 MB, a 1024² shadow map with 8 taps.

## The laptop's main thread at medium, attributed

The laptop profile at the medium preset was the one over budget in #151:
main-thread p95 43–46 ms on the Eixample orbit at CPU ÷4, against 16.7 ms.
Re-measured here on **production exports** (`serve-map-build.ts`;
`--no-counters` for timing, `--profile` for attribution), `#151` (`eb6383a`)
against this branch, 2026-10-12, same machine, real GPU recorded per scene.

**First finding: most of that 43–46 ms was the measurement.** The same scene
on a production export of the same code: p95 30–31 ms (two runs). The dev
server ran React in development mode and the HUD's GL counters on every frame
(~2 ms a frame at ÷4, attributed); the HUD now needs `?perf=1` everywhere.

### Where a frame goes

Self time per drawn frame, by subsystem — production export, Eixample orbit,
medium, this branch. Native WebGL calls are charged to their caller; "browser"
is the renderer's own native work (command submission, compositing, style
and layout), not attributable to a script.

| subsystem | CPU ÷4: ms / frame | CPU ÷2: ms / frame |
| --- | ---: | ---: |
| MapLibre (its own JavaScript) | **17.3** | **8.7** |
| three.js (the renderer, for every GoWay 3D layer) | 6.6 | 3.5 |
| browser (native) | 3.8 | 2.3 |
| city engine (selection, LOD, ground, shadows' bookkeeping) | 1.9 | 0.9 |
| React | 0.7 | 0.4 |
| garbage collection | 0.5 | 0.3 |
| city life | 0.3 | 0.15 |
| perf runtime (dynamic resolution, frame statistics; no HUD) | 0.2 | 0.1 |
| live | 0.0 | 0.0 |
| **main thread p50 / p95 of the path** | 25.1 / 41.6 | 11.3 / 22.0 |

(The profiler's own overhead inflates a profiled run; the timing tables below
are unprofiled.) MapLibre's per-frame cost is flat — no function above 0.8 ms
of a ÷4 frame: symbol work (the per-frame label vertex updates behind its
`bufferSubData`, `updateBucketOpacities`, the cross-tile symbol index), its
draw calls (`draw`, `bindVertexArray`, `useProgram`, uniforms), terrain
(`_getDEMTileMatrix`, `getSourceTile`, `calculatePosMatrix`) and its camera
(`_calcMatrices`). On the still street at z18, redrawn only because city life
moves, MapLibre is still 12.5 ms of a ÷4 frame: a custom layer that animates
makes MapLibre draw everything else again.

### What was cut

1. **The terrain lift, 3.5× cheaper.** Lifting a tile onto the terrain
   (`cityMeshes.ts` → `groundTileFor().lift`) looked up each vertex's building
   on every vertex; it now walks each building's run of vertices once — one
   comparison and one store per vertex, the same output
   (`city3dGroundPacked.test.ts` compares every vertex). An 810,000-vertex tile:
   2.81–2.95 → 0.80–1.05 ms on the host unthrottled, 4× that at ÷4. In the
   orbit's slow frames at ÷2: the lift 135 → 34 ms over the path, the city
   engine's share of a slow frame 6.7 → 2.7 ms.
2. **A tile's lift and its first upload never share a frame.** A tile on
   terrain is drawn only once lifted, and its first draw is when its mesh goes
   to the GPU; one frame did both. Now a tile lifted before it was ever drawn
   is first drawn the next frame, and that frame lifts nothing
   (`cityEngine.ts` → `awaitingFirstDraw`); a tile already drawn flat (the
   city was on screen before the map tilted and the terrain came) has its mesh
   on the GPU and is drawn the frame it is lifted, as before. Gated:
   `frameBudget.test.ts` → "on terrain, no frame both lifts a tile and uploads
   one" (reverting it fails with a 1.2 MB upload in a lifting frame) and
   "terrain arriving under a city already drawn does not hold its tiles back a
   frame" (holding them back fails it: 6 triangles drawn).
3. **The HUD only on `?perf=1`**, development builds included.
4. Still landmark models compose their node matrices once instead of every
   frame (only a moved model's subtree is re-derived); not separable from the
   noise in the timings, kept because it removes work.

Interleaved runs (#151, this branch, alternating, three each) — production,
medium, main-thread ms:

| CPU | scene | p50 | p95 |
| --- | --- | --- | --- |
| ÷2 | eixample | 10.0 / 9.6 / 10.1 → 9.9 / 10.3 / 9.9 | 16.7 / 16.7 / 17.1 → **15.0 / 16.5 / 15.5** |
| ÷2 | manhattan | 7.9 / 7.4 / 7.8 → 7.5 / 8.0 / 7.5 | 12.5 / 12.1 / 12.5 → 12.2 / 12.8 / 12.5 |
| ÷4 (ABBA, the machine loaded) | eixample | 22.6 / 20.6 / 19.5 / 18.7 → 19.2 / 23.6 / 21.8 / 22.9 | 37.5 / 37.4 / 39.5 / 36.6 → 30.6 / 38.8 / 36.5 / 36.2 |

At ÷4 the difference is inside the spread of either build: the cuts are
milliseconds of a 17 ms MapLibre frame and of its rarer slow frames (below).

At ÷2 the Eixample orbit's p95 is now within 16.7 ms in every interleaved
run; in uncontended runs the still street at z18 with traffic reads 9.5–10.3
and Eixample at night 15.6.
Runs taken while other work loaded this machine read 3–7 ms higher at p95 in
every scene alike — compare interleaved runs only. (These runs predate #152,
merged since, which rebuilds the TSL materials when a mesh first gains its
lift; re-measured after the rebase only on a loaded machine, where #151 and
this branch read alike.)

### What is left, and why

**At CPU ÷4 the budget cannot be met by GoWay's code.** MapLibre's own
JavaScript is 17 ms of the mean frame on this path — more than the whole
16.7 ms budget — before the browser's 3.8 ms and before a single GoWay layer
draws; with every GoWay subsystem at zero a ÷4 frame would still take
17–21 ms (MapLibre, and the browser's native work, part of which is ours). The levers that reach it are product decisions, not hotspots: hiding
the basemap's labels while tilted saves 2–4 ms of a ÷4 frame (measured on the
dev server, every symbol layer hidden: draw calls 262 → 165); dropping the terrain costs more
than it saves (MapLibre then redraws every 2D layer per tile: 25–28 ms of
MapLibre, ~840 draws). Neither is taken here.

**÷4 is not a laptop.** CDP throttling divides THIS machine's CPU (an
i9-14900K). By published Geekbench 6 single-core scores, roughly: an Intel
i5-1135G7 (Iris Xe) is about half of it, an Apple M1 about three quarters, an
A14 (iPhone 12) about two thirds, a Pixel 6a's Tensor about a third to a
half. So ÷2 models the integrated-GPU laptops of the medium preset, ÷4 a CPU
slower than any of them; the phone profiles at ÷4 are about right for a
Pixel 6a and pessimistic for an iPhone 12. Hence the `laptop-2x` profile;
the budget table's main-thread lines are for the real devices.

**At ÷2 the remaining slow frames are arrivals, not steady work.** The
frames at or over the path's p95 (`--profile` → `slowFrames`), per frame:
MapLibre 12–17 ms (its symbol placement commits every ~300 ms of motion:
`updateBucketOpacities`, `updateLayerOpacities` and their `bufferSubData`),
three.js 10–17 ms — **mesh uploads** (`bufferData`: a z15 tile's full-detail
level is several MB, handed over in the frame it is first drawn) and, the
first time a material variant is drawn in a session, **shader linking**
(three reads the link status synchronously: `getProgramInfoLog`, up to
~200 ms over a path) — and the city engine 2.7 ms. Next steps, in order:
compile the engine's material variants ahead of first use
(`renderer.compileAsync` while loading), and hand a full-detail tile to the
GPU in chunks over several frames. How much of `bufferData`'s cost is WSL's
D3D12 translation is not measurable on this machine.

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
asserts, per scene (an orbit at 62°, a street at z17.6, the same street with
the street detail on — `MAP_STREETS.md` — and a 75° skyline) and per
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
| Two ground samplers: city life kept its own per-z15 grid cache beside the engine's `TileGrounder` (same sampler, same grid, sampled twice); live vehicles asked MapLibre's `queryTerrainElevation` per vehicle | `lifeRenderer.ts`, `terrainGround.ts`, `live3d` | **Fixed**: one `Ground` (`terrainGround.ts` → `createGround`, an LRU of grids) made by the engine's `setGround` and handed to the grounder, every overlay (`CityOverlay.setGround`) and the live pass (`City3dHandle.ground()`); `city3dTerrainGround.test.ts` proves a tile is sampled once whoever asks |
| Web Mercator written out in seven more places (`tileMath`, `camera/plane`, `cityLife/sim/network`, `lod`, `viewportLink`, `embed`, `landmarks/tour`), with two different Earth radii | `lib/map/**`, `engine/**` | **Fixed**: `lib/map/geo.ts` is the one (`mercatorX/Y`, their inverses, `metersPerPixel`, the mean Earth radius); the rest import or re-export it. One deliberate exception: `lib/live/coverage.ts`, which `liveChunk.test.ts` requires to import nothing |
| Hex colour → RGB, four copies (and a fifth, `engine/city3d/colour.ts`) | `cityEngine.ts`, `city3dTrees.ts`, `city3dLight.ts`, `tsl/cityTileView.ts`, `osmTiles.ts`, `live3d/liveModels.ts`, `style/*` | **Fixed**: `lib/map/colour.ts` (`parseHexColour`, `hexToRgb`, `hexToPacked`), `colour.test.ts` |
| The GPU LOD test of city life replayed on the CPU for its statistics | `lifeRenderer.ts` `countTriangles` | Deliberate (development statistics), noted |

## Limits

- **CPU throttling divides this machine's CPU**, not a laptop's or a
  phone's: ÷4 is slower than every target laptop, ÷2 close to an Iris Xe or
  M1 laptop (see "÷4 is not a laptop" above).
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
- The JS heap (Chrome's `performance.memory`) reads lower after the profile
  in every scene (e.g. desktop Eixample 491 → 116 MB); it is GC-timed and quantised,
  and the cause is not attributed — read it as observed, not as a win.
- Native (`MapCanvas.native.tsx`) does not read the profile yet; the profile is
  platform-neutral so it can.
- Fill rate is not gated: a new full-screen pass, more PCF taps or a heavier
  material changes no count the gate reads. The benchmark's GPU ms is the
  measure; a GPU-timer gate in CI needs a GPU runner.

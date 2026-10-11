# Native 3D: one map engine for web and native

How the iOS and Android apps get everything the web map draws (the 3D city,
GoWay city tiles with Catastro heights, trees, landmarks, sky and shadows,
simulated traffic, live vehicles, street markings, the settings), without a
second renderer to maintain. Includes the **phase 1 prototype**: one shared
module drawing the same city tile in a browser (WebGL2 and WebGPU) and on
Android (WebGPU through Dawn on Vulkan), measured.

## Decision

1. **One engine, in TypeScript, on three.js's `WebGPURenderer` with materials
   written in TSL.** three compiles TSL to GLSL for WebGL2 and to WGSL for
   WebGPU, so one material definition draws on every backend. Decoding,
   meshing, LOD, the simulation, live data, settings and the
   [quality profile](#quality-profile) stay one codebase. Only a thin host
   differs per platform: the canvas and GPU device, the frame loop, input,
   threads and the tile cache.
2. **On native the GPU API is WebGPU through `react-native-webgpu`**
   (Dawn: Metal on iOS, Vulkan on Android). It is the only way to run the
   same three.js engine natively with a real GPU API under it.
3. **The end state is GoWay's engine drawing the whole map on both
   platforms**: vector tiles, terrain, globe, roads, labels and the 3D layers.
   MapLibre GL JS stays under the web map until the engine passes the same
   perf and parity gates, then it retires. MapLibre Native leaves the apps
   when the native host ships. See [The base map](#the-base-map) for why one
   renderer everywhere, and not MapLibre on web plus ours on native.
4. **Rejected**: the web map in a WebView (the owner's call: it is a
   workaround and slows the native app), a native port of the engine (Filament
   or SceneKit: two engines), and three.js inside MapLibre Native's custom
   layer (it cannot be done on iOS; see [Evidence](#evidence)).

## Evidence

Read from source at the exact versions GoWay ships, not assumed.

| Question | Answer | Where |
| --- | --- | --- |
| What does `@maplibre/maplibre-react-native` 11.4.1 bundle? | MapLibre Android **13.6.1**, `opengl` variant by default (`vulkan` selectable). MapLibre iOS **6.31.0** | `android/gradle.properties`, `MapLibreReactNative.podspec` |
| Does MapLibre Native have custom layers on its new backends? | Yes, on all three. `CustomLayerHost::render` gets a GL context, a Metal `MTLRenderCommandEncoder` + command buffer, or a Vulkan `vk::CommandBuffer` + render pass. Drawn in the translucent pass with the map's depth readable (`depthModeForSublayer(0, ReadOnly)`) | `include/mln/style/layers/{,mtl/,vulkan/}custom_layer_render_parameters.hpp`, `src/mln/gfx/drawable_custom_layer_host_tweaker.cpp` |
| Is iOS still OpenGL? | No. 6.x is Metal: "the first release that uses Metal… replaces OpenGL ES" | `platform/ios/CHANGELOG.md` |
| Can three.js (WebGL) draw into that layer? | Not on iOS: there is no GL context to draw into. expo-gl (58.x) is OpenGL ES (`EAGLContext`) with its **own** context and GL thread; JS queues ops into batches that run there. On Android it would take a fork of expo-gl replaying JS batches inside the layer's callback with the camera matrix swapped in | `expo-gl/common/EXGLNativeContext.h`, `ios/EXGLContext.mm` |
| Does MapLibre Native have 3D terrain, globe or sky? | No: none of them exists in the core tree. The web city stands buildings, trees and traffic on terrain, so a MapLibre Native base can never be at parity | MapLibre Native tree at `ios-v6.31.0` |
| `react-native-webgpu` status | **0.13.0** (2026-10-07; the old `react-native-wgpu` 0.5.17 is renamed to it). Dawn `chrome-m154a`. RN ≥ 0.81, New Architecture only, Expo config plugin. Peers: worklets ≥ 0.7.2 and reanimated ≥ 4.2.1; GoWay has 0.10.0 and 4.5.0. Documents three.js `WebGPURenderer` (pass `canvas`, `context`, `device`; call `context.present()`) | package, docs → Integrations → Three.js |
| Can the web keep MapLibre while the engine moves to TSL? | **Yes, measured** ([Phase 2, step 1](#phase-2-step-1-buildings-through-webgpurenderer-inside-maplibre)): three's WebGL backend accepts an external `context` and has `resetState()`, so `WebGPURenderer({ forceWebGL, context: gl })` draws inside MapLibre's custom layer, in its frame and depth buffer | `three/src/renderers/webgl-fallback/WebGLBackend.js:230,745` |

## Phase 1: the prototype

**Built and measured. It is not wired into the app.** No app module imports
it (`components/__tests__/engine3dChunk.test.ts` pins that), so no bundle
changes.

| Piece | Where |
| --- | --- |
| Tile bytes → packed mesh, the function every host calls (moved out of the worker so a native thread can call it too) | `components/map/engine/city3d/tileMeshing.ts` (`meshWorker.ts` now imports it) |
| The building material in TSL, term for term `shaders.ts` + `osmShaders.ts` (both formats since phase 2) | `components/map/engine/city3d/tsl/buildingMaterial.ts` |
| One tile, meshed and drawn by `WebGPURenderer`; the host passes canvas, context, device, `present` | `components/map/engine/city3d/tsl/cityTileView.ts` |
| Browser host | `scripts/tsl-tile-preview.ts` (serves) + `scripts/tsl-tile-preview.page.ts` (the page) |
| Android host | a throwaway Expo app (not committed, see [Running it](#running-it)): one `<Canvas>` from `react-native-webgpu` and a call to `createCityTileView` |
| Shared hex parsing (was private to `cityEngine.ts`) | `components/map/engine/city3d/colour.ts` |
| Tests | `components/map/__tests__/city3dTsl.test.ts`: lanes and WebGPU-legal strides, the TSL material reads the GLSL material's uniforms (except the two not ported) |

Two things differ from the GLSL because WGSL requires it, and neither changes
the look. The storey openings are computed for every fragment and masked,
because WGSL allows `fwidth` only in uniform control flow. The `uint16` lanes
are declared `vec4` and converted by the node builder. Not ported yet: the
terrain lift (`uGrounded`), the LOD dither (`uFadeFrom`/`uFadeTo`) and the
city-sky variant.

### Measured

One input everywhere: the densest Barcelona z15 city tile in the local archive,
`15/16580/12236` (Eixample). That is 5,973 buildings, 273 KB raw and 147 KB
gzip, meshing to 455,084 vertices, 252,354 triangles, 12.9 MB of buffers and
7 draws. The camera is fixed (pitch 60°, 900 m, orbiting). The canvas is
412×915 CSS px at DPR 2.625 in browsers and 1079×2399 on the emulator.

| Host | Backend (adapter) | Mesh on the calling thread | JS per frame p50 / p95 | Frame interval p50 |
| --- | --- | ---: | ---: | ---: |
| Bun 1.4 (host CPU, JIT) | — | 200–357 ms (cold 357) | — | — |
| Headless Chromium, host | WebGL2 (ANGLE → D3D12 → RTX 5090) | 336–495 ms | 0.4 / 0.9 ms | 16.7 ms (vsync) |
| Headless Chromium, host | WebGPU (**SwiftShader fallback**: WSL exposes no GPU to Dawn) | 289 ms | 0.6 / 1.2 ms | 144 ms (software) |
| Android 16 emulator, Chrome 134 (V8 JIT) | WebGL2 (SwiftShader GLES) | **1,351–1,472 ms** | 2.7–3.4 / 14–28 ms | 88–90 ms (software) |
| Android 16 emulator, **this app** (Hermes, release build) | **WebGPU: Dawn on Vulkan** (SwiftShader via gfxstream) | **1,810–2,065 ms** (decode 174, mesh 1,586, pack 305) | empty frame 8 ms; full tile 182 ms (GPU-bound) | 200–286 ms (software) |

What the numbers say, and what they cannot:

- **The same module renders the same tile on all three backends.** The
  WebGL2, browser-WebGPU and Android-Dawn frames show the same buildings,
  palette, light, storey rows and ground occlusion. The TSL compiled to GLSL
  and to WGSL with no shader errors on any backend.
- **Hermes is not the 10× disaster it could have been.** On the same virtual
  CPU, Hermes meshes the dense tile in 1.8–2.1 s and V8's JIT in 1.35–1.47 s:
  about **1.3–1.5×**. It is still **seconds on the JS thread**, so meshing must
  run off that thread on native exactly as it does on the web
  ([Risks](#risks)). Under load the in-app figure rose to 7–14 s, because the
  software GPU starved the emulator's four vCPUs and System UI raised an ANR.
  Those runs are reported here and excluded from the ratio.
- **The native frame cost is the emulator's GPU, not the engine.** An empty
  frame (clear + present) is 8 ms of JS. A quarter of the pixels only takes
  the full frame from 182 to 142 ms, so it is SwiftShader's vertex work
  through gfxstream. **No GPU number here predicts a phone.** The emulator's
  "host" GPU mode is Mesa llvmpipe under WSL, and Dawn's Vulkan probe hangs
  on it ("Failed to open rendernode"), so SwiftShader was the only GPU that
  ran.
- **Pre-meshing is not the way out of Hermes**: the same tile's packed mesh is
  2.47 MB gzip against the tile's 147 KB (17×).
- **Sizes.** `three/webgpu`'s minimal renderer is 215 KB gzip against
  `three`'s 132 KB (+83 KB). The whole prototype module, mesher included, is
  265 KB gzip. Dawn is `libwebgpu_dawn.so` per ABI: 15.8 MB arm64-v8a,
  uncompressed. The harness app at rest after one dense tile measured
  147 MB PSS on the emulator (66 MB native heap).
- **iOS was not run**: there is no Mac here. Dawn's Metal backend is what
  `react-native-webgpu` uses there.

### Running it

```bash
# Browser host (any GoWay city archive; see MAP_3D_CITY.md → Running it locally).
cd packages/frontend
bun scripts/tsl-tile-preview.ts --archive=.tiles/city-barcelona-z15.pmtiles [--write-tile=/tmp/tile.mvt]
# → http://localhost:8790/?backend=webgl   (or backend=webgpu, appearance=dark)
```

The Android host is a scratch Expo 57 app. It is not committed, because it
is an instrument and not a second app: `expo` 57.0.26, `react-native` 0.86.0,
`react-native-webgpu` 0.13.0, `react-native-worklets` 0.10.0,
`react-native-reanimated` 4.5.0 and `fast-text-encoding` (Hermes has no
`TextDecoder`). Its Metro config maps `@/…` to `packages/frontend` and adds
the repo's `node_modules` to `nodeModulesPaths`, so the module it renders is
the file in this repo. `App.tsx` mounts `<Canvas>`, calls
`navigator.gpu.requestAdapter()` → `requestDevice()` →
`ref.getContext('webgpu')`, then `createCityTileView({ canvas: context.canvas,
context, device, present: () => context.present(), … })` with the bytes
`--write-tile` wrote. Build with
`./gradlew assembleRelease -PreactNativeArchitectures=x86_64`, and boot the
emulator with `-gpu swiftshader_indirect`.

## Phase 2, step 1: buildings through `WebGPURenderer` inside MapLibre

**Built, behind the registry's `cityTsl` (Labs, development builds only, off
by default; `?cityTsl=1` in a development build).** With it on, the 3D
city's buildings are drawn by three's `WebGPURenderer` on its WebGL2 backend,
with the TSL material, in MapLibre GL JS's own context. Trees, overlays,
models and landmarks stay on `WebGLRenderer` in the same frame. Off, nothing
changes. With the city sky the engine keeps the GLSL path, because the sky's
building material is not ported yet.

| Piece | Where |
| --- | --- |
| Both building formats in TSL: ramp, tagged colour, storeys, light, occlusion, **terrain lift**, **LOD dither** | `tsl/buildingMaterial.ts` |
| The pass: `WebGPURenderer` on MapLibre's context, no offscreen target, a read-only view of MapLibre's canvas, backend state reset per frame | `tsl/buildingPass.ts` |
| Tile entries get the shared TSL materials and carry their fade per mesh | `cityMeshes.ts` |
| The engine draws the pass, then `WebGLRenderer` for the rest; dev-only draw CPU/GPU stats | `cityEngine.ts`, `gpuTimer.ts` |
| Registry entry, labels in 12 languages, flag module | `lib/map/mapFeatures.ts`, `mapFeatureLabels.ts`, `cityTslFlag.ts` |

How it shares MapLibre's frame:
- **One context, so one framebuffer and one depth buffer.**
- **No offscreen target.** `WebGPURenderer` renders through a half-float
  target plus a full-screen quad whenever the output needs tone mapping or a
  colour-space conversion. The palette is written raw (as before), so the
  output is the working space with no tone mapping.
- **The canvas stays MapLibre's.** three writes `canvas.width` on resize,
  which would clear the frame so far. It gets a view of the canvas whose size
  it reads and whose writes it cannot make.
- **One material per format and variant, shared by every tile.** three keys a
  node material's build by node identity. Per-tile materials meant a node
  build per tile and a uniform upload per tile per frame. A tile's fade is
  read per object (`FADE_USERDATA_KEY`).
- **The engine's own uniform objects drive the TSL uniforms** (`onRenderUpdate`).
  Light, palette, opacity and terrain have one source of truth.

### Measured

Headless Chromium on the host GPU (ANGLE → D3D12 → RTX 5090). Barcelona city
tiles at z16.8, pitch 60°, trees off so the scene is buildings only: 8 tiles
and 1,309,323 triangles on the phone viewport (412×915 @2.625), 2,154,551 at
1080p. Three alternating runs each, 10 s of continuous rotation (ctrl-drag).

| | GLSL (`WebGLRenderer`) | TSL (`WebGPURenderer`, WebGL2) |
| --- | ---: | ---: |
| Pixels, settled frame (phone, map area) | — | **identical** (mean difference 0; also on Park Güell's slope, terrain lift on, both building formats in view) |
| Pixels, 1080p | — | 0.86% differ by > 8/255 without trees; 0.01% with trees |
| Draw CPU p50 / p95, phone | 0.31–0.36 / 1.5–3.0 ms | 0.86–0.93 / 3.2–4.9 ms |
| Draw CPU p50, 1080p | 0.34 ms | 0.88 ms |
| Draw GPU p50 (`EXT_disjoint_timer_query_webgl2`) | 0.09–0.46 ms | 0.12–0.28 ms: equal within noise |
| Frame interval p50 | 16.7 ms | 16.7 ms |
| Shader programs linked at settle | 16 | 16 (programs are shared by source) |

- **Depth is shared.** With trees on, they are drawn by `WebGLRenderer`
  after the TSL buildings, and every tree behind a building is hidden. Both
  renderers wrote one depth buffer: MapLibre's.
- **The camera is right.** The pixels are identical, so the projection,
  placement, terrain lift and culling agree.
- **The cost is CPU, per draw.** It is about +0.55 ms a frame here at ~56
  draws, roughly +10 µs a draw: per-object uniform-buffer uploads
  (`bufferData`/`bufferSubData`), VAO binds and node bookkeeping inside
  three's `_renderObjectDirect`. GPU time is the same, because it is the same
  shader. On a mid-range phone, whose CPU is several times slower than this
  host's, expect +2–3 ms a frame. That is why
  [Risks](#risks) lists one draw per tile as its own step.
- **Bundle** (`expo export --platform web`, gzip): first paint unchanged
  (`__common` byte-identical, entry +87 B for the registry entry). The lazy
  3D chunk is +210 KB, because three's WebGPU build is in it whether or not
  `cityTsl` is on. Only people who turn on the 3D city (Labs) download it.
  Loading it with a separate `import()` was tried and refused: Expo hoists a
  module that two async chunks share into the first-paint `__common` chunk,
  and three's core went there (27.5 → 135.8 KB gzip for every visitor). The
  extra goes when the last GLSL material does and `WebGLRenderer` leaves the
  chunk.

The buildings' GLSL (`shaders.ts`, `osmShaders.ts`) is deleted when the TSL
path becomes the default. That needs the sky's building material in TSL first,
since the sky shades the buildings. Until then `cityTsl` is the A/B, not a
second copy anyone ships.

Next, one material at a time, each deleting its GLSL twin as it lands: trees,
then street markings (once `feat/street-detail` merges), landmarks/models,
city life, live 3D, and the sky and shadow passes (which unlock `cityTsl`
with the sky). Each step is A/B-measured the same way: same scene, same
pixels, draw CPU and GPU.

## The base map

Native cannot keep MapLibre Native under a WebGPU city. The two would be
separate surfaces with no shared depth, so buildings would cover labels and
route lines, and the camera would reach the city a bridge hop late. MapLibre
Native also has no terrain or globe. So on native **GoWay's engine draws the
base map**. The only question is the web.

| | MapLibre on web, GoWay's engine on native | **GoWay's engine on both** |
| --- | --- | --- |
| Divergent code | Two base-map renderers forever: MapLibre's style evaluation, labels, terrain, globe and gestures on web, ours on native. Every cartography change is made twice and drifts | One renderer, one style evaluation, one label engine, one camera. Only the host differs |
| Performance | Web keeps a second GL pipeline, and the city pays a custom layer's state save and restore every frame | One frame, one depth buffer, one budget. WebGPU where the browser has it, with lower per-draw CPU cost |
| Risk | Lower on web today | Labels and text are a large piece to own ([Risks](#risks)) |
| What GoWay already owns | The style is generated in TypeScript (`lib/map/style/*`); glyphs are built from Inter (`map:glyphs`), the sprite and tiles are GoWay's | Same: the inputs are already GoWay's |

**Decision: GoWay's engine on both.** It is the only answer with one codebase,
and the inputs (style, glyphs, sprite, tiles, DEM) are already GoWay's.
MapLibre is "a replaceable adapter" (AGENTS.md), and this replaces it.
Expression evaluation can come from `@maplibre/maplibre-gl-style-spec`
(BSD-3, pure JS) rather than a rewrite. Symbol layout and collision can be
adapted from MapLibre GL JS's (BSD-3, with its notice) rather than invented.

## Phased plan

Estimates are one engineer who knows the codebase, and they are estimates.
"Parity" at each step is stated plainly.

| Phase | What | Parity after it | Estimate |
| --- | --- | --- | --- |
| **1. Prototype** (this change) | Shared meshing; TSL building material; one tile on WebGL2, browser WebGPU and Android Dawn; measured | Web unchanged; native unchanged | Done |
| **2. The engine on `WebGPURenderer`, web first** | ~~First prove `WebGPURenderer` with the WebGL backend inside MapLibre's custom layer (external context, shared depth, `resetState`)~~ (done: [step 1](#phase-2-step-1-buildings-through-webgpurenderer-inside-maplibre), the buildings behind `cityTsl`). Then port every material to TSL: OpenMapTiles buildings, trees, sky/atmosphere/shadow passes, city life, live vehicles, landmarks (`modelLook`), street markings, terrain lift and LOD dither. Delete the GLSL as each lands: one copy at every step | Web identical (same pixels, same budgets); native unchanged | 4–6 weeks |
| **3. The engine draws the base map** (web, behind a flag) | Vector-tile fill and line tessellation in the workers; style expressions via `maplibre-gl-style-spec`; terrain from GoWay's DEM and the globe; SDF labels from GoWay's glyphs, with line placement, collision and fading; one camera and gesture controller; the `MapCanvas` contract (markers, overlays, label taps, `onViewportChange`) on the new renderer | Web with the flag = web today; MapLibre still the default | **4–6 months.** Labels are the long pole (6–10 weeks of it) |
| **4. Native host** | `MapCanvas.native.tsx` on `react-native-webgpu`. Off-thread meshing and decoding (worklet runtimes); a native tile cache; gestures on the UI thread (Gesture Handler + Reanimated feeding the shared camera). The config plugin goes in `@oxy.so/app-preset`, never the app. MapLibre Native removed. Device gate on a mid-range Android (Adreno 6xx) and an A14-class iPhone | **Native = web**, every feature | 4–6 weeks + device benchmarks |
| **5. Web switches** | The new renderer becomes the web default after the same gate on mid-range Android Chrome; `maplibre-gl` removed | One renderer everywhere | 2–4 weeks |

Phase 2 is worth doing on its own merits (WebGPU on the web, one TSL source
for every material) even before native exists, and it de-risks phase 4. Phase 3
is the real cost of "no second renderer": it is the work MapLibre does for
GoWay today.

## Risks

- **Labels and text** (phase 3). Shaping beyond Latin (Arabic and Hebrew bidi,
  Indic scripts), CJK glyph coverage, placement along lines, collision and
  fading, accessibility of what is drawn. This is the largest piece and the
  one most likely to run long. Mitigation: adapt MapLibre GL JS's symbol code,
  keep GoWay's glyph pipeline, and add scripts in the order GoWay's
  `LABEL_LANGUAGES` need them.
- **Workers on Hermes.** React Native has no Web Workers, and meshing is
  seconds on the JS thread. The candidate is react-native-worklets worklet
  runtimes running the bundled modules ("Bundle Mode", which
  `react-native-webgpu` documents for three.js scenes and calls
  **experimental**). Measuring that is phase 4's first task. If it fails, the
  fallback is not a second mesher; it is fewer, smaller jobs (far levels,
  smaller tiles) on the same code. Pre-meshing is 17× the bytes (above).
- **Gestures.** They must feel native, which means the camera is driven on the
  UI thread and the frame rendered without a JS-thread hop.
  `react-native-webgpu` can render from the UI runtime (`runOnUI`). Running
  three.js there needs the same Bundle Mode.
- **Tile loading on native.** It needs an HTTP cache with offline behaviour
  and cancellation, and decoding off-thread. The web's browser cache and Web
  Workers do this for free today.
- **three's per-draw CPU cost.** `WebGPURenderer` spends about 10 µs more
  CPU per draw than `WebGLRenderer` on its WebGL2 backend (step 1: +0.55 ms a
  frame at the same ~56 draws). That is likely 2–3 ms on a mid-range phone.
  Remedy, measured as its own step: one draw per tile (32-bit indices,
  which WebGL2 and WebGPU both have) instead of the 16-bit chunks `packing.ts`
  cuts today.
- **three's WebGPU path is younger than its WebGL one.** `react-native-webgpu`
  documents a renderer leak across remounts in r184. Pin and test three
  upgrades.
- **Binary size.** Dawn is about 16 MB uncompressed per ABI. MapLibre Native
  leaves in phase 4, which offsets part of it; measure the store download.
- **Unmeasured on hardware.** Every GPU number above is software. The phase 4
  gate on real devices decides whether the budgets hold.

## Quality profile

The engine reads every budget from the shared `QualityProfile` being built on
`feat/map-perf` (`lib/map/quality/profile.ts`: tiers, draw/cache bytes, tile
counts, shadow map size, agents, animation clock). Nothing here adds a second
budget. On native, `resolveQuality` is fed by the native host's own device
detection (device class, memory) and the same Settings → Performance choice;
the engine code that reads it is the web's.

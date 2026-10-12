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
| Tile bytes → packed mesh, the function every host calls (moved out of the worker so a native thread can call it too) | `components/map/engine/city3d/tileMeshing.ts` (called by the mesh service, `meshService.ts`, which both hosts run: [Off-thread meshing](#phase-4-groundwork-off-thread-meshing)) |
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

**Built and measured behind a registry flag (`cityTsl`, since removed: step 2
made it the only path).** The 3D city's buildings are drawn by three's
`WebGPURenderer` on its WebGL2 backend, with the TSL material, in MapLibre GL
JS's own context. What is not ported yet stays on `WebGLRenderer` in the same
frame. With the city sky the buildings keep the sky's GLSL material, which is
not ported yet.

| Piece | Where |
| --- | --- |
| Both building formats in TSL: ramp, tagged colour, storeys, light, occlusion, **terrain lift**, **LOD dither** | `tsl/buildingMaterial.ts` |
| The pass: `WebGPURenderer` on MapLibre's context, no offscreen target, a read-only view of MapLibre's canvas, backend state reset per frame | `tsl/tslPass.ts` (was `buildingPass.ts`) |
| Tile entries get the shared TSL materials and carry their fade per mesh | `cityMeshes.ts` |
| The engine draws the pass, then `WebGLRenderer` for the rest; dev-only draw CPU stats (GPU time: the perf runtime's, `MAP_PERFORMANCE.md`) | `cityEngine.ts` |

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
| Pixels, settled frame (phone, map area) | — | **identical** (mean difference 0; also on Park Güell's slope with both building formats in view — but see [the terrain correction](#correction-the-terrain-lift-was-not-measured)) |
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
  3D chunk is +210 KB, because three's WebGPU build is in it. Only people
  who turn on the 3D city (Labs) download it.
  Loading it with a separate `import()` was tried and refused: Expo hoists a
  module that two async chunks share into the first-paint `__common` chunk,
  and three's core went there (27.5 → 135.8 KB gzip for every visitor). The
  extra goes when the last GLSL material does and `WebGLRenderer` leaves the
  chunk.

## Phase 2, step 2: trees, and TSL is the only path

**The decision (owner): flip per material, and delete each GLSL twin in the
same change.** No material exists twice; the 3D city is Labs. So:

- **The TSL pass always runs** (`tsl/tslPass.ts`). It draws the **trees**
  always and the **buildings** whenever the city sky is off. With the sky the
  buildings stay the sky's GLSL material, drawn by `WebGLRenderer` right after
  the pass, into the same depth buffer.
- **Deleted:** `treeShaders.ts`, the plain building shaders
  (`CITY_*_SHADER`, `OSM_VERTEX/FRAGMENT_SHADER`) and the `cityTsl` flag.
  `OSM_BASE_GLSL`, `TAG_TEMPER` and `glslFloat` stay, because only the sky
  path (and the detailed look, which needs the sky) reads them now.
- **`tsl/treeMaterial.ts`** ports the instanced trees: placement, yaw, width,
  lean and tint from the instance's four numbers; the canopy occlusion; the
  contact shadow; the zoom threshold; the terrain lift (`aGround`). One
  material (plus its dithered variant) serves every tile; a tile's unit and
  fade are read per mesh.
- **`tsl/common.ts`** holds what buildings and trees share: MapLibre's
  extrusion light, the premultiplied output, the terrain lift, the per-object
  dither and the uniform binding. Everything is written once.

### Measured against `main`

Same tool and scene as step 1 (phone viewport, Barcelona city tiles, 1.31 M
building triangles), `main` (all GLSL) against this step:

| Scene | Pixels vs `main` | Engine frame CPU p50, `main` → step 2 |
| --- | --- | ---: |
| Buildings + trees, no sky (all TSL) | **identical** | 0.80 → 1.40 ms |
| Buildings only, no sky (all TSL) | **identical** | 0.61 → 1.14 ms |
| City sky on (trees TSL, buildings the sky's GLSL) | identical (0.002% > 8/255, the sun's clock moving between runs) | 1.80 → 1.53 ms (within run-to-run noise) |

GPU time is unchanged (same shaders). The CPU cost is three's per-draw
overhead measured in step 1, now paid by every 3D-city frame: the next step
removes most of it.

## Phase 2, step 3: one draw per tile

`WebGPURenderer` pays its CPU per draw, so a tile's buildings are now **one
draw**. `packing.ts` emits a single chunk per mesh with 16-bit indices up to
65,536 vertices and 32-bit indices past them, where it used to cut dense
tiles into 16-bit chunks of ≤ 65,535 vertices (seven draws for the dense
Barcelona tile). The chunk machinery went with it: `packMeshGeneral`, the
builder's `reserve`, `sourceStart`/`sourceIds` and the LOD mesher's
split-a-roof fallback.

### Measured: before and after, one session

The same tool, scene and session, three alternating runs each (phone
viewport, Barcelona city tiles, 1.31 M building triangles, 8 tiles):

| Engine frame CPU p50 | `main` (GLSL) | step 2 (TSL, chunked) | step 3 (TSL, one draw per tile) |
| --- | ---: | ---: | ---: |
| Buildings only | 0.47–0.51 ms | 0.78–0.84 ms | **0.54–0.56 ms** |
| Buildings + trees | 0.62–0.67 ms | 0.99–1.09 ms | **0.78–0.87 ms** |

- **Draw CPU, buildings only:** 0.61–0.64 → 0.37–0.38 ms (−40%). The TSL
  buildings now cost what the GLSL ones did, within about 0.05 ms.
- **GPU time** is unchanged, and the pixels are identical to both `main`
  and step 2.
- **GPU memory:** the tile cache holds 66.4 → 74.1 MB for the same view
  (+11.6%). The dense tiles' indices are 4 bytes instead of 2. The budgets
  (`lod.ts`) count it, so at the edge of a budget a tile drops sooner.
- **What remains with trees (~+0.2 ms)** is the trees' draws: one per tree
  shape per tile. Fewer tree draws were tried and measured next
  ([step 4](#phase-2-step-4-fewer-tree-draws-measured-and-not-adopted)):
  every way of getting there costs the GPU more than it saves the CPU.

Absolute numbers move with the host's load between sessions: step 2 measured
1.40 ms in its own session against 0.99–1.09 ms here. Compare columns from
the same table.

## Phase 2, step 4: fewer tree draws, measured and not adopted

A tile draws its trees in up to five instanced draws: one per shape (three
broadleaf canopy variants, conifer, palm). Two ways to draw fewer were built
and measured with 3D terrain on. **Neither is merged.** Both pay more GPU
than the CPU they save, so the five draws stay.

**One draw per tile: every kind's shape in one buffer.** Each instance keeps
its own kind's vertices and collapses the rest to a point. It works, but
every instance runs the vertex shader over all three near shapes (289
vertices instead of 71–141) and submits all their triangles. Measured in the
frame-budget gate's scenes (`frameBudget.test.ts`, all three presets):

- Draws fall by 31–47%.
- Triangles submitted to the GPU rise by **84–95%**.

That fails the gate's triangle budget at every preset, so it was never put
in front of a GPU.

**One draw per kind: the broadleaf variants in one buffer.** The three canopy
variants share their topology, so they can share an index buffer. Each tree
carries its variant in two spare bits of its kind byte, and the shader picks
its position and normal. This is at most three draws per tile, with the same
triangles. Measured in one session, alternating builds, with terrain on:

| | `main` | one draw per kind |
| --- | ---: | ---: |
| Frame-budget gate, draws (all scenes and presets) | 26–87 | 16–47 |
| Eixample (15,136 trees): instanced draws per frame, p50 | 43–60 | 19 |
| Eixample: engine frame CPU, p50 | 0.84–0.86 ms | 0.70–0.74 ms |
| Park Güell (7,017 trees, 132 m up): engine frame CPU, p50 | 0.89–0.96 ms | 0.76–0.80 ms |
| `bench:map` Eixample, GPU p50, city life off | 3.98–4.15 ms | **5.37–5.47 ms** |
| The same with trees off | 4.08–4.23 ms | 4.17–4.23 ms |

- **The CPU saving is 0.14 ms a frame.**
- **The trees cost 1.3 ms more GPU** (RTX 5090 through WSL's D3D12; a phone's
  GPU is many times slower). Every vertex now fetches all three variants'
  positions and normals: 76 bytes instead of 28.
- **Interleaving alone costs GPU here.** A control build kept the
  interleaved buffer but read only the first variant. It still cost 0.6–0.9
  ms more, so the stride by itself costs GPU on this path.
- **Pixels:** 5.0k of 2.07 M pixels differ from `main`. Two runs of `main`
  differ by 3.4k (the HUD is included in both counts).

(These GPU numbers are the frame up to the city's last draw: the timer that
cut it there is fixed separately, and both columns were cut alike.)

What would get the variants into one draw without the bandwidth: pull only
the instance's own variant from a small data texture by vertex index
(`gl_VertexID`, WebGPU's `vertex_index`). It is not worth building for 0.14
ms. The draws a tile's trees cost are already bounded by the shape count,
not by the tree count.

## Phase 2, step 5: street detail

The streets' surfaces and markings (`cityStreets/`, #159) are TSL whenever
the city sky is off (`streetMaterials.ts`), drawn by the TSL pass; their
unlit GLSL is gone. Under the sky they stay GLSL (`streetShaders.ts`, now the
sky's variant only) until the sky is ported, as the buildings do.

- **One material per kind for every tile.** The GLSL path built a material
  and a ground texture per tile. Every street tile's ground grid now has a
  slot in one float texture (`groundAtlas.ts`), and a mesh reads its slot,
  size, detail and grounding per object. The sky's GLSL reads the same atlas,
  so there is one ground path.
- **Overlays choose their scene.** `CityOverlay.attach(scene, tslScene)`: a
  ported overlay adds its meshes to the TSL pass's scene.
- **Same placement, line for line.** The ground read, the 6 cm lift, the
  per-layer clip-space depth nudge, the sub-pixel line widening (with the
  projection's `[3][3]` read per render) and the SDF arrows and words.

Measured on Passeig de Gràcia (z18.4, 55°, four z15 road tiles, 226 k street
triangles, 8 street draws), terrain on, sky off, four alternating rounds of
10 s on a loaded host (load ~22), before #165 (a schema-2 archive; the
materials and the draws are the same):

| Median of the p50s | `main` (GLSL) | TSL |
| --- | ---: | ---: |
| Engine frame CPU | 1.08 ms | 1.12 ms |
| Engine draw CPU | 0.81 ms | 0.89 ms |
| GPU (the perf runtime's frame timer) | 4.56 ms | 4.50 ms |

- **Pixels:** the same, except around trees. The GLSL streets drew after
  the TSL pass and failed the depth test wherever a tree's contact shadow had
  written depth, leaving pale holes in the road around every street tree. The
  TSL streets draw first among the opaque (`renderOrder`), and the shadows
  blend onto them. 5.5 k of 2.07 M pixels differ, all of them there.
- **The visibility gate covers the streets now** (below). `main` and TSL
  measure the same shares. Streets that ignore the ground (built and run
  once to prove it) fail it.
- **Budgets are the quality profile's** (`streets`, #165): the tiles and
  triangles a frame may draw, and so the ground atlas's slots.

## Phase 2: models and landmarks

The model layer (`models.ts`: the SDK's models, the route flyover's
vehicle, GoWay's landmarks) is drawn by the TSL pass: `drawScene(scene,
camera)` draws its own scene with its own y-north camera into the same frame
and depth buffer. `WebGLRenderer` no longer draws a model.

- **Node twins.** Each glTF material becomes its node twin (`MeshStandard`,
  `MeshPhysical` or `MeshBasicNodeMaterial`, every property carried over as
  three's own `NodeLibrary` does: `modelLook.ts` → `toNodeMaterial`). Its
  output is encoded to sRGB in the material, as `WebGLRenderer` encoded it,
  because the pass writes raw values into the map's frame.
- **The uplight is an emissive node.** The GLSL `onBeforeCompile` patch is
  gone. The wash (asset-metre height from the node's own transform, wall
  facing, night factor) is added to the material's emission.
- **The reflected sky is a texture, not a render.** The GLSL path rendered a
  gradient sphere through `WebGLRenderer`'s PMREM inside the host's frame,
  saving and restoring the map's framebuffer by hand. Now it is a 64×32
  equirectangular gradient that the pass pre-filters itself (three's PMREM
  node), turned so its up is the world's +z (`scene.environmentRotation`).
  Nothing renders off-screen, on any backend, native included.

- **A landmark is one or two draws** (`modelBatch.ts`). The TSL pass pays
  its CPU per draw: `WebGPURenderer`'s WebGL2 backend issues about 30 GL
  calls for a lit draw against `WebGLRenderer`'s 13. A landmark was 5–25
  meshes of one material each, so a still, untextured asset (every shipped
  landmark) is merged into its own space at load, each material's look baked
  per vertex (colour, roughness, metalness, day emission, night glow, the
  wash) and read back by one node material; decals are a second batch with
  their depth bias. A tintable or animated model (the SDK's vehicles) is
  still drawn mesh by mesh.

Measured on the Sagrada Família (z17.6, 60°, terrain on), alternating builds:

| | `main` (GLSL) | TSL, mesh by mesh | TSL, batched |
| --- | ---: | ---: | ---: |
| The landmarks' own CPU per frame (perf runtime section, median of 4) | 0.57 / **0.82** ms | 1.17 ms | **0.33** ms |
| Draws the landmarks add (the Sagrada Família, Torre Glòries and their neighbours in view) | 71 | 71 | **10** |
| Pixels against `main`, day / night (dark map) | — | within 8 levels but ~150 | the same as mesh by mesh |

The first two columns were measured in one session and the batched one in
another against `main` again (0.82 ms there): compare within a session.

- **Reflections** differ by a few levels (three's node PMREM of a texture
  against `WebGLRenderer`'s of a sphere); the night look (windows, crowns,
  uplight) is the same.
- **GPU** time could not be told apart from the host's noise (load ~20).

**The visibility gate checks a landmark now** (below): the Sagrada Família,
on and off, changes 31.50% of the map (31.48% on `main`). With the models not
drawn it changes 0%, and the gate fails.

## Phase 2: GoWay Live in 3D

GoWay Live's vehicles (`live3d/livePass.ts`, a `CityPass`) are drawn by the
TSL pass: `CityPass.render` receives it (`drawScene`) instead of the engine's
`WebGLRenderer`. Its materials were three's built-ins (an unlit, vertex-
coloured `MeshBasicMaterial` with a per-instance tint for stale vehicles, a
translucent `LineBasicMaterial` for the aircraft's stalks), which
`WebGLRenderer` encoded to sRGB; now their node twins
(`MeshBasicNodeMaterial`, `LineBasicNodeMaterial`) with the same encoding
in the material. Instancing, the instance colour and the baked light are
three's and the pass's own, unchanged.

- **Tested** (`livePass.test.ts`): the library loaded from disk, a live bus
  placed, and the scene handed to the pass holds node materials with the
  encoded output.
- **Not compared on screen**: at the time of the run the open feeds had no
  surface vehicle drawn as a model in view (Barcelona's buses and Rodalies
  were estimated, drawn hollow in 2D; no aircraft low enough), so there was
  nothing live to compare pixel by pixel. The same node-twin pattern is what
  the landmarks were compared with (`models.ts`, above).
- **Cost**: a few draws (one per live model kind, the stalks), as before.

Next: the sky and shadow passes (which retire the last building and street
GLSL), with the sky's building material and the detailed look's material
response.

## Correction: the terrain lift was not measured

Steps 1–3 reported the TSL materials pixel-identical "on Park Güell's slope,
terrain lift on". **They were not.** The development environment those
measurements ran in drew no 3D terrain (no `EXPO_PUBLIC_MAP_TERRAIN_TILES`),
so nothing was ever lifted, on either path. With terrain, `main` after
steps 2–3 (`432fd6a`) drew **no trees, and no buildings without the city
sky**: everything the TSL pass drew stood at z = 0, under the terrain
(Passeig de Gràcia, the owner's preview).

**Cause.** The TSL materials read a mesh's lift (`ground`, `aGround`) only
where its geometry carries it (`tsl/common.ts` → `terrainLift`). A tile is
often drawn before it is grounded: terrain tiles arrive after the city tiles.
Its program was then built with no lift, and three rebuilds a drawn mesh's
program only when its MATERIAL's version moves. A geometry gaining an
attribute is not enough. The GLSL path never had this: a GLSL program reads
an unbound attribute as 0 and the bound one once it exists.

**Fix.** `applyGround` (`cityMeshes.ts`) invalidates the shared TSL materials
(`invalidate()`, every built variant) whenever a TSL mesh gains its lift for
the first time. three then re-checks each drawn mesh's program against its
geometry and rebuilds the ones that now read a lift. In-place re-grounding
(new values, same layout) does not invalidate.

**How it is checked now.**
- `city3dGroundPacked.test.ts`: grounding a tile for the first time moves
  every variant's version, in-place re-grounding does not. It fails without
  the fix.
- A visibility check in the A/B harness, run in the owner's configuration
  (Catastro and NYC official data, terrain from `goway.to`, sky on and off,
  terrain held back 8 s). It is now committed and in CI as
  [the visibility gate](#the-visibility-gate). Its first, uncommitted run:

| Share of the map (Passeig de Gràcia, noon) | `main` @`432fd6a` | fixed |
| --- | ---: | ---: |
| Tree canopy, sky on / off (0% with trees off) | **0 / 0%** | 17.9 / 17.9% |
| Building walls and windows, sky on / off (0.23% with the city off) | 21.1 / **0.23%** | 21.1 / 10.2% |

## The visibility gate

`packages/frontend/scripts/check-city3d-visible.ts` (`check:city3d-visible`)
is the committed form of the check above. It is CI's `3D city visibility` job
(`.github/workflows/ci.yml` → `city3d`), required by `CI complete` and by both
deploys: a matrix of one leg per sky (`--skies=sky`, `--skies=nosky`) side by
side, so the wall time stays one leg's as the views grow. **Every port PR runs it**, and its description reports the numbers.
The GPU-free gates (meshing, frame budget, `city3dGroundPacked`) cannot see
this regression: they counted every buried tree as drawn.

```sh
bun run --cwd packages/frontend export:web --dev --output-dir /tmp/city3d-gate
bun run --cwd packages/frontend check:city3d-visible --dist=/tmp/city3d-gate [--skies=sky,nosky] [--out=dir] [--debug]
```

It runs the real app, from a development export (only a dev build publishes
`__gowayCity3d`, what the engine drew), in headless Chromium on SwiftShader.
Nothing comes from the network:

- **City tiles**: the synthetic city (`__tests__/fixtures/syntheticCity.ts`,
  `cityTile(…, { official: true })`), with official LOD2 surfaces on its
  central blocks: OSM plus a Catastro-shaped model, the owner's configuration
  without the owner's data. The gate's own server serves them, because the
  tiles are fetched inside Web Workers and Playwright's routes do not see
  those requests.
- **Terrain**: a synthetic Terrarium tile at a constant 50 m. MapLibre's 3D
  terrain comes on only with the tilt (`lib/map/style/relief.ts` →
  `terrainWanted`), so the order that broke `main` is forced in three steps,
  each waiting for the engine to settle rather than for a fixed time (a fixed
  delay expires while a slow runner is still loading):
  1. Open flat at z19: the city tiles are drawn with no terrain at all.
  2. Tilt to 60°: the terrain switches on, its elevation **held back**, and
     the tilted view's tiles are drawn ungrounded too.
  3. Release the elevation (2 s after the city settles,
     `GATE_TERRAIN_DELAY_MS`), and wait until MapLibre reads more than 40 m
     under the camera. A run where the terrain never lifts the map fails
     rather than passing on a flat map.
- **Quality**: `?quality=high`. On SwiftShader the profile would resolve to
  low, which draws no 3D terrain, so nothing would ever be lifted and the
  gate would pass on the broken code (it did, until this was added).
- **Fixed inputs**: local noon; the tilt in six eased 10° steps to absolute
  pitches, each waited out (`moveend`), so a slow runner lands on the same
  camera (the keyboard's relative steps land short when frames are slower
  than the ease); city life, live data, landmarks and the flyover off.

Per sky (on and off) it asserts:

- **Trees**: the engine drew trees, and the canopy-green share of the map is
  at least 1% and 3× the same view with trees off.
- **Buildings**: the engine drew triangles, and the share of the map darker
  than the noon basemap (walls, windows) is at least 2% and 4× the same view
  with the 3D city off. That reference has no basemap buildings, so MapLibre's
  extrusions cannot stand in for the city.
- **Streets** (since step 5): the street detail drew triangles from the
  fixture's road tiles (`syntheticCity.ts` → `roadTile`, schema 3: one-way
  three-lane streets with names, turn lanes, signals and zebra crossings in
  every gap between blocks), and over a junction turning the streets on
  changes at least 3% of the view (pixels moving more than 24 levels, below
  the chips' rows). Measured: 14.24% with the sky and 14.29% without, on
  `main` and TSL alike; streets drawn without their ground measure 0%.
- **Models** (no sky; models draw alike under either): a landmark of the
  registry, the Sagrada Família, stands in the synthetic city. With
  `landmarks` on it must change at least 1% of the map against the same view
  with them off, below the top 110 rows where the layer's own chip appears.
  Measured: 31.5%.

The streets are on in every city view, so the walls-and-windows share reads
79.4% with the sky and 27.5% without since step 5 (asphalt and sidewalks are
not the noon basemap), against 72.6% and 21.0% in the table below.

The assertions are coverage, not frame time, so software GL is enough and
the result does not depend on the runner: CI's two cores measured the same
shares as 32 local ones, to the hundredth. The export takes about 20 s; the
gate about 2 minutes on 32 cores and 13 on CI's two.

| Share of the map (synthetic city, noon) | without #152's re-grounding, 3 runs | `main` |
| --- | ---: | ---: |
| Tree canopy, sky on (0% with trees off) | **0, 0**, 15.8% | 15.8% |
| Tree canopy, sky off | **0, 0, 0%** | 15.8% |
| Walls and windows, sky on (0.03% with the city off) | 72.6% | 72.6% |
| Walls and windows, sky off | **0.03, 0.03**, 21.0% | 21.0% |
| Verdict | **FAIL, FAIL, FAIL** | PASS |

Without the fix, the trees without the sky are buried in every run, and the
rest in most: with the sky on, one run in three drew its trees anyway. What
re-creates a mesh's render objects (and so, by chance, its program) depends
on the frame's timing; the no-sky trees are the gate's deterministic catch.
On failure the screenshots (`{sky,nosky}-{trees,notrees,streets,nostreets,nocity}.png`, `landmark.png`, `nolandmark.png`) are
uploaded as the `city3d-visible-sky` / `city3d-visible-nosky` artifacts.

## Phase 4 groundwork: off-thread meshing

React Native has no Web Workers, and meshing a dense tile holds the JS thread
for a second or more. This step answers phase 4's first question ([Risks →
Workers on Hermes](#risks)): **can a react-native-worklets worker runtime run
GoWay's mesher, unchanged, off the JS thread?** Yes, measured on the
emulator below.

### One service, two hosts

The worker's body moved, unchanged in behaviour, into a host-neutral service.
Both hosts run it, so a tile meshes the same on every platform. No module is
forked and there is no native mesher.

| Piece | Where |
| --- | --- |
| The mesh service: fetch, byte cache, mesh, trees, pack, cancel, reply in the protocol (`protocol.ts`). Takes a `MeshHost` (`post`, `fetch`, `now`) and needs no `AbortController` | `components/map/engine/city3d/meshService.ts` |
| Web host: the Web Worker, now a thin wrapper around the service | `components/map/engine/city3d/meshWorker.ts` |
| Native host: one worker runtime per pool slot, the service on it, the tile fetched on the RN thread | `components/map/engine/city3d/meshRuntime.ts` (`meshRuntimeWorker`) |
| The pool takes any worker: its factory gets the reply and failure callbacks (`WorkerEvents`) and returns `postMessage`/`terminate`. `webWorker()` wires a Web Worker | `components/map/engine/city3d/workerPool.ts` |
| Tests | `city3dMeshService.test.ts` (the service, including a host with no `AbortController`), `city3dMeshRuntime.test.ts` (the native host behind the real pool, with worklets stood in for), `city3dWorkerPool.test.ts` |

What a worker runtime offers and lacks (Hermes, worklets 0.10.0, Bundle Mode,
release build, measured):

| Global | On a worker runtime | So |
| --- | --- | --- |
| `fetch` | **absent** | The RN thread fetches (asynchronous I/O, which does not hold the thread) and hands the bytes across. worklets' fetch preview (`FETCH_PREVIEW_ENABLED`) is experimental, and in 0.10 a release build crashes creating the runtime: worklets' init reads the `TurboModules` polyfill before its registry shim has installed it |
| `AbortController` | **absent** | The service runs without it. A cancelled request's download finishes, then its result is dropped and the cancel acknowledged |
| `TextDecoder`, `performance`, `setTimeout`, `queueMicrotask` | present | The decoder and the timings work as on the web |
| Transfer | none | The reply's buffers are copied back: tens of milliseconds for a dense tile (below) |

### Measured (emulator)

**Emulator numbers, not a device benchmark.** Android 16 x86_64 emulator, 4
vCPUs, SwiftShader GPU, Hermes release build, on a shared and loaded host.
Same tile as phase 1: Barcelona 15/16580/12236, 273 KB, 252,354 triangles.
JS-thread figures from ten launches, worker-runtime figures from the five
that reached them; ranges span all of them.

| | Mesh time | The JS thread meanwhile |
| --- | --- | --- |
| On the JS thread (today's only option on native) | 0.73–2.41 s | **frozen for the whole mesh**: longest frame 1.0–2.5 s |
| On a worker runtime (`runOnRuntimeAsync`, the mesher directly) | 0.78–1.98 s; round trip +34–103 ms (the result copied back) | frame p50 16.6–16.8 ms (33 ms in one launch), longest 35–58 ms |
| **The native host** (`WorkerPool` over two `meshRuntimeWorker`s, tile fetched on the RN thread from a local server) | 1.89–1.99 s mesh, 1.95–2.42 s request to reply | frame p50 16.8 ms, p95 26.6 ms, longest 84 ms |
| Two runtimes at once | each 0.78–1.94 s | wall ≈ one mesh in 4 of 5 launches (853–897 ms for about 800 ms each); serialised once (2.25 s) |

- **Meshing costs the same on a worker runtime.** It is the same Hermes on
  another thread, so a mesh takes about as long. The difference is that the
  JS thread keeps drawing frames: its longest frame drops from the whole mesh
  (1–2.5 s) to under 0.1 s.
- **Runtimes scale across cores**, so the pool's `quality.workers` means the
  same on native as on the web.
- **The byte cache works per runtime.** Three re-meshes of one tile made one
  HTTP request, and a 404 came back as empty ground, as on the web.

### What adopting it needs (phase 4)

`meshRuntime.ts` runs only in Bundle Mode, where the service and the mesher
are modules on the worker runtime. Nothing imports it yet. The native host
will need:

- **Bundle Mode in `@oxy.so/app-preset`**, never the app: the worklets Babel
  plugin with `bundleMode: true` and this directory in
  `importForwarding.relativePaths` (otherwise the mesher stays on the RN
  thread and every call to it from the runtime throws "Tried to synchronously
  call a Remote Function"), and Metro wrapped with
  `getBundleModeMetroConfig`. On Android the harness also needed
  `pickFirsts` for `libworklets.so`, which expo-modules-core's worklets
  integration packages a second time; recheck that with a clean build when
  the preset adopts Bundle Mode.
- **No runtime disposal in worklets 0.10.** `terminate()` stops using a
  runtime but cannot free it. The pool replaces a worker only when it fails,
  so this is bounded, but a remounted map must reuse its pool.
- **The tile cache** ([Risks](#risks)): the RN thread's `fetch` has no
  offline cache or cancellation; phase 4's native tile cache goes behind the
  host's `fetch`.

### Running it

The harness is the phase 1 throwaway Expo app (not committed), switched to
Bundle Mode with `importForwarding` as above. It resolves `@/` into GoWay's
frontend, logs `MESH_HOST` lines, and fetches the tile from a local server
through `adb reverse tcp:8099 tcp:8099`. It needs `usesCleartextTraffic` for
that server only.

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
| **2. The engine on `WebGPURenderer`, web first** | ~~First prove `WebGPURenderer` with the WebGL backend inside MapLibre's custom layer (external context, shared depth, `resetState`)~~ (done: [step 1](#phase-2-step-1-buildings-through-webgpurenderer-inside-maplibre); trees and the flip: [step 2](#phase-2-step-2-trees-and-tsl-is-the-only-path)). Then port every material to TSL: OpenMapTiles buildings, trees, sky/atmosphere/shadow passes, city life, live vehicles, landmarks (`modelLook`), street markings, terrain lift and LOD dither. Delete the GLSL as each lands: one copy at every step | Web identical (same pixels, same budgets); native unchanged | 4–6 weeks |
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
  **experimental**). Measured on the emulator, it works: the unchanged
  mesher runs on a worker runtime and the JS thread keeps its frames
  ([Off-thread meshing](#phase-4-groundwork-off-thread-meshing)). What remains
  is device numbers, and Bundle Mode in the preset. Pre-meshing is 17× the
  bytes (above).
- **Gestures.** They must feel native, which means the camera is driven on the
  UI thread and the frame rendered without a JS-thread hop.
  `react-native-webgpu` can render from the UI runtime (`runOnUI`). Running
  three.js there needs the same Bundle Mode.
- **Tile loading on native.** It needs an HTTP cache with offline behaviour
  and cancellation, and decoding off-thread. The web's browser cache and Web
  Workers do this for free today.
- **three's per-draw CPU cost.** `WebGPURenderer` spends about 10 µs more
  CPU per draw than `WebGLRenderer` on its WebGL2 backend (step 1). One draw
  per tile (step 3) brought the buildings back to parity. The trees still
  draw once per shape per tile (~+0.2 ms here). Every port keeps draws few;
  that is now a rule of the engine, not an optimisation.
- **three's WebGPU path is younger than its WebGL one.** `react-native-webgpu`
  documents a renderer leak across remounts in r184. Pin and test three
  upgrades.
- **Binary size.** Dawn is about 16 MB uncompressed per ABI. MapLibre Native
  leaves in phase 4, which offsets part of it; measure the store download.
- **Unmeasured on hardware.** Every GPU number above is software. The phase 4
  gate on real devices decides whether the budgets hold.

## Quality profile

The engine reads every budget from the shared `QualityProfile`
(`lib/map/quality/profile.ts`: tiers, draw/cache bytes, tile
counts, shadow map size, agents, animation clock). Nothing here adds a second
budget. On native, `resolveQuality` is fed by the native host's own device
detection (device class, memory) and the same Settings → Performance choice;
the engine code that reads it is the web's.

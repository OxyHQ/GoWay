# Route flyover and Camera Studio

A cinematic camera for GoWay's map: **"Fly the route"** previews a computed
route from a chase camera, and **Camera Studio** (`/studio`) authors camera
tours — draw a path or drop keyframes, smooth it, aim each keyframe, preview,
undo/redo, share it as a link, export it as a video. The vehicle that drives a
flyover is the first coordinate-anchored 3D model on the map, so this is also
phase 1 of [`SDK_MAP_MODELS.md`](SDK_MAP_MODELS.md) on the web.

Inspired by World Labs' [Atlas Camera Studio](https://github.com/worldlabsai/atlas-camera-studio)
(draw a camera path, smooth it, interpolate cameras, preview, undo/redo, export
a clip) and [munim-maps](https://github.com/munimtechnologies/munim-maps)
(models anchored at coordinates, vehicles animated along paths). Neither is a
dependency; what was taken is the shape of the tools.

**Off by default.** A person turns it on in the map's settings dialog, under Labs
(the registry's `flyover`; [`MAP_FEATURES.md`](./MAP_FEATURES.md)), and the
panel then offers "Open Camera Studio". `EXPO_PUBLIC_MAP_FLYOVER=1` turns it on
for a build (no production deployment sets it) and `0` removes it; a
development build also takes `?flyover=1` per tab, which a production build
ignores (`lib/map/flyoverFlag.ts`, the `city3dFlag.ts` pattern). With it off the planner shows no "Fly the route",
`/studio` redirects to the map at the tour's first camera, and the feature's
chunk is never requested.

## What runs where

| | Web | Native |
| --- | --- | --- |
| Route flyover (camera, pause, scrub, skip, reduced motion) | Yes | Yes — the same code drives `MapApi.moveTo`; **not run on a device for this change** |
| The vehicle | A GLB in the map's three.js scene, occluded by buildings | Its fallback marker, moved every frame (no custom-layer API in `maplibre-react-native`, see `SDK_MAP_MODELS.md` → Native) |
| Camera Studio: keyframes, aim, sliders, undo/redo, preview, share | Yes | Yes (share uses the system share sheet); **not run on a device** |
| Studio: draw a path | Yes | Yes (responder events + the top-down projection); **not run on a device** |
| Video export | WebM via `MediaRecorder`, mark and credit composited | No |
| With the city-3D prototype on | Buildings are meshes (OpenMapTiles, or GoWay city tiles with `?cityTiles=1`); the vehicle shares their scene | — |

## The route flyover

`lib/map/camera/routeFlyover.ts` is pure: a route line and a viewport size in,
`frameAt(timeMs)` out. The player (`features/flyover/useCameraPlayer.ts`) owns
only time, so pause, scrub, skip and export are "ask for another time".

- **The shot.** Take-off from a top-down overview of the whole route into a
  chase position behind the start (3 s); follow; land on a tilted overview of
  the whole route that keeps the final heading (3.5 s). Between two poses the
  centre moves with the *scale* (the van Wijk & Nuij zoom-and-pan rule), so
  the ground does not rush past at the bottom of the swoop.
- **Look-ahead bearing.** The camera faces the point 4 % of the route ahead
  (40–400 m), Gaussian-smoothed along the route, so a zig-zag street does not
  whip it left and right and it is already turning before a corner. The
  vehicle faces along the road itself.
- **Speed.** A trapezoidal profile (ease in, cruise, ease out), slowed to 45 %
  in the sharpest turns, where the camera also pulls back half a zoom level and
  flattens 14°.
- **Length.** Flight time grows logarithmically (300 m ≈ 16 s, 1.2 km ≈ 26 s,
  10 km ≈ 50 s, at most a minute); cruise zoom falls with length (≈ 17.0 for
  1.5 km, where the 3D buildings are the point; 14.5 floor for long drives).
- **Chapters.** The route's maneuvers (`geometryIndex`), else the detected
  turns, filled so no gap exceeds a fifth of the flight. Skip back/forward
  steps through them.
- **Reduced motion.** With the system setting on, nothing flies: play cuts
  between the chapters as stills, 3.5 s each; seek and skip cut too
  (`useReducedMotion` from Reanimated, as the planner already uses).
- **Frames are not settled cameras.** Each frame is
  `moveTo(camera, { duration: 0, transient: true })`. `transient` is new on
  `MapCameraOptions`: the move is reported as in progress, so the sun light is
  not re-aimed and "Search this area" logic does not run sixty times a second.
  Pausing or ending issues one ordinary `moveTo`.

While flying, `ExploreScreen` hides its sheet or panel and the floating
controls; the transport bar claims the bottom edge, so the mark and the credit
rise above it.

**A flyover flies the engine's route, fixtures or not.** `mockTransport.ts`
never answers `POST /routes` — it goes to the API at `EXPO_PUBLIC_API_URL` — so
the path always runs along streets. With no routing engine behind that API
there is no route, and so no "Fly the route".

## Camera Studio

`app/studio.tsx` → `features/flyover/studio/`. The model is
`lib/map/camera/tour.ts`; editing is `useTourEditor.ts` over
`lib/map/camera/history.ts`.

- **Keyframes** are MapLibre-shaped cameras (centre, zoom, pitch) plus an aim:
  *follow path*, *fixed* bearing, or *look at* a point picked on the map. The
  aim is blended across each segment, so a tour can follow a street and swing
  round to a tower without a cut.
- **Smoothing.** Centres are joined by a centripetal Catmull-Rom spline (α =
  ½), which passes through every keyframe and, unlike uniform Catmull-Rom,
  never forms cusps or loops where keyframes are unevenly spaced (Yuksel et
  al. 2011) — the shape of a hand-drawn stroke. Zoom and pitch ride the same
  knots. The test pins that the uniform spline overshoots where centripetal
  does not.
- **Timing by perceived motion.** A segment costs its ground distance in
  screen pixels at its zoom, plus its change of zoom, bearing and pitch; the
  tour eases in and out; holds are flat stretches. A long pan at street level
  takes longer than the same pan from a kilometre up.
- **Drawing.** Draw mode levels the camera, a transparent surface captures the
  drag, and pixels become coordinates through `unprojectTopDown` (exact at
  pitch 0, any bearing; tested as the inverse of its projection). The stroke
  is simplified (Ramer–Douglas–Peucker at 10 px) into keyframes 1.5 zoom levels
  closer, pitched 55°, following the path.
- **Undo/redo, one step per gesture.** A stroke is one `push`; a slider drag
  is `begin … preview … commit` and undoes as one step however far it went; a
  gesture left open (a keyboard step with no release) is settled by the next
  edit. ⌘/Ctrl-Z, ⇧⌘/Ctrl-Z and Ctrl-Y on the web. 100 steps.

### The tour link

`https://goway.to/studio?tour=1.<payload>&lat=…&lng=…&zoom=…`
(`lib/map/tourLink.ts`) — the viewport link's contract extended to a path:

- **Versioned**: the payload starts `1.`; any other version is refused.
- **Compact**: varints in base64url — coordinates as 1e-5° deltas (≈ 1 m, the
  Google polyline precision), zoom in hundredths, pitch and bearing in tenths,
  holds in tenths of a second. An 8-keyframe drawn tour is a 175-character URL.
- **Total**: `parseTourFromParams` answers a tour or `null`, never throws —
  tested against truncation, trailing bytes, foreign alphabets, unknown
  versions, out-of-range values and 2,000 random payloads.
- **Validated by zod** (`tourLinkSchema`): decoding yields candidate numbers;
  one schema decides whether they are a tour (2–64 keyframes, latitude within
  Web Mercator, pitch 0–60, hold ≤ 10 s, speed 0.25–4). Zoom then clamps into
  the source's range, as the viewport link's does.
- **Degrades**: `lat/lng/zoom` of the first keyframe ride along, so a build
  without the Studio opens the map where the tour starts.

The schema lives in the app, not `packages/contracts`: it is a URL the app
writes and reads, not an API shape, and the SDK does not build it. If
`@goway.to/sdk` ever learns `links.tour()`, the schema moves to `contracts`
with it. (This added `zod` as a direct frontend dependency; it was already in
the bundle through the SDK.)

### Video export (web)

`features/flyover/studio/exportVideo.ts`. The tour plays in real time; on every
frame MapLibre draws, `MapApi.captureFrames` (new, web-only) hands over the GL
canvas in the same task, it is drawn onto a 2D canvas, and **the GoWay mark
and the data credit are painted into the frame** — the mark from the logo's
own geometry (`components/brand/artwork.ts` through `Path2D`), the credit from
`resolveMapAttribution()` — before `captureStream` → `MediaRecorder` (VP9,
else VP8). On screen both are DOM over the canvas; a recording of the canvas
alone would be a map GoWay drew without either, and the ODbL credit gone the
moment the file left the page. The export's mark never stands down for
`BrandedChromeProvider`: a video has no chrome around it.

Cancellable: closing the player while recording aborts the export (an
`AbortSignal`; leaving the Studio does too), and the recorder, the stream's
tracks and the frame listener are released whether it finished, failed or was
cancelled — a paused playback never reaches the end a recording waits for.

Limits: real-time capture records what the device renders (a slow device gets
a lower frame rate, a tile still loading is still loading); Chrome's WebM has
no duration in its header, so some players cannot seek it until remuxed.

## The vehicle: SDK_MAP_MODELS phase 1 on the web

- **API.** `MapCanvasProps.models` / `onModelPress`, `MapApi.moveModel`
  (`components/map/types.ts`). A `MapModel` is the note's client prop:
  `placement` (the contract's `ModelPlacementInput`), `asset` (`url`, or a
  `catalogue` key resolved from a stub, `lib/map/modelCatalogue.ts`),
  `sizing` (`world` or `screen` with `heightPx`), `minZoom`/`maxZoom`,
  `occlusion`, `tint` (materials named `paint…`), `accessibilityLabel`,
  `fallback`. Nothing names MapLibre or three.
- **Contract.** `packages/contracts/src/model.ts`: `modelPlacementSchema`,
  `MODEL_ALTITUDE_REFERENCES = ['ground']`, limits (latitude within Web
  Mercator's ±85.0511°, which the renderer can draw), and
  `parseModelPlacement`, exported by the SDK (types, values and the parser —
  not the schema, per the SDK's rule). The asset descriptor and catalogue are
  phase 2 and not added. No route, so no OpenAPI change.
- **Per-instance materials.** Instances of one GLB share geometry but each
  owns its materials, since occlusion and tint are material state; they are
  freed with the instance. A removed or replaced model reports `fallback`, so
  an id re-added later shows its marker while it loads; an id pushed past the
  300-instance cap by a reorder is removed and becomes its marker.
- **NaN gate and fallback.** Every placement is parsed by
  `parseModelPlacement`; a bad one costs that model (`components/map/models.ts`).
  Wherever a model is not drawn in 3D — native, outside its zoom window, while
  loading, after a failed or over-budget load — its fallback marker is drawn
  through the ordinary marker path, and pressing it is pressing the model.
- **One engine.** Models are a group in the city engine
  (`components/map/engine/city3d/models.ts`, reached only from
  `cityEngine.ts`, which is reached only through
  `components/engine3d/lazyChunk.ts`). With the city flag off the same engine
  attaches with `buildings: false` — no worker, no tiles, `building-3d`
  untouched.
- **Two layers, one renderer.** Buildings stay where they were (directly
  before `building-3d`), under the route line as on every map. Models get a
  second custom layer on the *same* engine, right after the overlay anchor:
  above GoWay's overlays (the vehicle is not painted over by its own route),
  below the labels, `'3d'`, so it depth-tests against the buildings already in
  the depth buffer — `fill-extrusion` or city meshes. It joins the style only
  when there is a model. This is the "one engine, one scene" of
  `MAP_3D_CITY.md` with one honest deviation: models render with their own
  camera in a second `render` call of the same renderer, because their world
  is y-north (the mirror folded into the camera) so glTF materials cull and
  light without special cases. Cross-pass transparency sorting is the cost.
- **Frames.** glTF metres, +Y up, front +Z, origin at the base centre;
  heading clockwise from north, then pitch (nose up), then roll, in ENU —
  pinned by `components/map/__tests__/mapModels.test.ts`.
- **Budgets enforced.** ≤ 2 MB per file (refused on a declared
  `content-length`, and the body is streamed with a running cap and cancelled
  the moment it passes it — a header can be missing or lie), ≤ 50k triangles, ≤ 20 distinct assets, ≤ 300
  instances; URLs HTTPS, this page's origin, or loopback; fetched without
  credentials. The first glTF clip loops, repainting only while it animates.
- **Alignment.** The unit test checks the anchor projected through the models'
  camera against the host matrix. In a running development build,
  `globalThis.__gowayModelAlignment` reports each drawn model's anchor where
  the engine put it beside `map.project` of its coordinate: measured during a
  Barcelona flyover in headless Chromium, the error on settled frames was
  ≤ 1e-8 px (the note's gate is 1 px).
- **The asset.** `public/models/goway-car.glb`, built by
  `scripts/build-flyover-model.ts` (GoWay's own work, CC0-1.0, recorded in
  `public/models/LICENSE.md`): 28 KB, ~600 triangles, no textures, no
  extensions, tintable paint. `__tests__/flyoverModel.test.ts` regenerates it
  and compares bytes, and checks the frame conventions and the lite budget.
  The flyover tints it with the theme's accent (the route line's colour);
  colours are parsed by the browser, since themes hand over `oklch()`.

Not done from phase 1: `lite` files and the `deviceProfile` gate (MapLibre
already requires WebGL2, so `unsupported` cannot reach the layer), `served`
assets (phase 2's descriptor), and `InstancedMesh` for repeated assets.

## What the flag costs when off

`expo export --platform web` of this branch against `origin/main`
(`3eda89b`), both clean, flags off:

| Chunk | main | this branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,953,223 B | 6,959,732 B (+6,509 B; +2,430 B gz) | the `models` prop and its gate in both forks, `transient`, the two flag gates and `import()` stubs |
| `__common` (first paint) | 78,516 B | 78,516 B | unchanged |
| `lazy` (flyover + Studio) | — | 76,589 B (27 KB gz) | never requested with the flag off |
| `lazyChunk` (three.js) | 3,498,341 B | 3,571,349 B (+73 KB) | `GLTFLoader` and the model layer; requested only with city-3D on or a model to draw |

The flyover and the Studio share `lib/map/camera/`, so both screens enter
through one module, `features/flyover/lazy.ts`; two `import()`s would hoist
the shared modules into `__common` (the trap in `lazyChunk.ts`).
`components/__tests__/flyoverChunk.test.ts` pins it, and
`engine3dChunk.test.ts` now admits the model layer as part of the engine.

## Verification

Headless Chromium (SwiftShader) against `expo start --web`, fixtures, Barcelona
(Museu Picasso → Baluard Barceloneta → La Boqueria, 2.5 km): the flyover with
city-3D on and off, the vehicle tinted and oriented along each leg and hidden
by extrusions and meshes where the straight fixture line enters a block,
reduced-motion stills, and the Studio — an S-stroke became 8 keyframes, undo
and redo one step each, the shared link reopened to the same 8 keyframes, and
the export wrote a 925 KB VP9 WebM whose frames carry the mark and the credit.
No new console errors (the two pre-existing ones remain: no Oxy client id, a
react-native-web `accessible` attribute).

## Open questions

- Does a flyover belong in the embed (`/frame`)? It would need a route in the
  embed's parameters, which it deliberately does not take.
- Should the SDK build tour links (`links.tour`)? Then the schema moves to
  `contracts`.
- Native: per-frame `jumpTo` over the bridge is unmeasured on a device; if it
  stutters, `MapApi` grows a native-driven path animation.

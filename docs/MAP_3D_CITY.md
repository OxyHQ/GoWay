# City 3D: buildings beyond `fill-extrusion`

What GoWay's 3D buildings should become, how to get there, and what it costs.
Includes a working **web-only prototype, off by default**, that proves the
rendering path (`components/map/engine/city3d/`). Coordinate-anchored 3D models
in the SDK are designed in [`SDK_MAP_MODELS.md`](./SDK_MAP_MODELS.md); the
three.js engine here is meant to be **shared** with that work, not duplicated
(see [One engine, one scene](#one-engine-one-scene)), and its model layer loads
through the same lazy chunk (`components/engine3d/lazyChunk.ts`).

## Where GoWay is today

One MapLibre `fill-extrusion` layer, `building-3d`
(`packages/frontend/lib/map/style/buildings3d.ts`), over GoWay's own
OpenMapTiles-schema vector tiles. Its header states the ceiling honestly:
a footprint extruded into a **hard-edged prism**, shaded by a vertical gradient
and one viewport-anchored light. No bevels, no real ambient occlusion, no roof
shapes. "Those rounded edges are not reproducible in MapLibre."

What the tiles carry, re-measured for this note (z14 `building` layer, decoded
with the same `pbf` + `@mapbox/vector-tile` MapLibre uses):

| Tile | Features | Rings | Vertices | Properties present |
| --- | ---: | ---: | ---: | --- |
| Barcelona 14/8290/6119 | 38 | 18,942 | 144,809 | `render_height`, `render_min_height` |
| Lower Manhattan 14/4824/6157 | 1,488 | 4,830 | 35,625 | + `colour` (1,298), `hide_3d` (12) |
| Tokyo 14/14552/6451 | 130 | 1,529 | 10,476 | + `colour` (13), `hide_3d` (1) |

There is **no** `building:levels`, no `roof:shape`, no building use, no age and
no material. And at z14 OpenMapTiles **unions touching footprints**: Barcelona's
whole tile is 38 features, one a multipolygon of 4,655 rings. An Eixample block
is one volume at one height, not the dozen buildings it is. No renderer can undo
that; only different tiles can.

## What the reference projects do

Two recent projects show the step beyond extrusion, and they agree on the
architecture.

| | **Valdrada** (NYC) | **Procedural Tokyo** |
| --- | --- | --- |
| Buildings | NYC footprints joined to PLUTO (floors, use, year) and facade filings | PLATEAU CityGML (LOD1/2 shells) |
| Other data | Street centrelines (widths, lanes), USGS 3DEP, OSM, NAIP | OSM (roads, rail, parks, trees), GSI 5 m DEM, GSI aerial photos |
| Compile | Node.js compiler, records → binary tiles | `fetch` → `compile` → 256 m binary tiles, a shared `tileformat.js`, round-trip tested |
| Client | three.js / WebGL2; full detail near the camera, coarse far-field tiles | three.js; tiles meshed in Web Workers; load-near-view by default |
| Look | Procedural facades driven by recorded floor counts | pmndrs postprocessing (n8ao AO, bloom, tone mapping); takram `three-geospatial` atmosphere with aerial perspective; walls blend aerial photo far → generated facade near |
| Licence | Code MIT, docs CC BY 4.0, compiled city **ODbL** | Code MIT; a redistributed compiled area is "a derived database under the ODbL" |

Both are **single-city digital twins**: one municipality's records, compiled
offline, rendered by a client that owns the whole frame. GoWay is a **world
map** that has to stay a map — labels, POIs, routes, overlays, the mark and the
credit — and has to work in Barcelona, in a Ghanaian town with footprints and no
heights, and in the sea. So the *architecture* transfers (offline compiler,
binary tiles, worker meshing, LOD, a three.js renderer); the *data* does not,
and the renderer has to live inside the map rather than replace it.

## Data reality

Global OpenStreetMap coverage of the tags that would make buildings richer,
from taginfo (2026-10-10/11; counts of objects carrying the key):

| Key | Objects | vs. 710.9 M `building` |
| --- | ---: | ---: |
| `building:levels` | 43.4 M | ~6.1% |
| `height` (any object, so an upper bound) | 27.8 M | ≤ 3.9% |
| `roof:levels` | 5.2 M | ~0.7% |
| `roof:shape` | 9.8 M | ~1.4% |
| `building:part` | 4.8 M | — |
| `building:colour` | 1.5 M | ~0.2% |

So: **most of the world's buildings are footprints and nothing else**, and the
ones with more are clustered (German, Polish, Czech, Japanese and some US
cities are dense; whole countries are empty). A design that needs floors,
roofs or use to look right looks right in a handful of places and wrong
everywhere else. Municipal datasets — PLUTO (New York), PLATEAU (Japan), 3DBAG
(Netherlands, LOD2 roofs), the Spanish Catastro's INSPIRE buildings (floor
counts) — are far richer but come **city by city or country by country**, each
with its own licence, attribution and update cadence.

The design consequence: the baseline must look good with *footprint + height
only*, and every richer source is an enhancement that degrades to that baseline,
never a requirement.

## Decision

### 1. Render with three.js inside MapLibre, as a custom layer

A `CustomLayerInterface` with `renderingMode: '3d'` hands a layer MapLibre's
own WebGL2 context, its depth buffer and, every frame, its mercator → clip
matrix. three.js draws into that context with that camera. The buildings then
sit in the map's own layer stack — above roads and footprints, below every
label, overlay anchor and marker — and occlude and are occluded by the
basemap's other 3D content correctly.

Rejected: a second canvas over or under the map (no shared depth, so labels and
routes cannot interleave with buildings; two compositors drifting a frame
apart), and a full-screen three.js view that draws its own basemap (that is a
different product — a 3D mode — and it would have to re-earn every guarantee
`MapCanvas` gives today, the mark and the credit included).

The engine is **host-neutral**: it takes a GL context and, per frame, a
mercator → clip matrix and the camera's centre, zoom and bounds
(`CityView`). The MapLibre-specific part is a thin adapter
(`components/map/city3dLayer.web.ts`). MapLibre stays a replaceable adapter
(AGENTS.md → Product boundaries); a different host map only needs a different
adapter.

### 2. Geometry: mesh the existing tiles now, compile GoWay 3D tiles next

| | **A. Mesh the OpenMapTiles `building` layer client-side** (the prototype) | **B. Offline compiler → GoWay-owned binary 3D tiles** |
| --- | --- | --- |
| Data | `render_height`/`render_min_height` only; z14 footprints unioned | Per-building OSM footprints and `building:part`s; levels, roof shape and height where tagged; per-city municipal data merged where licensed |
| Coverage on day one | Worldwide, identical to the basemap | Worldwide after a planet build |
| Client cost | Fetch (normally a cache hit) + decode + mesh every tile, every visit | Upload pre-built buffers; nothing to mesh |
| What it can bake | Per-building bevel and occlusion | Plus neighbour occlusion, which needs other tiles' buildings — impossible per tile on the client |
| Infra | None | A compile step beside `scripts/build-map-tiles.ts`, an archive in R2, a route in `worker/index.js` |
| Licence | Same as the basemap | A Derivative Database — see [Obligations](#obligations) |

**Recommendation: A now, B as the destination.** A is what the prototype runs,
and it already proves the expensive-to-get-wrong part — the rendering path, the
precision handling, the worker, the shading. B replaces only the *source* step
(the worker's fetch + decode); the engine, the adapter, the LOD scheme and the
shader carry over unchanged.

For B the compiler belongs next to the Planetiler build GoWay already runs on
Oxy hardware (`scripts/build-map-tiles.ts`), reading the **same** OSM extract so
that the 2D basemap and the 3D tiles always describe the same planet. Output: a
compact GoWay binary per tile — quantised local positions (int16), oct-encoded
normals, one occlusion byte, LOD levels — in a PMTiles-style archive in R2,
served by the same Worker. The format is **internal**: the SDK draws maps
through `MapCanvas`, so no third party ever parses it, and it must never become
a public contract (the same rule that keeps Drizzle rows and worker internals
out of the SDK). If an export format is ever wanted, OGC 3D Tiles 1.1 is the one
to emit, from the same compiler.

### 3. Mesh off the main thread, always

Measured on the prototype's mesher with the real tiles above (Bun, one core):

| Tile | Decode | Mesh | Vertices | Triangles | Buffers |
| --- | ---: | ---: | ---: | ---: | ---: |
| Barcelona | 17 ms | 165 ms | 1,108,188 | 616,068 | 26.2 MB |
| Manhattan | 3 ms | 28 ms | 264,985 | 144,066 | 6.2 MB |
| Tokyo | 2 ms | 7 ms | 75,299 | 40,772 | 1.8 MB |

In a headless Chromium's worker, Barcelona tiles took 260–400 ms each. On the
main thread that is a quarter of a second of frozen map per dense tile. The
worker fetches, decodes and meshes, and hands the typed arrays back as
**transferables** (no copy).

### 4. LOD and loading

- **Load near view.** Both reference projects default to it, and for a pitched
  camera it is the only sane choice: the viewport runs to the horizon. The
  prototype draws the nearest **6** z14 tiles (the source's max zoom; GoWay's
  tiles are over-zoomed above it, so one mesh per tile serves every zoom) and
  keeps a **192 MB** GPU budget, evicting least-recently-used tiles.
- **Far field.** The prototype draws nothing beyond the near ring, so at high
  pitch the flat footprints show past it. Production needs a coarse far LOD:
  in B, a pre-built low-detail level per tile; in A, plain prisms without
  bevel or occlusion columns (roughly a third of the vertices).
- **Fade.** The meshes grow in over exactly the zooms `building-3d` does
  (`BUILDINGS_3D_FADE`, 15.5 → 16.5), so switching renderers changes how
  buildings look, never *when* they appear.

### 5. Shading: bevels and baked occlusion

What `fill-extrusion` cannot do and the prototype does:

- **Bevelled roof edges.** The roof is the footprint inset by `b` (0.7 m,
  capped at 20% of the height and 35% of the footprint's characteristic width
  `2·area/perimeter`) and lifted to the full height; the walls stop `b` short,
  so every roof line is a 45° chamfer that catches light differently from roof
  and wall. Where the full inset folds over itself (narrow corridors, zig-zag
  edges from tile simplification) it retries at half width, then falls back to
  a plain prism: measured, 0.9% of Barcelona's 15,501 polygons and 0.5% of
  Manhattan's 4,405 end up without a bevel.
- **Baked ambient occlusion**, two terms derived from the footprint alone:
  ground contact (walls darken toward the street, 0.62 → 1 over 7 m) and
  concave corners (inside corners of Ls and courtyards darken by up to 38%,
  fading over 3 m, with an extra vertex column at that reach so the gradient
  does not smear across a whole facade).
- **The map's own light, lit MapLibre's way.** The city layer follows exactly
  the `light` `MapCanvas.web.tsx` gives `building-3d`: the real sun from
  `useSunLight` (`lib/map/sun.ts`, `lib/map/sunLight.ts` — map-anchored, recomputed
  on settle and every five minutes, restarted when the engine is rebuilt), or the
  style's own light when GoWay does not own the style. `components/map/city3dLight.ts`
  converts it into ENU, and the shader is MapLibre's `fill-extrusion` lighting
  formula, so the two renderers agree on every face's light — pinned by a test
  against a re-implementation of MapLibre's own light and normal conventions —
  and differ only in the bevel and the baked occlusion (which takes the place of
  MapLibre's vertical gradient). The light is a uniform: a moving sun costs one
  `setLight` and no re-meshing.

Not done, and why: screen-space AO (n8ao) and full-frame post-processing need
the whole frame's depth and normals, and inside MapLibre the frame is
MapLibre's. Neighbour occlusion (a low building beside a tower) is a
compile-time job for B.

### 6. Atmosphere

Procedural Tokyo's look comes largely from takram's `three-geospatial` (MIT):
physically based sky and aerial perspective in a linear HDR pipeline with tone
mapping. Doing that for the *whole* frame means owning the frame — rendering
MapLibre into a texture and compositing — which is a large step and makes the
basemap's colours no longer MapLibre's.

The recommended path is staged: (1) MapLibre's own `sky` / fog for the horizon,
(2) the same fog colour and distance applied in the building shader (aerial
perspective for the one layer that has depth), (3) the ambient term tinted by
the real sun's elevation. Full-frame atmosphere stays a separate decision, made
only if the staged version visibly falls short.

### 7. Native

`@maplibre/maplibre-react-native` exposes **no custom-layer API**: MapLibre
Native's custom layers are C++ and platform code, and the React Native wrapper
does not surface them. So, honestly:

- **Native keeps `fill-extrusion`** — the shipped look — for the foreseeable
  future. The prototype is web-only and `MapCanvas.native.tsx` is untouched.
- **Native still benefits from B.** A GoWay tile layer with *per-building*
  footprints and heights (not unioned) can feed the native extrusion directly:
  individual buildings instead of whole blocks, which is the largest single
  visual difference on native.
- A native custom layer (an Expo module wrapping MapLibre Native's custom layer
  per platform, or a future MapLibre Native plugin-layer API) is the only route
  to bevels on native; it is months, not weeks, and should be chosen by device
  benchmarks, exactly as Street 3D's native renderer is (`STREET3D_VIEWER.md` →
  Native strategy).
- A WebView 3D mode (Street 3D's approach) is possible for a dedicated
  "city view" screen, never for the main map.

### One engine, one scene

The city engine and the SDK's coordinate-anchored models
([`SDK_MAP_MODELS.md`](./SDK_MAP_MODELS.md)) must be **one** custom layer, one
`WebGLRenderer`, one scene and one camera. Two custom layers each wrapping
their own three.js renderer around MapLibre's context double the state
resets, cannot depth-sort against each other's transparency, and each re-solve
the precision problem. The engine's per-tile placement
(`tileModelMatrix`: local ENU metres → centre-relative mercator) is already the
general "anchor + metres" transform a model needs; the SDK work should add model
objects to this scene rather than build a second one.

## Obligations

**MapLibre and OpenFreeMap stay replaceable adapters.** The engine never imports
MapLibre; the adapter reads the vector source's tile template from the loaded
style (`getMapSource().ids.basemap`), never a hostname; nothing names
OpenFreeMap.

**The mark and the credit.** `MapCanvas` renders `MapBrand` (bottom-left) and
`MapAttribution` (bottom-right) as DOM outside the GL canvas, unconditionally.
A layer inside the map cannot affect them, which is a reason to keep 3D inside
`MapCanvas`. Any future full-screen 3D view must render both, the embed
included.

**ODbL.** Today's meshes are a *Produced Work* from the same OSM-derived tiles,
credited by the same line ("© OpenMapTiles © OpenStreetMap"). Compiled 3D tiles
(B) are served to every browser and are, like Valdrada's and Tokyo's compiled
cities, a **Derivative Database** of OpenStreetMap: they must be offered under
ODbL (or the source and compiler that rebuild them must be), and the credit
stays on every frame. Merging a municipal dataset adds its licence and its
credit to `MapAttribution` *while its data is drawn*, and each one needs a
licence-compatibility review before it is merged with ODbL data, not after.

**Honesty: procedural detail is styling, never fact.** GoWay already refused
fabricated places on the public map; the same rule governs buildings:

- Geometry and shading may be *derived* (a bevel, occlusion, a far-field
  simplification) but never *invented*: no storefronts, signage, names, doors,
  logos or business-like detail that the data does not contain.
- A facade pattern is allowed only where floors are **recorded**
  (`building:levels`, PLUTO's `NumFloors`), only as an abstract rhythm that
  follows that count, and it degrades to a plain wall where the count is absent
  — never to a plausible guess.
- Roof shapes only from `roof:shape` (or LOD2 data); everything else is flat.
- Colour comes from the cartographic palette's height ramp (shared with
  `building-3d` via `buildingHeightRamp`); `building:colour` stays unused, as
  `buildings3d.ts` already decided.
- Unknown heights keep the 3 m floor `fill-extrusion` uses; they are not
  "corrected" to look like a city.

## The prototype

**Off by default; web only.** Turn it on with `EXPO_PUBLIC_MAP_CITY3D=1` (a build
decision; no production deployment sets it), or in a development build per tab
with `?city3d=1`, which a production build ignores (`lib/map/city3dFlag.ts`).

| Piece | Where |
| --- | --- |
| Flag | `lib/config.ts` (`MAP_CITY3D_ENABLED`), `lib/map/city3dFlag.ts` |
| Gate | one effect in `components/map/MapCanvas.web.tsx` |
| MapLibre adapter | `components/map/city3dLayer.web.ts` — adds `goway:city3d` before `building-3d`, hides `building-3d`, restores it on detach |
| Light | `components/map/city3dLight.ts` — the `building-3d` light (`useSunLight`'s, fed by `MapCanvas.web.tsx`) as the engine's `CityLight` |
| Engine (three.js) | `components/map/engine/city3d/cityEngine.ts` |
| Worker | `components/map/engine/city3d/meshWorker.ts` (`new Worker(new URL(…, import.meta.url))`, which Expo bundles as a sealed chunk) |
| Pure parts (tested) | `tileMath.ts`, `mesher.ts`, `occlusion.ts`, `shaders.ts`, `decode.ts` |
| Chunk boundary | `components/engine3d/lazyChunk.ts` |

Two things it does that are easy to get wrong:

- **Precision.** Absolute mercator positions in float32 are ~2.4 m apart near
  the middle of the map, so buildings would swim. Each tile's model matrix is
  relative to the camera's centre, and the centre is folded into the
  projection — both in float64 before upload (`tileMath.ts`).
- **Orientation.** A vector-tile exterior is clockwise *as drawn*; the mesher
  reverses rings into ENU so the solid is always on the left. The first version
  forgot, and dropped 1,465 of Manhattan's 1,488 buildings as "holes".

Verified in headless Chromium (SwiftShader) on `expo start --web`: Lower
Manhattan, Barcelona's Eixample and Gràcia, light and dark, flag on and off; no
console errors from the layer (the same two pre-existing errors — no Oxy client
id, a react-native-web `accessible` attribute — appear with the flag off). The
cull side was checked by rendering both: `FrontSide` draws hollow boxes.

### What the flag costs when off

Measured with `expo export --platform web` against `main` before this change:

| Chunk | Before | After | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,944,374 B | 6,945,465 B (+1,091 B; +432 B gz) | the gate and one `import()` stub |
| `__common` (first paint) | 78,516 B | 78,516 B | identical once module ids are normalised |
| lazy three.js chunk | `sparkEngine` 3,485,258 B | `lazyChunk` 3,495,558 B (1.12 MB gz) | Street 3D's engine plus the city engine |
| `city3dLayer`, `meshWorker` | — | 7,107 B, 40,881 B | never requested with the flag off |

The first export put **three.js into `__common`** — 912,807 B on every first
paint — because two lazy chunks now imported it (the trap in
`~/Oxy/docs/build-and-runtime-traps.md`). Routing both engines through one
lazy module fixed that; the second export still hoisted `occlusion.ts`
(+1,186 B), because the adapter imported its defaults at runtime, so the
adapter now imports the engine folder for types only.
`components/__tests__/engine3dChunk.test.ts` pins both rules. The cost of the fix: opening either 3D feature downloads both engines.
A dedicated shared "three runtime" chunk is the cleaner end state.

## Phased plan

Estimates are engineering time for one person familiar with the codebase, and
are estimates; the runtime numbers are measured unless marked.

| Phase | What | Cost |
| --- | --- | --- |
| **0. Prototype** (this change) | Custom layer, worker mesher over existing tiles, bevels, baked AO, lit by the same sun light as `building-3d`; off by default | Done. Users: +1.1 KB entry, nothing else with the flag off |
| **1. Ship A on web** | Far-field LOD, per-tile fade-in, 2-worker pool, WebGL context-loss handling, device gating via `deviceProfile`-style checks (GPU memory: Barcelona's visible set is ~60 MB), MapLibre sky/fog matched in-shader, tap-through to the basemap preserved, a perf budget on mid-range Android Chrome | ~2–3 weeks. No infra. Opt-in users download the ~1.1 MB gz lazy chunk |
| **2. GoWay 3D tiles (B)** | Compiler beside the Planetiler build: per-building footprints and parts, OSM levels/roof shapes where tagged, pre-meshed + neighbour AO + LODs, quantised; archive in R2 behind the Worker; a per-building vector layer for native extrusion | ~4–6 weeks. Planet compile time and archive size **unmeasured** — measure on one country first; R2 storage is cheap and egress free, the build machine is the real cost |
| **3. Atmosphere** | Staged as in §6: sky/fog, in-shader aerial perspective, sun-tinted ambient | ~1–2 weeks |
| **4. Municipal data** | One dataset at a time (PLUTO, PLATEAU, 3DBAG, Catastro…): licence review, adapter in the compiler, credit while drawn, LOD2 roofs where present | ~1 week each + legal review |
| **5. Native** | (a) Extrude B's per-building layer in the existing native style — days. (b) A native custom layer — months, decided by benchmarks | (a) days, (b) months |

Procedural facades are deliberately not a phase. If they ever come, they come
under the honesty rule above, after Phase 4 has made recorded floor counts
common enough to be worth drawing.

## Open questions

- Where should the shared three.js runtime chunk live once a third consumer
  (SDK models) arrives — and should Spark move out of it?
- Does Phase 2 compile at z14 like the basemap (one mesh serves every zoom), or
  at z15/16 to keep dense-city tiles under ~10 MB?
- Is the B archive versioned with the basemap's planet build (same date stamp)
  or independently? Same-date keeps 2D and 3D in agreement.
- Picking: should tapping a 3D building select it (it is not a Place), or pass
  through to the basemap as today?

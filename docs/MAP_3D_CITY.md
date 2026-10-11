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

The prototype first drew the nearest **6** z14 tiles and nothing else, so a
tilted or wide view showed flat footprints past them. It now draws **every
tile the camera sees**, each at the level of detail its distance affords
(`lod.ts`, `lodMesher.ts`), within explicit budgets (below).

- **What is visible.** The engine recovers the eye from the host's mercator →
  clip matrix (the point the projection sends to infinity) and the six frustum
  planes from the same matrix, so it reads no MapLibre camera API. A z14 tile
  is drawn when its box — the tile square from the ground to 250 m — is not
  wholly outside the frustum; MapLibre's own far plane ends at the top of the
  screen (or the horizon), which bounds the set. Distance `r` is measured from
  the eye to the tile's nearest point, in units of the eye's distance to the
  ground under the screen centre. z14 is the only zoom whose buildings carry
  heights (a z13 `building` layer is one feature with no properties, measured),
  so every level is meshed from the same z14 tile.
- **Three levels.** Level 0 is the full mesh (bevel, corner occlusion). Level 1
  is a plain prism over the footprint simplified at 1 m (Douglas–Peucker that
  keeps tile-seam edges exact, `simplify.ts`). Level 2 simplifies at 4 m, fills
  courtyards under 150 m² and drops buildings under 80 m² and 15 m. Each level
  is charged a geometric error (1.5 m, 6 m) and drawn only where that error is
  under a pixel at the view's scale (`lodThresholds`): at zoom 16 in Barcelona
  (0.9 m/px, MapLibre's 512-px tiles) level 1 starts at `r` 1.7 and level 2 at
  `r` 6.7. A 60° view spans `r` ≈ 0.65 → 2.5, so it is levels 0 and 1; level 2
  is the horizon of a steeper camera (a flyover). Full detail is also floored at
  `r` 1, so the street in front of the camera is never coarse.
- **No popping, no holes.** A tile whose level is still loading keeps drawing
  whatever level of it is cached; swaps (and first appearances) are a 280 ms
  screen-door cross-fade (`transitions.ts`): the incoming mesh keeps the pixels
  where a fixed noise is below the fade's progress, the outgoing one exactly
  the others, so the two never both draw a pixel and never both leave one
  empty, and depth stays correct (no alpha sorting). Hysteresis (10%) keeps a
  camera resting on a threshold from swapping back and forth.
- **Loading.** Requests go to a pool of up to 3 mesh workers
  (`workerPool.ts`; cores − 1), nearest first, at most 2 in flight per worker
  so a pan cancels cleanly. A tile returns to the worker that meshed it before
  unless that one is busy, and each worker keeps the last 12 tiles' bytes, so a
  tile changing level is re-meshed from memory. Replies are handed to the GPU
  within a per-frame upload budget (12 MiB; one mesh only after a frame slower
  than 50 ms), nearest first, so three dense tiles landing together do not stall
  one frame. Least-recently-used meshes are evicted past the cache budgets,
  never one that is wanted or still fading. Empty tiles are cached as empty;
  failed tiles retry with backoff (1, 2, 4, 8 s, then a 5-minute cooldown) even
  while the view stands still — `building-3d` is hidden, so nothing else would
  draw them; a view straddling the antimeridian loads both sides
  (`tileScheduler.ts`, `lod.ts`, tested without WebGL).
- **Compact vertices.** Every level is uploaded in the format §2 proposes for
  GoWay's own tiles (`packing.ts`): `uint16` positions in tile units with height
  in 1/32 m and the shade word in the fourth lane (8 B), `int8` normals (4 B),
  `uint16` indices in chunks of ≤ 65,535 vertices. The model matrix undoes the
  quantisation, so the vertex shader is unchanged in cost. Barcelona's
  full-detail tile: 26.2 MB → 17.0 MB with the same vertices and triangles.
- **Where the city tiles cover the ground** (`sources.ts`): with `?cityTiles=1`
  a z14 tile wholly inside an archive's compiled area, at full detail, is drawn
  from its four z15 city tiles; every other tile — outside every archive,
  straddling an archive's edge, or far enough for a coarser level — from the
  OpenMapTiles buildings at its level. One source per z14 tile, so the two
  never double-draw or leave a gap. The compiled area comes from
  `/map/city/coverage.json` (`CITY_COVERAGE_PATH`; each archive's
  `goway:coverage` metadata, the compile box), because a city tile's 204 means
  "empty ground" inside it and "not compiled" outside it. Unreachable,
  malformed or slow (4 s): no coverage, the OpenMapTiles buildings everywhere.
  The first version had no such rule: outside Barcelona the map was flat with
  `building-3d` hidden (owner report, Madrid).
- **On 3D terrain** (`MAP_TERRAIN_GLOBE.md`): every level, and the trees, are
  placed on the drawn ground by `terrainGround.ts`, through the packed chunks
  (`cityMeshes.ts` → `groundTileFor`); a tile is not drawn until it is lifted.
- **Fade.** The meshes grow in over exactly the zooms `building-3d` does
  (`BUILDINGS_3D_FADE`, 15.5 → 16.5), so switching renderers changes how
  buildings look, never *when* they appear.

#### Measured per tile (worker, Bun, one core)

| Tile | Level 0 | Level 1 | Level 2 |
| --- | --- | --- | --- |
| Barcelona 14/8290/6119 | 1,107 k v · 17.0 MB · 188 ms | 510 k v · 7.8 MB · 46 ms | 233 k v · 3.5 MB · 40 ms |
| Ciutadella 14/8291/6119 | 892 k v · 13.7 MB · 153 ms | 397 k v · 6.1 MB · 41 ms | 171 k v · 2.6 MB · 27 ms |
| Manhattan 14/4824/6157 | 265 k v · 4.0 MB · 39 ms | 123 k v · 1.9 MB · 11 ms | 92 k v · 1.4 MB · 9 ms |
| Central Park 14/4825/6155 | 209 k v · 3.2 MB · 28 ms | 94 k v · 1.4 MB · 10 ms | 56 k v · 0.8 MB · 7 ms |
| Tokyo 14/14552/6451 | 75 k v · 1.1 MB · 13 ms | 38 k v · 0.6 MB · 3 ms | 22 k v · 0.3 MB · 2 ms |

Level 0 includes repacking the float mesh into the compact format (Barcelona:
~50 ms of the 188; meshing straight into it is a follow-up). Times were taken on
a loaded 32-core machine and vary ±30% run to run; the sizes are exact.

#### Budgets

| Budget | Value | Where | Measured against it |
| --- | --- | --- | --- |
| Building vertices drawn per frame | 8 M | `DRAW_BUDGET` (`cityEngine.ts`) | Barcelona at 80°: ≤ 7.3 M (19 tiles) |
| GPU bytes drawn per frame | 128 MiB | `DRAW_BUDGET` | Barcelona at 80°: 107 MiB; at 60°: 69 MiB (was 130) |
| GPU bytes cached (drawn + slack + fallbacks) | 192 MiB, 160 entries | `MAX_CACHED_BYTES`, `MAX_CACHED_TILES` | LRU, wanted and fading entries spared |
| Tiles drawn | ≤ 48, ≤ 6 at full detail | `LOD_POLICY` | |
| Upload per frame | 12 MiB (1 mesh after a > 50 ms frame) | `UPLOAD_BYTES_PER_FRAME` | |
| Requests in flight | 2 per worker, ≤ 3 workers | `MAX_IN_FLIGHT_PER_WORKER`, `poolSize` | |
| Worker time per tile | level 0 ≤ 200 ms, levels 1–2 ≤ 60 ms, trees ≤ 50 ms (Bun, dense tiles) | — | table above |
| Trees | ≤ 24,000 per tile, ≤ 40,000 drawn per frame (nearest tiles first); ≤ 98 triangles near, ≤ 30 far; shorter than `treeMinHeightM(zoom)` not drawn | `TREES.maxPerTile`, `TREE_BUDGET`, `treeGeometry.ts`, `treeShaders.ts` | Central Park: 18,233 trees, 1.28 M triangles; Barcelona at 80°: 20,523 |
| Main-thread time in `render()` | ≤ 2 ms steady (selection, scheduling, three's draw calls) | `frameCpuMs` dev stat | 1.0–1.3 ms steady in Barcelona at 60° and 80°; frames that upload new meshes cost more, which is what the upload budget bounds |

When the drawn set would exceed `DRAW_BUDGET`, `fitBudget` coarsens it from
the FARTHEST tile inward — down to level 2, then the next farthest — and only
when every tile is at level 2 drops the farthest; the street in front of the
camera is the last thing to lose detail. A tile not yet loaded is costed from
its other levels (or the running mean) by the measured level ratios (1 : 0.46 :
0.25).

#### Before and after

Same views, same harness, `main` (`3eda89b`) against this change, both served by
`expo start --web` and captured in headless Chromium on SwiftShader at 1280×800
(the wide view 1920×1080), tilted with Ctrl+drag; the 78–80° views raise
`maxPitch` as a flyover camera would (GoWay's own maximum is 60°). Tile counts,
triangles, trees and bytes are exact; "GL indices" counts every index the page
drew in one frame, MapLibre's included. Frame time is twelve forced repaints of
the same view, each closed by a one-pixel `readPixels`; SwiftShader rasterises
on the CPU of a shared, loaded machine, so read those as relative and noisy
(two runs each) — GPU frame times on real devices are **unmeasured**.

| View | Tiles drawn (now: L0/L1/L2) | Building triangles | Trees (triangles) | GPU MiB | GL indices / frame | ms / frame (before: two runs) |
| --- | --- | --- | --- | --- | --- | --- |
| Barcelona, z16, 60° | 6 → 5 (4/1/0) | 3.19 M → 2.61 M | 4,722 (0.34 M) | 130 → 69 | 10.7 M → 10.7 M | 520, 238 → 448 |
| Barcelona wide (1920×1080), z16, 60° | 6 → 7 (5/2/0) | 3.19 M → 3.04 M | 9,619 (0.51 M) | 130 → 80 | 12.3 M → 13.4 M | 709, 332 → 608 |
| Barcelona, z16, 80° | 6 → 19 (3/11/5) | 3.19 M → 3.73 M | 20,523 (0.52 M) | 130 → 107 | 11.0 M → 14.9 M | 741, 274 → 755 |
| Lower Manhattan, z16, 60° | 4 → 4 (3/1/0) | 0.41 M → 0.29 M | 1,827 (0.13 M) | 17 → 8 | 1.9 M → 1.9 M | 252, 79 → 93 |
| Lower Manhattan, z16.4, 78° | 6 → 13 (4/9/0) | 0.54 M → 0.87 M | 6,089 (0.24 M) | 22 → 24 | 2.7 M → 4.6 M | 191, 99 → 338 |
| Central Park, z16.3, 60° | 6 → 4 (3/1/0) | 0.60 M → 0.43 M | 18,233 (1.28 M) | 24 → 12 | 1.8 M → 5.5 M | 58, 57 → 324 |
| Parc de la Ciutadella, z16.6, 58° | 4 → 3 (3/0/0) | 1.24 M → 0.95 M | 3,432 (0.30 M) | 50 → 25 | 4.2 M → 4.2 M | 117, 86 → 165 |
| Ciutadella close, z17.6, 60° | 2 → 2 (2/0/0) | 0.94 M → 0.94 M | 3,132 (0.27 M) | 38 → 25 | 3.0 M → 3.8 M | 63, 59 → 88 |

What it says:

- **The whole view is 3D now.** At 60° a 1280×800 view needs only about five
  z14 tiles (MapLibre's frustum reaches ~1.7 km past the centre at zoom 16), so
  the old six mostly covered it; tilted further, or wide, it did not — at 78–80°
  the new engine draws 13–19 tiles to the skyline where the old one left flat
  footprints past the sixth.
- **Cheaper per tile.** The compact format and the far levels halve the GPU
  memory of the same views (Barcelona 130 → 69 MiB) and cut building triangles
  where the view allowed it, so drawing three times the area at 80° stays inside
  the 128 MiB / 8 M-vertex budget.
- **Trees cost what they draw.** On SwiftShader the Central Park view goes from
  ~58 ms to ~324 ms with 18,233 maquette trees (1.28 M triangles; with the
  first, 30-triangle trees it was ~160–210 ms, and 84 ms with
  `?city3dTrees=0`), so most of the added time there is the trees, whose
  canopies overlap heavily. A CPU rasteriser pays per pixel and per triangle;
  GPU instancing of ≤ 98-triangle meshes is the cheap case on real hardware,
  but that is **unmeasured**, which is why the trees have their own switch,
  their own per-frame budget and the zoom height threshold.
- **Main thread.** Steady-state time in `render()` is 1.0–1.3 ms in the densest
  view; worker time per tile is in the table above.

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

**Built** ([Phase 3](#phase-3-sky-atmosphere-shadows-and-time-of-day)), and
further than staged: MapLibre's fog never reaches a flat basemap, so the layer
blends the light and the haze over the basemap itself, adds a sky and sun
shadows, and is tuned to a pastel maquette look rather than photorealism.

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

### 8. Trees: the trees OpenStreetMap records

The look is Apple Maps' "Detailed City Experience" maquette (and the analysis in
Chee Aun's [replicating Apple Maps' 3D trees](https://cheeaun.com/blog/2021/11/replicating-3d-trees-apple-maps/)):
soft, matte, bumpy canopies on short trunks, simple cones for conifers, palms
where they are palms, each tree grounded by a faint contact shadow. The look is
copied; no asset or code is (all shapes are generated in `treeGeometry.ts`).

**What the data has.**

- GoWay's OpenMapTiles-schema basemap carries **no individual trees**: no
  `natural=tree` point in any layer (decoded, z12–14, Barcelona, Manhattan,
  Central Park, Parc de la Ciutadella, Tokyo; `poi` has parks and gardens as
  places, never trees). What it carries is AREAS: `landcover` `class=wood`
  (`subclass` wood, forest) and `class=grass` (`subclass` park, garden, grass,
  meadow, heath…), `landuse` pitches and playgrounds, `water`, and paths in
  `transportation`.
- OpenStreetMap itself records trees as `natural=tree` nodes, and in places
  densely: **119,302 in Barcelona's city-tile area** (Catalonia extract,
  2026-10-11). 11.7% record a crown form we can draw — 12,169 broadleaf (`leaf_type`),
  483 conifers, 1,337 palms (`genus` like *Phoenix* / *Washingtonia*,
  `taxon`/`taxon:family` Arecaceae, `leaf_type=palm`) — and 0.04% a height. The
  city-tile compiler now writes them as a `tree` layer (`lib/map/cityTiles.ts` →
  `CITY_TREE_LAYER`; `scripts/citygen/treeTags.ts` reads only what is recorded:
  crown from `leaf_type`, genus/species/taxon or family; `height`;
  `diameter_crown`). Barcelona's archive grew 6.16 → 6.99 MB with them.

**What is drawn.** By default, only trees the data records (owner decision
after review: "trees on top of buildings, trees at random everywhere" — no
tree where none is mapped).

1. **Mapped trees** (GoWay city tiles, `?cityTiles=1`): every `natural=tree`
   point, at its position, with its crown form when recorded (else broadleaf),
   its height when recorded (else a typical size for the crown —
   `MAPPED_TREE_HEIGHT_M`, a size for the eye), turned and varied by a seed
   from its OSM id, so it is the same tree every visit. With the default
   OpenMapTiles source there are no tree points, so no trees are drawn.
2. **No tree in a building** (`workerTrees.ts`): every tree — mapped or fill —
   whose point falls inside a footprint of its tile's own buildings is dropped
   (a courtyard is a hole, so a courtyard tree stays). Buildings of a
   neighbouring tile spilling over the edge are not consulted.
3. **On the same ground as the buildings**: on 3D terrain the trees read the
   grid the buildings stand on — the terrain as drawn (`MAP_TERRAIN_GLOBE.md`
   → "The ground is the drawn terrain", which also records why #126's
   de-noising of it was removed: in these cities the terrain is bare earth).
4. **The styling fill — off unless asked for** (`?city3dTreeFill=1` in
   development, `EXPO_PUBLIC_MAP_CITY3D_TREE_FILL=1` for a build;
   `trees.ts`): the 3D equivalent of the tree pattern a paper map prints over
   a forest, **in mapped woods only** (`landcover` `class=wood`: wood,
   forest), never in a park or a garden:
   - one tree per ~7 m, kept off everything mapped as something else — water,
     buildings, pitches, playgrounds, tracks, open grass, a cleared strip along
     every path and road by class (2.5 m each side of a footpath, 10 m of a
     primary) — and **9 m from every mapped tree**;
   - placed by a jittered lattice seeded by the tile and the cell (same trees
     every visit, none doubled at a seam), ≤ 24,000 per tile, thinned evenly;
   - a styling mix of crowns, 30% conifers — the `landcover` layer has no leaf
     type, so this is for the eye, not a census.
   With GoWay city tiles the fill reads the OpenMapTiles parent tile's
   landcover (the city tiles carry buildings and trees only), inside the city
   tile's quarter of it; a parent tile that fails to FETCH (not one that is
   absent) marks the tile incomplete and it is asked for again at 2, 8 and
   30 s (PR #126 review — it used to be cached without its fill for good).
3. **Shapes** (`treeGeometry.ts`): three broadleaf canopy variants (an icosphere
   pushed out by five soft lobes, not a sphere; 98 triangles with trunk and
   shadow), a two-tier cone conifer (34), a palm of seven drooping V-section
   fronds (74); far tiles (level 1) draw a 20-triangle canopy, a 6-triangle cone
   and a 30-triangle palm, no shadow; level 2 draws no trees. The trunk leans a
   little (palms more), the canopy rides it.
4. **Zoomed out, the tallest first**: trees shorter than `treeMinHeightM(zoom)`
   — 10 m at zoom 15.5, 0 from zoom 18 — shrink away over 3 m rather than pop
   (`treeShaders.ts`), which is also what keeps a whole-city view affordable.
5. **Colour** (`components/map/city3dTrees.ts`): canopies are the palette's PARK
   colour desaturated to a matte sage, a step darker than the ground on the
   light map and lighter on the dark one; conifers cooler and deeper; palms a
   touch warmer; trunks are the palette's BUILDING clay, darker. A few tint
   variants per seed. Lit by MapLibre's extrusion formula under the map's light,
   with a soft occlusion (underside darker, crown lighter).
6. **GPU instancing**: one shared unit tree per shape, four 16-bit numbers per
   tree (position, seed, kind + height); the vertex shader turns, sizes, leans
   and places each one, so thousands of trees cost the CPU nothing per frame.
   Instances are sorted by shape in the worker, so a tile is at most five
   instanced draws.

**Honesty.** A mapped tree is drawn where OSM records it and as what OSM
records; its unrecorded size and its turn are styling. A fill tree — only when
the fill is switched on — stands for no tree: none stands outside a mapped
wood, within 9 m of a mapped tree, or on anything mapped as something else,
and their number, species mix, size and position are not data. That is the rule above — procedural detail is
styling, never fact — applied to vegetation. The trees can be switched off on
their own: `EXPO_PUBLIC_MAP_CITY3D_TREES=0` for a build, or `?city3dTrees=0` in
a development tab (`lib/map/city3dTreesFlag.ts`).

**Not done, and why.** Municipal tree inventories are far richer than OSM where
they exist — Barcelona's *Arbrat viari* / *Arbrat zona* (every street and park
tree, species and height class) and New York's 2015 Street Tree Census — and
are the natural next source for the compiler's `tree` layer, merged with
`natural=tree` by position. Each needs its licence verified (both are published
as open data; the exact terms and attribution wording were not checked here) and
its credit added to `MapAttribution` while drawn, as the Obligations require.
Crown diameter is compiled but not yet used to size the canopy.

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

Phase 1 of the SDK models now does exactly that: models are a group in this
engine (`engine/city3d/models.ts`), drawn by the same renderer from a second
custom layer above GoWay's overlays — see
[`MAP_CAMERA_STUDIO.md`](./MAP_CAMERA_STUDIO.md) → "Two layers, one renderer".

The city-life simulation ([`MAP_CITY_LIFE.md`](./MAP_CITY_LIFE.md)) is the
second such guest: simulated cars and people are an OVERLAY of this engine
(`engine/city3d/overlay.ts`) — the same scene, camera, light and terrain as the
buildings, one instanced draw per vehicle model — never a renderer of their own.

Hand-crafted **landmarks** ([`MAP_LANDMARKS.md`](./MAP_LANDMARKS.md)) are
another guest: a second instance of the model layer in the same engine, drawn in the
BUILDINGS' pass (right after the city tiles) and replacing the city-tile
buildings they stand for — the mesh worker skips those OSM ids, and only
while the model is drawn. They are styling of one curated building, not a
relaxation of the honesty rules below for the city at large.

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
(B, now built — see [Phase 2](#phase-2-goway-city-tiles)) are served to every
browser and are, like Valdrada's and Tokyo's compiled cities, a **Derivative
Database** of OpenStreetMap. What that obliges, concretely:

- **Credit on every frame.** Already discharged: `MapAttribution.tsx` renders
  "© OpenStreetMap" bottom-right on every map, as DOM outside the GL canvas, and
  the city layer cannot affect it. The archive's own metadata carries the same
  attribution and `license: ODbL-1.0`, so it travels with the file.
- **Share-alike of the database.** Anyone who receives the tiles may ask for the
  database, so GoWay must offer it under ODbL: either the archive itself (a
  download link beside the credit or on an "About the map data" page) or the
  means to rebuild it — the extract (named and dated in the build receipt,
  `*.pmtiles.receipt.json`, with its replication timestamp) plus the compiler,
  which is in this repository. The receipt is what makes the second option
  honest: it names exactly which OSM snapshot a published archive came from.
  Publishing the receipt and the archive URL together is the cheapest way to
  satisfy both readings, and is a precondition of serving the tiles in
  production (see [Hosting](#hosting-what-production-needs)).
- **The compiler and the format stay GoWay's.** Share-alike reaches the
  DATABASE (the archive's contents), not the code that renders it; the client
  and the format are not thereby a public contract (AGENTS.md).

Merging a municipal dataset adds its licence and its credit to
`MapAttribution` *while its data is drawn*, and each one needs a
licence-compatibility review before it is merged with ODbL data, not after.

**Honesty: procedural detail is styling, never fact.** GoWay already refused
fabricated places on the public map; the same rule governs buildings:

- Geometry and shading may be *derived* (a bevel, occlusion, a far-field
  simplification) but never *invented*: no storefronts, signage, names, doors,
  logos or business-like detail that the data does not contain.
- A facade pattern is allowed only where floors are **recorded**
  (`building:levels`, PLUTO's `NumFloors`), only as an abstract rhythm that
  follows that count, and it degrades to a plain wall where the count is absent
  — never to a plausible guess. Implemented in `facades.ts` (`facadeFor`): one
  row of identical openings per recorded storey, nothing where the count is
  missing or disagrees with the height (a storey outside 2.2–6.5 m), and
  nothing on a **party wall** — an edge a neighbour shares — because a wall
  another building stands against is blind, and where it rises above its
  neighbour (Barcelona's *medianeras*) it is blind in reality too. The columns
  are an even division of each facade into ~3.2 m bays: styling, stated as such.
- Roof shapes only from `roof:shape` (or LOD2 data); everything else is flat.
  Where the shape is tagged and its height is not, the pitch is a default
  (30°, or `roof:angle`) and the tile says so (`roof_height_source=default`).
- Colour comes from the cartographic palette's height ramp (shared with
  `building-3d` via `buildingHeightRamp`). On the city tiles a tagged
  `building:colour`/`roof:colour` or `*:material` is drawn **tempered** into
  that ramp (`osmShaders.ts`): desaturated and pulled most of the way to the
  ramp's lightness, so it is a hint (warm brick, cool glass, a tiled roof)
  rather than the patchwork `buildings3d.ts` refused raw `colour` for — the
  first untempered render of Lower Manhattan proved that point with a black
  tower and a yellow roof.
- **Heights: recorded, or the default — never guessed.** Precedence, highest
  first: **official 3D data** (`height_source=lod2`, the LOD2 work: Catastro
  in Spain) > **OSM tags** (`height`, `building:levels`; `height_source=osm`)
  > **the 5 m default** OpenMapTiles also uses (no `height_source`). The
  compiler writes the source (`tags.ts`); the client keeps, per drawn unit,
  whether its height is the default (`TileMesh.polygonHeightDefault`, from
  `height_source` on the city tiles and from OpenMapTiles' `render_height` 5
  on the ground), so what draws it can tell a default from a fact. A default
  is not "corrected" to look like a city.

  *Measured ≠ invented — and why nothing is measured.* A height measured from
  a surface model would be data, not a guess, and was tried for the default
  buildings (the flat block at Passeig de Gràcia / Mallorca: OSM ways
  249405068 and 249408232, `building=apartments` and nothing else). It does
  not work with the data available, so do not retry it without new data:
  - **At runtime, from the terrain the map draws:** Mapterhorn's z12 tiles are
    the national BARE-EARTH models in Barcelona, Madrid and Manhattan (no
    Empire State, no Cuatro Torres, no Eixample; `MAP_TERRAIN_GLOBE.md` → "The
    ground is the drawn terrain"). There is nothing to measure: in the
    Eixample tile 15/16580/12238 a median-of-nine nDSM measured 1 of 996
    default buildings.
  - **At compile time, from raw Copernicus GLO-30:** it does see the city,
    but too coarsely. Median of nine samples per footprint minus the
    bare-earth ground, against the 215 buildings of the same tile whose height
    OSM records: median error **−10.8 m**, 18% within 5 m, 47% within 10 m
    (the maximum of the nine: −9.1 m, 20% within 5 m). Its 30 m cells average
    streets and courtyards into every block, and an isolated tower vanishes
    (Torre Glòries reads nothing). The flat block would rise to 7.6 and
    8.2 m, not ~25.

  A per-country LiDAR surface model (Spain's IGN MDS05 against MDT05) would be
  accurate enough; official building data (Catastro's floors above ground) is
  simpler and is the LOD2 work's.
- **Night lighting is styling, not data** (owner decision, 2026-10-11: "full
  Apple style"). It makes no claim about occupancy, opening hours or what is
  lit at any hour, and two kinds are allowed:
  - **Window glow**, only on walls whose window rows are drawn — that is, only
    where storeys are recorded, by the facade rule above — and never on a
    blind or party wall. Which windows glow is a pattern, not a census.
  - **Floodlighting** of landmarks. Drawn where the data records that a
    building is lit at night (`floodlit` / `lit` on the building:
    `CITY_PROPS.floodlit`, see Phase 3); a curated landmark set may add it as
    styling of the landmark it models.
  Both follow one input, `nightFactor` (`lib/map/landmarks/night.ts`), so the
  city lights up together. A warm street-level glow on every wall at night is
  the same kind of styling.
- What stays forbidden is unchanged: **facts are never invented** — no names,
  storefronts, signage, logos, doors or business-like detail the data does not
  contain, by day or by night.

## The prototype

**Off by default; web only.** Turn it on with `EXPO_PUBLIC_MAP_CITY3D=1` (a build
decision; no production deployment sets it), or in a development build per tab
with `?city3d=1`, which a production build ignores (`lib/map/city3dFlag.ts`).

| Piece | Where |
| --- | --- |
| Flag | The map-feature registry (`lib/map/mapFeatures.ts`, [`MAP_FEATURES.md`](./MAP_FEATURES.md)): `city3d`, `city3dTrees`, `city3dTreeFill`, switchable in the layers panel's Labs; their rules stay in `lib/map/city3dFlag.ts` (`?city3d=1` in development) and `lib/map/city3dTreesFlag.ts` (`?city3dTrees=0`, `?city3dTreeFill=1`). The adapter is handed the answers |
| Gate | one effect in `components/map/MapCanvas.web.tsx` |
| MapLibre adapter | `components/map/city3dLayer.web.ts` — adds `goway:city3d` before `building-3d`, hides `building-3d`, restores it on detach; on a style with no `building-3d` (the `openfreemap` escape hatch, a style-URL override) it declines and leaves the style untouched, rather than guessing an anchor in a document GoWay does not own |
| Light | `components/map/city3dLight.ts` — the `building-3d` light (`useSunLight`'s, fed by `MapCanvas.web.tsx`) as the engine's `CityLight` |
| Tree colours | `components/map/city3dTrees.ts` — crown and trunk from the palette's park colour |
| Engine (three.js) | `components/map/engine/city3d/cityEngine.ts` (selection, scheduling, upload budget, fades), `cityMeshes.ts` (a tile's GPU entry: building chunks + instanced trees) |
| Worker | `components/map/engine/city3d/meshWorker.ts` (`new Worker(new URL(…, import.meta.url))`, which Expo bundles as a sealed chunk), run as a pool by `workerPool.ts` |
| Pure parts (tested) | `tileMath.ts`, `mesher.ts`, `occlusion.ts`, `shaders.ts`, `decode.ts`, `tileScheduler.ts`; far field: `lod.ts`, `lodMesher.ts`, `simplify.ts`, `packing.ts`, `transitions.ts`; trees: `trees.ts`, `treeSources.ts`, `treeGeometry.ts`, `treeShaders.ts` |
| Chunk boundary | `components/engine3d/lazyChunk.ts` |
| On 3D terrain | `engine/city3d/terrainGround.ts` (pure) and `components/map/city3dGround.web.ts` — each building lifted to the drawn ground; see [`MAP_TERRAIN_GLOBE.md`](./MAP_TERRAIN_GLOBE.md) → "Buildings on terrain" |

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
cull side was checked by rendering both: with float positions (`tileModelMatrix`,
one mirror) `FrontSide` draws hollow boxes. The compact format's matrix stores y
southward — a second mirror — so buildings are now `FrontSide` and trees, still
placed in metres, `BackSide`; rendering the other way round draws hollow,
roofless shells again (`cityMeshes.ts`).

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

The far field, compact format and trees (this note's §4 and §8), measured the
same way against `main` at `28d10da` (city tiles, globe and terrain merged):

| Chunk | `main` | With them | |
| --- | ---: | ---: | --- |
| `entry` | 6,962,712 B | 6,962,712 B | identical but for the build's git id and the lazy chunks' hashed paths |
| `__common` | 78,516 B | 78,516 B | identical but for module ids |
| `lazyChunk` | 3,581,212 B (1,141,608 gz) | 3,623,094 B (1,156,888 gz) | +42 KB, +15 KB gz: LOD, packing, fades, tree shapes and instancing |
| `city3dLayer` | 11,162 B | 13,494 B | the trees flag and tree colours |
| `meshWorker` | 59,195 B | 79,393 B | far-field mesher, simplification, packing, tree placement |

The trees' own flag first lived in `lib/config.ts`, which is on the first-paint
path: +292 B in `entry` with the prototype off. It moved to
`lib/map/city3dTreesFlag.ts`, imported only by the lazy adapter, and
`engine3dChunk.test.ts` pinned that. Since the map-feature registry
(`MAP_FEATURES.md`) the trees are switched live from the layers panel, so they
are decided at first paint after all: the flag module is pure and reached only
from `lib/map/mapFeatures.ts`, which `engine3dChunk.test.ts` now pins instead;
the registry's whole first-paint cost is measured in `MAP_FEATURES.md`.

## Phase 2: GoWay city tiles

**Built, off by default, web only, served nowhere but a developer's machine.**
An offline compiler turns an OpenStreetMap extract into GoWay-owned
per-building tiles, and the city-3D engine has a second source mode that reads
them. The OpenMapTiles path is untouched and stays the default and the
fallback.

| Piece | Where |
| --- | --- |
| Schema (shared by compiler and client) | `lib/map/cityTiles.ts` |
| Compiler CLI | `scripts/build-city-tiles.ts` (`bun run --cwd packages/frontend map:city-tiles`) |
| Compiler internals | `scripts/citygen/` — `osmPbf.ts` (reader, relation roles included), `compile.ts` (passes, assembly, parts, tiling), `tags.ts` (+ `cssColours.ts`), `mvtEncode.ts`, `pmtilesWriter.ts` |
| Client decode | `components/map/engine/city3d/osmTiles.ts` |
| Client mesh | `osmMesher.ts`, `roofs.ts`, `facades.ts` |
| Client shader | `osmShaders.ts` |
| Engine/worker seam | `protocol.ts` (`format`), `meshWorker.ts` (one branch, packed like the rest), `cityEngine.ts` (`tileFormat`, `maxTiles`), `cityMeshes.ts` + `packing.ts` (the two extra attributes) |
| Flag | The registry's `cityTiles` (`lib/map/mapFeatures.ts`; `EXPO_PUBLIC_MAP_CITY_TILES`; offered in the layers panel only in a development build) over `lib/map/cityTilesFlag.ts` (`?cityTiles=1` in development; requires the city-3D flag) |
| Adapter | `city3dLayer.web.ts` → `citySourceFor` |
| Dev route | `scripts/dev-city-tiles.js`, wired in `metro.config.js`, only with `GOWAY_CITY_TILES_ARCHIVE` set |
| Tests | `scripts/__tests__/cityTags.test.ts`, `scripts/__tests__/cityTiles.test.ts` (a synthetic PBF through the whole compiler; MVT against the client decoder; PMTiles against `worker/pmtiles.js`), `components/map/__tests__/city3dRoofs.test.ts`, `city3dOsmMesher.test.ts`, `city3dCitySource.test.ts`, `lib/map/__tests__/cityTilesFlag.test.ts` |

### Format: MVT with a GoWay schema, in PMTiles

The reference projects each invented a binary tile; GoWay did not need to.
Each city tile is a **Mapbox Vector Tile v2** with one `building` layer and
GoWay's own properties, in a **PMTiles v3** archive — the container the
basemap already lives in, read by the same `worker/pmtiles.js`.

- **Native can use it unchanged.** Phase 5(a) wants a per-building,
  non-unioned vector source for MapLibre Native's `fill-extrusion`; this is
  one. `render_height`/`render_min_height` keep OpenMapTiles' names and
  meaning, so `building-3d`'s expressions apply as they are, and `colour` is a
  CSS string.
- **The worker already reads it.** `pbf` + `@mapbox/vector-tile` decode both
  sources; the second mode adds no dependency.
- **What a custom binary would have bought is pre-meshed geometry**, which is
  a different trade (a dense tile is 21 MB of buffers against 192 kB of gzip)
  and is deliberately not made here.

Properties are recorded facts, normalised, plus the two resolved heights:
`height`, `levels` (`building:levels`, only where tagged), `min_level`,
`roof_shape` (13 Simple 3D Buildings shapes), `roof_height` +
`roof_height_source` (`tag`/`levels`/`angle`/`default`), `roof_direction`,
`roof_orientation`, `colour`, `roof_colour`, `material`, `roof_material`,
`part`, and `height_source` (`osm` where `height` or `building:levels` is
tagged; absent where the 5 m default stands — see Honesty, "Heights"). The feature id is Planetiler's `osmId × 10 + 2|3`, so a city building
joins to OSM exactly as a basemap label does. Junk is dropped, not coerced
(`height=yes`, `~12`, `12;15`, `building:levels=2.5`, `roof:shape=pitched` is
read as gabled, `light_grey` as `#d3d3d3`) — 571 unreadable values refused across
Catalonia, every one counted by key in the receipt.

**Addressing: one zoom, whole buildings.** Tiles exist at **z15** only (the
client over-zooms them, as it does the basemap's z14). Each building goes
WHOLE and UNCLIPPED to the tile holding its representative point, so a roof's
ridge is computed on the whole footprint and there are no fake walls along
clip lines. An outline with `building:part`s is replaced by its parts (Simple
3D Buildings). Why z15, measured on Barcelona (same build, three zooms):

| Zoom | Tiles | Archive | Densest tile (raw / gzip) | Buildings in it |
| --- | ---: | ---: | ---: | ---: |
| z14 | 78 | 5.60 MB | 919 kB / 460 kB | 21,043 |
| **z15** | **280** | **6.16 MB** | **356 kB / 192 kB** | **7,969** |
| z16 | 922 | 6.87 MB | 116 kB / 67 kB | 2,578 |

(z14 and z16 were measured before the representative-point fix below, which
moved a few hundred buildings between tiles; the z15 row is after it.)
z14's densest tile meshes to ~60 MB of buffers in one worker job; z16 quadruples
the request count for the same ground. z15 answers the open question below.

### Compile: measured

On the build machine (one core of 32, other jobs running), Bun 1.4.2:

| Input | Output | Time | Archive | Features |
| --- | --- | ---: | ---: | ---: |
| Catalonia extract (271 MB, 2026-10-08) | Barcelona bbox | 11.9 s | 6.16 MB, 280 tiles | 245,868 (186,751 parts) |
| same | all of Catalonia | 15.3 s | 31.6 MB, 24,181 tiles | 1,267,017 |
| New York State extract (497 MB, 2026-10-09) | Manhattan bbox | 35.3 s | 3.42 MB, 166 tiles | 122,942 |

Times are the quietest runs; reruns under a load average of 30–50 took up to
1.7× as long. A building's tile is the one holding its area centroid (relative
to its first vertex: computed on raw mercator coordinates the shoelace sums
cancel at building scale, and the first version silently fell back to a
boundary point for every building). Where the time goes (Catalonia): ways+relations 3.3 s, member ways 1.7 s,
nodes 3.7 s, geometry 1.2 s, tags+tiling 2.2 s, encode+gzip 3.0 s. Each archive
is written with a receipt (`*.pmtiles.receipt.json`: extract, replication
timestamp, timings, coverage, rejected values) and verified by reopening it
with the Worker's reader and decoding tiles with the client's decoder.

**Planet, extrapolated (not run).** Throughput is 11–18 MB of PBF per second
single-threaded, so the 94.9 GB planet is **~1.5–2.5 h of compute**; size runs
25–28 bytes per building gzipped, so ~716 M buildings and parts make **~18–20 GB**
— a quarter of the 84 GB basemap. The limit is memory, not time: the compiler
keeps the positions of the nodes buildings use (5.3 per building in
Catalonia, 24 B each), ~90 GB for the planet. So the planet build is
**sharded by Geofabrik extract** (continents/countries, run in parallel), and
the shards merged per tile, de-duplicating by feature id (extracts overlap at
their borders; the id is the OSM element). Measure one continent first.

### Tag coverage, measured

Share of compiled features (outlines + parts) carrying each key, after parsing:

| | Barcelona | Catalonia | Manhattan | World (taginfo) |
| --- | ---: | ---: | ---: | ---: |
| `height` | 0.33% | 0.64% | **97.7%** | ≤ 3.9% |
| `building:levels` | **75.5%** | 56.6% | 7.8% | ~6.1% |
| `roof:shape` (non-flat) | 0.50% (0.26%) | 0.59% (0.46%) | 10.8% (0.98%) | ~1.4% |
| `building:colour` | 0.14% | 0.19% | 10.4% | ~0.2% |
| `roof:colour` | 0.19% | 0.32% | 4.3% | — |
| `building:material` | 0.11% | 0.10% | 5.9% | — |
| `roof:material` | 0.15% | 0.29% | 9.5% | — |

The two cities are opposites, and both are imports: Barcelona's 186,751
`building:part`s with floor counts are the Spanish Catastro's, Manhattan's
heights are NYC's building footprints. So Barcelona gets window rows on three
quarters of its features and Manhattan on few; Manhattan gets true heights and
Barcelona levels × 3.66 m. Roof shapes are rare in both (639 shaped roofs in
Barcelona, cathedral and Sagrada Família included). The honest renderer shows
exactly that difference.

### Client: what the second mode draws

- **Real per-building separation.** No union: every Eixample block is its
  dozen buildings again, at their own heights.
- **Roofs** (`roofs.ts`): every straight-sloped shape — skillion, gabled,
  saltbox, hipped, half-hipped, pyramidal, gambrel, mansard, and `round` (a
  barrel) — is the **lowest of a few planes** over the footprint's
  minimum-area rectangle, so one mesher builds them all: walls rise to the
  roof along every edge (gable ends for free), and each plane's patch is the
  footprint clipped by half-planes. `dome`, `onion` and `cone` are surfaces of
  revolution on star-shaped footprints, else a pyramid. Limit: one ridge per
  footprint — an L-shaped house gets a ridge across its bounding rectangle,
  not two meeting at a valley; that needs a straight skeleton.
- **Colours and materials**, tempered into the palette (see Honesty).
- **Storey rhythm** only where `building:levels` is recorded, never on party
  walls (see Honesty). It fades out where a storey is a few pixels tall.
- The flat-roof bevel and the baked occlusion are the prototype's, reused.

Per tile, measured in Bun on the densest Barcelona tile (7,934 buildings, as compiled before the centroid fix):
decode 7–20 ms, mesh 120–300 ms depending on load, 600,536 vertices, 334,748
triangles, 21.4 MB of buffers (29 B a vertex with the colour and rhythm
attributes). In headless Chromium (SwiftShader) worker jobs took 40–250 ms,
against 160–470 ms for the OpenMapTiles z14 tiles over the same views; the
Eixample view drew 1.44 M triangles from 9 city tiles (91 MB) against 2.34 M
from 4 OpenMapTiles tiles (100 MB). The layer draws up to 16 z15 tiles
(`CITY_TILES_MAX`): with §4's selection, every one the camera sees, nearest
first, all at full detail (the city tiles have no far level yet), in the
compact vertex format with the colour and rhythm lanes carried alongside
(`packing.ts`: 29 → 24 B a vertex with them, and 16-bit indices), and over budget the
farthest are dropped.

Verified in headless Chromium on `expo start --web` with both archives served
by the dev route: Eixample, Sagrada Família, Barri Gòtic (gabled tile roofs
on the cathedral and the Ajuntament, a dome), Lower Manhattan (setbacks,
tagged colours), light and dark, each beside the OpenMapTiles path at the same
camera. The only console errors are the two pre-existing ones (no Oxy client
id, a react-native-web `accessible` attribute).

### Running it locally

```bash
# 1. Any Geofabrik extract containing the city (never committed; ~/osm-data
#    is where the basemap build keeps them).
curl -fLo ~/osm-data/cataluna.osm.pbf \
  https://download.geofabrik.de/europe/spain/cataluna-latest.osm.pbf
# 2. Compile: writes packages/frontend/.tiles/city-barcelona-z15.pmtiles (+ receipt).
bun run --cwd packages/frontend map:city-tiles --pbf=$HOME/osm-data/cataluna.osm.pbf --area=barcelona
# 3. Serve it from the dev server and open the map with both flags.
GOWAY_CITY_TILES_ARCHIVE=$PWD/packages/frontend/.tiles/city-barcelona-z15.pmtiles \
  bun run --cwd packages/frontend web
# → http://localhost:8081/?city3d=1&cityTiles=1&lat=41.3925&lng=2.164&zoom=17&pitch=60
```

`--area=manhattan` with the New York extract builds the second city;
`GOWAY_CITY_TILES_ARCHIVE` takes a comma-separated list. `--bbox=w,s,e,n`
compiles any area; no `--area`/`--bbox` compiles the whole extract.
`--verify --archive=<path>` re-checks a finished archive.

### Hosting: what production needs

Nothing here is deployed. To serve the tiles on goway.to, mirroring the
basemap exactly:

1. **Build on the tiles machine** from the same planet snapshot as the
   basemap (same date stamp, so 2D and 3D agree), sharded as above; verify
   every shard archive; merge.
2. **Upload to R2** under a versioned key (`city/<date>.pmtiles`) with
   `aws s3 cp` against the R2 endpoint, as `build-map-tiles.ts --upload` does —
   never overwrite a live key (PMTiles is addressed by byte offset).
3. **Worker route**: `/map/city/{z}/{x}/{y}.pbf` (`CITY_TILE_PATH`) in
   `worker/index.js`, reading `MAP_CITY_ARCHIVE` through the same
   `PMTiles` class, same edge caching keyed on the archive key, same public
   headers; add `/map/city/*` to `run_worker_first` in `wrangler.toml` — until
   then the SPA fallback answers the path with `index.html` (200), which the
   worker treats as a failed tile.
4. **Coverage**: `/map/city/coverage.json` (`CITY_COVERAGE_PATH`) answered
   from each archive's `goway:coverage` metadata, as the dev route does — the
   client draws city tiles only inside it and the basemap's buildings
   elsewhere; without it, the city layer falls back to the basemap everywhere.
5. **ODbL**: publish the archive's URL and its receipt (see Obligations)
   before the flag is turned on for anyone.
6. **Flip** `EXPO_PUBLIC_MAP_CITY_TILES` only together with
   `EXPO_PUBLIC_MAP_CITY3D`, after Phase 1's device gating.

Cost: ~20 GB in R2 is about $0.30 a month; egress is free; the build machine
is the real cost, as for the basemap.

### What the flag costs when off

Measured with `expo export --platform web`, no flags set, `origin/main`
against this branch (separate Metro caches, `--clear`):

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,953,223 B | 6,953,223 B | identical once chunk hashes are normalised |
| `__common` (first paint) | 78,516 B | 78,516 B | identical once module ids are normalised |
| `city3dLayer` (lazy) | 6,776 B (2,965 gz) | 9,699 B (3,895 gz) | flag + source choice; never requested with city-3D off |
| `lazyChunk` (lazy, three.js) | 3,498,341 B | 3,502,751 B (+1,092 gz) | the OSM shader strings |
| `meshWorker` (sealed worker) | 40,934 B (14,410 gz) | 58,306 B (20,473 gz) | decoder, OSM mesher, roofs |

Nothing new reached first paint: the env read lived in `cityTilesFlag.ts`,
imported only by the lazy adapter, which is why it was not in `lib/config.ts`.
(It now lives in the map-feature registry, which is on first paint by design;
see `MAP_FEATURES.md`.)
`components/__tests__/engine3dChunk.test.ts` stays green (`osmShaders.ts` is
imported only by the engine; the adapter imports `lib/map/cityTiles*` and the
engine folder type-only).

### Next steps

- **Coverage gaps**: tiles outside a compiled archive are empty (204), so with
  the flag on and a city-only archive the rest of the world has no 3D
  buildings. A planet archive removes this; until then a per-tile fallback to
  the OpenMapTiles mesh would.
- **Party walls across tile borders** keep their rhythm (the neighbour is in
  another tile's mesh); the compiler could mark shared edges instead, which is
  also where neighbour occlusion belongs.
- **Far levels for the city tiles.** §4 draws every visible city tile, but at
  full detail only, so a steep view runs into the 16-tile cap and the budget
  sooner than the OpenMapTiles path does. A z13 prism-only level from the same
  compiler (or `lodMesher.ts` over the decoded footprints) is the natural far
  field.
- **Straight skeleton** for gabled/hipped roofs on non-rectangular footprints.
- **Pre-meshing and neighbour AO** in the compiler, if client meshing ever
  shows up on mid-range devices.
- **Planet**: shard, measure one continent, then the planet.
- **Roads**: the same extract also compiles a road archive on the same z15 grid
  (`scripts/build-city-roads.ts`, kept OUT of the building tiles: +72% gzip
  measured) for the city-life simulation — see
  [`MAP_CITY_LIFE.md`](./MAP_CITY_LIFE.md).

## Phase 3: sky, atmosphere, shadows and time of day

**Off by default; web only; on top of the city layer.** `EXPO_PUBLIC_MAP_CITY_SKY=1`
(a build decision; no deployment sets it) or `?citysky=1` in a development build,
and only together with the city layer (`?city3d=1&citysky=1`):
`lib/map/citySkyFlag.ts`. Without the city layer the answer is `false`, not
half a feature.

### The look it is tuned to

The art direction is **Apple Maps' detailed city, not a photograph**: a matte,
pastel maquette by day (warm white and grey buildings, soft greens, light blue
water, very soft shadows, no haze greying anything out) and, by night, a deep
blue-violet sky over a dim blue-grey city. The physics below supplies the
*shape* of the light — where the sun is, how long a shadow is, how the sky
reddens at sunset — and a handful of named constants bend it toward that look:
eye adaptation (`BRIGHTNESS_CURVE`), partial white balance
(`CHROMATIC_ADAPTATION`), light that bounces round streets (`ENV_BOUNCE`),
shadows that never go black (`SHADOW_OPACITY`), the real air for haze
(`AERIAL_DISTANCE_SCALE = 1`) and a stylised night sky. Each is commented
where it is defined (`engine/city3d/atmosphere.ts`) with what it does and why.

### Night: the seam, the palette, the lights

The owner's call for night is "full Apple style": lit windows and floodlit
landmarks are allowed as **styling** (see the [honesty rule](#obligations) for
exactly what that permits). This branch provides the input and the
floodlights; the window glow belongs to the city art direction
(`feat/city-art`) and landmark emissives to the landmarks work
(`feat/landmarks`), which read the same input.

**`nightFactor`** (`lib/map/landmarks/night.ts`, shared with the landmarks
work — one function, not two) — 0 by day, 1 at night — is the one number
every night look reads, so the whole city lights up together:

- with a time of day (the sky on): 0 above −1°, 1 below −9°, smooth between —
  the same window over which the sky turns to the stylised night;
- the dark appearance is a night-styled map: always 1.

The adapter is the one place it is set (`city3dLayer.web.ts` →
`engine.setNightFactor`): from the appearance, or — the sky on — from the
sun over the map centre each frame (`updateSun`), when an outside
`setNightFactor` is ignored. Read it as the `uNightFactor` uniform every city
material gets (one shared `{ value }` object, `cityEngine.ts` → `light`), or
as `CityEngine.nightFactor` — that same live object, to hand to a material
built elsewhere. Per-building inputs for night looks travel in one
per-vertex byte, `OsmTileMesh.flags` (`osmMesher.ts`) → `PackedChunk.flags`
(`packing.ts`) → the `flags` attribute; bit 0 is `VERTEX_FLAG_FLOODLIT`, and
a new bit is a new constant, never a new meaning for an old one.

**City life and other overlays** (`overlay.ts`) get the sky two ways: through
`setLight`, the sun's direction and the light on an up-facing surface, as the
trees get it — so the simulated traffic darkens and cools at night with no
change of its own — and, optionally, through `setSky`: the live uniforms
(sun, sky, bounce, shadow map and matrix, night factor, camera, ground) and
the GLSL that reads them (`SKY_OVERLAY_GLSL`: `sunVisibility`,
`hazeTransmittance`, `skyColor`), for an overlay that wants the sun's shadows
and the haze on its own objects. Only the buildings cast into the shadow map
(`SHADOW_CASTER_LAYER`); the instanced trees and the overlays do not.

**The palette** (`atmosphere.ts`): a deep blue-violet sky (`#141658` overhead to
`#27308c` at the horizon), a saturated blue night ambient that puts a cream
roof at about `#4f6185` — the references' slate — and a street bounce that
falls to a tenth at night, so walls sit darker than roofs (the value
contrast that keeps a night city reading as 3D, and that lit elements pop
against). Water and greens go deep blue and dark teal through the same light.
Before/after screenshots are in the PR.

**Floodlights** are drawn on buildings that **record** being lit at night,
compiled into the city tiles as `floodlit=true` (`CITY_PROPS.floodlit`,
`citygen/tags.ts` → `parseLitAtNight`). Which keys, measured on taginfo
(2026-10-11):

| Key | Objects | Read? |
| --- | ---: | --- |
| `floodlit` | 3 (all sports pitches) | yes (`yes`/`1`/`true`) — but alone it would light nothing |
| `building:floodlit` | 0 | no — unused |
| `lit` on a `building` / `building:part` | 32,955 / 391 | **yes**: `yes`, `24/7`, `automatic`, `dusk-dawn`, `limited`, `interval`, or a time range |
| `light_source=floodlight` | 6,888, 99.7% nodes | no — attributing a lamp to the building it faces is a spatial guess, not a tag |

On such a building at night the sky-lit material adds a warm uplight
(`FLOODLIGHT`): brightest at the foot of the walls, fading up the facade, a
little on the roof, scaled by `nightFactor`. The fact is the tag; the light's
colour, fall-off and strength are styling. A warm street-level glow on every
wall's lowest metres (`STREET_GLOW`) is styling of the same kind.

### Why not takram `three-geospatial` (what Procedural Tokyo uses)

Evaluated `@takram/three-atmosphere` 0.19.1 (MIT) and rejected it for this
layer, for reasons that are about the host, not the library:

- **Its aerial perspective is a post-processing effect.** `AerialPerspectiveEffect`
  is a pmndrs `postprocessing` pass that reads the whole frame's colour and
  depth (and normals) from an `EffectComposer`. A MapLibre custom layer draws
  INTO MapLibre's framebuffer mid-frame; there is no composer, and the
  basemap's colour and depth are not ours to read. Using it means rendering
  MapLibre into a texture and compositing — owning the frame, the step §6
  already declined.
- **Weight.** The package is 36.9 MB unpacked; `build/shared.js` imports
  `postprocessing` at module load even for the sky material alone; the
  precomputed Bruneton tables it loads are 8 MB each (scattering, single Mie,
  higher orders) unless generated on the GPU at start-up, which needs float
  render targets.
- **Frames.** It works in ECEF with its own sun and camera conventions; this
  layer's camera is a mercator → clip matrix it has to read back
  (`viewRays.ts`).

What it **does** take from that work: the model (Bruneton/Hillaire Earth
constants — Rayleigh 8 km, Mie 1.2 km with a Cornette–Shanks phase, ozone at
25 km), and the composition `scene · T + inscatter`.

Also rejected: **MapLibre's own `sky`/fog.** In maplibre-gl 6.10 `fog` is
applied only by the terrain shader (`draw_terrain.ts`) — it never reaches a
flat basemap — and `sky` is a two-colour gradient with no sun. (The relief
prototype uses it for the globe at low zoom, where this layer stays out —
below.)

### How it works inside a frame MapLibre owns

| Pass | When | What |
| --- | --- | --- |
| Shadow map | MapLibre's `prerender` (offscreen pass, before its framebuffer is bound) | The visible buildings' depth from the sun, 2048² (`sky.ts`). **Only when stale**: the sun moved (0.1°), the snapped receiver box moved, or the drawn tile set changed |
| `FILL` | `render`, before the buildings | Only where MapLibre drew nothing (blend `src·(1−dst α)`: past its far plane the canvas is transparent): the horizon haze |
| `MULTIPLY` | 〃 | The basemap × ground light (sun × shadow + sky, `^1/2.2`) × haze transmittance; 0 above the horizon |
| `ADD` | 〃 | Haze in-scatter below the horizon; the sky and the sun's disc above it |
| Buildings | 〃 | Same light, the shadow map (12-tap rotated Poisson PCF, 3 texels), same haze |

Blending is the one thing a layer can do to pixels it did not draw, so the
basemap — roads, water, land, the flat footprints — gets the same light, the
same shadows and the same haze as the buildings, while every label, POI and
overlay is drawn by MapLibre *after* the layer and stays exactly as legible as
before. **The frame's order matters** (`frameSelection.ts`, review of #125): the
tile selection — wanted tiles, terrain lifts — is made in the frame's FIRST
pass, the offscreen one, so the shadow map is of this frame's buildings and
not the last; the offscreen pass runs at every zoom the sky draws, buildings
or not, because it is where the shadow target is first allocated and a
program whose shadow sampler has none fails to draw; and the shadow map's key
includes each drawn tile's terrain-lift revision. The camera and each pixel's view ray come from the projection matrix
(`viewRays.ts`, float64: camera = `P⁻¹·(0,0,1,0)`, far-plane corners
interpolated by the GPU), and a pixel below the horizon is the flat ground plane
at that ray's hit.

- **Sky** (`atmosphere.ts`): single scattering with a transmittance table and a
  sky-tinted multiple-scattering term, ray-marched on the CPU into a 48 × 32
  table per sun **altitude** (azimuth is a rotation the shader applies). Cached
  per 0.2°, so panning computes nothing and a scrub computes each altitude once.
  Hue-preserving tone map (per-channel ACES turned a hazy horizon grey-green).
  Below −1° a stylised blue-violet night takes over by −9°.
- **Haze**: the closed-form transmittance of an exponential atmosphere along
  the view ray (`hazeTransmittance`, tested against a numeric integral) and the
  sky's horizon colour in that direction, so the ground meets the sky without a
  seam.
- **Light**: sun irradiance through the atmosphere, sky irradiance integrated
  from the table, light bounced round the street, an adaptation curve for
  brightness and partial white balance for colour. A multiplier on the map's
  own colours, `1` at reference daylight, with a pure 2.2 gamma so "multiply
  the basemap's sRGB pixel" and "light the building's linear albedo" agree.
  Both tile formats (OpenMapTiles and GoWay city tiles, whose colour function
  is shared: `OSM_BASE_GLSL`) and terrain grounding are supported.
- **Shadows** (`shadows.ts`): one orthographic map over a square receiver box
  round the map centre — radius from the view, rounded up in √2 steps; centre
  snapped to an eighth of it; box turned to face the sun so a low sun gets *more*
  resolution; window snapped to whole texels in absolute light space so a
  moved box does not shimmer. ~0.6–1.6 m texels at street zooms. The REAL sun
  (`lib/map/sun.ts` over the map centre), not `building-3d`'s shaped light:
  a shadow's length is a fact.
- **MapLibre's own sky** follows this one while it is attached
  (`hostSkyColours` → `map.setSky`, the previous sky restored on detach).
  MapLibre draws its `sky` behind everything and blends its `fog-color` into
  distant 3D terrain — including a second terrain draw after this layer, for
  the draped layers above it — so another module's colours there showed as
  a pale band over the night. The basemap passes put the ground at the drawn
  terrain's height near the centre (`groundM`), a plane: exact on a city's
  gentle slopes, drifting on a steep one (the buildings' own shadows stay
  exact — they are lifted with the buildings).
- **Zooms**: the effect fades in over z12 → z13. It is a street-scale effect,
  and below z12 the relief prototype's globe may be easing in, under which the
  flat-ground rays are not the drawn surface.
- **Pitch**: the ceiling goes from 60° to 80° while the sky is attached
  (`maxPitchFor` in `lib/map/citySkyFlag.ts`), only where tilting is allowed
  at all, and back on detach. `MapCanvas.web.tsx`'s interaction effect is the
  one place it is set, so an `interaction` change cannot drop a sky-lit map
  back to 60°. At 60° a z16 view never reaches the horizon.

### The time-of-day scrubber

`components/map/TimeOfDayScrubber.web.tsx`, shown only while the layer is
attached, in its own lazy chunk: an hour slider, previous/next day (±183) and
**Now** (the default; a live clock re-reads the sun every 30 s). The device's
clock: a whole day is still every hour of a far city's day, and the caption
says what the sun is doing *there* (`Sun 34° up`, `Golden hour`, `Blue hour`,
`Twilight`, `Night`, from its altitude over the map centre). Strings are in
`lib/messages/citySky.ts` (English, Spanish), kept out of the first-paint
tables. The arithmetic (`lib/map/timeOfDay.ts`) uses `setHours`, so a
daylight-saving day is the platform's problem, not an hour off every label.

### Measured

Headless Chromium on SwiftShader (software GL — a ceiling, not a laptop GPU
number), 1280 × 800, Barcelona z16.5 at 80°, six tiles, 3.19 M triangles:

| | |
| --- | --- |
| Sky table for a new altitude (CPU) | 3–30 ms, typically 5–10; 0 when cached |
| Shadow-map redraws | 6–10 while a view loads (one per arriving tile and radius step), then **0** for a still map or a pan under 1/8 of the radius |
| One shadow redraw | 250–900 ms in SwiftShader for 3.2 M triangles: one extra depth-only pass of the visible buildings. On a GPU, a fraction of the main pass |
| Per frame | three full-screen passes (1, 12 and 2 texture reads a pixel) and 12 shadow taps per building fragment |
| GPU memory | 16 MB depth + 4 MB R8 for the shadow target, 6 KB sky table |

Not yet measured: frame time on a real laptop and a mid-range Android GPU
(the PCF tap count and the shadow-map size are the knobs), and the
`expo export` budget on such a device.

### What the flag costs when off

Measured with `expo export --platform web --clear` against the `main` this
branch is based on (1175833: #126, #128, #129, #130, #133 merged), flags off:

| Chunk | Before | After | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,971,234 B | 6,972,644 B (+1,410 B; +343 B gz) | the flag, the gate and one `lazy()` stub |
| `__common` (first paint) | 81,754 B | 81,644 B (−110 B) | nothing of the sky's |
| `lazyChunk` (three.js) | 3,700,047 B | 3,736,219 B (+36,172 B; +12.3 KB gz) | the sky; requested only with the city layer on |
| `city3dLayer` | 18,274 B | 19,334 B | only with the city layer on |
| `TimeOfDayScrubber` | — | 7,808 B (3.4 KB gz) | only with the sky on |

The first export had `__common` at **90,174 B**: the scrubber used Bloom's
`Slider`, which another lazy route already imports, so a second lazy importer
hoisted it to first paint (the trap in
`~/Oxy/docs/build-and-runtime-traps.md`). The scrubber now uses the platform's
`<input type="range">` (it is a web-only file), and the export above is the
result.

### Limits

- **Terrain** (on by default since #128): the basemap's shadows and haze sit
  on a plane at the centre's ground height, so on a steep slope they drift;
  the buildings' shadows and haze follow the terrain exactly.
- **Globe**: none below z12 (see Zooms).
- **One shadow box**: buildings past ~1.4 km from the centre (high pitch) have
  no shadow; the shadows fade out at the box's rim.
- **Native**: none — the same custom-layer limit as the rest of this note.
- **Floodlights** only on the GoWay city tiles (the OpenMapTiles meshes carry
  no tags), only with the sky on, and only where `lit`/`floodlit` is tagged —
  which is rare (above). Curated landmarks are the landmarks work's.

## Phased plan

Estimates are engineering time for one person familiar with the codebase, and
are estimates; the runtime numbers are measured unless marked.

| Phase | What | Cost |
| --- | --- | --- |
| **0. Prototype** (this change) | Custom layer, worker mesher over existing tiles, bevels, baked AO, lit by the same sun light as `building-3d`; off by default | Done. Users: +1.1 KB entry, nothing else with the flag off |
| **1. Ship A on web** | ~~Far-field LOD, per-tile fade-in, worker pool~~ (done: §4 "LOD and loading", with budgets; trees: §8), WebGL context-loss handling, device gating via `deviceProfile`-style checks (GPU memory: Barcelona's visible set is ~60 MB), MapLibre sky/fog matched in-shader, tap-through to the basemap preserved, a perf budget on mid-range Android Chrome | ~2–3 weeks. No infra. Opt-in users download the ~1.1 MB gz lazy chunk |
| **2. GoWay 3D tiles (B)** | Compiler beside the Planetiler build: per-building footprints and parts, OSM levels/roof shapes where tagged; client second source mode with roofs, tempered colours and recorded storeys; archive in R2 behind the Worker; the same tiles as native's per-building extrusion source | **Compiler + client built, off by default** ([Phase 2](#phase-2-goway-city-tiles)): Barcelona 11.9 s / 6.2 MB, Catalonia 15.3 s / 31.5 MB. Remaining: sharded planet build (~2 h compute, ~18–20 GB extrapolated), R2 + Worker route, ODbL publication, far levels for the city tiles (they draw every visible tile at full detail today, §4); pre-meshing and neighbour AO only if measured necessary |
| **3. Atmosphere** | Sky, haze over basemap and buildings, sun shadows, time-of-day scrubber | **Built, off by default** ([Phase 3](#phase-3-sky-atmosphere-shadows-and-time-of-day)). Remaining: real-GPU frame budget, device gating, terrain-aware ground passes |
| **4. Municipal data** | One dataset at a time (PLUTO, PLATEAU, 3DBAG, Catastro…): licence review, adapter in the compiler, credit while drawn, LOD2 roofs where present | ~1 week each + legal review |
| **5. Native** | (a) Extrude B's per-building layer in the existing native style — days. (b) A native custom layer — months, decided by benchmarks | (a) days, (b) months |

Procedural facades are deliberately not a phase. Phase 2 draws the one kind
the honesty rule allows — a storey rhythm where `building:levels` is recorded
— and it turned out to be common where an import put it there (75.5% of
Barcelona's features, from the Catastro). Anything richer waits for Phase 4.

## Open questions

- Where should the shared three.js runtime chunk live once a third consumer
  (SDK models) arrives — and should Spark move out of it?
- ~~Does Phase 2 compile at z14 or at z15/16?~~ z15, measured (Phase 2 →
  Addressing).
- Is the B archive versioned with the basemap's planet build (same date stamp)
  or independently? Same-date keeps 2D and 3D in agreement.
- Picking: should tapping a 3D building select it (it is not a Place), or pass
  through to the basemap as today?

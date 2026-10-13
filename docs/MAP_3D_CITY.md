# City 3D: buildings beyond `fill-extrusion`

What GoWay's 3D buildings should become, how to get there, and what it costs.
Includes a working **web-only renderer, on by default since 2026-10-12**
([`MAP_FEATURES.md`](./MAP_FEATURES.md) → Defaults), that proves the
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
  one frame. The street detail's tiles (and its glyph atlas) take what the
  city's arrivals leave of the same budget (`overlay.ts` →
  `FrameUploadBudget`), and wait a frame otherwise. Least-recently-used meshes are evicted past the cache budgets,
  never one that is wanted or still fading. Empty tiles are cached as empty;
  failed tiles retry with backoff (1, 2, 4, 8 s, then a 5-minute cooldown) even
  while the view stands still — `building-3d` is hidden, so nothing else would
  draw them; a view straddling the antimeridian loads both sides
  (`tileScheduler.ts`, `lod.ts`, tested without WebGL).
- **Compact vertices.** Every level is uploaded in the format §2 proposes for
  GoWay's own tiles (`packing.ts`): `uint16` positions in tile units with height
  in 1/32 m and the shade word in the fourth lane (8 B), `int8` normals (4 B),
  one draw per tile, with `uint16` indices up to 65,536 vertices and `uint32`
  past them ([`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md) → Phase 2, step 3;
  originally chunks of ≤ 65,535 vertices). The model matrix undoes the
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
  buildings look, never *when* they appear. The fade is the same screen door
  as a level's (`tsl/common.ts` → `dithered`): at z16 half the screen's
  pixels draw the city and half the map. Each pixel is the front surface of
  the city or the map, never a blend. The buildings stay opaque and keep
  their depth, so no wall or street shows through another surface. Blended
  at the fade's alpha (as until main @52dde03), 37% of the city's pixels at
  z16 mixed in a surface behind the front one: walls and streets through the
  blocks (Madrid, owner report). Checked by the visibility gate's mid-fade
  view (`check-city3d-visible`, nosky leg).

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
| Building vertices drawn per frame | 8 M | the quality profile's `city.drawVertices` | Barcelona at 80°: ≤ 7.3 M (19 tiles) |
| GPU bytes drawn per frame | 128 MiB | `city.drawBytes` | Barcelona at 80°: 107 MiB; at 60°: 69 MiB (was 130) |
| GPU bytes cached (drawn + slack + fallbacks) | 192 MiB, 160 entries | `city.cacheBytes`, `MAX_CACHED_TILES` | LRU, wanted and fading entries spared |
| Tiles drawn | ≤ 48, ≤ 6 at full detail | `city.maxTiles`, `city.maxFullTiles` (`LOD_POLICY` holds the rest) | |
| Upload per frame | 12 MiB (1 mesh after a > 50 ms frame), shared with the street detail | `city.uploadBytesPerFrame` | |
| Requests in flight | 2 per worker, ≤ 3 workers | `MAX_IN_FLIGHT_PER_WORKER`, `city.maxWorkers` | |
| Worker time per tile | level 0 ≤ 200 ms, levels 1–2 ≤ 60 ms, trees ≤ 50 ms (Bun, dense tiles) | — | table above |
| Trees | ≤ 24,000 per tile, ≤ 40,000 drawn per frame (nearest tiles first); ≤ 98 triangles near, ≤ 30 far (far past the full-detail distance, even on a level-0 tile); shorter than `treeMinHeightM(zoom)` not drawn | `TREES.maxPerTile`, `city.treeBudget`, `treeGeometry.ts`, `tsl/treeMaterial.ts` | Central Park: 18,233 trees, 1.28 M triangles; Barcelona at 80°: 20,523 |
| Main-thread time in `render()` | ≤ 2 ms steady (selection, scheduling, three's draw calls) | `frameCpuMs` dev stat | 1.0–1.3 ms steady in Barcelona at 60° and 80°; frames that upload new meshes cost more, which is what the upload budget bounds |

**These are the HIGH preset's numbers** ([`MAP_PERFORMANCE.md`](./MAP_PERFORMANCE.md)). Every budget in this table is the
map's quality profile's (`lib/map/quality/profile.ts`, read through
`engine/quality.ts`); the medium (integrated laptop) and low (phone) presets
draw less, and `docs/MAP_PERFORMANCE.md` has all three, the device budgets
they come from, and the CI gate that holds them.

When the drawn set would exceed the draw budget, `fitBudget` coarsens it from
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

Superseded by [`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md). The native apps get
this engine itself, not a second one. It moves to three.js's
`WebGPURenderer` with TSL materials, and native draws it through
`react-native-webgpu` (Dawn on Metal or Vulkan). MapLibre Native can host
neither three.js on iOS (Metal only) nor terrain or globe on any platform.
The phase 1 prototype draws one city tile from one shared module on WebGL2,
browser WebGPU and Android Dawn, measured there.

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
  `diameter_crown`; the trunk's `circumference`; and `street` when the tree is
  recorded as a street or avenue tree — a node of a `natural=tree_row`, or
  `denotation=avenue|urban`). Barcelona's archive grew 6.16 → 6.99 MB with them.
  Measured on the extracts of 2026-10-11 (`natural=tree` nodes; Barcelona's box,
  Madrid's extract, New York City's box): `denotation=avenue|urban` 6.5% / 3.1% /
  5.8%; `circumference` 0.02% / 0.15% / 0.01%; a node of a `tree_row` 0.03% /
  0.05% / 0.01%; `height` 0.04% / 5.1% / 1.8%. Barcelona's street trees mostly
  record nothing but `natural=tree` — which is why the client reads a tree's
  setting from what surrounds it (below), and the compiler's `street` and
  `circumference` only add to it once an archive is rebuilt.

**What is drawn.** By default, only trees the data records (owner decision
after review: "trees on top of buildings, trees at random everywhere" — no
tree where none is mapped).

1. **Mapped trees** (GoWay city tiles, `?cityTiles=1`): every `natural=tree`
   point, at its position, with its crown form when recorded (else broadleaf),
   its height and crown diameter when recorded (a crown estimated from a
   recorded `circumference` otherwise: 1.5 m + 0.2 m per cm of trunk, 2–20 m),
   else its setting's typical size (item 2), turned and varied by a seed from
   its OSM id, so it is the same tree every visit. With the default
   OpenMapTiles source there are no tree points, so no trees are drawn.
2. **Street trees and park trees** (owner report on Carrer de Mallorca: "the
   trees in the middle of the city cover the whole street; in mountains,
   woods and parks it's fine"; `treeContext.ts`). The worker reads what
   surrounds each mapped tree — the road archive's tile at the same address
   (carriageways as wide as the street detail draws them, `cityStreets/lanes.ts`
   → `crossSection`; mapped sidewalks) and the basemap tile under it (parks,
   gardens and woods; urban landuse). A tree is a **street tree** when it stands
   within 3 m of a kerb (a park's edge included: its crown is over the street),
   or, outside a park or wood, when it is recorded as one (`street`), stands
   within 8 m of a kerb or 4 m of a mapped sidewalk, or stands in urban landuse
   (residential, commercial, retail, industrial). A street tree is drawn as
   Apple's Detailed City street tree — a modest lollipop on a clear trunk
   (`trees.ts` → `STREET_TREE`): 8.5–11.5 m unless recorded, its crown starting
   at 45% of its height (2.5–6 m: 3.8–5.2 m by default, above a bus), its crown
   about as wide as it is tall and at most 6.5 m unless recorded, its trunk
   slimmer. Every other tree — park, garden, wood, countryside — and every
   palm keeps the proportions it had (`MAPPED_TREE_HEIGHT_M`, the unit tree
   scaled by its height). The shader stretches the one unit tree to each
   tree's form (`treeGeometry.ts` → `CROWN_FRAMES`, `tsl/treeMaterial.ts`): two
   more 16-bit numbers per tree, the crown base and diameter.
3. **Never on a carriageway** (`treeContext.ts`). A mapped point inside a
   drawn carriageway by at most 1.5 m is a kerb tree a little off (OSM
   positions and centrelines are each good to a metre or two, and an
   unrecorded road width is the class default): it is moved square to the
   kerb and 0.75 m past it. Deeper in the road (a mis-mapped point, or a
   planted median the road's one centreline runs through), or moved into a
   crossing street, it is not drawn. Both are counted (`treeSettings` in the
   engine's development stats: street, nature, nudged, offCarriageway).
   Shared surfaces (`living_street`, `pedestrian`), tunnels and bridges have
   no carriageway at ground level. Measured on Barcelona's Eixample tiles
   (z15 16581–16583/12235–12237, 6,445 mapped trees): 0.6–1.7% nudged, at most
   0.2% left out (five on one tile: a row deep in Avinguda Diagonal's
   carriageway), 49–72% street trees per tile — the rest Plaça de Gaudí,
   Glòries and the blocks' inner gardens. Cost: one more fetch per city tile
   (its road tile, normally already cached by the street detail) and the
   basemap tile the fill already read, both asked for beside the tile itself
   (`meshService.ts`) so their round trips overlap its own; 17 ms of worker time, warm, on the
   densest of them (3,032 trees: road tile 5 ms, areas 2 ms, settling 8 ms),
   inside the trees' 50 ms.
4. **No tree in a building** (`workerTrees.ts`): every tree — mapped or fill —
   whose point falls inside a footprint of its tile's own buildings is dropped
   (a courtyard is a hole, so a courtyard tree stays). Buildings of a
   neighbouring tile spilling over the edge are not consulted.
5. **On the same ground as the buildings**: on 3D terrain the trees read the
   grid the buildings stand on — the terrain as drawn (`MAP_TERRAIN_GLOBE.md`
   → "The ground is the drawn terrain", which also records why #126's
   de-noising of it was removed: in these cities the terrain is bare earth).
6. **The styling fill — off unless asked for** (the `city3dTreeFill` map
   feature in Labs, or `?city3dTreeFill=1` in development; `trees.ts`): the 3D equivalent of the tree pattern a paper map prints over
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
7. **Shapes** (`treeGeometry.ts`): three broadleaf canopy variants (an icosphere
   pushed out by five soft lobes, not a sphere; 98 triangles with trunk and
   shadow), a two-tier cone conifer (34), a palm of seven drooping V-section
   fronds (74); far tiles (level 1) draw a 20-triangle canopy, a 6-triangle cone
   and a 30-triangle palm, no shadow; level 2 draws no trees. The trunk leans a
   little (palms more), the canopy rides it.
8. **Zoomed out, the tallest first**: trees shorter than `treeMinHeightM(zoom)`
   — 10 m at zoom 15.5, 0 from zoom 18 — shrink away over 3 m rather than pop
   (`tsl/treeMaterial.ts`), which is also what keeps a whole-city view affordable.
9. **Colour** (`components/map/city3dTrees.ts`): canopies are the palette's PARK
   colour desaturated to a matte sage, a step darker than the ground on the
   light map and lighter on the dark one; conifers cooler and deeper; palms a
   touch warmer; trunks are the palette's BUILDING clay, darker. A few tint
   variants per seed. Lit by MapLibre's extrusion formula under the map's light,
   with a soft occlusion (underside darker, crown lighter).
10. **GPU instancing**: one shared unit tree per shape, six 16-bit numbers per
   tree (position, seed, kind + height; crown base and crown diameter); the
   vertex shader turns, sizes, stretches, leans and places each one, so thousands of trees cost the CPU nothing per frame.
   Instances are sorted by shape in the worker, so a tile is at most five
   instanced draws.

**Honesty.** A mapped tree is drawn where OSM records it and as what OSM
records; its unrecorded size, its setting's proportions and its turn are
styling. A kerb tree moved off the carriageway moves by at most 2.25 m, square
to the kerb; one deeper in the road is not drawn rather than drawn somewhere
OSM does not put it. No tree is added in a city: the fill stands only in
mapped woods. A fill tree — only when
the fill is switched on — stands for no tree: none stands outside a mapped
wood, within 9 m of a mapped tree, or on anything mapped as something else,
and their number, species mix, size and position are not data. That is the rule above — procedural detail is
styling, never fact — applied to vegetation. The trees can be switched off on
their own: the `city3dTrees` map feature in Labs, or `?city3dTrees=0` in a
development tab.

**Not done, and why: official street-tree inventories** (a proposal for the
owner, nothing imported; checked 2026-10-12). Each would be merged with
`natural=tree` by position in the compiler's `tree` layer, credited in
`MapAttribution` while drawn, and recorded in `MAP_3D_SOURCES.md` like the
building sources — the AGENTS.md rule ("a licence-reviewed official model").

| Inventory | Licence | Per tree | Fit |
| --- | --- | --- | --- |
| Barcelona *Arbrat viari* (Ajuntament de Barcelona, Open Data BCN `arbrat-viari`; *Arbrat zona* and park trees are separate sets) | CC BY 4.0, updated weekly | 145,176 street trees and palms: position (ETRS89 and WGS84), species (scientific, Catalan, Spanish), `categoria_arbrat` (PRIMERA / SEGONA / TERCERA / EXEMPLAR — a size class whose definition the metadata does not give), planting date (22%), address, irrigation. **No height, no girth** | Best fit for Barcelona: species → crown form for every street tree (OSM has 12%); 88 on Carrer de Mallorca by Marina alone. CC BY 4.0 inside an ODbL derivative needs the same review the Catastro got (attribution, and CC BY's no-technical-restrictions term) |
| Paris *Les arbres* (Ville de Paris, opendata.paris.fr `les-arbres`) | **ODbL** — the city tiles' own licence | 220,218 trees: position, genus, species, cultivar, **height (m)**, **circumference (cm)**, development stage, `domanialite` (`Alignement` = street tree, `Jardin`, …), remarkable | Cleanest: same licence, real heights and girths, and street vs park recorded; Paris's city tiles are published (Île-de-France) |
| New York 2015 Street Tree Census (`uvpi-gqnh`) / Forestry Tree Points (`hn5i-inap`, live, NYC Parks) | NYC Open Data Terms of Use (no licence on the dataset; free reuse with the City's disclaimer) | 683,788 street trees (2015): position, species, **trunk diameter (DBH)**, curb location, health, sidewalk damage. The live set: DBH, condition, planted date | Good: DBH → crown via the circumference rule; curb location confirms the street setting. The terms need the owner's reading (no named licence) |
| Madrid *Arbolado en parques y zonas verdes de Madrid (detalle)* (Ayuntamiento de Madrid, datos.madrid.es `300761-0-arbolado-especies`) | CC BY 4.0 | Street (*viario*) and green-area trees counted one by one (palms and forest masses excluded): position (ETRS89 UTM 30N), species code, **perimeter**, **total height** | Good: heights and girths for street trees; same CC BY 4.0 review as Barcelona |

### One engine, one scene

The city engine and the SDK's coordinate-anchored models
([`SDK_MAP_MODELS.md`](./SDK_MAP_MODELS.md)) must be **one** custom layer, one
renderer (since phase 2 of `MAP_NATIVE_3D.md`, three's `WebGPURenderer`), one scene and one camera. Two custom layers each wrapping
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
The reviews, the verdicts (Barcelona's own model is not legally clear; the
Spanish Catastro and New York City's model are) and the merges themselves are
in [`MAP_3D_SOURCES.md`](./MAP_3D_SOURCES.md).

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
- Roof shapes only from `roof:shape` or a licensed official model's measured
  roofs ([`MAP_3D_SOURCES.md`](./MAP_3D_SOURCES.md)); everything else is flat.
  Where the shape is tagged and its height is not, the pitch is a default
  (30°, or `roof:angle`) and the tile says so (`roof_height_source=default`).
- Colour comes from the cartographic palette's height ramp (shared with
  `building-3d` via `buildingHeightRamp`). On the city tiles a tagged
  `building:colour`/`roof:colour` or `*:material` is drawn **tempered** into
  that ramp (`tsl/buildingSurface.ts`): desaturated and pulled most of the way to the
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

  *A fact its own record contradicts is not read.* A recorded height that
  the same record makes impossible is dropped and counted, not adjusted:
  an OSM outline's `height` of 100 m or more that is over 20 m a tagged
  storey AND over 20 times the side of its footprint (`tags.ts` →
  `contradictedHeight`: 14 outlines in every published region, elevations
  typed into `height`), and a cadastral part's storeys above the region's
  ceiling or standing alone as a needle (`MAP_3D_SOURCES.md` → Implausible
  storeys). What remains is the next source down the precedence.

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

**On by default (2026-10-12); web only.** A person switches it off in the
settings modal (Layers); a development tab takes `?city3d=0/1`, which a
production build ignores (`lib/map/mapFeatures.ts`). Its chunk is fetched only
once the camera reaches z14 or tilts 45° (`lib/map/cityEngineGate.ts`).

| Piece | Where |
| --- | --- |
| Flag | The map-feature registry (`lib/map/mapFeatures.ts`, [`MAP_FEATURES.md`](./MAP_FEATURES.md)): `city3d`, `city3dTrees`, `city3dTreeFill`, switchable in the settings modal (the woods fill in Labs), and per development tab with `?city3d=1`, `?city3dTrees=0`, `?city3dTreeFill=1`. The adapter is handed the answers |
| Gate | one effect in `components/map/MapCanvas.web.tsx` |
| MapLibre adapter | `components/map/city3dLayer.web.ts` — adds `goway:city3d` before `building-3d`, hides `building-3d`, restores it on detach; on a style with no `building-3d` (the `openfreemap` escape hatch, a style-URL override) it declines and leaves the style untouched, rather than guessing an anchor in a document GoWay does not own |
| Light | `components/map/city3dLight.ts` — the `building-3d` light (`useSunLight`'s, fed by `MapCanvas.web.tsx`) as the engine's `CityLight` |
| Tree colours | `components/map/city3dTrees.ts` — crown and trunk from the palette's park colour |
| Engine (three.js) | `components/map/engine/city3d/cityEngine.ts` (selection, scheduling, upload budget, fades), `cityMeshes.ts` (a tile's GPU entry: building chunks + instanced trees) |
| Worker | `components/map/engine/city3d/meshWorker.ts` (`new Worker(new URL(…, import.meta.url))`, which Expo bundles as a sealed chunk), run as a pool by `workerPool.ts` |
| Pure parts (tested) | `tileMath.ts`, `mesher.ts`, `occlusion.ts`, `shaders.ts`, `decode.ts`, `tileScheduler.ts`; far field: `lod.ts`, `lodMesher.ts`, `simplify.ts`, `packing.ts`, `transitions.ts`; trees: `trees.ts`, `treeSources.ts`, `treeGeometry.ts`; materials: `tsl/` ([`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md)) |
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
path: +292 B in `entry` with the prototype off. It moved to a module imported
only by the lazy adapter. Since the map-feature registry (`MAP_FEATURES.md`)
the trees are switched live from the settings modal, so they are decided at
first paint after all, by `lib/map/mapFeatures.ts` (which reads no build
variable; `engine3dChunk.test.ts` pins that); the registry's whole first-paint
cost is measured in `MAP_FEATURES.md`.

## Phase 2: GoWay city tiles

**Built, on by default (2026-10-12), web only; drawn wherever `coverage.json`
says a region is published (Catalonia, Madrid, New York State), the basemap's
buildings elsewhere.**
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
| Client material | `tsl/buildingSurface.ts` (the surface), `tsl/buildingMaterial.ts` (map-lit), `tsl/skyBuildingMaterial.ts` (under the city sky) |
| Engine/worker seam | `protocol.ts` (`format`), `meshWorker.ts` (one branch, packed like the rest), `cityEngine.ts` (`tileFormat`, `maxTiles`), `cityMeshes.ts` + `packing.ts` (the two extra attributes) |
| Flag | The registry's `cityTiles` (`lib/map/mapFeatures.ts`; offered in the settings modal only in a development build; `?cityTiles=1` in development; requires `city3d`) |
| Adapter | `city3dLayer.web.ts` → `citySourceFor` |
| Dev route | `scripts/dev-city-tiles.js`, wired in `metro.config.js`, only with `GOWAY_CITY_TILES_ARCHIVE` set |
| Tests | `scripts/__tests__/cityTags.test.ts`, `scripts/__tests__/cityTiles.test.ts` (a synthetic PBF through the whole compiler; MVT against the client decoder; PMTiles against `worker/pmtiles.js`), `components/map/__tests__/city3dRoofs.test.ts`, `city3dOsmMesher.test.ts`, `city3dCitySource.test.ts`, `lib/map/__tests__/mapFeatures.test.ts` |

### Format: MVT with a GoWay schema, in PMTiles

The reference projects each invented a binary tile; GoWay did not need to.
Each city tile is a **Mapbox Vector Tile v2** with one `building` layer and
GoWay's own properties, in a **PMTiles v3** archive — the container the
basemap already lives in, read by the same `worker/pmtiles.js`.

- **Native reads it with the same code.** The native apps run this engine
  ([`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md)), so the same decoder and mesher
  read these tiles there (`tileMeshing.ts`). `render_height`/`render_min_height`
  keep OpenMapTiles' names and meaning, so `building-3d`'s expressions also
  apply to them as they are, and `colour` is a CSS string.
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
**sharded by Geofabrik extract** (continents/countries, run in parallel).
Built: [`MAP_CITY_PLANET.md`](./MAP_CITY_PLANET.md) — 416 regions sized to a
16 GB runner, each owning the tiles wholly inside its polygon, NOT merged: the
Worker picks the owning region's archive per tile from a manifest, so a region
is rebuilt alone. Measured there on Portugal and the Netherlands, with the
planet's size and cost.

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
(`packing.ts`: 29 → 24 B a vertex with them; indices 16-bit up to 65,536
vertices, 32-bit past them, one draw per tile), and over budget the
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

**Superseded by [`MAP_CITY_PLANET.md`](./MAP_CITY_PLANET.md)**, which built
it: regional archives under dated keys, `/map/city/*` and `/map/city-roads/*`
in the Worker (`worker/city.js`) by manifest, `/map/city/coverage.json` as the
union of the regions' tiles, the archives and receipts served for the ODbL,
and the CI workflow — all inert until the owner sets `MAP_CITY_MANIFEST`
([Approval](./MAP_CITY_PLANET.md#approval)). The plan as first written, kept
for its reasons:

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
6. **Offer** `cityTiles` in the settings modal everywhere (drop its
   `offer: 'development'`), after Phase 1's device gating.

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

Nothing new reached first paint: the decision was then read only by the lazy
adapter, which is why it was not in `lib/config.ts`. (It now lives in the
map-feature registry, which is on first paint by design; see `MAP_FEATURES.md`.)
`components/__tests__/engine3dChunk.test.ts` stays green (the TSL materials are
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
- **Planet**: built, not yet run in CI or published —
  [`MAP_CITY_PLANET.md`](./MAP_CITY_PLANET.md).
- **Roads**: the same extract also compiles a road archive on the same z15 grid
  (`scripts/build-city-roads.ts`, kept OUT of the building tiles: +72% gzip
  measured) for the city-life simulation — see
  [`MAP_CITY_LIFE.md`](./MAP_CITY_LIFE.md).

## Street detail

Road surfaces, raised sidewalks with kerbs, lane lines, crossings, stop lines,
turn arrows, bus and cycle lanes and street names painted on the road — from
the road archive's tags, as another overlay of this engine (same scene, terrain
and sky). Its own note: [`MAP_STREETS.md`](./MAP_STREETS.md).

## Phase 3: sky, atmosphere, shadows and time of day

**On by default (2026-10-12); web only; on top of the city layer.**
`?citysky=0/1` in a development build, and only together with the city
layer. It is the map-feature registry's `citySky`, so a person can switch it
off in the settings modal's Map page
([`MAP_FEATURES.md`](./MAP_FEATURES.md)); the scrubber rides above a phone's
sheet with the credit and keeps clear of "My location". Without the city layer the answer is `false`, not
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
(`AERIAL_DISTANCE_SCALE = 1`) past a clear near field (`HAZE_CLEAR_M`), a
daytime ambient that keeps little of the sky's blue (`DAY_AMBIENT_SATURATION`)
and a stylised night sky. Each is commented
where it is defined (`engine/city3d/atmosphere.ts`) with what it does and why.

### Crisp near, hazy far (owner preview, Madrid Gran Vía)

The first cut looked washed out on a tilted street-level view (Gran Vía at
18:09, sun 16°, terrain on): the whole city pale, as if veiled. Three causes,
three changes, each with a test (`city3dAtmosphere.test.ts`,
`city3dAttach.test.ts`):

- **The basemap was hazed twice.** MapLibre's own terrain fog
  (`fog-ground-blend`, from the relief prototype's sky) fogs the draped
  basemap by depth, and the city sky had coloured that fog with its own pale
  horizon — on top of the city sky's haze. While the city sky draws,
  MapLibre's ground fog is off (`fog-ground-blend: 1`); its sky and horizon
  colours still follow this sky, and the previous sky returns on detach.
- **Haze started at the camera.** Real air dims 1–3 km of street a few per
  cent, which on a pale pastel palette reads as a veil. Aerial perspective
  now starts at `HAZE_CLEAR_M` (1.5 km) and is unchanged past it, so a
  street-level view is crisp and horizon views still fade into the sky.
- **The shade was cold blue-grey.** The sky term alone lit the shade and the
  basemap's shadows. By day the ambient keeps only 40% of its colour
  (`DAY_AMBIENT_SATURATION`, back to full through twilight: the night stays
  blue), and less street bounce (`ENV_BOUNCE` 0.4 → 0.28) with slightly deeper
  shadows (`SHADOW_OPACITY` 0.7 → 0.78) gives the city its form back.

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
(`packing.ts`) → the normal's spare lane (`w`); bit 0 is `VERTEX_FLAG_FLOODLIT`, and
a new bit is a new constant, never a new meaning for an old one.

**City life and other overlays** (`overlay.ts`) get the sky two ways: through
`setLight`, the sun's direction and the light on an up-facing surface, as the
trees get it — so the simulated traffic darkens and cools at night with no
change of its own — and, optionally, through `setSky`: the sky's live TSL
nodes (`tsl/skyNodes.ts`: the sun, sky, bounce, shadow matrix, night factor,
camera and ground, and `sunVisibility`, `hazeTransmittance`, `skyColor`,
`aerial`, `groundLight`), for an overlay that wants the sun's shadows and the
haze on its own objects (the street detail does). Only the buildings cast into the shadow map
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
| Shadow map | MapLibre's `prerender` (offscreen pass, before its framebuffer is bound) | The visible buildings' depth from the sun, 2048² at the high preset, 1024² at medium, none at low (`sky.ts`, `MAP_PERFORMANCE.md`). **Only when stale**: the sun moved (0.1°), the snapped receiver box moved, or the SET of drawn tiles that can cast into the box changed — and that last at most every 250 ms while the camera moves (`SHADOW_CASTER_REDRAW_MS`; an orbit used to redraw it on most frames) |
| `FILL` | `render`, before the buildings | Only where MapLibre drew nothing (blend `src·(1−dst α)`: past its far plane the canvas is transparent): the horizon haze |
| `MULTIPLY` | 〃 | The basemap × ground light (sun × shadow + sky, `^1/2.2`) × haze transmittance; 0 above the horizon |
| `ADD` | 〃 | Haze in-scatter below the horizon; the sky and the sun's disc above it |
| Buildings | 〃 | Same light, the shadow map (rotated Poisson PCF over 3 texels: 12 taps at the high quality preset, 8 at medium, none at low — `MAP_PERFORMANCE.md`), same haze |

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
  is shared: `tsl/buildingSurface.ts`) and terrain grounding are supported.
- **Shadows** (`shadows.ts`): one orthographic map over a square receiver box
  round the map centre — radius from the view, rounded up in √2 steps; centre
  snapped to an eighth of it; box turned to face the sun so a low sun gets *more*
  resolution; window snapped to whole texels in absolute light space so a
  moved box does not shimmer. ~0.6–1.6 m texels at street zooms. The box's
  metres are measured at the centre's latitude rounded to 0.25°
  (`SHADOW_LATITUDE_STEP_DEG`), so equal keys mean identical matrices: at
  the live latitude a pan north or south moved the snap grid ~2.5 m per metre
  panned while the cached map stayed, and the shadows slid off their casters
  — or the ground lit wholesale — until the next redraw snapped them back
  (the owner's missing ground shadows and pan flicker; pinned by
  `city3dShadows.test.ts` and the visibility gate's pan). The REAL sun
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

`components/map/TimeOfDayScrubber.web.tsx`, in its own lazy chunk, opened on
demand while the layer is attached (the sun in the explore screen's top-right
stack, or Settings → "Change time…"; closing it is going back to now —
[`MAP_FEATURES.md`](./MAP_FEATURES.md) → "The time of day"): an hour slider,
previous/next day (±183), **Now** and × (closed, the map is lit for now; a
live clock re-reads the sun every 30 s). The device's
clock: a whole day is still every hour of a far city's day, and the caption
says what the sun is doing *there* (`Sun 34° up`, `Golden hour`, `Blue hour`,
`Twilight`, `Night`, from its altitude over the map centre). Strings are in
`lib/messages/citySky.ts`, in the twelve `LABEL_LANGUAGES`, kept out of the
first-paint tables. The arithmetic (`lib/map/timeOfDay.ts`) uses `setHours`, so a
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
- **Native**: not yet. The route is [`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md).
- **Floodlights** only on the GoWay city tiles (the OpenMapTiles meshes carry
  no tags), only with the sky on, and only where `lit`/`floodlit` is tagged —
  which is rare (above). Curated landmarks are the landmarks work's.

## Art direction: the detailed city look

**Target: Apple Maps' "Detailed City Experience", by look, never by asset or
data.** It is one optional map feature, `detailedCity` (`lib/map/mapFeatures.ts`;
the settings dialog's Map page, `?detailedCity=0/1` per tab in a development
build), on by default since 2026-10-12 and needing
`city3d`. With it off, the city layer draws exactly what it drew before, so the
two can be compared side by side at the same camera.

| Piece | Where |
| --- | --- |
| Feature entry | `lib/map/mapFeatures.ts` (`detailedCity`), labels in `mapFeatureLabels.ts` |
| Palette: the 3D ground, the material (day, night) | `lib/map/style/palette3d.ts` |
| The ground as paint overrides, generated | `lib/map/style/city3dGround.ts` → style `metadata['goway:city3d-ground']` (`scripts/build-map-style.ts`) |
| Material response (the sky's `CityMaterialResponse`) and its surface tint | `components/map/engine/city3d/tsl/detailedMaterial.ts`; tables, values and the JS mirror in `materials.ts` |
| Per-building seed | `osmMesher.ts` → `buildingSeed` (an untagged surface's unused rgb) |
| Adapter half (material data, ground apply/undo) | `components/map/city3dStyle.ts`, wired in `city3dLayer.web.ts` (`detailed`) |
| Tests | `lib/map/__tests__/palette3d.test.ts`, `components/map/__tests__/city3dMaterials.test.ts`, `city3dStyle.test.ts` |

### What the references show

Apple's images are not committed. They are Apple's newsroom set for iOS 15
(San Francisco's Ferry Building by day, London's Royal Albert Hall at night,
London wide by day, the Castro at night) and the landmark screenshots in the
owner's brief (Statue of Liberty at night; Toronto City Hall, the Biosphère and
the Wynn at night; Apple Michigan Avenue, Steve Jobs Theater and Apple Fifth
Avenue by day). Read side by side with GoWay's renders, they agree on:

- **Day is a white maquette.** Buildings a near-white warm grey; the sunny
  wall `≈#ecebe8`, the shaded one `≈#c9c8c6` — darker, a shade cooler, never
  black; roofs a step under the lit walls and under the ground. Massing, not
  detail: windows are barely there.
- **The streets carry the plan.** Near-white ground and plazas, pale grey
  asphalt with white kerbs (the inverse of the 2D map's white streets on
  cream), saturated light-green parks, vivid light-blue water.
- **Night is blue, not dark.** Slate blue-violet ground, deep teal parks,
  blue-grey buildings a step LIGHTER than the ground, lit from a moonlit sky
  (the tops brightest, the shaded sides darkest), warm windows scattered
  irregularly with dark glass between.

### The palette

**Ground** (`CITY_GROUND_PALETTES`, the 2D palette with these replaced; it
cross-fades in over z14.5 → 15.5 so the region map stays the 2D cartography
and the buildings, fading in from 15.5, arrive on their own ground):

| | Light | Dark |
| --- | --- | --- |
| land / built-up | `#f1f0ec` / `#eeede8` (no cream) | `#3d4a66` / `#434c6c` |
| park / pitch | `#acdd8c` / `#b4e298` | `#17685c` / `#1a7062` |
| water | the 2D `#8ddbf6` (already Apple's) | the 2D `#1c347a` |
| street fill (primary → local) | `#c6c9cd` → `#d5d7da`, asphalt | `#303a52` → `#333d55` |
| street casing (the kerb) | `#fbfbfa` — lighter than the ground | `#53607e` → `#4d5a78` |
| street label / park label | `#515554` / `#15652d` | 2D `#f2f5f9` / `#8df6c7` |

The two label inks are the 2D ones walked down (light) or up (dark) their own
lightness axis until they clear **4.5:1** again on the new streets and parks —
the method `palette.ts` uses for POI type, pinned in `palette3d.test.ts`.

**Ground mechanics.** The overrides are not a list anyone keeps:
`city3dGround.ts` runs the style's own `buildLayers` with both palettes and
turns every paint colour that differs into a zoom cross-fade (a colour, or the
palette's low-zoom ramps, evaluated at the fade exactly as MapLibre
interpolates them; anything else fails the build). `map:style` writes them
into each style document's `metadata`, `map:style:check` drift-checks them and
validates the overridden style with MapLibre's validator, and the adapter
applies them with `setPaintProperty` and puts every value back on detach. A
style without them (`openfreemap`, a URL override) keeps its ground. Cost:
+13.9 KB raw, **+0.8 KB gzip** per style document; no JavaScript.

**Material** (`CITY_MATERIALS`, blended field by field on the GPU by the engine's night factor):

| | Day | Night |
| --- | --- | --- |
| Albedo (low → very tall) | `#dedcd7` → `#d5d6d8` (towers cooler, greyer) | `#566586` → `#5e6d90` |
| Wrap | 0.55 | 0.50 |
| Contact AO at the foot / reach | 28% / 10 m | 30% / 10 m |
| Corner AO kept | 80% | 80% |
| Wall gradient (base → top) | 7% | 12% |
| Bevel highlight | 0.12 × sky | 0.06 × sky |
| Per-building tint | ±6% lightness, ±2.5% warm↔cool | ±4%, ±2% |
| Tagged colour kept | 35% of the classic temper, 12% of its chroma | 30%, 12% |
| Response to the sky: fill gain / fill chroma / sun gain | 1.6 / 40% / 0.65 | 2.0 / 25% / 0.65 |
| Window openings | 10% (faint) | 75%, dark glass `#2b3352` |
| Lit windows | — | 36%, warm `(1.0, 0.78, 0.40)` ↔ cooler `(0.9, 0.9, 0.82)`, 72–100% brightness |

Through the face values that come out (sun at 40° from the zenith, the JS
mirror): day roof `#e8e7e4`, lit wall `#f2efe6`, shaded wall `#c0beb9`; night
roof `#6378ad`, lit wall `#50618d`, shaded wall `#414e70` — every night face
above the `#3d4a66` ground, which a test pins.

### What the feature costs when off

`expo export --platform web`, no features on, against `main` at `97e6d49`
(separate Metro caches, `--clear`):

| Chunk | `main` | With the detailed look | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 1,757,712 B gz | 1,757,736 B gz (+24 B; +227 B raw) | the `detailedCity` registry entry — what every optional feature costs |
| `__common` (first paint) | 81,774 B | 81,774 B | identical once module ids are normalised |
| `MapSettingsPanel` (lazy) | 18,179 B gz | 19,190 B gz | the feature's labels, every UI language |
| `city3dLayer` (lazy) | 7,152 B gz | 8,399 B gz | palette, ground apply/undo |
| `lazyChunk` (lazy, three.js) | 1,194,541 B gz | 1,198,044 B gz | the material GLSL |
| `meshWorker` (sealed) | 29,124 B gz | 29,230 B gz | the building seed |
| style documents (every map) | — | +0.8 KB gz each | the generated ground overrides, inert unless applied |

`palette3d.ts` is imported at runtime only by the lazy adapter; the engine
imports it for types only, so nothing is shared between the two lazy chunks
(`engine3dChunk.test.ts` stays green).

### The lighting model: one response, the sky's light

Ownership (lead decision): **the sky owns the light inputs** — sun direction,
colour and intensity, sky and bounce irradiance, the shadow map, haze, what the
scene emits (street glow, `floodlit=yes`), the night factor — and **the art
direction owns the material response**: how a surface turns those inputs into
colour. They compose in ONE shader. `materials.ts` holds the response once:

```
wrap    = clamp((n·L + w) / (1 + w), 0, 1)                       soft terminator
fill    = mix(bounce, skyUp, n.z/2 + 1/2)                        hemisphere
colour  = albedo · tint · (sun · wrap · shadow + fill)
          · contactAO(h) · mix(1, cornerAO, k) · gradient(h/H)   (contact, gradient: walls only)
          + albedo · emitted  +  edge · chamfer(n.z) · fill       the 45° bevel catches light
```

It is `tsl/detailedMaterial.ts`, the `CityMaterialResponse` (`CitySurface`,
`CitySkyLight`) the sky's shading path calls (`CityEngineOptions.sky.response`),
in the sky's linear light, with its real sun, soft shadow, sky, bounce and
emitted light; roll-off, gamma and haze stay the sky's. **There is no second
path**: the detailed look is always drawn in the city sky's light, and the map
adapter gives it a live-clock sky when the page asked for none (`?citysky=1`
adds the time-of-day scrubber). The sky's light is physical — a warm sun, a
blue sky, a dim vertical wall — so the clay answers it with three palette
fields: `skyFillGain` (1.6 day, 2.0 night), `skyFillChroma` (how much of the
sky light's hue the matte surface shows: 40% day, 25% night) and `skySunGain`
(0.65). The sun keeps its colour, so golden hour is golden. Pinned against the
sky's own `computeSkyState` at sun 50°, 8° and night (`city3dMaterials.test.ts`).

Why this shape and not MapLibre's: MapLibre floors an unlit face at
`1 − intensity` of its colour and multiplies, which on a pale palette is a
white lid on a grey box. Here no face is lit by the sun alone — a wall facing
away keeps the whole sky fill — so the shaded side is ~20% under the lit one
and cooler (blue sky, warm sun): clay, not cardboard.

The surface colour is shared too: `tsl/buildingSurface.ts` (the ramp and the
tempered tag), then the detailed look's tag clamp and per-building tint
(`detailedMaterial.ts` → `surface`), which leaves the openings to the
response.

### Night

- **One night factor, the engine's.** Every material field has a day and a
  night value, blended ON THE GPU by `uNightFactor` — the uniform every city
  material shares (`CityEngine.setNightFactor`), fed by
  `lib/map/landmarks/night.ts` (the dark map is full night) or, under the city
  sky, by its time of day. The day ramp travels in the shared `uLow`/`uTall`/…
  uniforms and night darkens it by `night.low / day.low`. Nothing in the art
  direction keeps a night factor of its own (the earlier placeholder is gone).
- **Windows glow only where they are drawn**, i.e. where `building:levels` is
  recorded (the storey rhythm, `facades.ts`) — never on a wall without a
  recorded count, never on a party wall. Which windows are lit, their warmth
  and their brightness come from a deterministic integer hash of (bay,
  storey, building seed): **styling, stable frame to frame, and not a claim
  about occupancy or anything else in the world.** Far away, where a storey is
  too small to draw, a facade fades to its average glow instead of shimmering.
- **Not here, on purpose**: the night sky, the street-level warm light on the
  walls, `floodlit=yes` uplighting and landmark glow are the sky's and the
  landmarks' (they arrive as `emitted` and as the landmark models).

### Facades

Apple's near views (Rockefeller Center at night, the owner's `nav1`/`nav2`)
read as architecture, not boxes: piers between window columns, windows set back
in frames, cornices and setback ledges, a distinct ground floor. The detailed
look draws the same vocabulary as **relief on the recorded storey rhythm**,
inside its one material response (`materials.ts` → `gowayFacade`), and only up
close.

**Data, and the honesty line.** Nothing is drawn that the data does not
support:

- The grid is the RECORDED storey rhythm (`facades.ts`): `building:levels`,
  or the Catastro's official storey count where the official-data tiles set it
  (`official_levels`, which the decoder already prefers). No count, no grid, no
  relief: a plain wall.
- The STYLE varies by two recorded facts the compiler now keeps
  (`lib/map/cityTiles.ts`): `use`, a class from `building=*` (`residential`,
  `commercial`, `civic`, `religious`, `industrial`; `yes` and anything unlisted
  is none), and `era`, a bucket from `start_date` (before 1900, 1900–1944,
  1945 on; only a leading 4-digit year is read). A `building:part` inherits
  both from its outline (Barcelona is drawn entirely as Catastro parts). They
  ride in the per-vertex flag byte (`osmMesher.ts` → `buildingFlagsOf`: bit 0
  floodlit, bits 1–3 class, bits 4–5 era).
- The style is a TYPE, never a survey: an office gets piers because offices
  of that kind tend to have them, not because this one is known to. No
  signage, names, storefronts or doors come from any of it.

Coverage in the rebuilt archives (2026-10 extracts): Barcelona 86% of
features carry a class (mostly inherited) and 1.2% an era; Manhattan 18% and
6.6%. **Rockefeller Center itself records no storeys in OSM**, so its towers
stay plain walls: the relief shows on its neighbours that do (a 6th Avenue
block), not on the complex `nav1` shows.

**What is drawn** (per-class numbers in `FACADE_STYLES`, generated into the
shader's tables; era nudges them):

| Element | How |
| --- | --- |
| Window grid | One opening per bay × recorded storey; size per class (offices wide and tall, civic and religious narrow and tall, industrial high strips) |
| Recess + frame | The opening sits 6–18 cm back: shaded, most under its head; a thin lighter frame around it |
| Piers | Commercial, civic and religious walls (and anything 1900–1944) raise 16–26 cm piers between window columns |
| Cornice | The top 0.3–0.6 m of every part's recorded storeys projects 20–40 cm (heavier before 1900, lighter after 1945) — every setback is a part, so every setback gets its ledge |
| Ground floor | On three storeys or more: a taller first-floor opening, a slightly darker plinth, and a string course over it |

The relief is a height field over the wall whose slope is computed
ANALYTICALLY from its smoothstep profiles, bending the normal the sky's light
sees (occlusion still classifies by the wall's own), plus a recess shade and
an albedo factor.

**Budget.** No geometry, no textures, no new attributes beyond two spare bits
of an existing byte. In the shader: one `fwidth` per building fragment, then
`if (detail <= 0.0) return` (the window grid, gone once a storey is under
~5 px) and `if (near <= 0.0) return` (the relief, full from ~30 px a storey,
gone by ~14 px). Because the slope is analytic — no `dFdx`/`dFdy`, which must
run in uniform control flow — roofs, far walls, far LOD tiles and walls with no
recorded storeys pay one `fwidth` and a branch; only near walls with a storey
rhythm pay the ~40 ALU of the relief. Frame time could not be measured
meaningfully on SwiftShader (GPU work completes asynchronously: rAF intervals
and `gl.finish()` showed no difference either way); a real-GPU measurement
belongs with the device budget in Phase 1.

### Side by side

Rendered in headless Chromium (SwiftShader) on `expo start --web`, the
`/frame` route, city tiles (Catalonia + Manhattan z15), clock pinned to
2026-06-21 (Barcelona 11:00, New York 11:00), classic against detailed, light
and dark: Eixample (41.3925, 2.164, z17, pitch 60), Sagrada Família, Barri
Gòtic, Lower Manhattan. Composites against the references were judged by eye,
honestly:

**Tagged colours** (`building:colour`, materials) are clamped to a lightness
hint in this look: the first renders tinted Lower Manhattan towers pink and
green, against Apple's uniform massing. `tagSaturation` keeps 12% of a tempered
tag's chroma — under 1.5% channel spread for a pure red, pinned by a test —
while a tagged black building still reads a step darker.

**Close:** the day maquette (white-grey massing, soft cool shade, no black
sides, roofs under the ground, faint bevel lines), the 3D ground (asphalt
streets with white kerbs, saturated parks), the night palette's blue massing
with moonlit tops, the warm irregular windows.

**Still short of Apple:**

- **No soft contact halo on the ground** around a footprint (Apple's buildings
  sit in one); the sky's shadow map draws sun shadows, not ambient occlusion.
- **Silhouettes are chamfered, not rounded.** The bevel is 0.7 m; a wider
  rounded profile is a mesher change (`MESH`) for after the LOD work lands.
- **Manhattan at night is mostly unlit**: 7.8% of its features record
  `building:levels`, so most towers have no windows to glow — the honesty rule
  working as intended. A municipal floor count (PLUTO, Phase 4) fixes it.
- **Facades are flat walls with a window grid.** Apple's near views (Rockefeller
  Center) carry piers, recessed windows, cornices and a ground-floor band;
  procedural facade relief driven by recorded levels is the follow-up.

## Phased plan

Estimates are engineering time for one person familiar with the codebase, and
are estimates; the runtime numbers are measured unless marked.

| Phase | What | Cost |
| --- | --- | --- |
| **0. Prototype** (this change) | Custom layer, worker mesher over existing tiles, bevels, baked AO, lit by the same sun light as `building-3d`; off by default | Done. Users: +1.1 KB entry, nothing else with the flag off |
| **1. Ship A on web** | ~~Far-field LOD, per-tile fade-in, worker pool~~ (done: §4 "LOD and loading", with budgets; trees: §8), WebGL context-loss handling, device gating via `deviceProfile`-style checks (GPU memory: Barcelona's visible set is ~60 MB), MapLibre sky/fog matched in-shader, tap-through to the basemap preserved, a perf budget on mid-range Android Chrome | ~2–3 weeks. No infra. Opt-in users download the ~1.1 MB gz lazy chunk |
| **2. GoWay 3D tiles (B)** | Compiler beside the Planetiler build: per-building footprints and parts, OSM levels/roof shapes where tagged; client second source mode with roofs, tempered colours and recorded storeys; archive in R2 behind the Worker; the same tiles on native, through the same engine | **Compiler + client built, off by default** ([Phase 2](#phase-2-goway-city-tiles)): Barcelona 11.9 s / 6.2 MB, Catalonia 15.3 s / 31.5 MB. Remaining: sharded planet build (~2 h compute, ~18–20 GB extrapolated), R2 + Worker route, ODbL publication, far levels for the city tiles (they draw every visible tile at full detail today, §4); pre-meshing and neighbour AO only if measured necessary |
| **3. Atmosphere** | Sky, haze over basemap and buildings, sun shadows, time-of-day scrubber | **Built, off by default** ([Phase 3](#phase-3-sky-atmosphere-shadows-and-time-of-day)). Remaining: real-GPU frame budget, device gating, terrain-aware ground passes |
| **4. Municipal data** | One dataset at a time (PLUTO, PLATEAU, 3DBAG, Catastro…): licence review, adapter in the compiler, credit while drawn, LOD2 roofs where present | **Started** ([`MAP_3D_SOURCES.md`](./MAP_3D_SOURCES.md)): survey and verdicts; CityGML/CityJSON readers, conflation and a `building_lod2` tile layer; Spain's Catastro storeys merged for every municipality an area covers (official > OSM tags > 5 m, `height_source`; Barcelona 18.1 MB against 7.0 MB, Madrid 8.6 against 1.9); New York City's 3D model merged (Manhattan 8.8 MB against 3.6 MB). Next: 3DBAG (needs RD New), German states, PLATEAU |
| **5. Native** | The same engine on `WebGPURenderer` + TSL, drawn by `react-native-webgpu`, with GoWay's engine drawing the base map: [`MAP_NATIVE_3D.md`](./MAP_NATIVE_3D.md) → Phased plan | Phase 1 prototype built; the rest is that note's plan |

Procedural facades are deliberately not a phase. Phase 2 draws the one kind
the honesty rule allows — a storey rhythm where `building:levels` is recorded
— and it turned out to be common where an import put it there (75.5% of
Barcelona's features, from the Catastro). Anything richer waits for Phase 4
— which, where a model is merged, draws the OSM match's recorded storeys on
the model's measured shape and nothing more ([`MAP_3D_SOURCES.md`](./MAP_3D_SOURCES.md)).

## Open questions

- Where should the shared three.js runtime chunk live once a third consumer
  (SDK models) arrives — and should Spark move out of it?
- ~~Does Phase 2 compile at z14 or at z15/16?~~ z15, measured (Phase 2 →
  Addressing).
- Is the B archive versioned with the basemap's planet build (same date stamp)
  or independently? Same-date keeps 2D and 3D in agreement.
- Picking: should tapping a 3D building select it (it is not a Place), or pass
  through to the basemap as today?

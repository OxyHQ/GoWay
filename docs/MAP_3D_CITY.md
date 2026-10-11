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
  keeps a **192 MB** GPU budget and a 64-tile entry budget, evicting
  least-recently-used tiles. Tiles with no buildings (sea, fields, a 204/404)
  are cached as empty entries, so a revisit does not fetch them again; the
  entry budget is what bounds them. A failed tile is retried even while the
  view stands still — `building-3d` is hidden, so nothing else would draw it —
  with backoff (1, 2, 4, 8 s, then a 5-minute cooldown: at most five requests
  per cooldown for a tile that never loads). A view straddling the
  antimeridian loads both sides, each tile fetched as its canonical `x` and
  drawn in the world copy the camera sees it in. All of this is
  `tileScheduler.ts` and `tilesForView`, tested without WebGL.
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
| MapLibre adapter | `components/map/city3dLayer.web.ts` — adds `goway:city3d` before `building-3d`, hides `building-3d`, restores it on detach; on a style with no `building-3d` (the `openfreemap` escape hatch, a style-URL override) it declines and leaves the style untouched, rather than guessing an anchor in a document GoWay does not own |
| Light | `components/map/city3dLight.ts` — the `building-3d` light (`useSunLight`'s, fed by `MapCanvas.web.tsx`) as the engine's `CityLight` |
| Engine (three.js) | `components/map/engine/city3d/cityEngine.ts` |
| Worker | `components/map/engine/city3d/meshWorker.ts` (`new Worker(new URL(…, import.meta.url))`, which Expo bundles as a sealed chunk) |
| Pure parts (tested) | `tileMath.ts`, `mesher.ts`, `occlusion.ts`, `shaders.ts`, `decode.ts`, `tileScheduler.ts` |
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
| Engine/worker seam | `protocol.ts` (`format`), `meshWorker.ts` (one branch), `cityEngine.ts` (`tileFormat`, `maxTiles`, two attributes) |
| Flag | `lib/map/cityTilesFlag.ts` (`EXPO_PUBLIC_MAP_CITY_TILES`, `?cityTiles=1` in development; requires the city-3D flag) |
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
`part`. The feature id is Planetiler's `osmId × 10 + 2|3`, so a city building
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
from 4 OpenMapTiles tiles (100 MB). The layer draws the nearest 16 z15 tiles
(`CITY_TILES_MAX`, ~3.7 km square).

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
4. **ODbL**: publish the archive's URL and its receipt (see Obligations)
   before the flag is turned on for anyone.
5. **Flip** `EXPO_PUBLIC_MAP_CITY_TILES` only together with
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

Nothing new reaches first paint: the env read lives in `cityTilesFlag.ts`,
imported only by the lazy adapter, which is why it is not in `lib/config.ts`.
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
- **Far-field LOD** (Phase 1) matters more here: 16 z15 tiles reach ~1.8 km.
  A z13 prism-only level from the same compiler is the natural far field.
- **Straight skeleton** for gabled/hipped roofs on non-rectangular footprints.
- **Pre-meshing and neighbour AO** in the compiler, if client meshing ever
  shows up on mid-range devices.
- **Planet**: shard, measure one continent, then the planet.

## Phased plan

Estimates are engineering time for one person familiar with the codebase, and
are estimates; the runtime numbers are measured unless marked.

| Phase | What | Cost |
| --- | --- | --- |
| **0. Prototype** (this change) | Custom layer, worker mesher over existing tiles, bevels, baked AO, lit by the same sun light as `building-3d`; off by default | Done. Users: +1.1 KB entry, nothing else with the flag off |
| **1. Ship A on web** | Far-field LOD, per-tile fade-in, 2-worker pool, WebGL context-loss handling, device gating via `deviceProfile`-style checks (GPU memory: Barcelona's visible set is ~60 MB), MapLibre sky/fog matched in-shader, tap-through to the basemap preserved, a perf budget on mid-range Android Chrome | ~2–3 weeks. No infra. Opt-in users download the ~1.1 MB gz lazy chunk |
| **2. GoWay 3D tiles (B)** | Compiler beside the Planetiler build: per-building footprints and parts, OSM levels/roof shapes where tagged; client second source mode with roofs, tempered colours and recorded storeys; archive in R2 behind the Worker; the same tiles as native's per-building extrusion source | **Compiler + client built, off by default** ([Phase 2](#phase-2-goway-city-tiles)): Barcelona 11.9 s / 6.2 MB, Catalonia 15.3 s / 31.5 MB. Remaining: sharded planet build (~2 h compute, ~18–20 GB extrapolated), R2 + Worker route, ODbL publication, far-field LOD; pre-meshing and neighbour AO only if measured necessary |
| **3. Atmosphere** | Staged as in §6: sky/fog, in-shader aerial perspective, sun-tinted ambient | ~1–2 weeks |
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

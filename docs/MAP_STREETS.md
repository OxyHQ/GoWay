# Street detail: lanes, crossings, sidewalks and names on the road

Road surfaces, raised sidewalks with kerbs, and the paint on the road —
lane lines, crossings, stop lines, turn arrows, bus and cycle lanes, and the
street's name — drawn in the 3D city from what OpenStreetMap records. The
look is Apple Maps' detailed streets (the owner's references: Sixth Avenue at
Rockefeller Center by night); nothing of Apple's — no asset, no data — is
used.

**Labs, off by default, web only, development builds only** (nothing serves the
road archive on goway.to yet). It is the registry's `cityStreets`
(`lib/map/mapFeatures.ts`, needs `city3d`): the settings dialog's Labs,
`?cityStreets=1` in a development tab, or `EXPO_PUBLIC_MAP_CITY_STREETS=1` for a
build ([`MAP_FEATURES.md`](./MAP_FEATURES.md)).

```bash
# Road archive, schema 2 (the same one city life drives on):
bun run --cwd packages/frontend map:city-roads --pbf=$HOME/osm-data/new-york.osm.pbf --area=manhattan
GOWAY_CITY_TILES_ARCHIVE=<buildings>.pmtiles,$PWD/packages/frontend/.tiles/city-roads-manhattan-z15.pmtiles \
  bun run --cwd packages/frontend web
# → http://localhost:8081/?city3d=1&cityTiles=1&cityStreets=1&lat=40.7595&lng=-73.9807&zoom=18.4&bearing=209
```

## Where it lives

| Piece | Where |
| --- | --- |
| Tags → tile properties (compiler) | `scripts/citygen/streetTags.ts`, wired into `scripts/citygen/roads.ts`; schema `lib/map/cityRoads.ts` → `STREET_PROPS`, `STREET_NODE_PROPS` (schema 2) |
| Shared road code (decoder, graph frame and geometry, chaining, driving side) | `components/map/engine/roads/` — `roadTiles.ts`, `roadGraph.ts`, `drivingSide.ts`; used by the simulation and the streets alike |
| Cross-section: bands, widths, which line where | `components/map/engine/cityStreets/lanes.ts` |
| Crossing pattern and arrow choice per tag | `cityStreets/markings.ts` |
| Mesher (pure, in the worker) | `cityStreets/streetMesher.ts`, buffers `meshBuffers.ts` |
| SDF atlas: the map's glyphs, the arrows | `cityStreets/streetAtlas.ts` (glyph PBFs decoded with `scripts/mapgen/glyph-pbf.ts`, the build's own decoder) |
| Worker, protocol | `cityStreets/streetWorker.ts`, `protocol.ts`, run through the engine's `WorkerPool` |
| Renderer (a `CityOverlay` of the city engine) | `cityStreets/streetRenderer.ts`, `streetShaders.ts` |
| Palette (day, night) | `lib/map/style/streetPalette.ts` |
| Adapter | `components/map/city3dLayer.web.ts` (`streets` option), `MapCanvas.web.tsx` (`useMapFeature('cityStreets')`) |
| Tests | `components/map/__tests__/cityStreetsLanes.test.ts`, `cityStreetsMarkings.test.ts`, `cityStreetsMesher.test.ts`; `scripts/__tests__/cityStreetTags.test.ts`, `cityRoads.test.ts`; `lib/map/__tests__/mapFeatures.test.ts` |

## The data: one road archive, schema 2

The road archive the city-life simulation already drives on
([`MAP_CITY_LIFE.md`](./MAP_CITY_LIFE.md)) carried classes, lane counts,
one-way, speeds, sidewalks, signals, crossings and restrictions. Street detail
needs more, so the compiler now also writes, **only where OSM records them
readably**:

| Property | From |
| --- | --- |
| `name` | `name` — the local-language name, like `places.name` (never `name:<lang>`) |
| `width` | `width` (m, `ft`, `'"` converted; 2–60 m) |
| `turn_lanes`, `_forward`, `_backward` | `turn:lanes*`, normalised; one unknown value refuses the whole tag |
| `bus_lanes*`, `busway`, `lanes_bus*` | `bus:lanes*`/`psv:lanes*` (per lane), `busway*=lane`, `lanes:bus*`/`lanes:psv*` |
| `cycle_lane` | `cycleway*=lane|opposite_lane` (painted lanes; tracks are their own ways) |
| `parking` | `parking:lane:*` on the carriageway, or `parking:*=lane` |
| `sidewalk_width` | `sidewalk:*width` |
| `bridge` | `bridge=*` ≠ `no` |
| `crossing`, `crossing_markings` | on `footway=crossing` ways |
| node `crossing_markings`, `crossing_ref`, `direction` | `crossing:markings`, `crossing_ref`, `traffic_signals:direction`/`direction` |

Measured on the same extracts as before (Bun 1.4.2, one core, loaded machine):

| | Manhattan | Barcelona |
| --- | ---: | ---: |
| Archive, schema 1 → 2 | 2.20 → 2.38 MB (+8%) | 3.05 → 3.49 MB (+14%) |
| Compile | 39.7 s | 27.1 s |
| Car ways with a name / `turn:lanes` / bus lanes / cycle lane / parking / `width` | 80% / 15.6% / 5.6% / 12% / 4.7% / 1.1% | 83% / 5.9% / 6.4% / 0.3% / 1.1% / 7.9% |
| Values refused (top) | `crossing:markings` 301, `width` 126 | `crossing:markings` 86, `width` 39 |

What the two cities record differs, and it shows: New York records the
crossing pattern on the crossing WAY (`crossing=traffic_signals` +
`crossing:markings=zebra` on 450 ways of the Rockefeller tile, against 35
nodes), Barcelona on the node, mostly `dots` and `dashes`. Both are read.

The additions are additive: the simulation's decoder reads a schema-2 tile
unchanged, and a schema-1 archive draws with the generic class markings only.
Archive and receipt obligations are the road archive's (`MAP_CITY_LIFE.md` →
Hosting).

## What is drawn, from which tag

The honesty rule of [`MAP_3D_CITY.md`](./MAP_3D_CITY.md) ("procedural detail
is styling, never fact") governs the paint: **a marking that states something
— a crossing, an arrow, a bus lane, a stop line — is drawn only where OSM
records it.** Sizes, colours and patterns are styling.

- **Lanes** (`lanes.ts` → `crossSection`): recorded `lanes`/`lanes:forward`/
  `lanes:backward` (or the length of a recorded per-lane list), split by the
  side traffic keeps to (`roads/drivingSide.ts`). An odd unsplit count draws
  the larger half forward (the split is styling, the total is not);
  inconsistent counts (`lanes=2` + `lanes:forward=2` on a two-way road) are not
  drawn as recorded. A recorded `width` sets the lane width when it leaves each
  lane 2.3–5 m, and is refused otherwise.
- **Where lanes are NOT recorded** the carriageway still needs a width: the
  simulation's class default lane count (`roadGraph.ts` → `defaultLanes`) at a
  class lane width (`LANE_WIDTH_M`). That width is styling, and so is the only
  paint such a road gets: **a dashed centre line on a two-way through road
  (`tertiary` and up), solid edge lines on a motorway or trunk, nothing else** —
  no lane dividers, arrows or bus lanes from a default.
- **Lines**: dashed between same-direction lanes (3 m dash, 6 m gap); at the
  centre a double line on a major road (or two lanes each way), solid on
  `secondary`/`tertiary`, dashed below; solid beside a bus lane (wider) and a
  cycle lane; none beside parking. Centre lines are yellow in the Americas,
  Norway, Finland and South Korea (coarse boxes, `paintRulesAt`), white
  elsewhere.
- **Crossings** (`markings.ts` → `crossingStyle`) at mapped crossing nodes, in
  the direction of the `footway=crossing` way across the road when there is one
  (a skewed crossing stays skewed): `crossing:markings` on the node, then on the
  way; `crossing_ref`; then `crossing` — `zebra`/`marked`/`uncontrolled` →
  zebra; `traffic_signals` with no recorded pattern → the two transverse lines
  only (the least a signalled crossing is painted with); `ladder`, `lines`,
  `dashes`, `dots`, `surface` as recorded; `unmarked`, `informal`, `no`,
  pictograms and anything unreadable → nothing.
- **Stop lines** across the approaching lanes where a signal is recorded at or
  within 35 m of the junction, or a stop sign within 20 m (a give-way sign: a
  dashed line), 1 m before the crossing they guard; and both ways at a mid-block
  signal with its crossing. Never at an unsignalled junction.
- **Turn arrows** only from `turn:lanes` whose lane count matches the lanes it
  describes (one wrong count would shift every arrow), at the end the lanes
  run toward, repeated 28 m back on a long link. `sharp_*` draws as the plain
  turn; `reverse` bends to the side traffic crosses.
- **Bus lanes** from a per-lane pattern, else a `lanes:bus` count (the kerb
  lanes), else `busway:<side>`; tinted, with **BUS** painted behind the arrows,
  upright to the approaching driver (so upside down from behind, as in the
  references). Never every lane of a road. The word "BUS" and the
  terracotta tint are styling; Apple's "ONLY" is not drawn — it would be a
  claim the data does not make.
- **Cycle lanes** (`cycleway*=lane`) tinted green beside a solid line;
  **parking** lanes widen the carriageway, unpainted.
- **The street's name** (`name`, the local language) painted along long
  straight stretches, in the map's own glyphs, upper case, with US street-type
  suffixes abbreviated (`6th Avenue` → `6TH AVE` — styling of the recorded
  name, never a translation). It reads with the traffic on a one-way street
  and eastward (else northward) on a two-way one, sits inside one lane so it
  crosses no line, and keeps 14 m (plus 8 m where there is a stop line) clear of
  each end so it never meets the arrows, crossings or stop lines. A name in a
  script that needs shaping (Arabic, Hebrew, the Indic scripts, Thai) is not
  painted rather than painted wrong; a name with any glyph missing is not
  painted at all.

## Surfaces

- **Links and junctions.** Drivable pieces from the tile and its eight
  neighbours (so a junction near an edge sees every arm) are chained junction
  to junction by the simulation's own `chainPieces` (`roads/roadGraph.ts`),
  continuing through a node only where the carriageway is the same and does not
  turn by more than ~50°. At a junction every arm is cut back until its kerbs
  clear the next arm's round a kerb fillet (5 m where a major road meets, 3.5 m
  otherwise — styling), and the junction is the polygon of the arm mouths and
  the fillets. Where only the carriageway changes (a two-arm junction), a short
  transition; a crossing on such a node is painted there.
- **Sidewalks.** Recorded `sidewalk=both|left|right` is a 15 cm slab beside the
  carriageway (`sidewalk:width`, else 2.5 m — styling) with kerb faces, and
  fills the junction corners round the fillet where both arms record one.
  `sidewalk=separate` (New York, Barcelona) means the sidewalk is mapped as its
  own way: that way is a slab along its line, widened toward the nearest
  parallel kerb within 8 m (never past it), and the junction corners are filled
  as above.
- **Paving**: `living_street` and `pedestrian` carriageways, footways and paths
  are flat paving, lighter than asphalt.
- **Not drawn**: tunnels (hidden by definition) and bridges (the basemap draws
  them; a deck at its height is a next step).

Every primitive belongs to the tile its anchor lies in (a strip segment's
midpoint, a junction's node, a crossing's node, a word's centre), so two tiles
never draw the same thing.

## Arrows, words and names: one SDF atlas

Everything painted that is not a straight line is a quad sampling ONE
single-channel signed-distance atlas (`streetAtlas.ts`, 1024², R8), so a tile's
markings are one draw call and stay sharp at any zoom:

- **Glyphs are the map's own**: the style's glyph ranges
  (`/map/fonts/{fontstack}/{range}.pbf`, Inter Bold, built by
  `scripts/build-map-glyphs.ts`), decoded with the build's own
  `glyph-pbf.ts`, in MapLibre's encoding (24 px em, 3 px border, edge at 191).
- **Arrows are rasterised once per shape** in the same encoding, as the union
  of stroked paths and heads (through, left, right, slight, U-turn, merges and
  any combination).

**Why in the three.js scene and not a MapLibre symbol layer on the road
plane**: paint is part of the road, not a label. In the scene it is
depth-tested (a building in front hides it), stands on the same terrain as the
road, is lit and hazed by the city sky like the asphalt, darkens at night with
the palette, never collides with or displaces the map's labels, and is drawn by
the same worker that knows the lanes, so a name sits inside a lane and clear of
the arrows. A symbol layer would draw over buildings, float on the 2D ground,
take part in label collision, and need the lane geometry on the main thread.

The worker owns the atlas (one worker, so one packing order) and sends the
bytes it placed with each tile; the renderer mirrors them. A full atlas refuses
further shapes, which are then not drawn (counted); a new worker (after a
crash) starts a new atlas and the renderer re-meshes everything.

## Terrain and depth

- **On the drawn ground**: each vertex reads its tile's ground grid in the
  vertex shader — the same grid the buildings, trees and city life stand on
  (the engine's one `Ground`, `terrainGround.ts`: the same cached 33² grid per tile) — from
  a float texture, bilinearly. No per-vertex CPU work. Strips are cut every
  6 m so they bend with the ground instead of cutting through a crest (the
  Procedural Tokyo lesson: markings split along the terrain mesh).
- **No z-fighting**: 6 cm of lift over the ground, and coplanar layers
  (paving, asphalt, sidewalk, tint, paint) are told apart by a per-layer depth
  nudge toward the camera in clip space (`2e-6 · layer · w`) — a polygon
  offset per vertex. Paint draws after the surfaces without writing depth.
- **Thin lines never vanish**: a line thinner than ~1.2 device px is drawn
  that wide at proportionally less alpha, anti-aliased by its own
  across-coordinate (at z17 in Barcelona a 15 cm lane line is a third of a
  pixel).

## Levels of detail

The engine's own `selectLodTiles` (`lod.ts`) with street thresholds
(`streetLodPolicy`): a z15 road tile is drawn at **full detail** where it is at
z17 or closer on screen, **simplified** from z16, **not at all** below z16 (the
streets fade in over z16 → z16.25). One mesh per tile, two index ranges: the
simplified level (surfaces, sidewalk tops, tints, lines, crossings, stop lines)
is the first range; kerb faces, arrows, words and names follow and are drawn
(and faded in over z16.9 → z17.2) only at full detail. A pitched view steps its
far tiles down to the simplified range.

## Look

`lib/map/style/streetPalette.ts`, blended by the city's `nightFactor`
(`lib/map/landmarks/night.ts`, through the overlay's new `setNightFactor`, or
the sky's uniform under the city sky). **The asphalt and the sidewalk are the
3D city's ground palette** (`palette3d.ts` → `CITY_GROUND_PALETTES`, the
detailed look's, #127): a street's fill and casing, light by day and dark by
night, so the 3D streets and the flat roads around them are one colour and an
art-direction change moves both. The rest is this feature's own:

| | Day | Night |
| --- | --- | --- |
| Asphalt / sidewalk (the ground palette's primary road fill / casing) | `#c6c9cd` / `#fbfbfa` | `#303a52` / `#53607e` |
| Kerb face | `#d8d7d2` | `#475068` |
| Paving | `#e7e4dd` | `#5b6479` |
| Paint (white / yellow) | `#fbfbfa` / `#f0c75a` | `#c3c9d6` / `#c6a75c` (dimmed, no glare) |
| Bus / cycle tint | `#cf8c80` / `#9ccf9c` | `#6c4a55` / `#3f6a5d` |

Unlit, like the basemap they cover; under the city sky (and so always in the
detailed look, which draws in the sky's light) lit exactly as the sky's ground
pass lights the basemap — sun × shadow + sky, `^1/2.2`, then haze — so the
buildings' shadows fall on the streets.

## Budgets, measured

Mesher in Bun 1.4.2, warm, one core of a loaded 32-core machine; in the
browser, headless Chromium on SwiftShader on the same machine (a ceiling, and
noisy):

| | Manhattan 15/9650/12314 (Rockefeller) | Barcelona 15/16580/12238 (Eixample) |
| --- | ---: | ---: |
| Mesher, warm (Bun) | 99–148 ms | 103 ms |
| Worker job in the browser (3×3 fetch excluded, SwiftShader rendering beside it) | 120–440 ms | 145–730 ms |
| Surface triangles / marking triangles | 52 k / 13 k | 42 k / 15 k |
| Simplified level (surfaces / markings) | 21 k / 10.7 k | 18.5 k / 10.7 k |
| Buffers per tile (transferred) | 2.8 MB | 2.6 MB |
| Crossings / stop lines / arrows / names / words | 232 / 120 / 49 / 105 / 47 | 223 / 95 / 148 / 88 / 60 |

| Budget | Value | Where |
| --- | --- | --- |
| Tiles drawn | ≤ 16 (two draw calls each, so ≤ 32) | `STREET_BUDGET.maxTiles` |
| Meshes cached | 32, least recently used evicted | `maxCached` |
| Requests in flight | 3, one worker | `maxInFlight` |
| Ground grids sampled per frame | 2 new ones (≈ 1,000 terrain reads each); grids the engine already holds are free | `groundsPerFrame` |
| Typical street view (z18.4, 55°) | 2 tiles, ~115 k triangles, 4 draw calls | — |
| Main thread per frame | selection + placement only; measured within the city engine's `frameCpuMs` (2–15 ms on SwiftShader, dominated by the GPU emulation) | — |

Not measured: a real GPU, and a mid-range Android device (the city's Phase 1
device gating applies here too).

## What the flag costs when off

`expo export --platform web --clear`, no map variables set, `origin/main`
(`9fa9142`) against this branch, separate Metro caches:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 7,010,105 B (1,763,734 gz) | 7,010,316 B (1,763,767 gz) | +211 B, +33 B gz: the registry entry |
| `__common` (first paint) | 100,520 B | 100,520 B | identical size |
| `city3dLayer` (lazy) | 32,890 B | 35,213 B (+688 B gz) | the option, palette, glyph template |
| `lazyChunk` (lazy, three.js) | 4,603,365 B | 4,613,161 B (+2.7 KB gz) | renderer and shaders |
| `streetWorker` (sealed worker) | — | 86,402 B (30,303 gz) | decoder, mesher, atlas; started only with the feature on |
| `simWorker` (sealed worker) | 84,706 B | 87,724 B (+940 B gz) | the shared decoder reads the street properties too |
| `MapSettings…` (lazy, first open) | 258,951 B | 262,103 B (+885 B gz) | the name and description in 12 languages |

Nothing reaches first paint but the registry entry; the renderer and its
worker load only through `components/engine3d/lazyChunk.ts`
(`engine3dChunk.test.ts` pins it), and the shared road code lives in
`engine/roads/`, outside `cityLife/` (`cityLifeIsolation.test.ts` pins that the
simulation itself is still reached by nothing but the lazy chunk).

## Limits and next steps

- **Width is estimated** where `width` is not recorded (most roads): lanes ×
  class lane width. Separately mapped sidewalks then reach for that estimated
  kerb; where the estimate is wider than the street the sidewalk is clipped,
  where narrower a strip of the basemap shows between.
- **Junction clusters** (dual carriageways, slip roads) are joined node by
  node, so their polygons overlap (harmless: one colour); lane lines of one
  carriageway can run into the other's junction near a cluster.
- **Bridges** are left to the basemap; **tunnels** are hidden.
- **Turn lanes** are read per way end; `change:lanes` (solid lines before a
  junction), `placement`, `lanes:both_ways` (centre turn lanes), speed bumps and
  bus stops are not read yet.
- **Separate cycleways** (`highway=cycleway`) are not drawn: the road layer
  does not keep them (they are neither car nor foot ways).
- **Names** are placed once per link, on its straight middle; curved streets
  get no name.
- **Native**: none — the city layer's custom-layer limit (`MAP_3D_CITY.md`).

# City life: simulated traffic and people on the real street network

Cars and people moving in real time through the 3D city, on the streets
OpenStreetMap records: keeping to their side of the road, obeying one-way
streets and recorded turn restrictions, queueing at signals, slowing for turns,
and walking the pavements and crossings. The idea is Valdrada's ("simulates
traffic and pedestrians on the city's street network") and Procedural Tokyo's
("cars drive on the real road graph, keep left, obey signals and one-way
streets"); the data, the compiler and the renderer are GoWay's.

**It is a simulation, labelled as one, off by default, web only.** Nothing here
is real traffic, and nothing GoWay computes or shows is derived from it (see
[Honesty](#honesty)).

## Turning it on

Three flags, each a refinement of the one before, all off in production:

| Flag | Build switch | Per tab, development builds only |
| --- | --- | --- |
| City 3D | `EXPO_PUBLIC_MAP_CITY3D=1` | `?city3d=1` |
| City tiles | `EXPO_PUBLIC_MAP_CITY_TILES=1` | `?cityTiles=1` |
| **City life** | `EXPO_PUBLIC_MAP_CITY_LIFE=1` | `?cityLife=1` |

`lib/map/cityLifeFlag.ts` requires both of the others: the simulation is drawn
by the city-3D engine and drives on road tiles compiled beside the city tiles.
All three are entries in the map-feature registry ([`MAP_FEATURES.md`](./MAP_FEATURES.md)),
so in a development build they can also be switched in the layers panel's Labs
(`?labs=1`); city tiles and city life are offered there only in development
builds until the archives are served.

```bash
# 1. Compile the road archive (same extract, same z15 grid as the buildings).
bun run --cwd packages/frontend map:city-roads --pbf=$HOME/osm-data/cataluna.osm.pbf --area=barcelona
# 2. Serve both archives from the dev server: the route tells them apart by
#    their `goway:kind` metadata.
GOWAY_CITY_TILES_ARCHIVE=$PWD/packages/frontend/.tiles/city-barcelona-z15.pmtiles,$PWD/packages/frontend/.tiles/city-roads-barcelona-z15.pmtiles \
  bun run --cwd packages/frontend web
# → http://localhost:8081/?city3d=1&cityTiles=1&cityLife=1&lat=41.3932&lng=2.1636&zoom=18.5&pitch=55
```

Agents appear from zoom 15.5 (where the 3D buildings finish fading in).

## Where the road graph comes from

Two candidates: read the basemap's OpenMapTiles `transportation` layer at
runtime (no new data), or compile a road layer from the same OSM extract as the
city tiles. Measured on the same two tiles `MAP_3D_CITY.md` uses, decoded with
the client's `@mapbox/vector-tile`:

| z14 `transportation` | Barcelona 14/8290/6119 | Lower Manhattan 14/4824/6157 |
| --- | ---: | ---: |
| Line features | 1,396 | 1,097 |
| Line ends | 3,915 | 3,485 |
| … landing on another line's INTERIOR (a T-junction the tile does not split) | 1,122 (29%) | 557 (16%) |
| … meeting nothing (cut at the tile edge or simplified away) | 1,396 (36%) | 1,748 (50%) |
| Attributes | `class`, `subclass`, `oneway` (=1 only), `brunnel`, `ramp`, `service`, `access`, `surface`, `layer`, `level`, `indoor`, `bicycle`, `foot`, `horse` | same, + `toll`, `network` |
| Lanes, maxspeed, signals, crossings, sidewalks, turn restrictions | **none** | **none** |

So the basemap gives a class and a one-way flag on merged, simplified lines whose
topology has to be guessed back from coincident vertices, and no pavements at
all (Barcelona's tile carries 50 footways; its compiled roads carry thousands of
mapped sidewalks). **Decision: compile.** `scripts/build-city-roads.ts` +
`scripts/citygen/roads.ts`, schema `lib/map/cityRoads.ts`:

- Every `highway` way the simulation can use (car classes, footways, paths,
  steps, pedestrian streets, living streets), with `oneway` (implied for
  motorways and roundabouts), `lanes`/`lanes:forward`/`lanes:backward`,
  `maxspeed` (km/h; `mph` converted; country-implicit values like `ES:urban`
  refused), `sidewalk*`, `footway=sidewalk|crossing`, tunnels, and access
  (`private`, `motor_vehicle=no`, parking aisles and driveways are not roads a
  simulated car uses).
- `highway=traffic_signals|crossing|stop|give_way` nodes, and node-via
  `type=restriction` relations (`no_*`/`only_*`; via-way restrictions are
  skipped and counted).
- **Topology is exact by construction.** Each way is split at every node it
  shares with another kept way, at every tagged node, and at every z15 tile
  edge; each piece goes to the one tile it lies in. A piece's ends are the only
  graph nodes, joined by their global tile-unit position — the same integer
  from either tile, because a tile's origin is a whole multiple of the extent.
  A bridge shares no node with the street under it, so it never joins it.
- Way ids are written only for the ways a restriction names: on every piece
  they were a third of the archive.

**Its own archive** (`/map/city-roads/{z}/{x}/{y}.pbf`, `goway:kind=roads`),
not three more layers in the building tiles: measured on Barcelona, putting
them in the building tiles added **+72% gzip to every building tile** (4.45 MB
over 6.16 MB), paid by everyone who draws 3D buildings for a feature few turn
on.

| Road archive | Barcelona bbox | Manhattan bbox |
| --- | ---: | ---: |
| Compile (one core, Bun 1.4.2) | 16.6 s | 38.2 s |
| Archive | 3.05 MB, 297 tiles | 2.20 MB, 173 tiles |
| Tile gzip p50 / p95 / max | 6.4 / 26.8 / 34.4 kB | 13.3 / 24.0 / 42.6 kB |
| Ways (car / foot) | 109,646 (27,464 / 85,125) | 88,390 (18,139 / 70,344) |
| Car ways with `lanes*` / `maxspeed` / `sidewalk` / one-way | 58.3% / 69.9% / 15.5% / 73.7% | 61.1% / 53.4% / 51.6% / 64.5% |
| Signals / crossing nodes / stops | 7,324 / 31,517 / 668 | 5,869 / 25,818 / 2,398 |
| Mapped sidewalks / crossing ways | 29,246 / 22,016 | 29,734 / 22,285 |
| Node-via restrictions (via-way, skipped) | 2,133 (204) | 1,199 (3,441) |

Both cities are rich: Barcelona's lanes and speeds, Manhattan's sidewalks and
crossings. A town with none of these tags still simulates — on class defaults —
and looks emptier on its pavements, which is the honest outcome.

## The simulation

All of it in `components/map/engine/cityLife/sim/`, pure TypeScript, run in a
Web Worker (`simWorker.ts`) at a **fixed 20 Hz step** from a **fixed seed**:
the same tiles and views produce the same city, step for step (a test asserts
it). `Math.random` is not used anywhere in the folder.

### The lane graph (`network.ts`)

1. **Links**: drivable pieces chained across every node only two of them meet
   at, junction to junction. Signals and crossings inside become stops along it.
2. **Lanes**: per direction, the recorded `lanes*` counts (else 1, or 2 for
   motorways, trunks and one-way primaries/secondaries — simulation defaults,
   never written back as data), 3.2 m wide (3.6 m on motorways), offset to
   **the side the country drives on** (`drivingSide.ts`: a coarse table of
   left-hand-traffic boxes, checked against the capitals near their borders —
   approximate at a border, and documented as such), trimmed back from each
   junction until they clear every other road meeting there — two roads at
   angle θ are `2·d·sin(θ/2)` apart at distance d, so a crossroads takes a few
   metres and a slip road peeling off at a shallow angle up to 40 m.
3. **Connectors**: a cubic Bézier from each incoming lane to each outgoing
   direction it may take. No U-turn except at a cul-de-sac; none at all where
   the network was cut by the edge of what is loaded (cars leave there).
   Kerb lane for the kerb-side turn, inner lane for the far one. Recorded
   `no_*`/`only_*` restrictions applied.
4. **Conflicts**: two connectors of a junction conflict when their curves cross
   or they merge into one lane; two leaving the same lane never do.
5. **Signals**: a junction is signalised when a signal node is on it or within
   30 m (OSM usually tags the stop line, not the junction); junction nodes
   within 25 m of each other (a dual carriageway, an Eixample chamfer) share one
   controller. Two phases split by approach axis, 18–30 s green each, 4 s
   amber-and-all-red between, a seeded offset per junction. A signal with no
   junction near it is a mid-block pedestrian light.
6. **Crossings**: where a `footway=crossing` meets a road, or a crossing node is
   tagged: every lane over it gets a stop that holds while anyone is on it, and
   near a signalled junction people cross only on the crossed road's red.
7. **Footways**: walkable pieces as they are, plus a virtual pavement on each
   side a road's `sidewalk` tag records (never where it says `separate`, which
   means the pavement is mapped as its own way).

### Cars (`traffic.ts`)

- **Intelligent Driver Model** (Treiber, Hennecke & Helbing 2000; a = 1.4 m/s²,
  b = 2.2 m/s², T = 1.2 s, s₀ = 2 m, δ = 4) against the nearest thing ahead
  along the car's planned route: the car in front, or a stop line (red light,
  occupied crossing, a junction it could not reserve). Desired speed: recorded
  `maxspeed`, else a class default, times a per-driver 0.85–1.08; slower into
  turns (the speed from which comfortable braking reaches the turn's 6 m/s).
- **No overlaps, ever**: besides IDM, each step's advance is clamped to the gap
  measured at the start of the step (the leader only moves forward). Asserted
  over 2,400 steps of a busy signalled grid in the tests, and measured as zero
  over 120 s of Barcelona at full budget by `scripts/bench-city-life.ts`.
- **Junction reservation**: a car enters a junction only after reserving its
  connector — phase green, no conflicting connector reserved or occupied, room
  on the lane beyond (never block the box). Through lanes shorter than 20 m
  (between the nodes of one junction) the whole chain is reserved at once, so
  nobody stops inside a junction. Followers on the same lane queue through
  behind their leader.
- A car that has stood still 60 s (120 s in view) leaves: gridlock in a model
  this simple is possible, and this is the honest way out.

Measured on 600 cars over 60 s of Barcelona's Eixample (`bench-city-life.ts`):
**64% moving, 17% waiting at a red, 11% queued behind another car**, the rest
at crossings and junctions; Lower Manhattan 73% moving. Before chain
reservations, cars stopped *inside* junctions on the 3–5 m lanes between
junction nodes (8% of all car-time); that is what the 20 m rule fixed. The
angle-aware trimming above then took the same 600 cars from 9.4 to 12.8 km/h
and from 17 cars giving up stuck per minute to none: lanes of a slip road and
its main road no longer met head-on inside one another's junction.

### People (`pedestrians.ts`)

Walkers at 1.05–1.6 m/s, each a little to one side of the centre line, choosing
a new edge at every node (never straight back unless it is a dead end). At a
crossing they wait at the kerb until it is theirs: on the crossed road's red at
a signal, or while no car is about to pass otherwise. People do not avoid each
other; at a person's size on the map the lateral offset keeps them from visibly
overlapping.

### Density, budget, spawning (`simulation.ts`)

- An **active radius** around the camera: 800 m at z17, doubling per zoom out
  (250 m–1.8 km). Road tiles are loaded to 400 m beyond it (at most 25).
- **Targets**: 22 cars per lane-km and 26 people per footway-km inside the
  radius, times a zoom factor (full from z17, a fifth at z15.5), capped by the
  **budget: 1,200 cars and 1,200 people** (`city3dLayer.web.ts`).
- New agents appear **outside the visible box** when there is road there, and
  fade in over 0.6 s; surplus ones leave from outside it first, fading out.
  The first fill after a network loads places everyone and runs 12 s of
  simulated time before the first frame, so the city opens already moving.
- Panning rebuilds the network from what is loaded; agents are carried across
  **by position** (snapped to the nearest path heading their way within 3 m).
  A pan of more than 6 km starts a fresh city.

## Rendering (`lifeRenderer.ts`)

- An **overlay of the city-3D engine** (`engine/city3d/overlay.ts`): the same
  scene, camera, depth buffer, light and terrain as the buildings — one
  renderer, as `MAP_3D_CITY.md` → "One engine, one scene" requires. Buildings
  occlude cars behind them; on 3D terrain agents stand on the SAME ground
  the buildings and trees do — `terrainGround.ts`'s ground grid (the drawn
  terrain, sampled), per z15 tile, read bilinearly.
- **Soft maquette vehicles** (`agentModels.ts`): hatchback, saloon, van, bus
  and — only where a city's taxis wear a statutory livery — taxi. Every body,
  cabin and band is a superellipsoid (a box with every edge and corner
  rounded, between a box and an ellipsoid), so nothing is pointed or
  faceted: smooth averaged normals, a narrower cabin of tinted glass standing
  on the body with a painted roof, short cylinder wheels set under it, a bus
  with a continuous glass band round its rounded front. People are a capsule
  body, a round head and two rounded legs that swing with the distance
  walked. Soft pastel paints weighted to the whites, greys and silvers real
  fleets are mostly made of. No third-party models, textures, badges or
  lettering.
- **Two levels of detail per model, chosen on the GPU**: near meshes are
  592–792 triangles (a person 252), far ones ≤ 96 (a person 36). Each
  instance's on-screen size is estimated in the vertex shader (the centre's
  CSS pixels per metre scaled by depth); under 22 px, or off screen, it draws
  far. Both meshes read the same instance buffers.
- **Matte light and a contact shadow**: wrapped diffuse from the map's own sun
  plus a hemisphere fill (cool sky, warm street bounce), and a soft
  superellipse shadow blob (2 triangles, blended, depth-tested) under every
  vehicle and person.
- **Taxis** (`sim/liveries.ts`): Barcelona's black with yellow doors and New
  York's yellow are municipal liveries, not an operator's brand, so the
  simulation's generic taxi wears them there — about 6% of cars. Anywhere
  else there are no taxis at all (their slots are saloons): a plausible local
  taxi a city does not have would be invented detail.
- **Positions are interpolated on the GPU.** The worker streams each step's
  `x, y, heading, scale` per slot as transferable buffers; the vertex shader
  places every instance between the previous and the latest step (`uAlpha`),
  drawing the city 100 ms in the past so a late message slows motion instead of
  jerking it. Per frame the main thread sets one uniform.
- **Repaint**: MapLibre draws only when asked; while agents are visible the
  overlay asks at most every 33 ms (30 fps). Hidden tab, zoomed out or faded
  buildings: the worker pauses.

## Honesty

`MAP_3D_CITY.md` → "Procedural detail is styling, never fact" governs
buildings; the same rule, stronger, governs this:

- **It is labelled.** A "Simulated traffic" label (`cityLifeChip.web.ts`,
  English and Spanish; its accessible text says the cars and people are a
  simulation and not live traffic) is on screen **for exactly as long as any
  agent is drawn**: it is shown and hidden by the renderer's own
  `onActiveChange`, not by a flag a screen could read differently.
- **It is never read.** Nothing leaves the worker but positions and paint for
  drawing. No route, ETA, search result, place screen, statistic or server
  request uses it. `components/__tests__/cityLifeIsolation.test.ts` fails if
  anything outside `engine/cityLife/` other than the lazy engine chunk imports
  it.
- **It never looks like live data**: no congestion colouring, no counts, no
  "traffic" layer styling; generic vehicles, no operator liveries, no buses
  in a real operator's colours; taxis only in a city's statutory taxi colours.
- **What is real and what is not**: the streets, their directions, lane
  counts, speed limits, signals, crossings, pavements and turn restrictions are
  OpenStreetMap's. The agents, their routes, timings, signal phases and every
  default standing in for a missing tag are simulation parameters.

## Performance

Measured in Bun 1.4.2 on the development machine with `scripts/bench-city-life.ts`
(real road archives, 120 s of simulated time, the shipped budget of 1,200 cars
and 1,200 people) and in headless Chromium. The machine was shared with other
builds (load average 30–58 on 32 cores); quiet runs were 1.5–3× faster than
the loaded ones, so both are given.

| | Barcelona, Eixample (z17) | Lower Manhattan (z17) |
| --- | ---: | ---: |
| Road tiles in the network | 25 (bench) / 10 at z17.5 in the browser | 17 / 8 |
| Lanes / connectors / signal controllers | 10,629 / 13,941 / 1,533 | 4,931 / 6,968 / 613 |
| Network build | 166–377 ms (Bun); 120–250 ms in the browser's worker | 124–269 ms |
| Step | p50 0.8–2.1 ms, p95 2.3–3.2 ms | p50 1.5–2.2 ms, p95 2.4–4.4 ms |
| Warm-up (12 s simulated, once per fresh network) | 240–630 ms | 510–800 ms |
| Cars moving / mean speed / overlaps | 51% / 10.5 km/h / **0** | 56% / 11.6 km/h / **0** |
| Cars that gave up stuck (2 min) | 54 of 1,200 | 28 of 1,200 |
| Frame message | 48 kB per step (≈1 MB/s, transferred, not copied) | same |
| Triangles drawn (counted by the renderer's dev stats, the shader's LOD test replayed on the CPU) | z17.2, 1,200 + 1,200 agents: 7 k near + 155 k far + 5 k shadow (the first, all-box fleet: ≈ 120 k); z19 Passeig de Gràcia, 206 + 166: 51 k near + 19 k far (first fleet ≈ 19 k) — vs 0.66–1.4 M for the buildings | same |

The step is 2–6% of its 50 ms budget; the network build is the largest single
cost and runs in the worker. The real cost is the **repaint**: with agents on
screen the whole map is redrawn at up to 30 fps instead of only when the camera
moves. SwiftShader in headless Chromium manages 4–9 fps for the whole map, which
says nothing about a GPU; a perf budget on mid-range Android Chrome belongs with
Phase 1 of `MAP_3D_CITY.md` (device gating) before any of this is turned on.

Verified in headless Chromium (SwiftShader) on `expo start --web` with both
cities' building and road archives: Eixample (Passeig de Gràcia, Carrer de
València) and Lower Manhattan, pitched and top-down, frame sequences showing
cars moving with the one-way arrows, queueing at junctions, and people on the
pavements.

## What the flag costs when off

Measured with `expo export --platform web`, no flags set, this branch against
the `main` it is rebased on (28d10da), separate Metro caches, `--clear`:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,962,712 B | 6,962,712 B | identical but for the build id and lazy-chunk hashes |
| `__common` (first paint) | 78,516 B | 78,516 B | identical once module ids are normalised |
| `city3dLayer` (lazy) | 11,162 B (4,486 gz) | 15,568 B (5,958 gz) | flag, label, overlay wiring; never requested with city-3D off |
| `lazyChunk` (lazy, three.js) | 3,581,212 B (1,141,608 gz) | 3,613,553 B (1,153,578 gz) | renderer, shaders, models: +12 kB gz |
| `simWorker` (sealed worker) | — | 67,609 B (23,270 gz) | the whole simulation; started only with city life on |

Nothing new reached first paint: the flag was read only by the lazy adapter
(`cityLifeFlag.ts`, like `cityTilesFlag.ts`; since the map-feature registry it
is decided there, at first paint, and handed to the adapter — `MAP_FEATURES.md`
measures the registry), the renderer and its worker load
only through `components/engine3d/lazyChunk.ts`, and
`components/__tests__/engine3dChunk.test.ts` pins that.

## Hosting

Nothing is served in production. Serving the road archive means exactly what
the city tiles need (`MAP_3D_CITY.md` → Hosting): build from the same planet
snapshot, upload under a versioned key, a Worker route for
`/map/city-roads/{z}/{x}/{y}.pbf`, and — it is a Derivative Database of
OpenStreetMap under the ODbL — publish the archive and its receipt before the
flag is turned on for anyone.

## Limits and next steps

- **Junction model**: one reservation per junction, no gap acceptance, no
  priority by road class, no yellow-box subtlety; a junction cluster is joined
  by the 20 m rule rather than geometrically. Lanes stop short of a junction
  until they clear every road meeting there (`(w₁ + w₂) / 2·sin(θ/2)`, up to
  40 m where a slip road peels off), but two separately mapped carriageways
  drawn closer together in OSM than their lanes are wide still overlap. Roundabouts work as a ring of
  one-way links with ordinary junctions.
- **Lanes**: no lane changes between junctions; lane choice happens at the
  junction (kerb lane turns kerb-side). `turn:lanes` is not read yet — it would
  make lane choice recorded rather than assumed.
- **Lanes are drawn at their real offsets**, so on a broad avenue cars spread
  wider than the basemap's cartographic road line at high zoom, though always
  between the building faces.
- **People** do not avoid each other, do not enter buildings, and only cross
  where a crossing is mapped or a virtual pavement turns a corner.
- **No night**: headlights would need a night state from the sky work; none is
  assumed.
- **Not native**: like the city-3D layer it is web only.
- **Next**: `turn:lanes`, bus routes from `route=bus` relations (with stops),
  speed bumps and `traffic_calming`, junction clusters joined geometrically,
  and the device perf budget above.

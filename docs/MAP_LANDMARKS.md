# 3D landmarks

Hand-crafted, recognisable, stylised 3D models of famous buildings, drawn in
the city-3D scene in place of their OpenStreetMap buildings, lit by the real
sun by day and glowing at night, with a landmark **tour**: a full-screen
orbit camera, the landmark's name and category as a caption, and ◀ ▶ / play
to move between a city's landmarks. Web only, **on by default**
since 2026-10-12 (the map-feature registry's `landmarks`,
[`MAP_FEATURES.md`](./MAP_FEATURES.md)) — but a model draws only over
published city tiles, so the adapter keeps only the landmarks it can draw —
over a WHOLLY published z14 cell (the engine's own source rule: at a region's
ragged edge the cell is the basemap's), with a model that has not failed to
load — hands exactly those to the engine, and offers exactly those to the
tour and its pill (`city3dLayer.web.ts` → `drawableLandmarks`,
`lib/map/landmarks/load.ts` → `offerLandmarks`; `drawableLandmarks.test.ts`). Where nothing is published
(goway.to until its first region) there is no pill, no tour and no request
for a model.

It builds on two earlier pieces: the city-3D engine and GoWay city tiles
([`MAP_3D_CITY.md`](./MAP_3D_CITY.md)) and the coordinate-anchored model
layer ([`SDK_MAP_MODELS.md`](./SDK_MAP_MODELS.md), phase 1). A landmark is a
model of that layer — the same loader, frames, budgets and placement contract
— drawn in the buildings' pass, replacing the buildings it stands for.

## What ships

Twelve landmarks, every one GoWay's own procedural work (no third-party
asset, nothing ripped from any provider):

| Landmark | City | Method | Licence | Triangles | GLB |
| --- | --- | --- | --- | ---: | ---: |
| Sagrada Família | Barcelona | osm-enriched | CC0-1.0 | 30,320 | 242 kB |
| Torre Glòries | Barcelona | osm-enriched | CC0-1.0 | 14,592 | 128 kB |
| Casa Batlló | Barcelona | osm-enriched | CC0-1.0 | 25,544 | 165 kB |
| Casa Milà | Barcelona | osm-enriched | CC0-1.0 | 38,242 | 241 kB |
| Arc de Triomf | Barcelona | osm-enriched | CC0-1.0 | 9,640 | 90 kB |
| Museu Nacional d'Art de Catalunya (Palau Nacional) | Barcelona | osm-enriched | CC0-1.0 | 11,372 | 106 kB |
| W Barcelona | Barcelona | osm-enriched | CC0-1.0 | 6,081 | 65 kB |
| Statue of Liberty | New York | osm-enriched | CC0-1.0 | 11,750 | 91 kB |
| Empire State Building | New York | osm-enriched | CC0-1.0 | 11,594 | 109 kB |
| Chrysler Building | New York | osm-enriched | CC0-1.0 | 5,548 | 60 kB |
| Flatiron Building | New York | osm-enriched | CC0-1.0 | 2,832 | 38 kB |
| One World Trade Center | New York | osm-enriched | CC0-1.0 | 12,380 | 91 kB |

The authoritative numbers are the registry's (`model.bytes`, `model.triangles`),
which `landmarks:check` holds to the generators.

## The registry

`packages/frontend/public/landmarks/registry.json`, validated by
`lib/map/landmarks/registry.ts` at build time, in the tests and when the app
reads it.

**Why a reviewed data file and not a table.** A landmark is an asset GoWay
authored (or licensed) plus the facts that put it on the map. Nobody writes
one through an API; it changes exactly when its asset changes, ships with the
app as a static file, and its licence and provenance are reviewed in the
same pull request as its geometry. A Drizzle table would add a route, a
moderation surface and a migration for data no caller writes. It becomes the
right home only when landmarks are PLACE-attached models uploaded by people
(`SDK_MAP_MODELS.md` phase 4) — a different feature. It is **not a public
contract**: the SDK draws no map and no third party reads the file. The one
wire type it reuses is the model placement, parsed by the contract's own
`parseModelPlacement`.

Per entry:

| Field | Meaning |
| --- | --- |
| `id` | Stable slug; the asset is `/landmarks/<id>.glb`. |
| `name`, `locality` | The default (local-language) proper name, as `places.name` holds it, and where it is — the caption. |
| `category` | A taxonomy key; its label is the taxonomy's (`GET /categories`), never a copy in code. |
| `osm.element` | The landmark's own element (`way/34633854`), which is what a GoWay Place's `openstreetmap` source names: the place sheet offers the tour on that match, never on a name. |
| `osm.replaces` | Every city-tile building and `building:part` the model replaces. |
| `placeId` | The GoWay Place ID once one is known to hold it, else `null`. |
| `placement` | The contract's `ModelPlacementInput`: anchor, heading (+Z of the asset), altitude, scale. |
| `model` | Path, generator, and the asset's measured `bytes`, `sha256`, `triangles` and `boundsMeters` (written by the build). |
| `night.uplight` | The floodlight wash on the stone at night: colour, reach (m), strength. |
| `licence` | `spdx` (allow-list: CC0-1.0, CC-BY-4.0, CC-BY-3.0), `method`, `author`, `source`, `credit`, `derivedFrom`, `verifiedAt`, `notes`. |
| `tour` | Orbit zoom (≥ 16.5, where the city is fully drawn), pitch (≤ 60, the canvas's limit), seconds per orbit, the height the camera looks at, and `startAngle` — where round the orbit it opens, for a facade a taller neighbour hides (Chrysler behind One Vanderbilt). |

## Sourcing and licence policy

Preference order, recorded per entry in `licence.method`:

1. **`procedural`** — geometry code GoWay wrote (`scripts/landmarks/models/`),
   output GLB. Zero licence risk; the cleanest stylised look. CC0-1.0.
2. **`osm-enriched`** — GoWay's code over OpenStreetMap's own recorded
   geometry: footprints, `building:part` plans and heights, read from the
   city tiles' extract and written into the generator as constants. A
   Produced Work of an ODbL database; the map's "© OpenStreetMap" credit,
   already on every frame, covers it (`derivedFrom: ["openstreetmap"]`). All
   twelve are this: the massing stands exactly on the footprint it replaces,
   and everything else (ornament, windows, lights) is authored.
3. **`third-party`** — a licensed model from an outside author, ONLY under
   CC0 or CC BY, verified on the source page (URL in `licence.source`,
   `verifiedAt`), with the credit text CC BY obliges in `licence.credit`. The
   schema refuses NC, ND, "unknown" and anything off the allow-list, a CC BY
   entry without a credit, and a third-party entry without an https source.
   None ships today.

Never: assets or geometry from any map provider's apps or tiles (Apple's
included), scraped, reverse-engineered or "found" models, or anything whose
licence nobody checked. The LOOK is Apple's idea; nothing else is.

**Credits.** A CC BY model's credit joins the data credit (`MapAttribution`)
while — and only while — the model is drawn: the adapter reports the drawn
landmarks' credits (`landmarkCredits`) and `MapCanvas` passes them to the one
credit line no screen can drop. GoWay's own CC0 work owes none.

**Honesty.** `MAP_3D_CITY.md` lets the city draw only what OSM records. A
landmark is different in kind: a curated, reviewed representation of one
famous building, labelled as a model by the tour. Its ornament and its night
lighting are **styling** — the stylised, Apple-like map — not a record of the
building's real windows or floodlights. The rules that still hold: no text,
signage, logos or brand marks on any model (no "W" on the W), no invented
business detail, and the massing follows the OSM record where one exists.

## Modelling workflow

Generators are TypeScript in `packages/frontend/scripts/landmarks/`:

| File | Role |
| --- | --- |
| `kit.ts` | Geometry builders over three.js's geometry classes (build-time only): chamfered prisms, lofts, lathes, spires, panels on facade frames, window grids and runs, piers, radial repeats. Flat-shaded where flat, smooth where it turns. |
| `palette.ts` | The shared maquette palette: matte stone, brick, glass, steel, copper, gold; the night colours. |
| `glb.ts` | The writer: one mesh, one primitive per material, positions int16 / normals int8 (`KHR_mesh_quantization`, one uniform scale so normals stay true), every buffer meshopt-compressed (`EXT_meshopt_compression`), deterministic bytes. |
| `models/*.ts` | One generator per landmark (plus shared helpers `nycKit.ts`, `bcnModernKit.ts`, `bcnGaudiKit.ts`). |
| `../build-landmarks.ts` | Builds every generated landmark, enforces the budgets, writes the GLBs and the registry's measured fields; `--check` compares; `--only=<id>` writes one GLB and leaves the registry alone (the modelling loop). |

Frames are glTF's (`SDK_MAP_MODELS.md`): metres, +Y up, the model's front
(+Z) facing its `heading`, origin at the base of the anchor. Read the OSM
parts in that frame, align the model against them in a preview, then write
the plans in.

Style: matte maquette materials, clean massing with chamfered edges that
catch the light, glass and metal as accents, windows as separate geometry in
a lit and an unlit material (a seeded hash, so the night pattern is
deterministic), colour from the palette.

### Night

Materials carry their night behaviour in glTF `extras`, so the runtime knows
nothing about which model is which (`components/map/engine/city3d/modelLook.ts`):

- `goway.night = { color, strength }`: emitted × the night factor — windows,
  crowns, lanterns, the torch, Torre Glòries' LED skin.
- `goway.uplight = { color, reach, strength }` (from the registry's
  `night.uplight`): a floodlight wash patched into the shader, strongest at
  the base and on walls, fading over `reach` metres.

At night the sun and the sky light also dim and turn blue, so the warm light
is what the eye reads. The input is **`nightFactor`** (0 day … 1 night),
the same name and meaning as the city sky's (`feat/city-sky`); until that
lands, `lib/map/landmarks/night.ts` is the placeholder: the dark map is the
night map, and given the sun's altitude a light map darkens through the sky's
own fade (−1° → −9°). The adapter hands it to the engine; the sky will call
`City3dHandle.setNightFactor`. Generic floodlit/window glow on ordinary OSM
buildings belongs to the sky and art work, not here.

## Budgets

| Budget | Value | Enforced by |
| --- | --- | --- |
| Per landmark GLB | ≤ 1 MB (the model layer refuses > 2 MB) | `build-landmarks.ts`, the registry test |
| Per landmark triangles | ≤ 50,000 (the model layer's cap) | same |
| Landmarks in the scene | ≤ 8, those within 3 km of the view (kept to 4 km) | `city3dLayer.web.ts` (`landmarksForView`) |
| Distinct assets per page | ≤ 20 (the model layer's cap; assets are kept for the page's life) | `models.ts` |

The twelve together are ~1.5 MB; a view loads only the nearby ones, so a
Barcelona view downloads at most the seven Barcelona models (~840 kB).
LODs: not yet — each landmark is one GLB; a `lite` file per landmark for far
views and preview-class devices is the next step (`SDK_MAP_MODELS.md`'s
`lite` role).

## Rendering

- **One engine.** Landmarks are a second instance of the model layer inside
  the city engine (`cityEngine.ts`), drawn right after the city tiles, in the
  buildings' pass: under the route line like every building, depth-tested
  against the city and the basemap, lit by the map's own sun light (the same
  `CityLight` the city follows).
- **Replacing buildings, never deleting them.** The adapter hands the engine
  the landmarks near the view with their `hides` (city-tile feature ids,
  `osmId × 10 + 2|3`). The engine hides a landmark's buildings only while its
  model is DRAWN: the mesh worker skips those ids (`withoutHidden`), and the
  tiles that can hold them (`tilesAround`, the anchor's z15 tile and its
  neighbours) are re-meshed, each old mesh staying on screen until its
  replacement arrives. Every change to the hidden set is versioned, so a tile
  whose request was already in flight with the old set is meshed again (the
  first in-app run missed exactly that, and Torre Glòries stood inside its
  own OSM cylinder). A GLB that is slow or fails leaves the city's own
  buildings standing.
- **On the terrain.** Landmarks stand on the drawn ground like every model
  (`models.ts` → `setGround`), so the Palau Nacional sits on Montjuïc.
- **Needs city tiles.** Only GoWay's per-building tiles carry OSM ids; on the
  OpenMapTiles fallback (blocks unioned) nothing could be replaced cleanly, so
  landmarks are not drawn there.

## The tour

`features/landmarks/` (one lazy chunk), entered from the "Landmarks" pill (when
a landmark is within 6 km of the view; opens on the nearest; it sits in the
map's top-right stack, under the settings button) or from a place
sheet's "Landmark tour" (when the place IS a landmark, by its OSM source or
Place ID). The camera is driven through the map seam only (`MapApi.moveTo`,
`transient` per frame) — the feature imports neither three.js nor MapLibre:

- **Order**: from the chosen landmark, always on to the nearest not yet
  visited, within 40 km (one city). ◀ ▶ walk it, wrapping.
- **Lens**: the tour narrows the camera to a 22° field of view
  (`MapCameraOptions.fieldOfView`, web only; the map's own 36.87° comes back
  when it closes). At one zoom the scale at the centre is the same, but the
  camera stands ~1.7× farther back: perspective flattens into the maquette
  look, and a 400–540 m tower fits the frame at zoom 16.5 — where the city is
  fully drawn — instead of rising past the top of the screen. With the
  default lens the Empire State's crown sat above the camera itself.
- **Orbit**: the camera starts facing the main facade (turned by
  `startAngle`) and circles once per `tour.orbitSeconds`, its ground centre
  pushed `lookAtMeters · tan(pitch)` on so the landmark's middle, not its
  foot, is centred. Play moves on after one orbit; a drag, pinch or rotate
  pauses it.
- **Transitions**: eased flights whose length grows with distance
  (1.6–5 s), lifting (zoom out, pitch eased) in the middle of a long hop.
- **Reduced motion**: no orbit and no flight; each landmark is a still, cut
  to, and play steps every 6 s.
- The sheet, panel and floating controls step aside while touring; the mark
  and the data credit stay (the caption claims the bottom edge, so the credit
  rises above it).

## What the flag costs when off

Measured with `expo export --platform web --clear`, no flags set, `origin/main`
(`09ee48b`) against this branch rebased on it, separate Metro caches; sizes
raw (gzip -9), chunk hashes normalised:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,968,598 B | 6,971,234 B (+2,636 B; +772 B gz) | the two flag checks, two `import()` stubs, the place-card action slot, the canvas's credit state and lens option |
| `__common` (first paint) | 81,624 B | 81,624 B | identical |
| `city3dLayer` (lazy) | 11,954 B | 13,866 B | landmark selection and night; requested only with city 3D on |
| `lazyChunk` (lazy, three.js) | 3,626,598 B | 3,659,669 B (+9.7 kB gz) | the meshopt decoder, `modelLook.ts`, the landmark layer |
| `meshWorker` (sealed) | 81,786 B | 82,518 B | the hidden-id filter |
| `features/landmarks/lazy` | — | 14,062 B (5.4 kB gz) | the tour UI; requested only with the landmarks flag |
| `lib/map/landmarks/load` | — | 4,882 B (1.9 kB gz) | the registry reader; same |

The registry and the GLBs are static files, fetched only by a page with the
flag on. `components/__tests__/landmarksChunk.test.ts` pins the chunk rules:
the tour UI only through `features/landmarks/lazy.ts`, the registry reader
only through `import()` from its two users (so it is not hoisted into
`__common`), and nothing of the feature reaching three.js, MapLibre or an
engine.

## How to add a landmark

1. **Find its OSM data.** The landmark's element (the Place's source) and the
   city-tile buildings/parts it replaces: compile or reuse a city-tile archive
   and list the features around it (the compiler's ids are the elements).
2. **Add a registry entry** with `id`, `name`, `category`, `locality`,
   `osm`, `placement` (anchor; heading = bearing of the model's +Z), `night`,
   `licence`, `tour`, and `model: { path, generator }`.
3. **Write the generator** in `scripts/landmarks/models/<name>.ts`
   (`LandmarkModel`: materials + `build`), register it in `models/index.ts`.
4. **Iterate**: `bun run --cwd packages/frontend landmarks -- --only=<id>`,
   look at it day and night against the OSM parts, then in the app with
   `?city3d=1&cityTiles=1&landmarks=1`.
5. **Build** (`bun run --cwd packages/frontend landmarks`) — the registry
   gains the asset's bytes, hash, triangles and bounds — and commit the
   generator, the GLB and the registry together. CI runs `landmarks:check`.

A third-party model instead of a generator: CC0 or CC BY only, verified on its
source page, `model.generator: null`, `licence.method: "third-party"`, the
https source and the credit; optimise it to the budgets (quantised, meshopt)
before committing.

## Limits and next steps

- **Native**: none (the city-3D engine is web-only; `MAP_3D_CITY.md` → Native).
- **LOD**: one file per landmark; `lite` files for far views are next.
- **Night input**: a placeholder until the sky's `nightFactor` merges.
- **Picking**: tapping a landmark model does not open it yet; the place sheet
  and the pill do.
- **Coverage**: twelve landmarks in two cities. Each is a few hundred lines of
  generator; quality is judged by eye, case by case.

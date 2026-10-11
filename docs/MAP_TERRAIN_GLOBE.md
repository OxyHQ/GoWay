# Globe, terrain and hillshade

A world that is a **globe** when you zoom out, **real relief** when you look at
mountains, and 3D buildings that **stand on the ground** when both meet. **On by
default** on web, production included, with a native hillshade. Companion to
[`MAP_3D_CITY.md`](./MAP_3D_CITY.md), whose three.js building layer this
places on the terrain.

## On by default, and how to turn it off

| | Kill switch (any build) | Per tab (development builds only) |
| --- | --- | --- |
| Globe, space, glow | `EXPO_PUBLIC_MAP_GLOBE=0` | `?globe=0` (or `=1`) |
| Hillshade + 3D terrain | `EXPO_PUBLIC_MAP_TERRAIN=0` | `?terrain=0` (or `=1`) |

Both are on with no environment at all — which is how the production build
(`.github/workflows/deploy-frontend.yml`) is made: it sets neither variable.
Only an explicit `0`/`false` kills one (`enabledUnlessKilled`), so an empty or
mistyped value cannot switch relief off by accident. A production build ignores
the query parameters both ways (`lib/map/reliefFlag.ts`, pinned by
`reliefFlag.test.ts`), so no goway.to link changes anyone else's renderer.

The elevation tiles come from GoWay's own Worker route,
`https://goway.to/map/terrain/{z}/{x}/{y}.webp` (live since #124).
`EXPO_PUBLIC_MAP_TERRAIN_TILES` overrides the template for a preview.

| Piece | Where |
| --- | --- |
| Flags | The map-feature registry's `globe` and `terrain` (`lib/map/mapFeatures.ts`, [`MAP_FEATURES.md`](./MAP_FEATURES.md)): the kill switches, then the person's choice in the settings modal; `lib/map/reliefFlag.ts` for the development query; read live through `components/map/reliefFlags.ts` (`useMapRelief`) |
| Style fragments (pure, spec-validated) | `lib/map/style/relief.ts` — DEM sources, hillshade, terrain, sky, globe outline, space |
| DEM endpoint, vendor, credit | `lib/map/provider.ts` (`GOWAY_MAP_PATHS.terrain`, `MAPTERHORN_ENDPOINTS`, `TERRAIN_ATTRIBUTION_LINK`, `resolveTerrainTileUrl`) |
| Worker route | `worker/index.js` → `serveTerrain`; `wrangler.toml` (`run_worker_first`, `MAP_TERRAIN_UPSTREAM`, optional `MAP_TERRAIN_ARCHIVE`) |
| Web adapter (lazy chunk) | `components/map/reliefLayer.web.ts`, loaded by `MapCanvas.web.tsx` |
| Buildings on terrain | `components/map/engine/city3d/terrainGround.ts` (pure), `components/map/city3dGround.web.ts` (MapLibre side) |
| Native hillshade | `components/map/MapCanvas.native.tsx` |
| Credit | `components/map/MapAttribution.tsx`; the page it links to, `app/attribution.tsx` (`features/credits/`, notices in `lib/map/credits.ts`) |
| Models on terrain | `components/map/engine/city3d/models.ts` (`setGround`) |

## The DEM

**Decision: Mapterhorn** (<https://mapterhorn.com>), served through GoWay's
Worker now, from GoWay's own R2 bucket for production.

| | Mapterhorn | AWS "Terrain Tiles" (Mapzen/Tilezen) |
| --- | --- | --- |
| Data | Copernicus GLO-30 worldwide to z12; 0.25–10 m national models above it where they exist (much of Europe, Japan, the US) | SRTM-era mosaic, z0–15 (mostly 30 m data stretched) |
| Format | Terrarium WebP, 512 px | Terrarium PNG, 256 px |
| Licence | 151 sources, all attribution-only or public domain (CC BY 4.0, Copernicus, OGL, Etalab, DL-DE…): **commercial use allowed** | Attribution list (ArcticDEM, Geoscience Australia, Kartverket, LINZ, USGS…), commercial use allowed |
| Maintained | Yes — repo pushed 2026-10-08, NLnet-funded | **Frozen**: "regular updates are not planned"; sample tile last modified 2017-11-15 |
| Hot-linking | Public endpoint, CORS `*`, `max-age=604800` — but **no usage policy**, and its privacy policy logs every caller's IP, referrer and user agent for 30 days | Public S3, no policy either way |
| Self-hosting | `planet.pmtiles` z0–12: **356 GB**; with every z13–18 regional file: 9.93 TB | Size unpublished; not worth hosting a frozen dataset |

Also considered: raw **Copernicus GLO-30** (free incl. commercial, but GeoTIFFs
GoWay would have to tile itself — which is exactly what Mapterhorn's z0–12 is);
MapLibre's **demotiles** terrain (one demo tile around Innsbruck, not for
production); MapTiler / Mapbox / Esri terrain (API keys, proprietary terms —
not open).

**Why through the Worker.** GoWay's rule is that the browser only ever talks
to goway.to (`provider.ts` → `GOWAY_MAP_PATHS`). Hot-linking Mapterhorn would
send every viewer's IP and viewport to a third party that logs them, with no
policy saying the traffic is welcome. Through the Worker, Mapterhorn sees
Cloudflare, and Cloudflare's cache answers almost everything. Measured against
the deployed route (2026-10-11): a tile nobody had asked for took 0.52–0.68 s
and came back without `cf-cache-status`; the same tile a second later was
`cf-cache-status: HIT` in ~0.15 s, `cache-control: public, max-age=604800`,
CORS `*`. So the upstream sees each tile about once per Cloudflare location per
week.

**Is the proxy safe for full production traffic?** For launch-scale traffic,
yes: the cache absorbs repeat views, Mapterhorn's endpoint is itself served from
Cloudflare with a week's `max-age`, and the Worker refuses anything past z12 or
outside the world before fetching. What it is not is a contract: Mapterhorn
publishes no usage policy, so GoWay's relief depends on a volunteer service's
goodwill, and each colo's first view of a tile still reaches it. The R2 archive
below removes both and is the **follow-up to do before traffic grows**, not a
nice-to-have.

**Production path** (`MAP_TERRAIN_ARCHIVE`): upload Mapterhorn's
`planet.pmtiles` to the `MAP_TILES` bucket under a dated key and set the var;
the Worker then reads it by byte range with the same `pmtiles.js` reader the
vector tiles use, and no request leaves Cloudflare. Cost on R2: 356 GB ×
$0.015/GB-month ≈ **$5.3/month**, egress free, ~1 class-B read per edge-cache
miss ($0.36 per million). Adding the high-resolution regional files for the
markets that matter is the upgrade path (all of them: ~$149/month).

**`maxzoom` 12.** Mapterhorn is complete to z12 and patchy above; a missing
z13+ tile is a 404 that MapLibre answers by walking up one zoom at a time —
several failed requests per tile across most of the planet. At 12 the source
is complete everywhere and over-zoomed (≈15 m/px at Barcelona's latitude from
30 m data). The Worker refuses z > 12 before fetching anything. Serving the
finer national models where they exist needs a coverage-aware choice of zoom
(Mapterhorn publishes a `coverage-index.pmtiles`); not in this change.

**Credit, and the Copernicus notices.** Every map frame carries `© Mapterhorn`
in the data credit while relief is drawn (now always), on web and native. It
links to GoWay's own **`https://goway.to/attribution#elevation`**, not straight
to Mapterhorn: the Copernicus DEM licence (Article 6) requires, wherever
GLO-30-derived data is shown to the public, the source notice *"produced using
Copernicus WorldDEM-30 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH
2014-2018 provided under COPERNICUS by the European Union and ESA; all rights
reserved"* (6b, for modified data — Mapterhorn's tiles are resampled and
re-encoded), the liability sentence *"The organisations in charge of the
Copernicus programme by law or by delegation do not incur any liability for any
use of the Copernicus WorldDEM-30"* (6c), and no implied endorsement (6d).
Mapterhorn's attribution page names its sources but carries neither notice, and
GoWay had no legal page. So GoWay's attribution page (`app/attribution.tsx`)
shows the basemap credits, `© Mapterhorn` linking on to Mapterhorn's full list,
and the three notices verbatim from `lib/map/credits.ts` — quoted from the
licence PDF Mapterhorn links for `glo30`, never translated or reworded. It is
public, signed-out and reachable from every map, the embed included.

**Caveat: GLO-30 is a surface model.** It includes trees and buildings,
smoothed to 30 m, so a dense city's "ground" sits some metres above the
streets. Everything drawn on the terrain (roads, buildings) is lifted
consistently, so nothing floats relative to anything else; the absolute height
is what is off. Where a national bare-earth model exists it fixes this at z12
already, not only above it: measured in Barcelona, Madrid and Manhattan, the
z12 tiles show no buildings at all ("The ground is the drawn terrain" below).

## The globe

MapLibre's `globe` projection: a sphere ("vertical perspective") to z11, easing
into mercator by z12 — before any street-level layer has to know (the 3D
buildings start at z15.5, and `cityEngine.ts` reads the mercator matrix it
always has). It is IN the style document from its first load: with the flag
on, `MapCanvas.web.tsx` builds the map without a style and hands it the URL
through `setStyle` with a `transformStyle` that adds `projection: globe`
(`mapStyleLoading` in `lib/map/reliefFlag.ts`), and the container starts on
the deep-space gradient. So the first frame is a globe on space whenever the
relief chunk (stars, glow, sky, hillshade, terrain) arrives — verified by
holding that chunk back 25 s. With the flag off the constructor is exactly
what it was.

**Space** is the map container's own CSS background — MapLibre clears to
transparent and draws nothing around the globe: a deep blue-black radial
gradient and 90 seeded stars as CSS radial gradients (no image, no canvas,
nothing per frame, the same sky every load). Same in both appearances; space
has no light mode.

**The glow is GoWay's, not MapLibre's.** MapLibre's `atmosphere-blend` is a
physical scattering model lit by the style's single `light` — which GoWay aims
from the sun for the *buildings* (`sunLitBuildingsLight`: azimuth from the sun,
polar angle shaped for walls, held up through the night). Measured in this
prototype: lit by that light, it drew a hard, mis-placed day/night band across
the globe (its north/south axis is also mirrored relative to the extrusion
light); lit "from behind the camera", it is additive haze that turned the
light palette cyan-white. So `atmosphere-blend` is 0 and the glow is a CSS
radial gradient fitted to the globe's outline, recomputed on every `move`
(`globeSilhouette` in `relief.ts`): MapLibre's sphere radius
(`worldSize / 2π / cos lat`), its focal length from the vertical field of view,
the pitch — an exact ellipse, so the glow hugs the limb when tilted too. The
light stays the buildings'.

## Hillshade and 3D terrain

- **Hillshade** from z3 to z17, strongest across the regional zooms
  (exaggeration 0.32 → 0.42 at z6 → 0 by z16.5), directly **under `water`**:
  above every land fill, so forests are shaded by their mountains, below water,
  roads, buildings and labels, which stay flat and legible. Cool blue-grey
  shadow, light from the upper left of the screen. Only properties MapLibre
  Native also has, because native draws the same layer.
- **3D terrain** once the camera tilts past 2°, off again under 0.5°
  (`terrainWanted`). Straight down, terrain changes nothing visible and costs a
  render-to-texture pass for every 2D layer; switched on as the tilt begins, a
  1,200 m summit moves ~40 m on screen, and the relief then grows with the
  pitch instead of popping in. Exaggeration 1: the mountains are as tall as
  they are.
- **Two `raster-dem` sources** over the same tiles, one per use, as MapLibre
  asks; the second fetch is a browser-cache hit.
- **Sky and fog** for the tilted horizon, per appearance.
- On a style GoWay does not own (`openfreemap`, a style-URL override) the
  hillshade and terrain decline — exactly as the city layer does — and the
  globe still applies. A failed DEM tile is reported once and never raises
  "Map data unavailable": flat ground is still a map.

## Buildings on terrain

With terrain on, MapLibre's custom-layer matrix puts `z` at **absolute**
elevation; a mesh built from `z = 0` is drawn at sea level — measured, the z14
tile under Gràcia spans 45–174 m, Andorra la Vella's 994–1,648 m, Montserrat's
164–1,122 m. So one lift per tile cannot work (off by up to 650 m) and the city
layer lifts each building (`terrainGround.ts`):

- **What is sampled.** MapLibre's terrain, read at the DEM source's own max
  zoom (`map.terrain.getElevationForLngLatZoom`, in its typed API): the same
  DEM, bilinear sampling and exaggeration the terrain is drawn with — at the
  zooms the city layer draws (≥ z15.5) the terrain is over-zoomed from that
  DEM. **0.5 µs per call** (20,000 calls, headless Chromium). The obvious
  `map.queryTerrainElevation` was tried first and dropped on measurement: it
  reads the *rendered* terrain tiles and, for a point outside them — which a
  z14 building tile's grid always partly is, behind or under a pitched camera —
  recomputes the covering tiles on every call: **~100 µs per call**, and one
  tile's grid took 166 ms on the main thread. Per tile, a 33 × 33 grid (≈55 m
  cells at z14; the terrain mesh itself is ≈9–15 m, from ≈15 m DEM pixels)
  costs **~1 ms** (≈5 ms on the very first call, while MapLibre builds its
  sampler cache); every building then reads the grid bilinearly, so the cost
  does not grow with the building count (Barcelona: ~15,500 polygons per
  tile).
- **The ground is the drawn terrain.** #126 opened the sampled grid (a
  minimum then a maximum filter over ~145 m, on a 65 × 65 grid sampled past
  the tile's edge) on the premise that the terrain is GLO-30, a surface model
  recording roofs, and that this stood Eixample's street trees on rooftops.
  Measured since (the flat-block investigation, `MAP_3D_CITY.md` → Honesty,
  "Heights"), both premises fail where GoWay draws 3D cities:
  - **Mapterhorn's z12 tiles are bare earth there.** Decoded from the tiles
    the map draws: no Empire State Building or One Vanderbilt in Manhattan, no
    Cuatro Torres or Torre de Madrid, no Torre Glòries, and over the Eixample
    the surface and the opened ground differ by 0.1 m (32.0 against 31.9 at
    Passeig de Gràcia / Mallorca). The national models (IGN, USGS 3DEP) feed
    the z12 tiles too, not only the finer zooms; raw GLO-30 over the same
    block reads 34–58 m.
  - **The opening removed real hills.** On bare earth the only bumps narrower
    than its window are knolls: on 5.2% of Barcelona's z15 cells it moved the
    ground by more than 2 m, the most at Carmel, Turó de la Rovira and
    Collserola's foothills (up to 17 m) — burying the buildings on them in
    the hillside MapLibre draws — plus a few metres at the Sagrada Família,
    the one building the bare-earth model kept.
  - **It did not move the trees.** At the owner's Eixample camera the view
    looks the same with and without it; the in-building drop removes 5 of the
    7,506 trees there. Rooftop trees did not reproduce on the commit before
    the fix either (`f8006c3`, two Eixample cameras), so the remaining
    candidate for the original report is the procedural fill of parks and
    gardens, which is now off by default and limited to mapped woods.
  So the opening is gone: buildings, trees, models and city life stand on the
  terrain as drawn (`groundGrid`), the grid is back to 33 × 33 (1,089 samples
  a tile instead of 5,329), and `city3dWorkerTrees.test.ts` pins a building on
  a 100 m knoll standing on it. Where the terrain IS GLO-30 (no national
  model), roads and labels drape over its roofs and canopy too; standing on
  the same surface keeps things together, and better terrain is the fix there.
- **How a building is placed.** MapLibre's own rule for `fill-extrusion`: the
  whole building at the ground under its centre, so roofs stay flat as in the
  data. Its fixed 10 m base sink is replaced by a measured one — the drop from
  the centre to the lowest corner of the footprint's box plus 1 m, never under
  2 m — and only vertices at the building's foot sink, so a part that starts in
  the air keeps its gap. The mesher records each polygon's first vertex and
  footprint box (`TileMesh.polygonStarts`/`polygonBoxes`: 20 bytes a polygon,
  ~1% of a dense tile's buffers); the lift is one float per vertex (+4.4 MB, or
  +17%, for a dense Barcelona tile), allocated only once terrain is on and added
  in the vertex shader only while it is. With the far-field levels and the
  compact vertex format (`MAP_3D_CITY.md` §4) the same placement runs on the
  packed chunks: each chunk remembers where its vertices came from, the lifts
  are one array whose slices are the chunks' `ground` attributes, and the
  trees of the same tile take the grid's ground under each of them
  (`cityMeshes.ts` → `groundTileFor`; `city3dGroundPacked.test.ts` pins the
  packed lifts equal to `vertexGround`'s).
- **Cost of placing.** ≤ 12 ms for a dense Barcelona tile (the per-vertex
  pass), one tile per frame, nearest first. A tile never grounded is not drawn
  until it is (it would be inside the hill); culling bounds follow the lift.
- **When it is redone.** On the `terrain` event and 250 ms after a DEM tile of
  the terrain's source arrives. A re-ground that moves no building by more
  than 0.25 m uploads nothing. Measured: a 4 s pan around Barcelona caused no
  refresh at all (the z12 DEM was already loaded); jumping Barcelona → Andorra
  caused one, which re-placed the four new tiles at ~1,000 m.
- **Rejected:** decoding the DEM in the mesh worker (a different, finer
  surface than the one drawn — buildings would float or sink against it);
  sampling MapLibre's DEM textures in the shader (internal API).
- **Both meshers.** Over OpenMapTiles each polygon is one unit; over GoWay's
  city tiles (`osmMesher.ts`) each OSM building is, so a pitched roof, a dome or
  a multipolygon is lifted in one piece and stays level with itself. Unit-tested
  for both; the city-tile path was not run against served tiles in this change.
- **Known limits.** A building cut by a tile edge is two pieces, each placed by
  its own centre; on a slope their roofs can differ by the slope across the
  seam. In the city tiles a `building:part` is its own building, so the parts
  of one building on a steep slope can step by the slope between their
  centres. Both want the parent's footprint in the tile; neither is fixed here.

**3D models** (`models.ts`, SDK_MAP_MODELS) stand on the same ground: a
placement's altitude is metres above the *drawn* ground (`ModelPlacement`), so
with terrain on each model reads the ground under its anchor every frame
(~0.5 µs, from the same sampler the buildings use) — a vehicle on a flyover
climbs with the road instead of driving through the hill.

The shipped **`fill-extrusion`** buildings need nothing: MapLibre lifts them
itself (centroid + 10 m sink) — confirmed in Barcelona with terrain on, where
they and the city layer stand on the same ground.

## Native

`@maplibre/maplibre-react-native` 11.4.1 (MapLibre Native Android 13.6.1) was
read, not assumed: its `<Map>` has **no** `projection`, `terrain` or `sky` prop,
and nothing in its Android or iOS sources sets one. So:

- **Globe, 3D terrain, sky: web only**, until the wrapper exposes them.
- **Hillshade: native too.** `RasterDEMSource` (with `encoding: 'terrarium'`)
  and a `hillshade` layer exist in 11.4, so `MapCanvas.native.tsx` draws the
  same `hillshadeLayer()` under `water` — on by default like the web, killed by
  `EXPO_PUBLIC_MAP_TERRAIN=0`. Its style-spec `paint` reaches native through
  the wrapper's own kebab→camel conversion (`nativeHillshade.test.ts`).
  Type-checked; **not yet verified on a device**.

## What it costs

**Bundle** (`expo export --platform web`, no environment, against `main` 28d10da
where relief was off unless asked):

| Chunk | `main` | This change | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,962,712 B | 6,968,598 B (+5,886 B; +2,072 B gz) | the attribution page and its words, the default-on parsing |
| `__common` (first paint) | 78,516 B | 78,516 B | identical |
| `reliefLayer` (lazy, **now fetched on every load**) | 6,121 B | 6,212 B (2,636 B gz) | requested when `MapCanvas.web.tsx` evaluates |
| `lazyChunk` (three.js, lazy) | 3,581,212 B | 3,581,359 B | the models' ground |

The style documents are byte-identical (`map:style:check`): the fragments are
added at runtime, never generated into them. The chunk-boundary rules still
hold (`components/__tests__/reliefChunk.test.ts`).

**Network: the DEM is the real cost.** Unique bytes per view, measured on the
production export served locally against goway.to's tiles:

| View | Elevation (DEM) | Vector tiles |
| --- | ---: | ---: |
| Default open, desktop 1280×800 | 6 tiles, 275 KB | 6 tiles, 314 KB |
| Default open, phone 390×844 | 4 tiles, 264 KB | 4 tiles, 291 KB |
| Globe z1.2–1.6 | **0** (was 906 KB) | 723 KB |
| Pyrenees z7, desktop | 9 tiles, ~1.2 MB | 175 KB |
| Montserrat z13 tilted, phone | 12 tiles, 1.67 MB | 544 KB |

The hillshade starts at **z3** (`HILLSHADE_MIN_ZOOM`): on the whole-globe zooms
its shading was a few pixels of texture for ~0.9 MB of DEM per view, and
MapLibre fetches a source's tiles only while a layer using it is shown. A DEM
tile is a 512 px WebP of 50–155 KB, so a mountain view roughly doubles or
triples the bytes of the same view flat; on a metered mobile connection that is
the cost to watch. Levers if it bites: a lighter encoding for the hillshade
(e.g. a 256 px variant), a later hillshade start, or `Save-Data` gating.

**First frame.** With no environment the production build opens on a globe on
deep space from the first frame (the projection is in the style document as it
loads); stars and glow follow with the 2.6 KB relief chunk.

## Performance

Measured in headless Chromium on **SwiftShader** (CPU rendering), so only the
ratios mean anything, and they overstate fill-rate costs a GPU absorbs. Frame
time while panning, relief on vs killed (`?globe=0&terrain=0`), development
build, two runs each, order alternated: Montserrat z13 pitched — median 83–100
ms on vs 100 ms off, p90 250–333 vs 217 ms; Barcelona z12 flat — median 150 vs
150 ms, p90 300 vs 267 ms; globe z2 — median 67 ms either way. A **cold**
mountain view is the expensive moment: the first run, while the DEM was still
arriving, measured a 450 ms median against 83 ms killed — the hillshade and
terrain re-render as each tile lands. Earlier: Barcelona with the city layer
and terrain was ~2× the city layer alone (render-to-texture). A device
benchmark on mid-range Android Chrome is still owed; on a weak phone GPU the
tilted terrain view is the one most likely to drop frames.

## Next

1. Upload `planet.pmtiles` and set `MAP_TERRAIN_ARCHIVE` — before traffic grows
   (see "Is the proxy safe").
2. Coverage-aware maxzoom for the national models (sharper Montserrat, a bare-
   earth Barcelona).
3. Device benchmarks; then decide whether tilted terrain should follow the city
   layer's device gating on weak GPUs, and whether `Save-Data` should drop the
   hillshade.
4. Native globe and terrain when maplibre-react-native exposes them.

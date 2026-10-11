# Globe, terrain and hillshade

A world that is a **globe** when you zoom out, **real relief** when you look at
mountains, and 3D buildings that **stand on the ground** when both meet. A
working web prototype, **off by default**, plus a native hillshade. Companion to
[`MAP_3D_CITY.md`](./MAP_3D_CITY.md), whose three.js building layer this
places on the terrain.

## Turning it on

| | Build flag (any build) | Per tab (development builds only) |
| --- | --- | --- |
| Globe, space, glow | `EXPO_PUBLIC_MAP_GLOBE=1` | `?globe=1` |
| Hillshade + 3D terrain | `EXPO_PUBLIC_MAP_TERRAIN=1` | `?terrain=1` |

No production deployment sets either flag, and a production build ignores the
query parameters (`lib/map/reliefFlag.ts`, pinned by `reliefFlag.test.ts`), so
no goway.to link can switch an experimental renderer on for anyone else. They
combine with `?city3d=1`.

The elevation tiles come from GoWay's own Worker route,
`https://goway.to/map/terrain/{z}/{x}/{y}.webp`. Until that route is deployed,
a development session points straight at the upstream instead:

```sh
EXPO_PUBLIC_MAP_TERRAIN_TILES='https://tiles.mapterhorn.com/{z}/{x}/{y}.webp' \
  bun run --cwd packages/frontend web
# then open /?lat=41.595&lng=1.81&zoom=13&pitch=60&globe=1&terrain=1
```

| Piece | Where |
| --- | --- |
| Flags | `lib/config.ts` (`MAP_GLOBE_ENABLED`, `MAP_TERRAIN_ENABLED`), `lib/map/reliefFlag.ts`, resolved once in `components/map/reliefFlags.ts` |
| Style fragments (pure, spec-validated) | `lib/map/style/relief.ts` — DEM sources, hillshade, terrain, sky, globe outline, space |
| DEM endpoint, vendor, credit | `lib/map/provider.ts` (`GOWAY_MAP_PATHS.terrain`, `MAPTERHORN_ENDPOINTS`, `TERRAIN_ATTRIBUTION_LINK`, `resolveTerrainTileUrl`) |
| Worker route | `worker/index.js` → `serveTerrain`; `wrangler.toml` (`run_worker_first`, `MAP_TERRAIN_UPSTREAM`, optional `MAP_TERRAIN_ARCHIVE`) |
| Web adapter (lazy chunk) | `components/map/reliefLayer.web.ts`, loaded by `MapCanvas.web.tsx` |
| Buildings on terrain | `components/map/engine/city3d/terrainGround.ts` (pure), `components/map/city3dGround.web.ts` (MapLibre side) |
| Native hillshade | `components/map/MapCanvas.native.tsx` |
| Credit | `components/map/MapAttribution.tsx` |

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

**Why through the Worker, even for the prototype.** GoWay's rule is that the
browser only ever talks to goway.to (`provider.ts` → `GOWAY_MAP_PATHS`).
Hot-linking Mapterhorn would send every viewer's IP and viewport to a third
party that logs them, with no policy saying the traffic is welcome. The Worker
route keeps both on Cloudflare's side and caches each tile at the edge for a
week, so most requests never reach Mapterhorn at all.

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

**Credit.** `© Mapterhorn` → <https://mapterhorn.com/attribution> (which names
every source, Copernicus included), appended to the data credit by
`resolveMapAttribution({ terrain })` whenever the terrain flag is on — on web
and native, because `MapAttribution` and both canvases read the same
`MAP_RELIEF`. **Before production:** Copernicus requires, for data derived
from GLO-30, the notice *"produced using Copernicus WorldDEM-30 © DLR e.V.
2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under
COPERNICUS by the European Union and ESA; all rights reserved"* and a
liability disclaimer on a legal page. GoWay has no legal page yet; that is a
release gate, not a prototype one.

**Caveat: GLO-30 is a surface model.** It includes trees and buildings,
smoothed to 30 m, so a dense city's "ground" sits some metres above the
streets. Everything drawn on the terrain (roads, buildings) is lifted
consistently, so nothing floats relative to anything else; the absolute height
is what is off. The national bare-earth models above z12 fix this where they
exist.

## The globe

MapLibre's `globe` projection: a sphere ("vertical perspective") to z11, easing
into mercator by z12 — before any street-level layer has to know (the 3D
buildings start at z15.5, and `cityEngine.ts` reads the mercator matrix it
always has). Set at `style.load`, which fires before the first frame, and the
chunk carrying it is requested when `MapCanvas.web.tsx` is evaluated, long
before any style arrives, so the world is never seen flat first.

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

- **Hillshade** at every zoom to z17, strongest across the regional zooms
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
- **How a building is placed.** MapLibre's own rule for `fill-extrusion`: the
  whole building at the ground under its centre, so roofs stay flat as in the
  data. Its fixed 10 m base sink is replaced by a measured one — the drop from
  the centre to the lowest corner of the footprint's box plus 1 m, never under
  2 m — and only vertices at the building's foot sink, so a part that starts in
  the air keeps its gap. The mesher records each polygon's first vertex and
  footprint box (`TileMesh.polygonStarts`/`polygonBoxes`: 20 bytes a polygon,
  ~1% of a dense tile's buffers); the lift is one float per vertex (+4.4 MB, or
  +17%, for a dense Barcelona tile), allocated only once terrain is on and added
  in the vertex shader only while it is.
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
  same `hillshadeLayer()` under `water` when `EXPO_PUBLIC_MAP_TERRAIN=1`.
  Type-checked; **not yet verified on a device**.

## What the flags cost when off

The relief adapter is one lazy chunk requested only when a flag is on; the
style fragments load with it (pinned by `components/__tests__/reliefChunk.test.ts`).
What reaches first paint is the flag check, the credit's extra branch and the
error filter. Measured with `expo export --platform web`, flags off, against
`main`:

| Chunk | `main` (3eda89b) | This change | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,953,223 B | 6,955,355 B (+2,132 B; +628 B gz) | flags, the gate and its `import()` stub, the credit, the Worker path and vendor constants, the error filter |
| `__common` (first paint) | 78,516 B | 78,516 B | identical once module ids are normalised |
| `reliefLayer` (lazy) | — | 6,179 B (2,666 B gz) | never requested with the flags off |
| `lazyChunk` (three.js, lazy) | 3,498,341 B | 3,502,555 B (+4,214 B) | the city engine's grounding |
| `city3dLayer`, `meshWorker` (lazy) | 6,776 B, 40,934 B | 7,336 B, 41,365 B | the terrain bridge; the polygon ranges |

The style documents are byte-identical (`map:style:check`): the fragments are
added at runtime, never generated into them.

Verified in the running app with the flags off: no request for the relief
chunk or any elevation tile, the container's background untouched, and no
dev hook installed.

## Performance

Measured in headless Chromium on **SwiftShader** (CPU rendering), so only the
ratios mean anything, and they overstate fill-rate costs a GPU absorbs: frame
time while panning, median — Montserrat z13 pitched: terrain off 117 ms, on
83 ms (noise; same order); globe z2: 50 ms flat, 67 ms globe; Barcelona city
layer z16.3: 117 ms, 233 ms with terrain (the render-to-texture pass plus the
custom layer drawn into the 3D pass). A device benchmark on mid-range Android
Chrome is still owed before any of this ships, as for the city layer.

## Next

1. Deploy the Worker route, then upload `planet.pmtiles` and set
   `MAP_TERRAIN_ARCHIVE`.
2. The Copernicus notice and disclaimer on a legal page.
3. Coverage-aware maxzoom for the national models (sharper Montserrat, a bare-
   earth Barcelona).
4. Device benchmarks; then decide whether terrain should follow the city
   layer's device gating.
5. Native globe and terrain when maplibre-react-native exposes them.

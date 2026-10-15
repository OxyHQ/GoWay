# Globe, terrain and hillshade

A world that is a **globe** when you zoom out, **real relief** when you look at
mountains, and 3D buildings that **stand on the ground** when both meet. **On by
default** on web, production included, with a native hillshade. Companion to
[`MAP_3D_CITY.md`](./MAP_3D_CITY.md), whose three.js building layer this
places on the terrain.

## On by default, and how to turn it off

| | On this device | Per tab (development builds only) |
| --- | --- | --- |
| Globe, space, glow | the `globe` map feature | `?globe=0` (or `=1`) |
| Hillshade + 3D terrain | the `terrain` map feature | `?terrain=0` (or `=1`) |

Both are on for everyone, with no build variable: a person switches either off
in the map's settings (`MAP_FEATURES.md`). A production build ignores the query
parameters both ways (`lib/map/mapFeatures.ts`, pinned by
`mapFeatures.test.ts`), so no goway.to link changes anyone else's renderer.

The elevation tiles come from GoWay's own Worker route,
`https://goway.to/map/terrain/{z}/{x}/{y}.webp` (live since #124).
`EXPO_PUBLIC_MAP_TERRAIN_TILES` overrides the template for a preview.

| Piece | Where |
| --- | --- |
| Flags | The map-feature registry's `globe` and `terrain` (`lib/map/mapFeatures.ts`, [`MAP_FEATURES.md`](./MAP_FEATURES.md)): the person's choice in the settings modal, and `?globe=`/`?terrain=` in a development build; read live through `components/map/reliefFlags.ts` (`useMapRelief`) |
| Style fragments (pure, spec-validated) | `lib/map/style/relief.ts` — DEM sources, hillshade, terrain, sky, globe outline, space |
| DEM endpoint, vendor, credit | `lib/map/provider.ts` (`GOWAY_MAP_PATHS.terrain`, `MAPTERHORN_ENDPOINTS`, `TERRAIN_ATTRIBUTION_LINK`, `resolveTerrainTileUrl`) |
| Worker route | `worker/index.js` → `serveTerrain`: GoWay's own sets first (`worker/terrain.js`, `MAP_TERRAIN_MANIFEST`, "The archive"), then the fallback; `wrangler.toml` (`run_worker_first`, `MAP_TERRAIN_UPSTREAM`, optional `MAP_TERRAIN_ARCHIVE`) |
| Web adapter (lazy chunk) | `components/map/reliefLayer.web.ts`, loaded by `MapCanvas.web.tsx` |
| Buildings on terrain | `components/map/engine/city3d/terrainGround.ts` (pure), `components/map/city3dGround.web.ts` (MapLibre side) |
| Native hillshade | `components/map/MapCanvas.native.tsx` |
| Credit | `components/map/MapAttribution.tsx`, each own-terrain source while on screen (`useSourceCredits.ts`); the page it links to, `app/attribution.tsx` (`features/credits/`, notices in `lib/map/credits.ts`) |
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
z12 tiles show no buildings at all ("The ground is the drawn terrain" below) —
with one measured exception, the Sagrada Família ("A building in the bare
earth" below).

### A building in the bare earth: the Sagrada Família

The owner's second report: "here the terrain should be almost flat, but it
makes a mini mountain" (Plaça de la Sagrada Família, night). Measured on the
tiles goway.to serves (2026-10-13), on a 10 m grid in the Eixample's own axes
around the basilica, against a plane fitted 90–150 m out:

| Source | Plane at the basilica | Slope (to the sea) | Above the plane at the basilica |
| --- | ---: | ---: | ---: |
| Mapterhorn z12 (what the map draws) | 32.4 m | 3.2% | up to **+31 m** over ~4,000 m² of the basilica's footprint (and −4 m where the crypt is) |
| Mapterhorn z13–z16 | 32.4 m | 3.2% | the same spike, +52–54 m at its top |
| IGN MDT05 (WCS `Elevacion4258_5`, CC BY 4.0 scne.es) | 32.2 m | 3.1% | ≤ 2.2 m (whole-metre values) |
| ICGC MET 5 m (WCS `icc:met`, CC BY 4.0) | 32.7 m | 3.2% | ≤ 0.7 m |

So the Eixample here is bare earth in every source, sloping ~3% to the sea,
and the block is 32–33 m, not 40–45 m. Mapterhorn's tiles are bare earth too
except over the basilica itself: one of its Spanish sources (IGN's MDT02 or
the 0.5 m MDT of the third LiDAR coverage, 2022–2025, both listed in its
`attribution.json`) classified part of the building as ground. MapLibre's
bilinear read spreads that spike over the pixels around it, ~14 m each way:
the mound, the plaza paths draped over it, and the low buildings beside it cut
by it. GoWay's sampler then read the z11 tile and a 29 m grid, which smeared it
wider still; since the fix everything stands on the spike exactly as drawn,
which is right for the drawing and still wrong for the world.

Not fixed in code, on purpose: flattening the terrain under footprints would
invent ground the data does not have (and is wrong where a building does stand
on a hill), and only the data is wrong here.

**The fix is the data**, at the root and everywhere: GoWay's own bare-earth
archive, next section. Its ICGC set has the basilica's footprints 2.1 m above
the open ground around them, where Mapterhorn has them 16.1 m above it; and
the gate finds the same kind of fault wherever Mapterhorn's sources have it,
by one rule, without naming a building.

## The archive: GoWay's own bare-earth terrain

**Built, not published** (2026-10-15). The owner's rule for the DEM: fix it at
the root, everywhere, not a patch where a landmark shows it. Mapterhorn is a
good aggregate, but measured it has three faults no client code can undo:

- **It picks the finest source, not the cleanest.** Its pipeline stacks
  sources by resolution (alphabetical on a tie) and checks none for ground:
  over the Sagrada Família its coverage tile lists `es2a` (IGN's MDT02, 2 m),
  `es5a`, `es5c` and `glo30`, and the finest, MDT02, most likely kept part
  of the basilica as ground (+31 m). The same in Barcelona at Palau Sant Jordi (+31 m), the Zona Franca
  warehouses (+29 m), the Fira (+23 m); in Paris on the Beaugrenelle
  slab (+18 m). Measured below.
- **No vertical datum.** "Vertical reference systems are not treated at the
  moment" (Mapterhorn #255): every country's heights are its own datum
  (Alicante, NGF-IGN69, NAVD88, Tokyo Bay MSL…), 0.3–2.3 m apart, so two
  sources meet with a step and nothing is in one global frame.
- **0.5 m steps at z12** (1 m at z11), which the street level draws as
  terraces on a gentle slope.

So GoWay builds its own **sets** — one bare-earth model (DTM) at one vintage,
per region — and serves them in front of Mapterhorn, which stays the fallback
everywhere no set is published. One pipeline, one code path for every set; no
environment flag; nothing about a place in it.

| Piece | Where |
| --- | --- |
| Sources and licences | `lib/map/terrainSources.ts` (credits, notices) |
| Sets: input, datum, extent | `scripts/terrain/catalogue.ts` (order = priority) |
| Reading a set onto a grid | `scripts/terrain/inputs.ts` (a COG by range; USGS's index of COGs; IGN's ATOM département archives; GSI's tile pyramid), `warp.ts` (GDAL + PROJ to web mercator and EGM2008) |
| The gate and the correction | `scripts/terrain/gate.ts`, `ground.ts`, `canopy.ts`, `footprints.ts` |
| The seam | `scripts/terrain/blend.ts` |
| Encoding | `scripts/terrain/terrarium.ts`, `webp.ts` |
| The build | `scripts/build-terrain-set.ts` (`map:terrain-set`), `build-satellite-manifest.ts --family=terrain` (`map:terrain-manifest`), `.github/workflows/build-terrain-tiles.yml`, GDAL/PROJ/p7zip pinned in `scripts/terrain/environment.yml` |
| The gate as a tool | `scripts/check-terrain-ground.ts` (`check:terrain-ground`) |
| Serving | `worker/terrain.js` over `worker/rasterSets.js` (the satellite imagery's set/cell/manifest machinery, now shared), `MAP_TERRAIN_MANIFEST` |
| The credit | `lib/map/terrainCoverage.ts`, `components/map/useSourceCredits.ts`, `/attribution#elevation` |
| Tests | `scripts/__tests__/terrainArchive.test.ts`, `worker/__tests__/terrain.test.js`, `lib/map/__tests__/terrainCoverage.test.ts` |

### How a cell is built

A set is cut into **cells** (z7 tiles, one PMTiles archive each, z7–12 inside:
≤ 1,365 tiles), keyed exactly like the imagery:

```
terrain/<set>/<stamp>/7/<x>/<y>.pmtiles               the cell's tiles
terrain/<set>/<stamp>/7/<x>/<y>.pmtiles.receipt.json  sources, CRS, datum pipeline, encoding, the gate's numbers, timings
terrain/manifest.json, terrain/manifests/<stamp>.json the live manifest and every one ever published
```

A cell is processed in **blocks** (z10 tiles), each a window of the **z14
analysis grid** (512 px tiles: 2.4–4.8 m pixels — the gate sees a house) plus
a margin wide enough for the feather and the gate's ring:

1. **Read** the set onto the window (`inputs.ts`): GDAL warps it to EPSG:3857
   with heights converted to **EGM2008** (EPSG:3855) by PROJ, averaging when
   the source is finer than the grid, bilinear when coarser. Several inputs
   (3DEP tiles, IGN départements) are mosaicked into one VRT first, so one
   no-data mask governs the average. A height no terrain has (below −12 km,
   above 9 km) stops the build and names where it is.
2. **Gate** it against the footprints and tree stands the map draws there
   (below), and correct it only if the set asks to.
3. **Feather** it into the fallback (Mapterhorn z12, bilinear as MapLibre
   draws it) where the set ends on land (`blend.ts`, below).
4. **Average** the block's core down to z12 (4 × 4), z11, z10; z9–z7 from the
   blocks' z10 tiles (the fallback's own tile filling a quadrant no block
   covered). A tile is **published only where the set has ground in it**;
   everywhere else the fallback stays what the map draws.
5. **Encode** Terrarium at the zoom's step, lossless WebP; pack; read every
   tile back through `worker/pmtiles.js`; write the receipt.

### One datum: EGM2008

Every set's heights are converted by PROJ from the source's compound CRS
(horizontal + its national vertical datum, in the catalogue) through the
geoid grids of `proj-data` (pinned): EGM2008 is the frame of Copernicus
GLO-30, GEDTM30 and every global model, and the closest thing to "sea level"
everywhere at once. Measured at each landmark (`cs2cs`/`cct`, same pipelines
as the build):

| Set | Source datum (grid) | EGM2008 − source |
| --- | --- | ---: |
| ICGC, Catalonia | Alicante (`es_ign_egm08-rednap`) | −0.55 m at the Sagrada Família |
| IGN RGE ALTI, France | NGF-IGN69 (`fr_ign_RAF20`) | −0.81 m at Notre-Dame |
| USGS 3DEP | NAVD88 (`us_noaa_g2018u0`) + NAD83(2011) → ITRF2014 | −0.37 m at the Empire State Building |
| GSI | JGD2011 heights, Tokyo Bay MSL (`jp_gsi_gsigeo2011`) | +0.27 m at Tokyo Tower |

**3DEP needs its own pipeline.** PROJ's default from NAD83(2011) to WGS 84 is
a null transformation ("2 m"), and it ignores that the two ellipsoids are
1.25 m apart vertically in New York: its EGM2008 heights came out +0.88 m
above NAVD88 where the right answer is −0.37 m. The catalogue gives the set
the explicit pipeline (GEOID18 → NAD83(2011) → ITRF2014 by EPSG's
time-dependent Helmert at epoch 2010.0 → EGM2008), and the build uses it
(`-ct`). Every other set's default pipeline is cm-exact (ETRS89, RGF93 and
JGD2011 sit on ITRF at that level).

The served Mapterhorn tiles carry the national datums, so beside a set the
fallback is 0.2–0.8 m off: the feather absorbs it (below), and measured at
the landmarks the built ground differs from Mapterhorn's by the datum offset
plus the source's own correction (Notre-Dame: 33.34 m against 34.00 m; Tokyo
Tower: 18.80 against 18.57).

### Precision

A tile stores heights rounded to a step that grows with the pixel
(`terrainStepM`): **1/8 m at z12** (12.5 cm: under a kerb, and under 1% of a
pixel as a slope), 1/4 m at z11, …, 1 m from z9. Lossless WebP pays for every
bit of noise, so the step is the size. Measured on the built urban z12 tiles
(Paris, Tokyo; 47 tiles), re-encoded from the same heights:

| Step at z12 | KB a tile | vs Mapterhorn's tiles |
| ---: | ---: | ---: |
| 1/16 m | 135.5 | 2.14× |
| **1/8 m (chosen)** | **107.6** | **1.70×** |
| 1/4 m | 82.3 | 1.30× |
| Mapterhorn, 0.5 m | 63.3 | 1 |

1/8 m because the DEM is the map's main network cost per view ("What it
costs"): 1/16 m would add another 28 KB a tile for steps nobody can see at a
12–19 m pixel. Below z12 the pixel doubles each zoom and so does the step.

### The seam

Where a set ends ON LAND (its no-data where ESA WorldCover says land: a border,
a survey's edge, a hole), every pixel within **500 m** inside it is
`w · set + (1 − w) · fallback`, `w` rising smoothly (smoothstep) from 0 at the
edge to 1: a 0.8 m datum step becomes a 0.16% grade, a source's own
correction a gentle one, and a set's ground is untouched beyond its outer half
kilometre. Where a set ends at the SEA (WorldCover water, or outside
WorldCover), nothing is feathered: the coast is the land's edge, not the
source's, and Manhattan is never more than 2 km from water. Tile edges need no
seam of their own: neighbouring tiles of one set come from one continuous
analysis grid, and a published tile next to an unpublished one already holds
the fallback's heights at their shared edge. Pinned by the seam and pyramid
tests (no step, no overshoot, the set exact past the feather, the shore kept;
a step across a tile edge is the step inside), and measured on the built
archives (every z12 edge of the proof): across the 1,446 edges
between two set tiles the mean step is 2.45 m against 2.33 m between two
columns inside a tile (the Pyrenees dominate the mean), and 0.75 m across the
118 edges from a set tile to Mapterhorn's; at z10, 8.7 m against 7.7 m.

### Contamination: the gate

A bare-earth model knows no ground under a building: its producer
interpolates across the footprint from the ground around it (a LiDAR DTM
triangulates the ground returns of the streets and yards). So a model that
STEPS UP under a footprint, relative to the open ground right around it, kept
the building. The gate (`ground.ts` → `footprintGround`):

- **Footprints**: GoWay's own city tiles (`/map/city/15/…`, OSM), only those
  standing on the ground (`render_min_height` 0), burnt into the z14 grid.
- **Tree stands**: ESA WorldCover 2021 tree cover (10 m, CC BY 4.0), connected
  stands up to 150 m across (a forest wider than that has no ground around it
  to compare with). A surface model keeps the canopy.
- **The ring**: every open pixel (in no footprint, not tree cover) from one
  source pixel to 12 m beyond that around the footprint — past a kept
  building's own smear. A least-squares **plane** through it. A hill under
  a block of houses rises through the streets between them too, so the plane
  follows the hill; a building kept as ground is a step up from it.
- **The verdict**: the footprint's 90th-percentile height above that plane.
  Reported over 2, 5 and 10 m; **fails over 5 m** (a storey and more; a LiDAR
  DTM's own error is 0.1–0.5 m, a terrace or a garden wall a metre or two).

What still stands 5 m above its ring in a clean LiDAR model is ground, and is
named here so nobody "fixes" it: a building on a summit (the Montjuïc
castle), dug into a hillside (Collserola's foothills, Atago hill in Tokyo), a
stadium's earthwork stands (the Estadi Olímpic), a raised reservoir (Paris's
Montsouris), a folly on a cliff (the Buttes-Chaumont). These set the floor:
~0.04–0.2% of footprints in every clean model measured.

**What the gate cannot see**: a surface model over a dense city raises the
streets as much as the roofs — a blanket, not a step — so the gate measures
GLO-30 in São Paulo cleaner (0.18% over 5 m) than GEDTM30 (1.33%), which is
the opposite of the truth. Certifying a fallback model needs an absolute
reference (ICESat-2's ground photons); not built.

**The correction** (`correctWindow`): every failed footprint and stand, grown
by the ring's inner distance, becomes one hole that gets the membrane — the
smoothest surface meeting the ground around it (harmonic, so never above the
highest edge nor below the lowest). Built and tested; **no set uses it**: the
rule is the next-best clean source first, and every set built is clean (below).
It is for a region whose only source fails, and only after its gate numbers
are in this document; never by name.

### Measured: before and after

**Gate**, 10 × 10 km around each city's landmark (Barcelona 2.165, 41.40;
Paris 2.342, 48.857; Manhattan −73.986, 40.748; Tokyo 139.745, 35.659), z14
grid, footprints judged / over 5 m / over 10 m, and tree stands over 5 m:

| City | Set | Footprints judged | Over 5 m: Mapterhorn → set | Over 10 m: Mapterhorn → set | Tree stands over 5 m: Mapterhorn → set |
| --- | --- | ---: | ---: | ---: | ---: |
| Barcelona | ICGC 5 m | 155,456 | 322 (0.21%) → **165** (0.11%) | 34 (0.02%) → **9** (0.01%) | 32 (0.44%) → **36** (0.49%) |
| Paris | IGN RGE ALTI 1 m | 122,202 | 115 (0.09%) → **51** (0.04%) | 14 (0.01%) → **2** (0.00%) | 22 (0.26%) → **20** (0.24%) |
| Manhattan | USGS 3DEP 1 m | 83,160 | 50 (0.06%) → **49** (0.06%) | 2 (0.00%) → **2** (0.00%) | 8 (0.13%) → **9** (0.15%) |
| Tokyo (Minato) | GSI DEM5A | 161,738 | 161 (0.10%) → **155** (0.10%) | 8 (0.01%) → **4** (0.00%) | 32 (0.64%) → **31** (0.61%) |

**The landmarks**: the landmark's footprints' 90th percentile
above the open ground around them, and the relief within 40 m:

| Landmark | Set | Its footprints: p90 above the ground around (max) — Mapterhorn → set | Relief within 40 m | Ground at the point |
| --- | --- | ---: | ---: | ---: |
| **Sagrada Família** | ICGC | **16.06 m** (16.18) → **2.12 m** (2.12) | 29.1 → 5.4 m | 37.59 → 29.33 m |
| Palau Sant Jordi | ICGC | **31.47 m** (34.74) → 8.01 m (8.56): dug into Montjuïc's slope, measured as a terrace in the source | 40.2 → 15.4 m | 110.95 → 85.50 m |
| **Notre-Dame** | IGN | 0.56 m (0.60) → **0.21 m** (0.24) | 1.84 → 1.57 m | 34.00 → 33.34 m (datum −0.81, source +0.15) |
| Beaugrenelle (Front de Seine) | IGN | **17.63 m** (20.95) → **0.18 m** (0.38) | 22.6 → 1.7 m | 53.05 → 30.89 m |
| **Empire State Building** | USGS 3DEP | 0.87 m (1.04) → **0.69 m** (0.81) | 2.06 → 2.17 m | 15.00 → 14.81 m (datum −0.37, source +0.18) |
| **Tokyo Tower** | GSI | 0.93 m (1.93) → **0.95 m** (1.62): Mapterhorn is GSI's DEM5A here too | 5.81 → 5.79 m | 18.57 → 18.80 m (the datum's +0.27) |

So the Sagrada Família, the Palau Sant Jordi and the Beaugrenelle slab were
buildings in Mapterhorn's ground and are not in GoWay's; Notre-Dame, the
Empire State Building and Tokyo Tower were already flat, and stay so in one
datum at 1/8 m. Mapterhorn is right in Manhattan and Tokyo, as measured: a set
there is for the datum and the precision, not a fault.

Screenshots (before: what goway.to draws; after: the built set served
locally), same camera: `goway-videos/terrain-bare-earth/`.

- `relief-<landmark>-before-after.png` — the ground itself, as MapLibre reads
  the tiles onto the z14 grid: hillshade (×3) on a colour ramp shared by both
  halves, the footprints in blue; left Mapterhorn, right the set. Sagrada
  Família, Palau Sant Jordi, Notre-Dame, Beaugrenelle, Tokyo Tower, Empire
  State Building.
- `<before|after>-<landmark>-day.png` — the app, a development export served
  locally with `serve-map-build --upstream=https://goway.to`, after with
  `--terrain=<build dir>` (the Worker's own `terrain.js` over the built
  archives and manifest); `…-bare-…` the same camera with the 3D city off, so
  the ground shows. Headless Chromium on SwiftShader, the high preset.

### Global fallback: what replaces GLO-30 where no national model exists

Most of the world has no open LiDAR DTM, and there Mapterhorn is Copernicus
GLO-30 — a surface model: roofs and canopy, smoothed to 30 m. The candidates:

| Model | Licence | Bare earth? | Verdict |
| --- | --- | --- | --- |
| **GEDTM30** (OpenGeoHub, Ho et al. 2025, v1.2) | **CC BY 4.0** (Zenodo 14900180, 18887460; code MIT); trained on GLO-30 and AW3D30 (credit JAXA) with ICESat-2/GEDI; no FABDEM input. Both records say "use for testing purposes only" | Modelled: canopy and buildings partly removed; RMSE 10.7 m vs GNSS, 2–7 m vs LiDAR DTMs | Measured in Barcelona: buildings over 5 m 4.93% (GLO-30 5.69%, Mapterhorn 0.21%, ICGC 0.17%). Better than GLO-30, nowhere near a DTM. A candidate for the GLO-30-only regions after an absolute check (ICESat-2); not adopted |
| FABDEM | CC BY-NC-SA 4.0 | Modelled | **Out**: non-commercial |
| FathomDEM | CC BY-NC-SA 4.0, academic access | Modelled (best of the three) | **Out** |
| Copernicus GLO-30 | Copernicus licence (commercial OK, notices) | **No**: surface | What Mapterhorn is there today |
| MERIT DEM, NASADEM, AW3D30 | NC / public domain / JAXA terms | Trees only, or none | No |
| DeltaDTM, DiluviumDEM | CC BY 4.0 | Coastal lowlands only | Possible coastal patch |

So the planet's street-level ground is national LiDAR DTMs, country by country
(below); the fallback stays Mapterhorn until GEDTM30 (or a successor) is
measured clean against ICESat-2 in GLO-30-only cities.

### The planet: sources

Every source GoWay may use (licence permits public, commercial redistribution
of derived tiles). Sizes are the producers' or Mapterhorn's; "est." is area ×
resolution. Built today: ★.

| Region | Model | Licence | Res. | Datum | Coverage | Bulk access | Size |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ★ Catalonia | ICGC terrain model (LiDAR 2021–23) | CC BY 4.0 | 0.25 (BCN), 0.5, 1, 5 m | Alicante | all | single COGs, `datacloud.icgc.cat/datacloud/model-elevacions-terreny/tif_unzip/` | 1 m 92 GB, 5 m 4.4 GB |
| Spain | IGN MDT05 / MDT02 (2015–21) / MDT 50 cm (3rd cov., ~45%) | CC BY 4.0 ("Obra derivada de MDT… scne.es") | 5 / 2 / 0.5 m | Alicante (EGM08-REDNAP) | all / all / partial | CNIG sheets; WCS `servicios.idee.es/wcs-inspire/mdt` | est. 60 GB / 0.5 TB / 8 TB |
| ★ France | IGN RGE ALTI 2.0 | Etalab 2.0 | 1 m | NGF-IGN69 (Corsica IGN78C: own set) | métropole | ATOM per département, `data.geopf.fr/telechargement/resource/RGEALTI` | 415 GB |
| France | IGN LiDAR HD MNT | Etalab 2.0 | 0.5 m | NGF-IGN69 | ~78% (ZICAD holes) | `data.geopf.fr` | est. 9 TB |
| Netherlands | AHN4 / AHN5 DTM | CC0 / CC BY 4.0 | 0.5 m | NAP | all (no data under buildings: the feather fills) | PDOK ATOM | est. 0.5 TB |
| Belgium | Flanders DHMV II; Wallonia MNT 2021–22; Brussels | Modellicentie gratis hergebruik / CC BY 4.0 / CC0 | 1 / 0.5 / 0.5 m | TAW/Ostend (−2.3 m!) | all | WCS / ATOM / ATOM | 50 GB / 198 GB / 3 GB |
| Luxembourg | LiDAR 2024 MNT | CC0 | 0.5 m | — | all | single COG | 40 GB |
| Switzerland | swissALTI3D | free, "©swisstopo" | 0.5, 2 m | LN02 | all | STAC | 770 / 44 GB |
| Germany | DGM1 of all 16 Länder | dl-de/by-2.0, dl-de/zero-2.0, CC BY 4.0 | 1 m | DHHN2016 | all | per Land (NRW, Bayern, Niedersachsen STAC, …) | est. 0.7 TB |
| Austria | ALS DTM (BEV) | CC BY 4.0 | 1 m | EVRF2000-AT | all | `data.bev.gv.at` | ~350 GB |
| Denmark | DHM/Terræn | CC BY 4.0 | 0.4 m | DVR90 | all (bridge decks kept) | Dataforsyningen | 258 GB |
| Norway | DTM1 | CC BY 4.0 / NLOD | 1 m | NN2000 | mainland | ATOM, WCS | 1.6 TB |
| Sweden | Markhöjdmodell | **CC BY 4.0** (not CC0) | 1 m | RH2000 | all | STAC (free login) | est. 1.2 TB |
| Finland | Korkeusmalli | CC BY 4.0 | 2 m | N2000 | all | funet mirror | est. 250 GB |
| Estonia | DTM | open licence | 1 m | EH2000 | all | Maa-amet | est. 180 GB |
| Poland | NMT (GUGiK) | free by statute (no formal licence) | ≤1 m | PL-EVRF2007 | all | WFS index → ASC | 223 GB |
| Czechia / Slovakia / Slovenia | DMR 5G (LAZ) / DMR 5.0 / LSS | CC BY 4.0 | points / 1 m / 1 m | Bpv / Bpv / SVS | all | ATOM / ZIP / ARSO | 120 / 183 / 54 GB |
| Portugal | DGT LiDAR MDT | CC BY 4.0 | 0.5, 2 m | — | mainland, NW pending | STAC (account) | est. 1.7 TB |
| UK | EA Composite DTM 2022; Scotland phases; Wales DTM | OGL v3 (not Scotland's phase 2) | 1 m | ODN | England ~99%, Wales all, Scotland patches | WCS, S3, single COG | 153 / 142 / 49 GB |
| Ireland | GSI Open Topographic LiDAR | CC BY 4.0 | 0.13–2 m | Malin Head | partial | image services | — |
| Italy | regions (Alto Adige CC0, Emilia-Romagna, VdA, Piemonte, Lombardia, Liguria, Sardegna CC BY 4.0); TINITALY 10 m | CC BY 4.0 / CC0 | 0.5–5 m | mixed (some ellipsoidal: use orthometric) | patchwork | WCS per region | — |
| ★ United States | USGS 3DEP seamless 1 m (S1M); 1/3″ | public domain | 1 m / 10 m | NAVD88 | CONUS partial / all | AWS `prd-tnm`, index GeoPackage | 4.9 TB / 494 GB |
| Canada | NRCan HRDEM mosaic; MRDEM-30 | OGL-Canada 2.0 | 1, 2 m / 30 m | CGVD2013 | LiDAR areas / all | S3 COG | 8.7 TB / 84 GB |
| Mexico | INEGI CEM 3.0 | libre uso (commercial OK) | 15 m | — | all (from contours) | INEGI | — |
| ★ Japan | GSI elevation tiles DEM5A (laser), DEM10B | GSI terms (credit; derived-work sentence) | 5 / 10 m | Tokyo Bay MSL | urban + plains / all | tile pyramid | — |
| New Zealand | LINZ 1 m DEM | CC BY 4.0 | 1 m | NZVD2016 | >80% | AWS `nz-elevation` | 377 GB |
| Australia | GA 5 m LiDAR DEM; states via ELVIS | CC BY 4.0 (QLD unclear) | 5 m; 1–5 m | AHD | 245k km²; patchy | S3 zips; ELVIS | 38 GB |
| Out | Lithuania (NC), Hong Kong (revocable, not bare), Toscana (NC), FABDEM, FathomDEM, TanDEM-X EDEM | | | | | | |

### Cost: the planet

Measured per z10 block (≈ 25–40 km square) on this machine, end to end
(read, footprints, gate, fallback, blend, encode):

| Set (how it is read) | Seconds a block | of which reading | Notes |
| --- | ---: | ---: | --- |
| ICGC 5 m (one COG over HTTP) | **40** | 22 | Catalonia's cell 7/64/47: 48 blocks with ground, 822 tiles, 153.8 MB |
| IGN RGE ALTI 1 m (ATOM, per département) | **81** from the cache; 1,138 for the first block | 12; 1,116 | the first block downloaded the eight départements whose envelope meets it (≈ 15 GB of 7z, 35 GB extracted, ~13 MB/s); every block of them after reads the extracted 1 m GeoTIFFs |
| USGS 3DEP 1 m (index of COGs over HTTP) | **≈ 1,230** | ≈ 1,200 | twelve-odd 10 km LZW tiles of 1 m floats a block, read in full |
| GSI DEM5A (tile pyramid) | **52** | 22–42 | ~1,100 PNG tiles a block |

The rest of a block is the same everywhere: footprints ~7 s (1,024 city tiles,
edge-cached), the gate ~4 s, the fallback ~1.5 s, the feather ~4 s, encoding
~3.5 s.

A block's archive share measured 2.3 MB (Tokyo), 2.5 MB (Paris) and 3.2 MB
(Catalonia, mountains) — call it 3 MB. Blocks are z10 tiles: ~1,000 km² at
35°, ~600 km² at 50°, ~340 km² at 62°.

| Scope | Land | Blocks | Archive (R2) | Build (runner-hours) |
| --- | ---: | ---: | ---: | ---: |
| The four proof sets, whole (Catalonia, France, US 3DEP 1 m where flown, Japan) | 2.5 M km² | ≈ 3,300 | ≈ 10 GB, **$0.15/month** | France ≈ 24 h (≈ 4 h of it the 180 GB of archives), US 1 m ≈ 620 h, Japan ≈ 7 h, Catalonia ≈ 1 h: **≈ 650 h** |
| + the rest of the US at 3DEP 1/3″ (10 m), its own set behind the 1 m one | + 6.6 M km² | + 7,200 | + 22 GB | + ≈ 120 h (a 10 m COG is a 5 m one's read) |
| + every European source in the table (Spain, Germany, UK, the Nordics, Benelux, the Alps, Poland, …) | + 4 M km² | + 7,600 | + 23 GB | + ≈ 170–250 h |
| + Canada (HRDEM areas), New Zealand, Australia's 5 m | + 2 M km² | + 4,000 | + 12 GB | + ≈ 70–200 h (HRDEM 1 m is 3DEP-like) |
| **All of the table** | **≈ 15 M km²** | **≈ 22,000** | **≈ 67 GB, $1.00/month** | **≈ 1,000–1,200 h** |
| For scale: Mapterhorn's whole planet z0–12 in R2 | 149 M km² | — | 356 GB, $5.30/month | — |

**Money**: GitHub's standard runners are free for a public repository (GoWay is
one), so the build costs nothing but time: 20 jobs at a time, ≈ 2–3 days of
wall clock for the whole table, ≈ 1.5 days of it the US at 1 m. R2 storage
≈ **$1/month** for all of it, class-A writes ≈ $0.05 (one put per cell and its
receipt), egress $0. The footprints cost ~22 M city-tile reads at the edge
during a full build (≈ $4 of Worker requests past the plan's 10 M; reading
the city archives straight from R2 in CI would remove even that). Every
source is free to read (producers' own servers; AWS Open Data buckets).
**Users' bandwidth**: a published DEM tile is ~1.7× Mapterhorn's (1/8 m
against 0.5 m: "Precision"), a few hundred kB more per tilted city view;
Cloudflare's egress is free.

### Publishing (owner's decision; nothing published)

1. Dry run the workflow for the four proof sets (`publish` off): every cell
   built and verified in CI, receipts and the would-be manifest as artifacts.
2. Publish them (`publish` on): archives under dated keys, then the manifest.
3. Set `MAP_TERRAIN_MANIFEST = "terrain/manifest.json"` in `wrangler.toml` and
   deploy: `/map/terrain/*` answers from the sets where published, Mapterhorn
   elsewhere; the credit names each source while it is on screen. Rollback:
   comment the line out (every tile Mapterhorn's again) or copy an older
   `terrain/manifests/<stamp>.json` over the live one.
4. Then country by country in the source table's order of people per km².
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

### Day and night

The globe is lit by the real sun: day on one side, night on the other, a
smooth twilight band of ~1,500 km between them, moving with the live clock or
with the time-of-day scrubber (`MapCanvas` hands the scrubber's instant to
the relief handle's `setTime`). `components/map/globeNightLayer.web.ts`, a
custom layer added with the globe; the model and shader are
`lib/map/style/globeNight.ts`, pinned by `__tests__/globeNight.test.ts`.

- **Per pixel, not per polygon.** Each pixel is ray-cast onto MapLibre's unit
  globe (the inverse of `defaultProjectionData.mainMatrix`) and its sun
  altitude read off the angle to the subsolar point (`lib/map/sun.ts` →
  `subsolarPoint`). No tiles or polygons: the poles and the antimeridian need
  nothing, and the twilight is a gradient. Through MapLibre's globe → mercator
  transition (z11–12) the same ray also meets the mercator plane
  (`fallbackMatrix`) and the two are mixed by `projectionTransition`.
- **A multiply under the 3D layers and the labels** (inserted before
  `building-3d`): the labels stay legible on the night side. The night is the
  city sky's own (`pow(sky ambient, 1/2.2)` at a sun 20° down, the blue-violet
  the street-level ground pass ends at), the twilight fitted to that pass
  within 0.1 at every sun altitude. The dark appearance gets its gentler
  night. Without night-lights data the night side is dark: no city lights are
  invented.
- **It hands over to the city sky** by fading out over z12–13, the zooms the
  sky's ground pass fades in over (`sky.ts` → `EFFECT_ZOOM`, pinned). Where
  the city engine is not attached yet (it comes at z14 or a 45° tilt), the map
  between z13 and z14 is the plain basemap, as before.
- **Cost**: one full-screen pass of a ray–sphere test below z13, nothing above;
  the quality profile's `relief.globeNight` (on in every preset: cheaper than
  the hillshade). It animates only with the live clock: one repaint a minute
  while the map is otherwise still.
- **MapLibre's own atmosphere stays off**: it is lit by the buildings' style
  light and draws over the labels (above). The glow around the globe is
  unchanged (the same on both sides).

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
- **The terrain textures' size is the quality profile's**
  (`relief.terrainTextureScale`, `reliefLayer.web.ts` → `applyTextureScale`):
  MapLibre caches the 2D layers per terrain tile at 2× its 1,024 px tile
  (2,048², ~22 MB each, mipmapped); the low preset makes them 1× — a quarter
  of the memory, roads and fills draped at half the resolution, labels
  untouched. Terrain stays on at every preset: without it MapLibre redraws
  every 2D layer per tile on every frame (`docs/MAP_PERFORMANCE.md` → the
  presets).
- **Two `raster-dem` sources** over the same tiles, one per use, as MapLibre
  asks; the second fetch is a browser-cache hit.
- **Sky and fog** for the tilted horizon, per appearance.
- On a style GoWay does not own (`openfreemap`, a style-URL override) the
  hillshade and terrain decline — exactly as the city layer does — and the
  globe still applies. A failed DEM tile is reported once and never raises
  "Map data unavailable": flat ground is still a map.

## Everything on the drawn ground

Street detail, building feet, tree trunks, city life, models and live vehicles
all stand on ONE ground (`terrainGround.ts` → `Ground`), and that ground is
the surface MapLibre's terrain draws — not a copy of it at another resolution.

**What MapLibre draws.** Each terrain tile is a 128 × 128-square mesh; each
vertex reads the DEM bilinearly between pixel CENTRES (`get_elevation` in its
vertex prelude; `Terrain.getElevationSampler` is the CPU twin), times the
exaggeration; each square is two flat triangles split from its north-west
corner to its south-east one. A terrain tile at zoom `z` reads the DEM tile at
`z − deltaZoom` (`TerrainTileManager`, `deltaZoom` 1), at most the source's
max zoom: at street level (terrain tiles z15–z18) always the z12 tile. A z15
terrain tile has two mesh lines a DEM pixel, on and halfway between the pixel
centres; finer ones subdivide it toward the bilinear DEM.

**What GoWay reads.**

- **The same DEM tile:** the host samples at `maxzoom + deltaZoom`
  (`city3dGround.web.ts`). It used to ask for `maxzoom` itself — which
  `getElevationForLngLatZoom` treats as a terrain tile's zoom, so it read the
  z11 tile: Barcelona at 29 m pixels under a terrain drawn from 14 m ones.
- **The same resolution:** each tile's grid (`GroundGrid`) is the DEM sampled
  at its own pixel centres, one past each edge (66 × 66 for a z15 tile, 130 ×
  130 for z14), so reading it bilinearly anywhere IS MapLibre's bilinear read
  (`gridAt`). It used to be 33 × 33 whatever the DEM. Buildings, trees, city
  life and models stand on it.
- **The same facets, for the street detail:** a GPU draws a triangle flat, the
  street is several layers of different triangles (asphalt, sidewalks, kerbs,
  paint, words), and a 30 m junction polygon has no vertex inside it. Over the
  bilinear DEM, every vertex on it, the layers' flat pieces still parted: the
  asphalt rose through the paint (Balmes: 8% of the paint under the asphalt,
  by up to 12 cm — letters missing from painted names) and the terrain through
  the asphalt. So the street stands on MapLibre's own mesh on its z15 tile
  (`facetAt`), and the street worker cuts every surface, tint and word along
  the mesh's lines and diagonals and adds a point to every painted line where
  it crosses one (`cityStreets/groundLattice.ts`, `MAP_STREETS.md` → Terrain
  and depth): every piece of every layer lies flat on one facet, so the layers
  share its plane.
- **Never under a finer terrain tile:** inside a z15 square the DEM is one
  bilinear patch whose corners the facets meet; it departs from them only by
  its twist `d = tl + br − tr − bl`, rising above them where `d < 0`, by at most
  `−d / 4`, and finer meshes interpolate that patch. Each corner of the street's
  ground is raised by the largest such rise of the squares round it
  (`streetGround`), read facet-wise (`streetGroundAt`): never under the
  terrain on z15–z18 tiles, still flat on each facet. The raise is the data's
  own: on Barcelona's street tiles 1.6 cm at the median, 6–9 cm at p95, 9–19 cm
  at p99 (DEM noise), 0 where the patch is not twisted.

**Measured.** The street tiles of the reports, their real road tiles, the z12
DEM goway.to serves, MapLibre's meshes rebuilt from the same pixels; "terrain
over" = where the drawn terrain rises above the street's surfaces before its
6 cm lift (`main`'s column with the lift), "paint under" = where the asphalt
rises above a tint, crossing, arrow or word:

| Mallorca–Marina 15/16581/12236 | Terrain over the street (z16 tiles) | Paint under the asphalt |
| --- | ---: | ---: |
| `main`: z11 DEM, 33² grid (with the 6 cm lift) | **22.5%**, worst 1.75 m | — |
| bilinear z12 DEM at every vertex, uncut | 0.44%, worst 0.25 m | — |
| …cut along the mesh | 0.001%, worst 6 cm | **6.8%**, worst 5 cm |
| this: on the facets, raised by the twist | **0.000%** (z15–z18) | **0.00%** |

Upper Balmes 15/16579/12237 and Carrer de Margarit (Montjuïc) 15/16580/12240,
the same way: on the bilinear DEM, cut, the paint is under the asphalt over
5.1% / 4.2% of it; on the bare z15 facets the terrain of z16–z18 tiles rises
above the street over 0.05–0.09% / 0.37–0.54% of it (worst 0.2 / 0.37 m); with
the raise, 0.000% and 0.00% on both. Against MapLibre's own `Terrain`,
`DEMData` and mesh (`city3dTerrainSampler.test.ts`): the sampler and the grid
are identical at every mesh vertex and within 2.8 cm / 7 mm / 1.7 mm / 0.4 mm
between vertices on z15 / z16 / z17 / z18 tiles; the facets ARE the z15 mesh;
the street's ground is never under any of them.

**What it does not match.** Terrain tiles kilometres out (z ≤ 14) are drawn
from coarser meshes or DEM tiles than the street level's; the street detail is
not drawn there. While the z12 DEM tile is still loading, MapLibre draws from
a loaded parent and so does the sampler (the same `getSourceTile`); the ground
is re-sampled when the tile arrives.

**Cost.** ~0.4 µs a sample (headless Chromium): a z15 grid is 4,356 samples
(~2 ms), a z14 one 16,900 (~7 ms), once per terrain, cached, one tile per
frame (`GROUND_TILES_PER_FRAME`, the streets' `groundsPerFrame`); a street
tile's 133² corners (`streetGround`) another ~1 ms. The cut is the big one: the
DEM's noise twists nearly every square, so a street tile's surfaces go from
55 k to 248 k triangles (Mallorca–Marina; Balmes 61 k → 276 k), counted
against the profile's `streets.drawTriangles` (farther tiles fall back to the
simplified level, then out, sooner), meshed in the worker (~0.15–0.25 s a
tile). Each tile's ground slot is a layer of one array texture, uploaded on
its own (69 KB); a tile's two meshes go to the GPU in separate frames within
the profile's upload budget. What the cut costs on a real GPU, per preset:
`MAP_PERFORMANCE.md` → "The street on the terrain's facets, on a real GPU".

**Cutting only where the facets bend does not pay, measured.** The obvious
saving — merge the facets wherever the street ground is a plane and cut only
where it bends — was built and measured (2026-10-13): a right-triangulated
irregular network (RTIN, Martini's 4-8 mesh) over each tile's street ground,
exact to its facets at full refinement, every triangle's error the TRUE
largest gap over the grid points it covers, propagated for conformity, the
tile's edge kept at full detail so tiles meet, and the street raised by the
error so it stays above the ground. On the real road tiles and DEMs:

| Tile (z15) | `main` facets (#210) | network at 1 cm | at 3 cm | at 10 cm | at 20 cm |
| --- | ---: | ---: | ---: | ---: | ---: |
| Mallorca–Marina, Barcelona | 247.6 k street triangles | 44.2 k network triangles: no fewer street triangles (262 k) | 42.3 k (256 k) | 28.2 k | 15.7 k |
| Rockefeller, Manhattan | 257.0 k | 40.7 k (267 k) | 37.9 k (258 k) | | |
| Gran Vía, Madrid | 205.0 k | 44.7 k (221 k) | 42.9 k (217 k) | | |
| Filbert St, San Francisco | 273.2 k | 45.9 k (299 k) | 44.5 k (293 k) | | |
| Louvre, Paris | 158.6 k | 37.3 k (160 k) | 34.9 k (155 k) | | |

Unsimplified, a tile's network is ~42 k triangles (two a mesh square plus the
edge); at errors a street could carry it barely shrinks, and by the time it
halves (10–20 cm) the street floats 20–40 cm. The ground is not smooth at
this scale anywhere measured: Mapterhorn stores heights to **0.5 m at z12**
(1 m at z11, 0.25 m at z13, halving with each zoom — every pixel of the
Barcelona and Manhattan tiles decodes to a multiple), so the terrain MapLibre
draws is a staircase smoothed over 14 m pixels; and the finer z13/z14 tiles
(0.25 / 0.125 m, 7 / 3.6 m pixels) measured the same — a city's bare earth has
kerbs, crowns and gutters at the centimetre scale. A coplanarity cut would
pay only on a DEM with no such texture; none of GoWay's is one.

## Buildings on terrain

With terrain on, MapLibre's custom-layer matrix puts `z` at **absolute**
elevation; a mesh built from `z = 0` is drawn at sea level — measured, the z14
tile under Gràcia spans 45–174 m, Andorra la Vella's 994–1,648 m, Montserrat's
164–1,122 m. So one lift per tile cannot work (off by up to 650 m) and the city
layer lifts each building (`terrainGround.ts`):

- **What is sampled.** MapLibre's terrain as it draws it: the DEM tile it
  draws from, at its own pixels — see "Everything on the drawn ground" above.
  The obvious `map.queryTerrainElevation` was tried first and dropped on
  measurement: it reads the *rendered* terrain tiles and, for a point outside
  them — which a z14 building tile's grid always partly is, behind or under a
  pitched camera — recomputes the covering tiles on every call: **~100 µs per
  call**, and one tile's grid took 166 ms on the main thread.
  `map.terrain.getElevationForLngLatZoom` (typed API) costs ~0.4 µs a call;
  every building reads its tile's grid bilinearly, so the cost does not grow
  with the building count (Barcelona: ~15,500 polygons per tile).
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
  terrain as drawn (`groundGrid`, since on the DEM's own lattice), and
  `city3dWorkerTrees.test.ts` pins a building on
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

- **Globe, 3D terrain, sky: web only**, until the wrapper exposes them. So is
  the globe's day and night: native has no globe to light, and its wrapper
  exposes no custom layer. A flat-map terminator could be a GeoJSON `fill`
  of night polygons (the wrapper has `GeoJSONSource` and `fill`), stepped into
  bands rather than a gradient; not done — the native globe is the engine's
  (`MAP_NATIVE_3D.md`).
- **Hillshade: native too.** `RasterDEMSource` (with `encoding: 'terrarium'`)
  and a `hillshade` layer exist in 11.4, so `MapCanvas.native.tsx` draws the
  same `hillshadeLayer()` under `water` — on by default like the web, switched
  off with the `terrain` map feature. Its style-spec `paint` reaches native through
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
2. Publish GoWay's own bare-earth sets (the owner's decision: "The archive"
   → Publishing), then country by country; report the Sagrada Família's
   classification to Mapterhorn all the same.
3. z13–14 tiles where a set's source is finer than z12 (the analysis grid is
   z14 already: sharper Montserrat), with a coverage-aware `maxzoom`.
4. Device benchmarks; then decide whether tilted terrain should follow the city
   layer's device gating on weak GPUs, and whether `Save-Data` should drop the
   hillshade.
5. Native globe and terrain when maplibre-react-native exposes them.

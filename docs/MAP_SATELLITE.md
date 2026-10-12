# Satellite imagery: sources, the build, the Worker, the styles, the plan

GoWay's `satellite` and `hybrid` maps: a raster base under (or without)
GoWay's own roads and labels, built only from imagery whose licence lets GoWay
**host it, re-serve it and display it publicly and commercially**, served from
GoWay's own R2 bucket through the Worker, and credited while each source is on
screen. **Status: proven end to end on Catalonia locally; nothing is
published.** The owner's decisions are at the end ([Decisions](#decisions)).

| Piece | Where |
| --- | --- |
| Sources GoWay may serve (the licence decision) | `packages/frontend/lib/map/imagerySources.ts` |
| Modes, tiers, tile paths | `lib/map/imagery.ts` |
| Style documents (pure, generated) | `lib/map/style/imagery.ts` → `public/map/goway-{satellite,hybrid}.json` (`map:style`, checked by `map:style:check`) |
| Style URL | `resolveMapStyleUrl(appearance, imagery)` (`lib/map/provider.ts`) |
| Map hook | `MapCanvasProps.imagery` (`components/map/types.ts`), both canvases |
| Credit while on screen | `lib/map/imageryCoverage.ts`, `components/map/useImageryCredits.ts`, `/attribution#imagery` (`lib/map/credits.ts`) |
| Sets (what is built, from what) | `scripts/imagery/catalogue.ts` |
| Build one set's cells | `scripts/build-satellite-set.ts` (`map:satellite-set`); `scripts/imagery/{cells,pmtilesStream}.ts`; GDAL pinned in `scripts/imagery/environment.yml` |
| Manifest | `scripts/build-satellite-manifest.ts` (`map:satellite-manifest`) |
| Worker | `worker/satellite.js`, routed from `worker/index.js`; `wrangler.toml` (`run_worker_first`, `MAP_SATELLITE_MANIFEST`, commented out) |
| CI | `.github/workflows/build-satellite-tiles.yml` (dry run by default); uploads through `scripts/city-r2.sh` (shared with the city tiles) |
| Local proof | `scripts/serve-map-build.ts --satellite=<dir>` |
| Tests | `worker/__tests__/satellite.test.js`, `lib/map/__tests__/imagery.test.ts`, `scripts/__tests__/satellitePipeline.test.ts`, `components/map/__tests__/reliefAttach.test.ts` |

## The rule

Only imagery whose licence allows GoWay to host it, re-serve it and display it
publicly and commercially, with the attribution drawn. **Never** Google, Apple,
Bing, Esri World Imagery, Mapbox Satellite, Maxar, Planet NICFI, any
"non-commercial" source (EOX Sentinel-2 cloudless 2018+ is CC BY-NC-SA), any
scraped tile service or reverse-engineered endpoint. A source enters
`imagerySources.ts` only after its licence is quoted below; the build refuses a
set naming any other (`catalogue.ts` → `checkSet`), and the client credits a
source only by its id there — never by a string the server sends — so a set of
an unlisted source is not drawn as credited, it is dropped
(`parseImageryCoverage`). Bulk downloads only: GoWay never harvests a viewing
service (WMS/WMTS), and never proxies one at runtime, so no viewer's viewport
reaches a third party.

## Phase 1 — the sources

Researched 2026-10-12/13. Every licence is quoted from the URL given; where a
claim could not be read at the source it says **unverified**. Sizes are the
publisher's, measured from a bucket listing, or estimated (marked ≈). The
GoWay size column is what the archives would weigh at the encoding below
([Encoding](#encoding)): WebP q80, 512 px, measured **8.0 MB/km²** for dense
urban 25 cm imagery (Barcelona, incl. overview zooms; 78 KB a z18 tile, 2.4
bits a pixel) and an **estimated 3.3 MB/km²** for open country (1 bit a pixel,
the usual rate for rural aerial photography at this quality; the rural
measurement could not be made, see [the proof](#local-proof-done-2026-10-13)).

### Global and low zoom

| Source | Coverage · resolution · vintage | Licence (quoted) | Credit | Access · size | Host derived tiles? |
| --- | --- | --- | --- | --- | --- |
| **ESA WorldCover S2 RGBNIR composite** (chosen) | Planet land, 10 m, yearly median of every Sentinel-2 L2A scene of 2020 and of 2021; no sea (nodata) | Each file: `license=CC-BY 4.0 - https://creativecommons.org/licenses/by/4.0/`; AWS registry: "License: CC-BY 4.0" (<https://registry.opendata.aws/esa-worldcover-vito-composites/>) | "© ESA WorldCover project 2021 / Contains modified Copernicus Sentinel data (2021) processed by ESA WorldCover consortium" (the files' own `copyright` tag) | `s3://esa-worldcover-s2/rgbnir/{2020,2021}/`, eu-central-1, public, 1° COGs, UInt16 × 10⁻⁴ reflectance; 2021: 19,359 tiles, **9.18 TB** (listed) | **Yes** |
| Copernicus Sentinel data (the licence under all of the above) | — | "EU law grants free access to Copernicus Sentinel Data and Service Information for the purpose of the following use … (a) reproduction; (b) distribution; (c) communication to the public; (d) adaptation, modification and combination …"; modified: "Contains modified Copernicus Sentinel data [Year]" (<https://sentinels.copernicus.eu/documents/247904/690755/Sentinel_Data_Legal_Notice>); ESA: "No distinction is made between public, commercial and scientific uses" | as quoted | — | — |
| **NASA Blue Marble NG** (chosen, z0–7) | Planet incl. ocean bathymetry shading, 500 m (21,600 × 10,800 px used: ~1.85 km), monthly 2004 | NASA material "generally are not subject to copyright in the United States"; commercial use "must not explicitly or implicitly convey NASA's endorsement"; "NASA should be acknowledged as the source" (<https://www.nasa.gov/nasa-brand-center/images-and-media/>) | "Blue Marble Next Generation, Reto Stöckli, NASA Earth Observatory" | Visible Earth PNG, 190 MB (`world.topo.bathy.200408.3x21600x10800.png`) | **Yes** |
| Copernicus Data Space "Sentinel-2 Global Mosaics" (L3 quarterly) | Planet land, 10 m, quarterly 2020 Q4 – 2026 Q2, first-quartile composite with SCL cloud mask | STAC licence "other" → the Sentinel legal notice (<https://stac.dataspace.copernicus.eu/v1/collections/sentinel-2-global-mosaics>) | "Contains modified Copernicus Sentinel data [Year]" | `s3://eodata/Global-Mosaics/Sentinel-2/S2MSI_L3__MCQ/…`, free CDSE account; quota 12 TB / 30 days; ≈15–20 TB a quarter | **Yes** — the fresher upgrade path |
| Own annual mosaic from Sentinel-2 L2A | Planet, 10 m, any year since 2018 | as Copernicus | as Copernicus | `s3://e84-earth-search-sentinel-data` (`sentinel-2-c1-l2a`), us-west-2, **not** requester-pays; ≈12 GB read per MGRS tile-year (20 scenes × B02–B04 + SCL) | **Yes** — see [own mosaic](#an-own-sentinel-2-mosaic) |
| EOX Sentinel-2 cloudless **2016** | Planet, 10 m, 2016–17 | "licensed under the Creative Commons Attribution 4.0 International License" (<https://cloudless.eox.at/license-non-commercial>) | "Sentinel-2 cloudless - https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 & 2017)" | WMTS only; bulk only "on request" | Legally yes, but only by bulk delivery from EOX (never by harvesting their WMTS); 2016 vintage — **not used** |
| EOX cloudless 2018–2025, EOxCloudless | Planet, 10 m | "Creative Commons Attribution-NonCommercial-ShareAlike 4.0" / "Sub-licensing or any kind of direct resale is not permitted" (<https://cloudless.eox.at/documentation/license>) | — | — | **No** (non-commercial / paid) |
| Sentinel Hub 120 m mosaic | Planet, 120 m, 10-day 2019–20 | "CC-BY 4.0, Credit: Contains modified Copernicus data [year] processed by Sentinel Hub" (<https://sentinel-s2-l2a-mosaic-120.s3.amazonaws.com/readme.html>) | as quoted | `s3://sentinel-s2-l2a-mosaic-120`, eu-central-1 | Yes — z0–8 alternative |
| Landsat C2 (USGS) | Planet, 30 m | "There are no restrictions on Landsat data … it can be used or redistributed as desired" (AWS registry `usgs-landsat`) | "Landsat imagery courtesy of the U.S. Geological Survey" | `s3://usgs-landsat`, **requester-pays** | Yes, but 30 m and no ready mosaic — not needed beside 10 m |
| Digital Earth Africa GeoMAD | Africa, 10 m, yearly since 2017 (geomedian) | "DE Africa makes this data available under the Creative Commons Attribute 4.0 license" (AWS registry `deafrica-geomad`) | "Contains modified Copernicus Sentinel data [year], processed by Digital Earth Africa" | `s3://deafrica-services/gm_s2_annual`, af-south-1, public | **Yes** — Africa upgrade where the median is cloudy |
| Digital Earth Australia GeoMAD | Australia, 30 m (Landsat) | "CC BY Attribution 4.0" (<https://data.dea.ga.gov.au/README.txt>) | Geoscience Australia | `s3://dea-public-data` | Yes (30 m) |
| Copernicus VHR 2018/2021 mosaic | Europe, 2 m | "The data cannot be downloaded" (land.copernicus.eu) — commercial imagery | — | view services only | **No** |

### Europe — national and regional orthophotos

| Source | Coverage · resolution · cycle | Licence (quoted, URL) | Credit | Bulk access | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Catalonia — ICGC Ortofoto territorial** (proof) | All Catalonia, 25 cm RGB + IRC, every year (2025 out) | "Geoinformation from the Cartographic and Geological Institute of Catalonia subject to a Creative Commons Attribution 4.0 International license (CC BY 4.0)" (<https://www.icgc.cat/en/Geoinformation-and-Maps/Data-and-products/Image/Territorial-Orthophoto>) | the sentence quoted | One file a year: `datacloud.icgc.cat/datacloud/orto-territorial/gpkg_unzip/ortofoto-rgb-25cm-catalunya-2025.gpkg` — **210.6 GB GeoPackage** (RGBA, 256 px JPEG tiles, EPSG:25831, internal overviews, HTTP ranges served); ECW 120.7 GB | **Yes** |
| **Spain — PNOA Máxima Actualidad** (IGN/CNIG) | All Spain, 25 cm (15 cm in parts of the north, 20 cm Canaries), 3-year cycle | "conlleva la aceptación por el usuario de una licencia CC-BY 4.0" (<https://www.ign.es/resources/licencia/Condiciones_licenciaUso_IGN.pdf>) | "Obra derivada de PNOA <fecha> CC-BY 4.0 scne.es" — clauses 5–6 also require it in a new **service's metadata** (our manifest and receipts carry it) | **COG per MTN25 sheet**, 13,764 files (<https://centrodedescargas.cnig.es/CentroDescargas/ortofoto-pnoa-maxima-actualidad>) | **Yes** |
| **France — IGN BD ORTHO** | Metropolitan + overseas, 20 cm, 3–6-year cycle | "Licence Ouverte / Open Licence version 2.0" (<https://www.data.gouv.fr/fr/datasets/bd-ortho-r/>) | source + date ("IGN – BD ORTHO® <année>"; IGN wording **unverified**) | JPEG2000 .7z per département (`data.geopf.fr/telechargement/…`) | **Yes** |
| **Netherlands — Beeldmateriaal (PDOK)** | National, 8 cm (HR, open from 2021) and 25 cm | "CC-BY (4.0)" (data.overheid.nl, 2026 RGB) | "Beeldmateriaal Nederland" (**unverified** wording) | ECW via the data room; large areas by order form | **Yes** (bulk may need a request) |
| **Switzerland — SWISSIMAGE 10 cm** | National, 10 cm (25 cm Alps), 3-year cycle | "may be enriched and processed and also used commercially", "distributed and made accessible" (<https://www.swisstopo.admin.ch/en/terms-of-use-free-geodata-and-geoservices>) | "© swisstopo" | **COG**, 1 km tiles (~42,700), 2.4 TB | **Yes** |
| **Austria — basemap.at Orthofoto** | National, 29 cm (15 cm parts) | "Open Government Data Österreich Lizenz CC-BY 4.0 … kommerzielle Zwecke frei" (<https://basemap.at/>) | "Datenquelle: basemap.at" | MBTiles dump, yearly | **Yes** (already web mercator) |
| **Germany — NRW DOP10** | 10 cm | Datenlizenz Deutschland – Zero 2.0 | none required | JPEG2000 directory, 1.19 TB | **Yes** |
| Germany — Bavaria, Lower Saxony (STAC+COG), Schleswig-Holstein, Bremen | 20 cm | CC BY 4.0 | e.g. "© GeoBasis-DE/LGLN (Jahr), Daten geändert" | various (Lower Saxony COG on S3) | **Yes** (Bremen **unverified**) |
| Germany — Berlin, Hesse | 20 cm | DL-DE Zero 2.0 | none | ATOM / download centre | **Yes** |
| Germany — Brandenburg, Saxony, Saxony-Anhalt, Rhineland-Palatinate, Baden-Württemberg, Hamburg, Saarland, Thuringia | 20 cm | dl-de/by-2.0 | per state, e.g. "©GeoBasis-DE / LVermGeoRP<Jahr>, dl-de/by-2-0" | directories/ATOM (Saarland WMS only; Thuringia **unverified**) | **Yes** (Saarland: no bulk) |
| Germany — Mecklenburg-Vorpommern, federal BKG DOP20 | — | "genehmigungs- und ggf. geldleistungspflichtig" / "Lizenzierung erfolgt gegen Entgelt" | — | — | **No** |
| **Belgium** — Wallonia (25 cm, CC BY 4.0, 209 GB GeoTIFF), Brussels UrbIS (5 cm, CC0), Flanders (15 cm, no licence named: "gratis als open data") | | Wallonia: "licence ouverte CC BY 4.0" (geoportail.wallonie.be); Brussels: "Creative Commons (CC-0)" | "SPW"; none; "© Digitaal Vlaanderen" | per province / ATOM / JPEG2000 | Wallonia, Brussels **yes**; Flanders **ask** |
| Luxembourg (ACT) | ≤ 10 cm, 2022 | CC0 1.0 | none | JPEG2000, 208 files | **Yes** |
| Czechia (ČÚZK) | 12.5 cm, 2-year | CC BY 4.0 since 1.7.2023 | ČÚZK | TIFF/JPEG sheets (use files, not WMS) | **Yes** |
| Poland (GUGiK) | 5–25 cm | "dostępna bezpłatnie do pobrania i możliwa do dowolnego wykorzystania" (no licence named) | GUGiK | per-sheet downloads | **Yes** (statute, not a named licence) |
| Denmark (Klimadatastyrelsen) | 12.5 cm, yearly | commercial use allowed | "Indeholder data fra Styrelsen for Dataforsyning og Infrastruktur, Forårsbilleder Ortofoto, <month year>" | GeoTIFF 1 km | **Yes** |
| Slovakia, Slovenia, Estonia, Finland (50 cm), Latvia (2016–18) | 15–50 cm | CC BY 4.0 / open | per agency | files | **Yes** (Slovenia licence from metadata) |
| Portugal — DGT OrtoSat 2023 | 30 cm Pléiades Neo | CC BY 4.0 for data-centre downloads (<https://www.dgterritorio.gov.pt/dados-abertos>) | DGT | GeoTIFF | **Ask**: Airbus's onward-redistribution rights **unverified** |
| Italy — Toscana 2023, Alto Adige 2023 | 20 cm | CC BY 4.0 (metadata) | regions | Toscana by e-mail; Alto Adige WMTS only | Toscana **yes on request**; others no |
| Italy national (AGEA), Ireland, Norway, Lithuania, UK national (APGB), Liechtenstein, Sweden (GDPR review pending) | | "TUTTI I DIRITTI RISERVATI" / licensed / "Commercial With Permission" | | | **No** |
| UK — Environment Agency Vertical Aerial Photography | patchy | Open Government Licence | "© Environment Agency copyright and/or database right <year>" | ECW | Yes (patchy) |

### Outside Europe

| Source | Coverage · resolution · cycle | Licence (quoted, URL) | Credit | Bulk access | Verdict |
| --- | --- | --- | --- | --- | --- |
| **USA — USDA NAIP** | Lower 48, 60 cm / 30 cm (23 states' latest flight), ≤ 3-year cycle | public domain: `https://www.usa.gov/publicdomain/label/1.0/` (<https://catalog.data.gov/dataset/national-agriculture-imagery-program-naip-imagery>); "Public Domain with Attribution" (<https://registry.opendata.aws/naip/>) | asked for: "Imagery: USDA FPAC-BC GEO, NAIP" | AWS **requester-pays**; Microsoft Planetary Computer COGs to 2023 free; 2024–25 county mosaics (MrSID) | **Yes** |
| **New Zealand — LINZ** | National, 50 cm everywhere, ≤ 15 cm on ~79,000 km² | "Licensed for re-use under 'CC-BY-4.0'" (<https://registry.opendata.aws/nz-imagery/>) | "Sourced from LINZ. CC BY 4.0" (<https://www.linz.govt.nz/products-services/data/licensing-and-using-data/attributing-elevation-or-aerial-imagery-data>) | `s3://nz-imagery`, ap-southeast-2, public, COG (lossless WebP), **96.3 TB** all years (listed) | **Yes** — the cleanest source found |
| **Japan — GSI photo tiles** (`seamlessphoto`, `ort`) | National, z14–18 (~0.5 m at z17 of 512 px) | PDL 1.0: "freely used, copied, publicly transmitted … Commercial use … is also permitted" (<https://www.gsi.go.jp/kikakuchousei/kikakuchousei40182.html>); photo tiles need no Survey-Act application (<https://maps.gsi.go.jp/development/ichiran.html>) | 「国土地理院」, plus 「GRUS画像（© Axelspace）」 where used; must state 編集・加工 | **No bulk**: tiles only | Licence **yes**; the only route is copying GSI's tiles — **ask GSI first** |
| Massachusetts (MassGIS, 15 cm), North Carolina (15 cm), Washington DC (7.5 cm, CC BY), New York City (15 cm, CC BY), Twin Cities (30 cm) | city/state | "No restrictions apply…" / "free and unrestricted use" / CC BY 4.0 / public domain | per agency | S3/JP2/tiles | **Yes** (NYC 2024 terms conflict: confirm) |
| Québec (regional 20 cm), Vancouver 2015 (7.5 cm), Ontario (16–50 cm) | | "Attribution (CC-BY 4.0)" / "Open Government Licence - Vancouver" / OGL – Ontario | per agency | downloads; Ontario bulk **uncertain** | Yes; Ontario **ask** |
| Hong Kong — Lands Dept True Digital Orthophoto 2023 | 25 cm | "for both commercial and non-commercial purposes" (<https://data.gov.hk/en/terms-and-conditions>) | "Lands Department, HKSAR Government / DATA.GOV.HK" | 192 GeoTIFF tiles | **Yes** |
| São Paulo city | 10 cm urban | CKAN `cc-zero` | none | GeoSampa | **Yes** |
| Mexico — INEGI orthophotos | 1.5–2 m, old | "Puede explotar comercialmente la información" (<https://www.inegi.org.mx/inegi/terminos.html>) | "Fuente: INEGI, <producto>" | per sheet | Yes (coarse) |
| Uruguay national 2017–18 | 32 cm (10 cm towns) | "datos abiertos" — licence **unverified** | | | **Ask** |
| OpenAerialMap | drone, patchy | "All imagery contained in OIN is licensed CC-BY 4.0" (<https://openaerialmap.org/about/>) | per image | per image | Per image |
| Australia states (NSW, Vic, WA, SA, Tas, NT), Toronto, Calgary, Ottawa, BC, New York State, USGS National Map imagery cache, Taiwan, Singapore, Israel, Korea, India | | commercial / no licence / "will not be available for direct download … due to license restrictions" | | | **No** |

## Phase 2 — the design

### Tiers

One raster source cannot stop at 10 m and also reach 25 cm: MapLibre requests
every tile of a source up to its `maxzoom`, and a tile nobody has is drawn as
nothing, not as its parent. So imagery is served in three **tiers**, one raster
layer each, finer above (`lib/map/imagery.ts`):

| Tier | Zooms | What | Where nothing is published |
| --- | --- | --- | --- |
| `base` | 0–13 | Blue Marble (z0–7) and the 10 m Sentinel-2 mosaic (z8–13), over-zoomed by MapLibre beyond 13 | z8+ open sea: the style's ocean colour |
| `detail` | 12–18 | 15–50 cm orthophotos | 404 from the manifest, no storage read; the base shows through |
| `fine` | 19–20 | 5–12 cm orthophotos | the detail tier's z18, over-zoomed |

Tiles are **512 px WebP with alpha**: an orthophoto's edge is a pixel edge,
not a tile edge. Within a tier the Worker picks, per tile, the first published
set (catalogue order = priority) that **has** that tile, so where two sources
overlap the preferred one wins and the other fills its holes.

### Sets, cells, keys

A **set** is one source (or composite) at one vintage — `icgc-ortofoto-2025`.
A set is cut into **cells**, the tiles of its `cellZoom`; every tile the set
publishes at zoom ≥ `cellZoom` is in exactly one cell, and each cell is one
archive:

```
satellite/<set>/<stamp>/<cellZoom>/<x>/<y>.pmtiles              the cell's tiles, all its zooms
satellite/<set>/<stamp>/<cellZoom>/<x>/<y>.pmtiles.receipt.json what it was built from, how, its sha256
satellite/manifest.json                                         the live manifest (rewritten last)
satellite/manifests/<stamp>.json                                every manifest ever published (rollback)
```

`<stamp>` is `YYYYMMDD-<suffix>`, never reused: a PMTiles archive is read by
byte offset, and an overwritten one would serve another tile's bytes. The
manifest lists each set's **cells as a coverage tree** (`coverageTree.js`, as
the city tiles' ownership), so the archive for a tile is computed, not looked
up in a list: Catalonia's 2,400-odd cells are 57 nodes of tree in the proof,
and the planet's 19,174 WorldCover cells a few kilobytes.

**Cell size is set by the upload path.** `wrangler r2 object put` refuses
objects over 300 MiB (measured by the city build). A z12 ICGC cell over central
Barcelona (z12–18, 5,461 tiles) measured **413 MB**; a z13 cell (z13–18,
1,365 tiles) **107 MB**. So the catalogue keeps a set within six zooms of its
`cellZoom`. With S3 multipart uploads (an R2 access key — a decision below)
cells could be 4–16× larger at no other change.

A set rebuilt in part (a failed job, a new flight over one province) is a
second manifest entry with the new stamp, listed first and holding only the
cells it rebuilt; `build-satellite-manifest.ts` subtracts those cells from the
older entry (`subtractCoverageTrees`) and lists their keys as retired — never
deleted by the build.

### The manifest

```json
{ "schema": 1, "generatedAt": "…",
  "sets": [{ "id": "icgc-ortofoto-2025", "stamp": "20261013-local", "name": "…",
             "tiers": ["detail"], "minZoom": 13, "maxZoom": 18, "cellZoom": 13,
             "sources": ["icgc-ortofoto"], "vintage": "2025", "bbox": [w, s, e, n],
             "cells": { "maxZoom": 13, "nodes": 57, "bits": "…" }, "cellCount": 13, "builtAt": "…" }] }
```

### Serving

`worker/satellite.js`, under `/map/satellite/` (`run_worker_first`):

| Path | Answer |
| --- | --- |
| `/map/satellite/{base,detail,fine}/{z}/{x}/{y}.webp` | **200** the stored WebP bytes (`image/webp`, a day at edge and browser, CORS `*`, CORP cross-origin) · **404** no published set has it (five minutes: the next manifest may). Outside the tier's zooms or the world: 404 before storage is touched |
| `/map/satellite/coverage.json` | sets, tiers, zooms, sources, cells — what the client needs for the credit; nothing about storage |
| `/map/satellite/manifest.json` | the manifest |
| `/map/satellite/data/<receipt key>` | a receipt the current manifest publishes; archives and the rest of the bucket are not offered |

Each archive's answer for a tile — the tile, or "absent" — is cached at the
edge under the archive's key, so a warm tile is one cache read and a cold one
is one R2 read plus directory reads that are themselves cached a week (the
same reader as every other route: `tiles.js` → `readTile`, sharing the
isolate's byte-bounded directory memo). WebP is stored as it is
(`tileCompression: NONE` — the codec is the compression), so `tileResponse`
sends the stored bytes to every client with **no `Content-Encoding`**, and
`check:worker-wire` holds the route to it in the real runtime (workerd): four
clients (gzip, identity, br-only, none), edge-cache miss and hit, each must get
the stored bytes as `image/webp`. **Memory**: the parsed manifest — its text
and each set's compact cell tree (5 B a node) — has its own 1 MiB line in
`budget.js`, and the parse refuses a manifest past it. **Off
until configured**: with `MAP_SATELLITE_MANIFEST` unset every tile is 404, the
coverage lists no sets, and no request touches storage.

### Encoding

Measured on 256 ICGC 2025 tiles of the Eixample (z18, 512 px, from the 25 cm
source, lanczos), PSNR against a lossless PNG of the same tiles:

| Encoding | Mean tile | PSNR | Encode, 1 thread, 256 tiles (incl. warp) |
| --- | ---: | ---: | ---: |
| WebP q70 | 50.6 KB | 33.9 dB | |
| **WebP q80** (chosen) | **63.4 KB** | **36.0 dB** | **83 s** |
| WebP q88 | 85.4 KB | 39.2 dB | |
| AVIF q60 | 41.9 KB | 33.8 dB | |
| AVIF q70 | 57.7 KB | 36.7 dB | 136 s |

**WebP.** AVIF is 9–17% smaller at equal PSNR and 64% slower to encode, but it
does not decode everywhere GoWay draws: MapLibre Native decodes images with
the platform — Android's `BitmapFactory` gained AVIF only in Android 12, iOS's
ImageIO in iOS 16 — while WebP decodes on every Android and iOS MapLibre
Native supports and in every browser. A second, AVIF copy for capable clients
would double storage for a ~13% saving. q80 because q70's 33.9 dB shows
ringing on roof edges at z18; 512 px because it halves the requests of 256 px
and is what MapLibre's raster sources and the DEM already use.

### Styles: satellite and hybrid

Generated from GoWay's dark document by `buildImageryStyle`
(`lib/map/style/imagery.ts`) and committed beside light and dark
(`map:style:check` keeps all four in step; light and dark are byte-identical
to before):

- **satellite**: background (Blue Marble's deep-sea blue, `#0d244f`, sampled at
  5°E 39°N, so the z8+ transparent sea meets the z0–7 Blue Marble ocean
  without a step) → the three imagery rasters → the overlay anchors only.
- **hybrid**: the same, then GoWay's roads (casings and tunnels dropped;
  translucent light strokes, motorways and trunks warm), rails, ferries,
  boundaries, POI dots and every label, with the dark palette's light text on a
  darker, wider halo. Every fill goes — the photo is the land.
- **3D buildings: off over imagery.** `building-3d` is dropped, so the city
  layer declines exactly as on any style without it. The territorial
  orthophotos are *not* true orthophotos: a tall building's roof is displaced
  from its footprint by the camera's lean, so a roof textured from the photo
  misregisters, and an untextured clay extrusion on a photographed roof draws
  every building twice. Textured buildings need true orthophotos or oblique
  imagery (a later step). **3D terrain stays on**: the relief adds its
  terrain (not its hillshade — a photograph has its own shadows) to an
  imagery style (`reliefLayer.web.ts`), and the photograph drapes over it.

### The hook (for the style system)

```ts
<MapCanvas imagery="hybrid" … />      // 'satellite' | 'hybrid' | null
resolveMapStyleUrl(appearance, mode)  // the document URL, both engines
```

The style picker passes `imagery`; the canvas loads the document (web
rebuilds the engine as for an appearance change; native swaps `mapStyle` in
place), credits the imagery, and suppresses the native hillshade. A
development build also reads `?imagery=satellite|hybrid` (production never
does). A picker should offer imagery only where
`/map/satellite/coverage.json` lists sets (it lists none until published).
A 404 from an imagery tier is a normal answer and never raises "Map data
unavailable"; any other imagery failure is reported once and the map stays up.

**Hand-off to the style engine (#197).** Its recipe (`docs/MAP_STYLES.md` →
"Imagery plugs in as one more style") makes satellite and hybrid catalogue
entries. Everything such an entry needs is here: the tier sources
(`imageryRasterSource`, `IMAGERY_TIER_IDS`, `imageryLayerId`), the ocean
colour, the hybrid line/label treatment (`buildImageryStyle`, which becomes
that entry's theme), the credit hook and the Worker. Until then,
`buildImageryStyle` over the dark document and the `imagery` prop are the
interim hook; after it, the prop maps onto the style ids.

### The credit

`useImageryCredits` reads `/map/satellite/coverage.json` once (five minutes),
and at every settled camera `imagerySourcesInView` names every source of every
set one of whose tiers is drawn at that zoom and one of whose cells meets the
view — the over-zoomed base under an orthophoto included, because a tile edge
can show it. Each source's short credit ("© ICGC", "© ESA WorldCover 2021 ·
Copernicus Sentinel-2", "NASA Blue Marble") rides in the compact ⓘ credit
(`MapAttribution`, both canvases), linking to `/attribution#imagery`, where
every source's notice is quoted in full (`lib/map/credits.ts`, from
`imagerySources.ts`). Measured in the proof below.

## The build

```bash
micromamba create -y -p <env> -f packages/frontend/scripts/imagery/environment.yml   # GDAL 3.13.3
bun run --cwd packages/frontend map:satellite-set --set=<id> --stamp=<YYYYMMDD-x> --out=<dir> \
  [--cells=all|z/x/y,… | --box=w,s,e,n] [--input=<local copy>] --gdal=<env>/bin
bun run --cwd packages/frontend map:satellite-manifest --entries=<dir>/entries \
  [--previous=<live manifest.json>] --out=<dir>/satellite/manifest.json
```

Per cell: **fetch** — the source warped (lanczos, alpha kept) to the cell's
own grid at the set's deepest zoom, in parallel horizontal strips, each its own
`gdalwarp` and HTTP connection, retried whole (the network here dropped 10–30%
of connections; a strip that cannot be fetched fails the cell, never a silent
blank tile) → **tile** — `gdal raster tile` (WebP q80, 512 px, nearest at the
deepest zoom because the grid is already identical, `average` for the
overviews, blank tiles skipped) → **pack** — a streaming PMTiles writer
sharing the city writer's directory code (`pmtilesPrelude`; identical bodies
stored once: ICGC paints its sea one flat blue, and 418 of those tiles packed
into 88 kB) → **verify** — every tile read back through `worker/pmtiles.js`
and compared byte for byte → **receipt**.

### The workflow

`.github/workflows/build-satellite-tiles.yml`, manual dispatch only:

- `sets`: catalogue ids; `box`: optional w,s,e,n; `cells_per_job` (24).
- `publish` (default **off**): off is a dry run — every cell built and
  verified, entries/receipts/would-be manifest kept as artifacts, nothing
  leaves GitHub. On: archives and receipts uploaded under dated keys
  (`city-r2.sh` with `OBJECT_PREFIXES=satellite`: no key overwritten, every
  object read back and hashed), then the manifest — dated copy first, live last.
- `keep_archives`: keep a dry run's archives 3 days.
- Jobs: `plan` (the matrix from `map:satellite-set --plan`, which drops
  open-ocean WorldCover cells), `build` (≤ 20 at a time, GDAL from conda-forge
  pinned, cells built on `/mnt`), `manifest` (also after a partial failure; a
  failed job's cells keep what the manifest named before).

## Local proof (done, 2026-10-13)

Catalonia over a Sentinel-2 global base, on the build machine (32 cores at a
load average of 75–105 from other work, so wall times are pessimistic):

| Set | Cells | Tiles | Archives | Time |
| --- | ---: | ---: | ---: | --- |
| `blue-marble-2004` z0–7, one cell | 1 (0/0/0) | 21,845 | 103.8 MB | 154 s |
| `worldcover-2021` z8–13 over Catalonia | 9 z8 | 6,493 | 175.9 MB (27.1 KB a tile) | 28–185 s a cell, ~70% of it the fetch from AWS |
| `icgc-ortofoto-2025` z13–18, central Barcelona (4 × 4 z13 cells, from the 2025 GeoPackage) | 13 (3 all sea: skipped) | 15,253 | 774.2 MB (dense cells 78–107 MB) | 66–86 s a dense cell |
| `icgc-ortofoto-2025`, two rural cells read straight from ICGC's server | **failed closed**: after the Barcelona fetch, `datacloud.icgc.cat` stopped accepting connections from this machine (connect timeouts of 135 s, while icgc.cat and AWS answered); every strip was retried 5 times, then the cell failed — no archive, no entry, no blank tile |

CPU: a full z12 ICGC cell (5,461 tiles) took 1,297 CPU-seconds — **≈0.24
CPU-s a tile** including the warp. The central-Barcelona strips (225 km²) came
from ICGC's GeoPackage in ~4 minutes over 8 connections at 6–10 MB/s each.

Served by `serve-map-build.ts --satellite=<out> --upstream=https://goway.to`
over a development export (the Worker's own `satellite.js` reading the
directory as the bucket), in headless Chromium (SwiftShader). Screenshots in
`goway-videos/` (`satellite-01` … `satellite-09`):

| Shot | What it shows |
| --- | --- |
| `satellite-01-hybrid-eixample-z16` | Hybrid over the Eixample at z16: ICGC 25 cm under GoWay's roads and labels; credit "© ICGC · © ESA WorldCover 2021 · Copernicus Sentinel-2" beside the basemap's |
| `satellite-02-satellite-sagrada-familia-z18` | Satellite at z18.2 over the Sagrada Família: the 25 cm flight at its native zoom |
| `satellite-03-hybrid-barceloneta-z15` | Hybrid on the coast: ICGC's own painted sea, the port, Barceloneta |
| `satellite-04-hybrid-catalonia-z9` | Hybrid at z8.6: the WorldCover 2021 Sentinel-2 mosaic of Catalonia with GoWay's labels |
| `satellite-05-satellite-ortho-edge-z13` | Satellite at z13.2 on the western edge of the built cells: ICGC tiles beside WorldCover tiles, the seam at the cell edge (pixel-exact; the colours differ) |
| `satellite-06-satellite-globe-z2` | The globe at z2.2: Blue Marble August 2004, credit "NASA Blue Marble" |
| `satellite-07-satellite-montserrat-terrain` | Satellite pitched 62° over Montserrat: WorldCover over-zoomed, draped over the 3D terrain (no hillshade) |
| `satellite-08-hybrid-phone-z17` | Hybrid on a 390 × 844 phone at z17, the credit in the corner |
| `satellite-09-map-same-view` | The ordinary map at shot 01's camera, for comparison |

Two things the run taught: under this machine's load a hybrid view needed
~60 s to place its labels (the vector tiles of central Barcelona are 1.2 MB
each), so the shots wait 70 s; and an imagery tier's 404s must not reach the
canvas's "Map data unavailable" state (fixed, `MapCanvas.web.tsx`).

## Costs

R2 storage $0.015/GB-month, egress $0; Class A writes $4.50/M (an archive is
one put, two with its receipt); Class B $0.36/M uncached reads; Worker $0.30/M
requests over the plan's 10 M; GitHub's standard runners are free for a public
repository (a private one: $0.016/runner-minute, 4 vCPU).

| What | Storage | R2 / month | Build |
| --- | ---: | ---: | --- |
| The proof (Blue Marble + Catalonia WorldCover + 13 Barcelona cells) | ~1.05 GB | ~$0.02 | done locally |
| Blue Marble z0–7, planet | 0.10 GB | $0.002 | 3 min |
| WorldCover 2021 z8–13, planet (19,174 cells, ~31.9 M tiles at the measured 27.1 KB) | **≈ 0.86 TB** | **≈ $13** | ~32 M tiles × ~0.15 CPU-s ≈ 1,300 runner-hours of 4 vCPU → ~128 jobs, 20 at a time ≈ **10–14 h wall**, $0; ~7 TB read from AWS eu-central-1 (free to read) |
| ICGC Catalonia, all of it (~2,400 z13 land cells, 32,108 km²) | **≈ 106–257 GB** | **≈ $1.6–3.9** | ~3.2 M tiles × 0.24 CPU-s ≈ 215 CPU-h ≈ 54 runner-hours → 100 jobs of 24 cells ≈ **3 h wall**, $0; 210 GB read from ICGC |
| An own planet Sentinel-2 mosaic (instead of WorldCover 2021) | ~1 TB | ~$15 | ≈300 TB read in AWS us-west-2 ($0), 2–4 k vCPU-h ($75–150 on demand, a third on spot), egress of ~1 TB to R2 ≈ $80–130: **≈ $300–600 a year's mosaic** |

**Publish commands** (after approval; the workflow runs the same):

```bash
# 1. Dry run in CI (nothing leaves GitHub): Actions → Build satellite tiles →
#    sets=blue-marble-2004,worldcover-2021, box=0,40,4,43.5, publish=false
# 2. Publish (dated keys, read back and hashed):
gh workflow run build-satellite-tiles.yml -f sets=blue-marble-2004,worldcover-2021 -f publish=true
gh workflow run build-satellite-tiles.yml -f sets=icgc-ortofoto-2025 -f cells_per_job=24 -f publish=true
# 3. Serve: uncomment MAP_SATELLITE_MANIFEST = "satellite/manifest.json" in
#    packages/frontend/wrangler.toml and merge (the frontend deploy ships it). Check
#    https://goway.to/map/satellite/coverage.json and /map/satellite/detail/16/33166/24476.webp
# By hand, from a local build (same script, same rules):
OBJECT_PREFIXES=satellite MANIFEST_KEY=satellite/manifest.json \
  bash packages/frontend/scripts/city-r2.sh put-tree <out>
OBJECT_PREFIXES=satellite MANIFEST_KEY=satellite/manifest.json \
  bash packages/frontend/scripts/city-r2.sh publish-manifest <out>/satellite/manifest.json <stamp>
```

Rollback: copy a `satellite/manifests/<stamp>.json` over
`satellite/manifest.json` (≤ 6 minutes to every colo), or comment the variable
out and deploy (every imagery tile 404; the picker offers none).

### An own Sentinel-2 mosaic

WorldCover 2021 is the base because it is ready, global, CC BY 4.0 and needs
no account. Its limits: 2021, and a plain median (haze and residual cloud in
persistently cloudy tropics). The upgrade is either CDSE's quarterly mosaics
(2026 Q2 exists; 12 TB a month of free quota ≈ 5 weeks a global quarter) or an
own annual composite from `sentinel-2-c1-l2a` in us-west-2 — 20–25 k land MGRS
tiles × ~20 low-cloud scenes × B02–B04 + SCL, SCL-masked first-quartile or
geomedian (odc-stac / odc-algo), the cost above. Either replaces only the
`worldcover-2021` set, by adding a new set listed before it.

## Phase 3 — the planet plan

Ranked by people covered × resolution × licence × bulk access. Storage at the
measured densities ([Phase 1](#phase-1--the-sources)): 25 cm-class sources at
z18 (finer sources capped at z18 in this plan: z19 is ×4 the bytes — a
decision below), 60 cm NAIP and GSI at z17; ≈ 3.3–8.0 MB/km² at z18 at 41°N
(open country–dense city), scaled by latitude. Build ≈ 0.24 CPU-s a tile on
GitHub's free 4-vCPU runners, 20 jobs at a time; storage $0.015/GB-month.

| # | Set (licence) | People | Area km² | Zoom | Storage | R2 / month | Tiles | Runner-hours |
| ---: | --- | ---: | ---: | --- | ---: | ---: | ---: | ---: |
| 0 | **Base: Blue Marble z0–7 + WorldCover 2021 z8–13** (public domain; CC BY 4.0) | 8.1 B | planet land | z0–13 | 0.86 TB | $13 | 32 M | ~1,300 |
| 1 | Spain — PNOA 25 cm (CC BY 4.0, COG per sheet); Catalonia from ICGC yearly | 48.6 M | 506,000 | z18 | 1.6–3.9 TB | $24–58 | 49 M | 820 |
| 2 | France — BD ORTHO 20 cm (Etalab 2.0) | 68 M | 551,700 | z18 | 2.1–5.2 TB | $32–77 | 65 M | 1,090 |
| 3 | USA — NAIP 60 cm, lower 48 (public domain) | 330 M | 8,080,000 | z17 | 6.1–14.9 TB | $92–223 | 188 M | 3,140 |
| 4 | Germany — 15 open states, DOP20/DOP10 (DL-DE Zero / by-2.0 / CC BY 4.0) | 80 M | 334,000 | z18 | 1.6–3.8 TB | $23–57 | 48 M | 800 |
| 5 | Poland — GUGiK 25 cm ("any use", statute) | 36.6 M | 312,700 | z18 | 1.5–3.7 TB | $23–56 | 47 M | 780 |
| 6 | Japan — GSI photo tiles (PDL 1.0; **ask GSI**, no bulk) | 124 M | 378,000 | z17 | 0.27–0.65 TB | $4–10 | 8 M | 140 |
| 7 | Netherlands — 8 cm at z18 (CC BY 4.0) | 18 M | 41,500 | z18 | 0.20–0.49 TB | $3–7 | 6 M | 100 |
| 8 | Czechia — 12.5 cm at z18 (CC BY 4.0) | 10.9 M | 78,900 | z18 | 0.35–0.85 TB | $5–13 | 11 M | 180 |
| 9 | Austria — basemap.at (CC BY 4.0) | 9.2 M | 83,900 | z18 | 0.34–0.83 TB | $5–12 | 10 M | 175 |
| 10 | Switzerland — SWISSIMAGE at z18 (free, commercial use) | 9.0 M | 41,300 | z18 | 0.16–0.40 TB | $2–6 | 5 M | 84 |
| 11 | Belgium — Wallonia + Brussels (CC BY 4.0, CC0; Flanders: ask) | 4.9 M | 18,700 | z18 | 0.09–0.21 TB | $1–3 | 3 M | 44 |
| 12 | Denmark — 12.5 cm at z18 | 6.0 M | 42,900 | z18 | 0.25–0.62 TB | $4–9 | 8 M | 130 |
| 13 | New Zealand — LINZ (CC BY 4.0, S3 COG) | 5.3 M | 268,000 | z18 | 0.87–2.1 TB | $13–32 | 27 M | 450 |
| 14 | US 15 cm states and cities — MA, NC, NYC, DC | 26.8 M | 167,600 | z18 | 0.52–1.25 TB | $8–19 | 16 M | 265 |
| 15 | Québec (south) — 20 cm (CC BY 4.0) | 8 M | 200,000 | z18 | 0.77–1.9 TB | $12–28 | 24 M | 395 |
| 16 | Hong Kong, São Paulo city | 19 M | 2,600 | z18 | < 0.02 TB | < $1 | 0.3 M | 5 |
| — | Later: NAIP 30 cm states at z18 (replaces their 60 cm) | | 3,740,000 | z18 | +11–27 TB | +$170–410 | 348 M | 5,800 |

**Totals.** Rows 0–2 (the base, Spain, France): **≈ 4.6–10 TB, $69–150 a
month, ~3,200 runner-hours** (≈ 7 days of 20 parallel free jobs; ~2 days if
the larger tiles machine builds them). Rows 0–16: **≈ 18–42 TB, $260–630 a
month**. Every number is linear in the density: the dense-urban 8.0 MB/km² is
measured, the 3.3 is an estimate — the first CI dry run of a rural province
replaces it.

**Order of work.** 0 (one dispatch; the planet at 10 m, the precondition for
every style decision) → 1 (Spain, from PNOA's per-sheet COGs, which avoids the
single 210 GB ICGC file; Catalonia's yearly ICGC set later, from a whole-file
download) → 2 → 3 → the rest as their licences are confirmed. The upload path
decides throughput: wrangler's 300 MiB per object means z13 cells for 25 cm
sources (~2,400 archives for Catalonia); R2 access keys with multipart would
allow z11–z12 cells and a quarter of the objects.

## Decisions

1. **Approve the base set** (Blue Marble z0–7 + ESA WorldCover 2021 z8–13,
   ~0.86 TB, ~$13/month) for a first published run. Its credit is
   "© ESA WorldCover 2021 · Copernicus Sentinel-2" and "NASA Blue Marble".
2. **Where the upload runs and with what credentials.** Either keep the city
   build's `CLOUDFLARE_API_TOKEN` + wrangler (≤ 300 MiB objects: z13 cells for
   orthophotos, many archives), or create an **R2 access key** (S3 API,
   multipart) for this bucket so cells can be 4–16× larger. Nothing was
   created; this is yours to do.
3. **Catalonia's source.** ICGC's yearly orthophoto (one 210 GB file; its server
   stopped answering this machine after a parallel range-read burst — build it
   from a whole-file download on the tiles machine, or ask ICGC) or PNOA's
   per-sheet COGs from CNIG (Spain-wide, 3-year cycle, CC BY 4.0 with the
   metadata clause). Recommended: PNOA for Spain now, ICGC's yearly set for
   Catalonia on top once it can be downloaded whole.
4. **z19 for 5–12 cm sources** (NL, NRW, Switzerland, Brussels, Czechia, DK):
   4× the bytes of z18 for the cm-level detail Google shows; this plan caps
   them at z18 until you choose.
5. **Licences to confirm by asking the publisher**: GSI (Japan, no bulk
   download — copying their tiles needs a courtesy agreement), Flanders (no
   licence named), Portugal OrtoSat (Airbus's redistribution rights), Ontario
   and Uruguay (bulk access / licence text), NYC 2024 (terms conflict).
6. **3D buildings over imagery**: off in this change (reasons above). Want
   untextured clay as an option in the picker, or wait for true orthophotos?
7. **Merge order with #197** (the style engine): its `MAP_STYLES` recipe takes
   imagery as a catalogue entry; this PR's pieces (tiers and sources, the
   Worker, the credit hook, the transform) are what that entry is built from.
   Whichever merges second rebases; the `imagery` prop becomes the catalogue's
   `satellite`/`hybrid` style ids.

## Limits and next

- **Seams** at a set's edge are pixel-exact (alpha), but colour differs between
  sources (ICGC 2025 vs WorldCover 2021) at z13; a colour-matching pass per set
  (histogram match to the base) is the follow-up.
- **ICGC's sea** is a flat painted blue (RGB ≈ 24, 42, 70), opaque, drawn over
  the base; close to the style's ocean, but not transparent.
- **Native** draws the documents and the credit (type-checked; not yet run on a
  device), and no 3D terrain (`MAP_TERRAIN_GLOBE.md` → Native).
- **True orthophotos** (where published) would allow roof-textured buildings.
- **Night**: the globe's night shading multiplies over the imagery like the map.

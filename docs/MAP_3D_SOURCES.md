# Official 3D building data: sources, licences, and what GoWay merges

GoWay's city tiles ([`MAP_3D_CITY.md`](./MAP_3D_CITY.md) → Phase 2) are
OpenStreetMap's buildings. This note is Phase 4: which **official, openly
licensed** building datasets can make them better — recorded heights instead
of the 5 m default, measured roofs instead of `levels × 3.66` boxes — whether
each may be served publicly inside an ODbL database, and how the two merged
so far are merged: **Spain's Catastro** (storeys per building part, every
municipality an extract covers — the fix for the 5 m boxes in Barcelona and
Madrid) and **New York City's 3D model** (LOD1.5 with LOD2 landmarks).

**Never a source:** Apple Flyover or any data scraped from a proprietary map
(e.g. the `flyover-reverse-engineering` project). It is unlicensed; it is not
downloaded, used or referenced as a source for anything here.

## How a verdict is reached

GoWay's city tiles are a **Derivative Database of OpenStreetMap** (ODbL 1.0).
Merging another dataset into them makes that dataset part of the derivative:
the model's roofs carry the OSM id they replace (`osm_id`) and OSM features
carry `drawn_by`, so the two are linked, not merely collected side by side.

- **ODbL §4.4** — a Derivative Database that is publicly used must be offered
  under the ODbL (or a compatible licence), and **§4.4(c)** forbids adding
  contents "incompatible with the rights granted under this License". **§4.5**
  exempts only a *Collective Database* (independent databases in unmodified
  form, side by side) and Produced Works.
  ([opendatacommons.org/licenses/odbl/1-0](https://opendatacommons.org/licenses/odbl/1-0/))
- **CC BY 4.0** permits adaptations under another licence as long as the
  recipient can still comply with BY: attribution kept, the change indicated,
  and no technical measures restricting the licensed material (§2(a)(5)(B),
  §3(a), §3(b)). Creative Commons' own guidance: BY adaptations "may be made
  under any license where it is possible to comply with both licenses"
  ([wiki.creativecommons.org/wiki/4.0/Adaptations](https://wiki.creativecommons.org/wiki/4.0/Adaptations)).
  So a CC BY dataset **can** sit in GoWay's ODbL tiles, credited, marked as
  modified, never behind DRM.
- **OSMF's "CC BY needs a waiver"** position
  ([osmfoundation.org/wiki/Licence/Licence_Compatibility](https://osmfoundation.org/wiki/Licence/Licence_Compatibility))
  is about data *added to the OpenStreetMap database* by its contributors. It
  does not govern a third party's derivative database, which is what GoWay's
  tiles are. Nothing here is imported into OSM.
- **Public domain / no-restriction** data (NYC Open Data) has nothing to
  reconcile; it is credited because the city asks for the source to be named
  and because a map should say where its shapes come from.
- **ND** (no derivatives) and **NC** (non-commercial) terms are incompatible:
  meshing, conflating and re-tiling is a derivative, and GoWay is a product.

Facts below were read on the publishers' own pages (dataset pages, licence
texts, ATOM feeds, metadata PDFs), on 2026-10-11. **UNCONFIRMED** marks what
could not be read there.

## Barcelona and Catalonia

| Dataset | Format, LOD | Licence | Verdict |
| --- | --- | --- | --- |
| **Ajuntament de Barcelona, "Model Tridimensional d'edificacions"** (CartoBCN) | SLPK (I3S), city-wide, 552 MB, updated 2026-04-30; DWG 3D per neighbourhood (73), 2026-05-26. **LOD1**: the 1:1000 topographic map's volumes extruded onto the municipal surface model (planimetric 0.02 m, altimetric 0.025 m, per the product metadata). Attributes `Z_MIN_VOL`, `Z_MAX_VOL`, `NIVELL`. | CartoBCN terms: "the majority" of datasets are **CC BY 4.0**; "where there is participation by third parties", **CC BY-ND 4.0**. The product's own feed says only "Llicència que dona l'aj bcn 2014"; the GPKG's README says its heights come from the **AMB**'s (Àrea Metropolitana) terrain and surface models — a third party. Which licence applies is **UNCONFIRMED**. | **Not merged.** If CC BY: usable with "Font de les dades: Ajuntament de Barcelona", modifications identified, date of last update stated. If CC BY-ND: not usable at all. Ask `cartografia@bcn.cat` before using it. Also LOD1: measured heights, no roof shapes. |
| **ICGC, Referencial topogràfic territorial v1** | GeoPackage 3D (~10 GB per year, all Catalonia), DWG/DGN 3D, IFC; 1:5,000; vertices carry altitudes. The extruded-volumes product was **withdrawn** in 2025 (spec change log, 12.06.2025). **No LOD2 product** found. | **CC BY 4.0** ("Geoinformació de l'Institut Cartogràfic i Geològic de Catalunya subjecta a una llicència Creative Commons de Reconeixement 4.0"). | Legally clear; **not merged** — 1:5,000 building outlines with altitudes add less than the Catastro storey counts OSM already carries in Barcelona. |
| **Dirección General del Catastro, INSPIRE Buildings** | INSPIRE GML 3.2, one zip per municipality (ATOM `catastro.hacienda.gob.es/INSPIRE/buildings/ES.SDGC.BU.atom.xml`; Barcelona is `08900`, Madrid `28900` — the Catastro's own codes, not INE's); `BuildingPart` footprints (0.1 m) with `numberOfFloorsAboveGround`. All Spain except Navarra and the Basque Country (their own cadastres), feed dated 2026-08-21. | **Not CC BY 4.0** on any page read. The dataset metadata: "no limitation", "No conditions apply". The feed's rights: "This service can be used free of charge in every instance, as long as that the D. G. of the Cadastre (Ministry of Finance) is mentioned as author and owner of the information". The licence it links (*Licencia de acceso y uso … INSPIRE*, v1.0, July 2016): public and commercial use of cadastral information **that has been transformed** into a different work; the original may not be redistributed untransformed; transformation must not alter or distort its content; the result must not be called "cartografía catastral" / "información catastral". | **Merged** (below). GoWay transforms it — reprojected, re-quantised to the tile grid, storeys turned into heights, conflated with OSM — credits "Dirección General del Catastro" while drawn, and never calls the result cadastral. |

**Verdict for Barcelona: no open LOD2 roof source exists, and the city's own
LOD1 model is not legally clear — but the Catastro's storeys are usable, and
merged.** A surface-model height estimate was tested elsewhere and rejected as
too inaccurate; the cadastre's recorded storeys are not an estimate.

## New York City

| Dataset | Format, LOD | Licence | Verdict |
| --- | --- | --- | --- |
| **NYC 3-D Building Model** (DoITT/OTI; NYC Open Data `tnru-abg2`) | CityGML 1.0 (`DA_WISE_GML.zip`, 916 MB → 13.8 GB, 20 delivery areas), also Multipatch and DGN; EPSG:2263, US feet. Stereo-compiled from **2014** aerial photos on the planimetric footprints: a "hybrid specification combining elements from LOD 1 and 2" — **LOD1.5** (roofs differing by less than 8 ft merged; domes, pitched roofs and appendages not modelled) and "approximately **100 iconic buildings** … in LOD 2". ±1.25 ft XY, ±1.6 ft Z (95%). One-time capture. | NYC Open Data: "There are no restrictions on the use of Open Data" (NYC Open Data FAQ). The Socrata record carries no licence; the DCP README adds a no-warranty use limitation. | **Merged** (below). Credited as "NYC 3D Building Model (modified)", linking the dataset page. |
| NYC Building Footprints (`5zhs-2jue`), PLUTO (`64uk-42ks`), LiDAR 2017 (`7sc8-jtbz`) | Footprints with `height_roof`; tax-lot `numfloors`; a ~180 GB point cloud. | Same terms, no restrictions. | Footprints and heights are already OSM's (the NYC import: 97.7% of Manhattan's features carry `height`); not merged again. The LiDAR could give real roofs for the post-2014 city — later. |

Measured in the file itself (DA12, Lower and Midtown Manhattan): 24,038
buildings, 609,730 polygons — 79,584 roofs, 505,897 walls, 24,249 grounds;
2.2% of roof polygons are sloped. Every building carries `BIN`, `DOITT_ID`,
`SOURCE_ID`.

## The rest of the world (survey)

Read on the publishers' pages by the same rules; none of these is merged yet.

| Dataset | Format, LOD | Licence and attribution | Public ODbL tiles? |
| --- | --- | --- | --- |
| **3DBAG** (Netherlands, TU Delft 3D geoinformation + 3DGI) | CityJSON(Seq), GPKG, OBJ, FlatGeobuf; **LoD2.2** from AHN lidar; release 2025.09.03 | CC BY 4.0; "© 3DBAG by tudelft3d and 3DGI", changes stated | Yes. Needs RD New (EPSG:28992/7415), which `crs.ts` does not implement yet (refused, never guessed). |
| **PLATEAU** (Japan, MLIT) | CityGML 2.0 (i-UR), 3D Tiles; LOD1 everywhere, LOD2 in some districts | PLATEAU site policy (based on the Public Data License 1.0), CC BY 4.0-compatible, and states it does not prevent use under ODbL; "出典：国土交通省 PLATEAUウェブサイト（URL）" plus a note of editing | Yes. The policy flags Survey Act limits on public-survey results (read before use). |
| **NRW**, **Berlin** | CityGML LOD2 (NRW: airborne laser; Berlin: standard roofs), 1 km tiles | Datenlizenz Deutschland **Zero 2.0** | Yes, no conditions. |
| **Bavaria** | CityGML 1.0 LOD2 per municipality (metalink) | **CC BY 4.0**; "Geobasisdaten: Bayerische Vermessungsverwaltung – www.geodaten.bayern.de (Daten verändert), Lizenz: CC BY 4.0" | Yes. |
| **Hamburg**, **Baden-Württemberg**, **Saxony** | CityGML LOD2 (Hamburg also 3D Tiles) | **dl-de/by-2.0** (source note, changes marked): "Freie und Hansestadt Hamburg, LGV"; "Datenquelle: LGL, www.lgl-bw.de, dl-de/by-2-0"; "Quelle: GeoSN, dl-de/by-2-0". BW tiling **UNCONFIRMED**. | Yes, with the source note. dl-de/by neither forbids nor names relicensing; merging into "new and independent datasets" is allowed. |
| **Montréal** | CityGML LOD2 textured (2020; 2016, 2009) | CC BY 4.0; cite "Ville de Montréal … Données ouvertes de la Ville de Montréal" | Yes. |
| **Zürich (city)** / **swisstopo swissBUILDINGS3D 3.0** | CityGML LOD2 roof model / CityGML 2.0 (stereo) | City: **CC0**. swisstopo: free geodata, "a reference to the source is mandatory" ("© swisstopo") | Yes. A Kanton Zürich model is **UNCONFIRMED**. |
| **Helsinki** | CityGML 2.0 LoD1/LoD2, WFS | CC BY 4.0 (hel.fi); exact attribution string **UNCONFIRMED** (hri.fi refused access) | Yes, credit "City of Helsinki". |
| **Vienna** | CityGML/DXF LOD2.1 roofs | "Datenquelle: Stadt Wien – data.wien.gv.at"; CC BY 4.0 per the city, data.gv.at record **UNCONFIRMED** (some Vienna sets are CC BY-NC) | Yes once the record confirms CC BY. |
| **Overture Maps buildings** | GeoParquet footprints and heights, no LOD2 geometry | **ODbL** ("Overture Maps Foundation, overturemaps.org") | Yes, but adds nothing over OSM for 3D. |
| **Global Building Atlas** (TUM) | LoD1 heights, ML-derived | **CC BY-NC 4.0** for the heights and LoD1 (only the ODbL-derived polygons are ODbL) | **No** — non-commercial. |
| **awesome-citygml** (GitHub index) | An index of ~68 regions' open 3D data | — | An index for finding datasets; never a source itself. |

## Spain: the Catastro's storeys

The visible problem: buildings OSM records no height for are drawn at the 5 m
default beside 20–30 m neighbours — the Carrer de Mallorca block in the
Eixample (ways 249405068 and 249408232, both `render_height` 5), and most of
Madrid (OSM records a height or storeys for 40% of central Madrid's
features). The Catastro records storeys above ground for every building part
in Spain outside Navarra and the Basque Country.

**Precedence: official > OSM tags > the 5 m default**, recorded per OSM
feature as `height_source` (`lib/map/cityTiles.ts` → `HEIGHT_SOURCES`, the
field `fix/city-flat-block` (#131) writes `osm` into):

- Each cadastral building (its parts, grouped by cadastral reference) is
  prepared as flat roofs, one per part, at the height its recorded storeys
  stand in **Spain's storey model** (`scripts/citygen/storeys.ts`): a 4.0 m
  ground floor, **3.05 m** for each storey above, and a 0.9 m parapet —
  `h(n) = 4.0 + 3.05·(n − 1) + 0.9`, so 4.9 m for one storey, 20.2 m for six.
  The 3.05 m is the Pla General Metropolità's own floor-to-floor increment
  (every PGM zone table rises 3.05 m a storey, and clau 13a states "alçada
  mínima de 3,05 m … inclòs el forjat"); Madrid's plans set minimum
  floor-to-floor heights of 2.90 m upper and 3.10 m ground (BOCM 2015-02-06,
  art. 9); the PGM's maxima allow a 4.5–5.5 m ground floor; the 0.9 m is the
  lower of the Código Técnico's barrier heights (DB-SUA 1 §3.2.1: 0.90 m
  below a 6 m fall, 1.10 m above). OpenMapTiles' worldwide 3.66 m a storey
  drew Spanish buildings ~15–20% too tall (six storeys: 22.0 m against
  20.2 m). The storey count is the recorded fact; the metres are a model,
  said as such. Parts with no storeys above ground (a patio over a basement)
  draw nothing.
- **OSM's own storeys in the same area use the same model.** In Spain
  `building:levels` is overwhelmingly the cadastre's count, imported; left at
  3.66 m, an OSM building and the cadastral building beside it with the same
  storeys would stand at two heights. So when the cadastre is merged, every
  OSM feature whose height comes from `building:levels` alone (no `height`,
  no `min_level`, no shaped roof) is re-heighted with the Spanish model and
  keeps `height_source: osm` — 13,371 in the Barcelona box, 2,875 in Madrid.
  The model is per source and region (`policy.storeys`), not global: the
  rest of the world keeps 3.66 m until a region's rules are known.
- It is conflated like any official model (below), with the cadastre's own
  policy (`sources.ts`): **no staleness test** (it is kept current by law —
  official wins over a disagreeing OSM tag), and OSM's `building:part`s do
  **not** outrank it (Spain's OSM parts are an import of it); only a tagged
  non-flat `roof:shape` does — the Sagrada Família and the cathedral keep
  their mappers' roofs.
- Every OSM feature at least 30% inside drawn cadastral buildings takes the
  cadastre's height as its **resolved** height: `render_height` is the median
  of the cadastral heights over its footprint, `height_source: cadastre`,
  `official_levels` the storeys. Its own `height` and `levels` tags stay
  exactly as OSM has them.
- Where at least half of it is covered, the cadastral parts draw it instead
  (`drawn_by: es-catastro`): a Barcelona finca is its 7-storey street block,
  its 1-storey rear wing and its open patio, not one prism — and the parts'
  recorded storeys draw the storey rhythm on their outline walls.

`map:catastro-list` reads the Catastro's feeds and prints the downloads an
area needs (17 municipalities for the Barcelona box; Madrid's is one); the
compiler takes the unzipped `*.buildingpart.gml` files.

### Measured

Same machine and caveats as below (load average 11–40):

| | Barcelona, OSM only | with the Catastro | Madrid, OSM only | with the Catastro |
| --- | ---: | ---: | ---: | ---: |
| Compile | 24.0 s | 80.8 s (reading 17 municipalities, 1.8 GB, 9.2 s; conflation 53.6 s) | 6.4 s | 50.9 s (reading 2.1 GB, 12.7 s; conflation 28.4 s) |
| Archive | 6.99 MB, 280 tiles | **18.06 MB** | 1.93 MB, 80 tiles | **8.64 MB** |
| Tile gzip p50 / p95 / max | — / — / 212 kB | 17 / 262 / 482 kB | 20 / 72 / 80 kB | 94 / 251 / 273 kB |
| OSM features given an official height | — | 205,539 of 245,868 (**33,991 had none**) | — | 53,899 of 59,829 (**34,170 had none**) |
| OSM features drawn by cadastral parts | — | 210,756 | — | 54,222 |
| Cadastral buildings drawn / not in OSM / left to OSM's roofs | — | 95,622 / 17,128 / 150 | — | 41,422 / 2,296 / 353 |

The two Carrer de Mallorca ways go from `render_height` 5 (nothing recorded)
to 20.2 m (6 storeys) and 17.1 m (5 storeys), `height_source: cadastre`, and
are drawn by their cadastral parts; the verifier fails the build if either
loses its official height (`EXPECTED_HEIGHTS` in the CLI).

Client, densest tiles (Bun, the worker's path): Barcelona 15/16585/12231 —
decode 14 ms, mesh 159 ms, 377,431 vertices, 13.7 MB of buffers, against
8 ms / 146 ms / 603,406 / 21.5 MB OSM-only (no bevels on cadastral parts);
Madrid 15/16046/12355 — 19 ms / 115 ms / 257,618 / 9.4 MB against 2 ms /
59 ms / 245,837 / 8.9 MB. The cost is the download: the densest Barcelona
tile is 482 kB gzipped against 212 kB.

Seen (same cameras, before/after): the Carrer de Mallorca block
(`?lat=41.3935&lng=2.1610&zoom=17.3&pitch=60`) goes from three 5 m slabs
beside 25 m neighbours to a continuous Eixample block with its rear wings
and patios; Madrid's Gran Vía goes from a field of 5 m boxes around the few
tagged buildings to a dense, storey-ruled city. Landmarks with mapped roofs
are unchanged. The credit "Dirección General del Catastro" appears while
cadastral tiles are drawn.

## What the merge does (NYC)

```
CityGML (EPSG:2263, ft) ──readCityGml──▶ buildings ──prepareBuilding──▶ roof planes in mercator,
                                                                     heights above own ground
OSM extract ──compile──▶ OSM features per z15 tile ─┐
                                                     ├─conflate──▶ building (OSM, + drawn_by)
                         model buildings ───────────┘             building_lod2 (roof surfaces)
```

| Piece | Where |
| --- | --- |
| Sources and their obligations | `scripts/citygen/lod2/sources.ts`; the map credit in `lib/map/cityOfficial.ts` → `CITY_LOD2_SOURCES` |
| CityGML reader (streaming, 1.0–3.0, local names) | `scripts/citygen/lod2/cityGml.ts` |
| CityJSON / CityJSONSeq reader | `scripts/citygen/lod2/cityJson.ts` |
| Projections (EPSG:2263, ETRS89/WGS 84 UTM, lat/lon), checked against PROJ | `scripts/citygen/lod2/crs.ts` |
| Building → planar roof surfaces | `scripts/citygen/lod2/prepare.ts` |
| Read + hash files, area filter | `scripts/citygen/lod2/ingest.ts` |
| Conflation, roof features | `scripts/citygen/lod2/conflate.ts` |
| Schema (v2) | `lib/map/cityTiles.ts` (`height_source`), `lib/map/cityOfficial.ts` (`building_lod2`, `drawn_by`, `official_levels`, the sources and their credits) |
| Client decode / mesh | `components/map/engine/city3d/lod2Tiles.ts`, `lod2Mesher.ts`; one branch in `meshWorker.ts` |
| Credit while drawn | `cityEngine.ts` (`onSources`) → `city3dLayer.web.ts` (`creditsFor`) → `MapCanvas.web.tsx` → `MapAttribution` (`extra`) |
| Tests | `scripts/__tests__/lod2Readers.test.ts`, `lod2Conflate.test.ts` (fixtures in `scripts/__tests__/fixtures/lod2/`, hand-made), `components/map/__tests__/city3dLod2.test.ts` |

### Encoding: roof polygons and their planes, not shape parameters

Two ways to get a measured roof to the client: derive OSM-style parameters
(`roof:shape` + height + direction) and let `roofs.ts` rebuild a roof, or ship
the roof polygons themselves. Parameters are smaller but lose exactly what the
model adds: NYC's buildings are 3.3 roof surfaces on average (setbacks,
bulkheads, a tower over a podium), 2% sloped; a parameter set describes one
ridge on one rectangle. So each **planar roof surface is one MVT polygon** in a
second layer, with its plane:

- a **flat** roof (95% of NYC's) is only `render_height` — its height;
- a **sloped** one adds `roof_h` (metres at the ring's minimum corner *as
  encoded*, which the decoder can recompute exactly whatever order the ring
  was written in) and `roof_dx`/`roof_dy` (metres per tile unit);
- a source polygon more than 0.25 m off its own best-fit plane is split into
  exactly planar triangles — the drawn roof is the measured one, never an
  average of it;
- **walls are not stored.** Their tops are roof edges and their bottoms the
  ground or a lower roof; the client raises them (`lod2Mesher.ts`). NYC's
  model is 506k wall polygons to 80k roofs in one delivery area.

Plus `source`, `source_id` (NYC's BIN) and `osm_id` for provenance. The client
draws each surface as a column on its plane, skips a wall wherever a
neighbouring surface is as high (a gable's ridge, the inside of a block) and
draws only the step above a lower one (a setback). `render_height` keeps the
layer drawable by a plain `fill-extrusion` (stepped blocks) for native.

### Conflation: OSM says what exists, the model says its shape

Decided per model building by sampling its footprint against nearby OSM
features (deterministic, no clipping library):

1. **Confirmed** — at least half of it inside OSM buildings, or it is not
   drawn: a building OSM no longer has was most likely demolished after 2014.
2. **Not stale** — where OSM records a height, the model's median height over
   the part where that OSM feature is the top surface must agree within
   max(10 m, 30%); otherwise the OSM feature is in conflict and keeps drawing
   itself, and a model building in conflict over 30% of its checked area is
   dropped (a 2014 garage under a 2020 tower). Judging per OSM *surface* is
   what lets a detailed model agree with one coarse OSM outline, and OSM's
   stacked parts be compared as a whole (the Empire State Building's).
3. **Not poorer than OSM's own 3D** — where OSM is hand-modelled
   (`building:part`s or tagged non-flat roofs over half the overlap) and the
   model is only stepped flat blocks (< 20 m² of sloped roof), OSM keeps
   drawing: the first Lower Manhattan render swapped mappers' pyramid crowns
   for flat boxes. A model building with real sloped roofs (one of the ~100
   LOD2 landmarks) wins.
4. **Covered** — an OSM feature at least half inside drawn model buildings,
   and not in conflict, gets `drawn_by: nyc-3dbm`; the client skips it.

Nothing is overwritten. The OSM feature keeps every property and its id; the
model's surfaces keep the model's id and the best-matching OSM id; `drawn_by`
records the decision. Each model building goes whole to the tile of its best
OSM match, so the feature it replaces is always in the same tile — and so the
client can dress the model's shape with that OSM feature's RECORDED facts
(tagged colour and material, storey rhythm where `building:levels` fits),
which the first Midtown render showed is what keeps a tagged brick tower from
turning into an anonymous beige one.

### Measured (Manhattan, New York State extract 2026-10-09, DA10+DA12+DA13)

On the build machine, Bun 1.4.2, with other jobs running (load average
28–50). Times are the quietest of several runs; under load they reached
1.6× (OSM-only 77 s, with the model 140 s):

| | OSM only | With the NYC model |
| --- | ---: | ---: |
| Compile | 29.4 s | 81.1 s (reading 1.8 GB of CityGML 18.9 s, conflation 31.8 s) |
| Archive (with `main`'s tree layer, last build) | 3.63 MB, 166 tiles | **8.82 MB**, 166 tiles |
| Tile gzip p50 / p95 / max | 19 / 50 / 64 kB | 38 / 141 / 172 kB |
| Tile raw p50 / p95 / max | 31 / 87 / 121 kB | 67 / 266 / 318 kB |

Conflation (last build): 97,662 model buildings read in the three delivery
areas, 76,238 inside the Manhattan box; **71,438 drawn**, 1,494 not in OSM,
1,245 stale, 2,061 left to OSM's richer 3D; **71,710 of 122,942 OSM features**
drawn by the model, 71,723 given its height (`height_source: lod2`; 555 had
none), 2,450 in height conflict; 162,357 roof surfaces, 8,653 of them sloped.

Client (Bun, the worker's code path, best of two runs):

| Tile | | Decode | Mesh | Vertices | Triangles | Buffers |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| 15/9650/12311 (densest archive tile) | OSM only | 2 ms | 46 ms | 113,966 | 64,055 | 4.1 MB |
| | with the model (4,196 surfaces, 34 OSM features left) | 7 ms | 78 ms | 145,921 | 86,941 | 5.3 MB |
| 15/9650/12315 (Midtown, ESB) | OSM only | 4 ms | 45 ms | 151,512 | 86,150 | 5.4 MB |
| | with the model | 7 ms | 65 ms | 175,871 | 100,984 | 6.3 MB |

Web bundles, `expo export --platform web` with no flags set, `origin/main`
(1175833) against this branch, separate Metro caches, `--clear`:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,971,234 B | 6,971,375 B (+141 B; +30 B gz) | MapCanvas merging the official-data credits with the landmark ones |
| `__common` (first paint) | 81,624 B | 81,765 B (+141 B; +37 B gz) | `height_source` and `HEIGHT_SOURCES` in `cityTiles.ts`, which `main` already shares between lazy chunks (the same key `fix/city-flat-block` adds) |
| `city3dLayer` (lazy) | 18,274 B | 19,396 B | `creditsFor`, `lib/map/cityOfficial.ts` |
| `lazyChunk` (lazy, three.js) | 3,700,491 B | 3,700,739 B | `onSources` |
| `meshWorker` (sealed worker) | 82,518 B (28,693 gz) | 91,233 B (31,570 gz) | official-surface decoder and mesher |

The first export of this branch put **804 B more on every first paint**:
`cityTiles.ts` sits in `__common` on `main` (several lazy chunks import it),
and the official-data constants had been added to it. They now live in
`lib/map/cityOfficial.ts`, which only the adapter, the worker and the
compiler import.

**Size.** The model costs ~71 B gzipped per drawn building, 2.5× the
archive. That is the honest cost of shipping roofs as polygons, and it buys
the setbacks and bulkheads no parameter set carries. Dropping hidden OSM
features from the tile would save about a third of it but would break the
"keep both" rule and native's fallback; not done.

### Seen (headless Chromium, SwiftShader, port 8108)

Same cameras, model vs OSM-only: Midtown/Murray Hill, Lower Manhattan,
Greenwich Village, Flatiron/Madison Square, the dark appearance; Barcelona's
Eixample, Barri Gòtic and Sagrada Família (OSM-only, unchanged, no NYC
credit). Judged:

- **Better:** rooftop bulkheads and water-tank enclosures, setbacks on
  pre-war towers OSM draws as one prism, sloped roofs on the LOD2 landmarks
  (the Empire State Building's 124 surfaces, 55 sloped).
- **Same:** where OSM is hand-modelled (Lower Manhattan's skyscrapers) —
  by rule 3, OSM keeps drawing.
- **Worse, honestly:** no bevel on model roofs (a chamfer is styling, and a
  measured edge should read as measured), so blocks look sharper than their
  OSM neighbours; and the model is 2014 — anything rebuilt since by less than
  10 m of height still draws its 2014 shape.
- The credit "NYC 3D Building Model (modified)" appears beside the basemap's
  while model tiles are drawn, and only then (absent with the OSM-only
  archive, absent in Barcelona).

### Regenerating

```bash
# 1. Download (never committed; ~916 MB). Delivery areas 12 and 13 are
#    Manhattan; 10 adds its east edge and Roosevelt Island.
curl -fLo DA_WISE_GML.zip https://s-media.nyc.gov/agencies/oti/DA_WISE_GML.zip
unzip DA_WISE_GML.zip 'DA_WISE_GMLs/DA1[023]_3D_Buildings_Merged.gml'
# 2. Compile with the New York extract.
bun run --cwd packages/frontend map:city-tiles --pbf=<new-york.osm.pbf> --area=manhattan \
  --lod2=nyc-3dbm:$PWD/DA_WISE_GMLs/DA12_3D_Buildings_Merged.gml,$PWD/DA_WISE_GMLs/DA13_3D_Buildings_Merged.gml,$PWD/DA_WISE_GMLs/DA10_3D_Buildings_Merged.gml
# 3. Serve and look, exactly as for any city archive (MAP_3D_CITY.md → Running it locally).

# Spain: the Catastro's building parts for every municipality the area meets.
bun run --cwd packages/frontend map:catastro-list --area=barcelona > urls.txt   # or --area=madrid, --bbox=…
mkdir catastro && (cd catastro && xargs -n1 curl -fLO < ../urls.txt \
  && for z in *.zip; do unzip -o "$z" '*.buildingpart.gml'; done)
bun run --cwd packages/frontend map:city-tiles --pbf=<cataluna.osm.pbf> --area=barcelona \
  --lod2=es-catastro:$(ls $PWD/catastro/*.buildingpart.gml | paste -sd, -)
```

The receipt (`*.pmtiles.receipt.json`) gains a `lod2` section: each file's
name, size and **SHA-256** (the dataset page does not version its files),
the CRS read, what was dropped and why, and the conflation counts. The
archive's metadata names the source, its terms and its attribution
(`goway:lod2`), and its `license` line says the ODbL database contains it.
`--verify` checks that the Empire State Building's model surfaces are in
their tile and at least 350 m tall, and — with the Catastro merged — that the
Carrer de Mallorca block has its official height.

## Limits and next steps

- **2014.** NYC's model is a one-time capture. Rule 2 catches large
  replacements; small ones draw the old shape. OSM stays the authority for
  existence, so post-2014 buildings draw from OSM.
- **Tile borders.** A model building is whole in its OSM match's tile; an OSM
  feature it covers in a neighbouring tile is hidden there and drawn here —
  invisible while both tiles are loaded (the near ring), a hole at the ring's
  edge for at most one frame of loading.
- **3DBAG next** needs RD New + NAP in `crs.ts` (an oblique stereographic on
  Bessel with a datum shift); German states and PLATEAU read as they are
  (CityGML, UTM/JGD lat-lon — JGD2011 geographic is not implemented yet).
- **Barcelona's own LOD1 model** needs a written licence answer from the city;
  the Catastro already gives Spain its heights.
- **Catastro tiles are heavy**: 2.5× the OSM-only archive in Barcelona, the
  densest tile 482 kB gzipped. A planet build would want the hidden OSM
  features' geometry dropped from tiles the cadastre fully covers (keeping
  their ids and facts) — not done, to keep both sources whole.
- **Storey heights are a model.** Spain's (4.0 + 3.05 m + 0.9 m) is typical
  of the rules, not of each building: a 1960s block with 2.7 m storeys or a
  modernista building with 4 m ones will be off by a metre or more over six
  storeys. Other countries keep 3.66 m until their rules are tabled.
- **Attribution page.** `goway.to/attribution` (`lib/map/credits.ts`) has a
  "3D buildings: official data" section with both sources' links and notices
  (the Catastro named as author and owner, "not cadastral cartography"; NYC's
  dataset, version and "modified"), in English and Spanish — the release gate
  in MAP_3D_CITY.md → Hosting is met for these two sources.

# City tiles for the world: the regional build, the Worker, the cost

GoWay's 3D city tiles (buildings and trees, [`MAP_3D_CITY.md`](./MAP_3D_CITY.md)
→ Phase 2) and the city-life road graph ([`MAP_CITY_LIFE.md`](./MAP_CITY_LIFE.md))
were compiled on a developer's machine for two cities. This note is how they
are built for the **whole planet**, served from R2 by the Worker, and what that
costs. **Live for three regions since 2026-10-12** (below, "Published");
the rest of the world waits for the workflow's first published run. The
owner's remaining steps are at the end ([Approval](#approval)).

| Piece | Where |
| --- | --- |
| Region catalogue (generated, committed) | `packages/frontend/scripts/citygen/regions.json`, read by `citygen/regions.ts`, planned by `scripts/plan-city-regions.ts` (`map:city-plan`) |
| Ownership: a region's tiles, from its polygon | `scripts/citygen/ownership.ts`; the tree format in `worker/coverageTree.js` |
| One region → two archives + receipts + manifest entry | `scripts/build-city-region.ts` (`map:city-region`); compilers take `--ownership=` (`citygen/regionArchive.ts`) |
| Manifest | `scripts/build-city-manifest.ts` (`map:city-manifest`) |
| Worker | `worker/city.js`, routed from `worker/index.js`; `wrangler.toml` (`run_worker_first`, `MAP_CITY_MANIFEST`) |
| Client | `fetchCityCoverage` (`components/map/city3dLayer.web.ts`), `engine/city3d/coverageIndex.ts` |
| CI | `.github/workflows/build-city-tiles.yml`, matrix from `scripts/city-batches.ts` |
| Tests | `worker/__tests__/city.test.js`, `scripts/__tests__/cityPlanet.test.ts`, `components/map/__tests__/city3dSources.test.ts`, `city3dCitySource.test.ts` |

## Why regions

The compiler holds what it compiles in memory: every building way, every node
position a building uses, every footprint. Memory, not time, is what stops a
planet build on one machine (`MAP_3D_CITY.md` → "Planet, extrapolated":
~90 GB). Planetiler solves this with disk-backed storage; the city compiler is
deliberately small and in-memory, so the planet is cut instead: into
[Geofabrik](https://download.geofabrik.de) extracts, each compiled alone, each
its own pair of archives.

Two things follow, and the design is about them:

1. **Regions must partition the ground exactly.** The client draws a tile from
   the city tiles *or* from the basemap, never both (`sources.ts`), and the
   Worker must know which archive answers a tile. Geofabrik polygons overlap
   at borders and are not boxes (Portugal's bounding box holds half of
   Galicia).
2. **A region must be rebuildable alone.** Re-merging hundreds of archives
   after a country changes would rewrite tens of gigabytes; one manifest
   naming one archive per region does not.

### Ownership

A region **owns the z15 tiles wholly inside its polygon** — the `.poly` the
extract was cut with — and its archives hold exactly those tiles
(`citygen/ownership.ts`). Wholly inside, because then every building whose
representative point is in the tile is in the extract (Geofabrik extracts carry
complete ways); a tile the border crosses is nobody's rather than half of
somebody's, and the client draws the basemap's buildings there, exactly as it
does anywhere not yet built. Ownership depends on nothing but the region's own
polygon, so a rebuild never changes a neighbour.

Ownership is a quadtree of tiles (`coverageTree.js`): the interior collapses to
a few large cells and only the border costs anything. The test is done in
longitude/latitude, where a mercator tile is an axis-aligned rectangle and a
polygon edge is the straight line osmium cut with. An edge lying exactly on a
tile edge does not "cross" it, so two polygons sharing a tile-aligned border
leave no gap (tested).

**Borders, measured (Portugal–Spain, 1,200 km of border, z15).** Of 213,039
tiles whose centre is in either polygon, **502 are owned by both** (Geofabrik's
polygons overlap a little) and **108 by neither** — about 100 km² along the
whole border, drawn from the basemap. A tile owned twice is answered by the
first region in the manifest (sorted by id); both archives hold the same
buildings there.

### Parts

A region whose extract would not fit the runner's memory is built in
**parts**: rectangles on the z10 tile grid (so no z15 tile straddles two),
chosen by recursive halving at the weighted median of the extract's **node
density** (`citygen/density.ts`, one pass, a counter per tile — nodes are what
both compilers' memory follows, and a capital weighs more than its mountains).
Each part is cut from the extract with `osmium extract --strategy=smart` and a
0.05° margin, owns the region's tiles inside its rectangle, and is published
as `<region>~<i>of<n>`. A region rebuilt in a different number of parts
replaces all of its old parts in the manifest.

**Measured on Portugal in two parts**: the density pass 9 s, the cut at
−8.44° (the Azores and Madeira with the west coast, the interior on its own);
peaks of 2.6 / 2.9 GB and 1.6 / 3.6 GB (buildings / roads) against the whole
region's 4.0 / 5.8 GB — and the two parts' archives are **tile-for-tile
identical** to the whole region's: 49,254 of 49,254 building tiles, 100,718 of
100,718 road tiles, none owned twice.

### Regions

`map:city-plan` walks Geofabrik's index and writes the catalogue:

1. **Fit the machine.** Built whole when `14 MB × extract MB` fits 14 GB (the
   usable part of a 16 GB runner — see [Measured](#measured)); else its
   Geofabrik children; a region with no children is built in parts.
2. **No region twice.** Geofabrik also publishes groupings over their members
   (`us` and its states, `dach`, `alps`, `britain-and-ireland`, `sea`). A
   grouping is dropped when the extracts of the regions inside it hold ≥ 98% of
   its bytes; a region lying inside the others (Beijing inside Hebei's polygon,
   `azores` inside Portugal's) is dropped by area. Bytes, not area, for the
   first rule: polygons have generous sea margins no member repeats, and by
   area `us` looked 5% uncovered and its fifty states were dropped instead.
3. **Official data where it exists** (`official`, below).

Planned on 2026-10-11: **416 regions, 425 builds with parts, 82.9 GB of
extracts** (Europe 184, Asia 70, North America 58, Africa 55, Oceania 23, South
America 16, Russia 8, Central America 1, Antarctica 1). Four regions are built
in parts: `us-south` (4.1 GB, 5), `asia/sea` (3.7 GB, 4), Quebec and Ontario
(2 each). Two Geofabrik regions publish an **empty `.poly`** on that date
(`asia/myanmar`, `north-america/us/tennessee`); their data is still built,
because the grouping around each (`sea`, `us-south`) then falls short of the
98% rule and is kept — which is exactly why those two are built in parts. The
planner reports per continent the chosen extracts' bytes against the
continent's own (0.95–1.17: overlaps at borders, plus overseas regions whose
polygons lie outside their continent's). Re-plan when Geofabrik's hierarchy or
the runner changes; the diff is the review.

## The archives, receipts and keys

Per region (or part), one run writes, mirroring the bucket:

```
city/<stamp>/<region>.pmtiles                 buildings + trees, the z15 tiles it owns
city/<stamp>/<region>.pmtiles.receipt.json    extract, replication timestamp, polygon + hash, timings, peak RSS, coverage counts
city-roads/<stamp>/<region>.pmtiles           the road graph, same tiles
city-roads/<stamp>/<region>.pmtiles.receipt.json
city/manifest.json                            the live manifest (rewritten last)
city/manifests/<stamp>.json                   every manifest ever published (the rollback)
```

`<stamp>` is `YYYYMMDD-<run number>`: unique per run, so **no key is ever
written twice** — a PMTiles archive is read by byte offset, and overwriting one
a Worker is reading serves another tile's bytes. The upload step refuses an
existing key. Each archive's metadata carries its region, polygon hash and
ownership too (`goway:region`, `goway:ownership`), so an archive found alone
still says what it covers and what OSM snapshot it is.

### The manifest

```json
{ "schema": 1, "generatedAt": "…", "tileZoom": 15,
  "regions": [{ "id": "europe/portugal", "name": "Portugal", "stamp": "…", "bbox": [w, s, e, n],
                "ownership": { "maxZoom": 15, "bits": "…" }, "ownedTiles": 1857772,
                "source": { "extract": "…", "polygon": { "url": "…", "sha256": "…" }, "replicationTimestamp": "…" },
                "official": [], "city": { "key": "…", "receipt": "…", "bytes": …, "sha256": "…" }, "roads": { … } }],
  "coverage": { "maxZoom": 14, "bits": "…" }, "roadsCoverage": { … },
  "attribution": "© OpenStreetMap contributors", "license": "ODbL-1.0 …" }
```

A run's manifest is the previous one with that run's regions replaced, checked
entry by entry (ownership decodes to the tile count it states; keys are dated
keys naming their region and stamp), with `coverage` — the union of every
region's tiles, coarsened to z14 — precomputed for the client. Keys no longer
referenced are listed (`retired.txt`, the job summary), never deleted.

## Serving

`worker/city.js`, under the two prefixes `run_worker_first` now names:

| Path | Answer |
| --- | --- |
| `/map/city/15/{x}/{y}.pbf`, `/map/city-roads/15/{x}/{y}.pbf` | **200** decoded MVT from the owning region's archive · **204** owned, nothing there (sea, fields) · **404** no published region owns it. Any other zoom or a coordinate outside the world: 404 before storage is touched |
| `/map/city/coverage.json` | `{ schema: 2, tiles: <z14 union>, roads, regions: [{ id, name, bbox, replicationTimestamp }] }` |
| `/map/city/manifest.json` | the manifest — the index of the published database |
| `/map/city/data/<key>` | an archive or receipt the CURRENT manifest names, streamed, ranges honoured (`pmtiles` tools open it directly); anything else in the bucket is 404 |

The client treats 204 and 404 alike (no tile); the coverage decides where it
asks at all. The two differ for caches: an empty tile is a fact about an
immutable archive (a day, edge and browser), "not covered" changes with the
next manifest (five minutes). Edge cache keys name the archive key, so a
rebuilt region never mixes with the old at the edge; directories are cached a
week per archive, as the basemap's. The manifest is read once per colo per five
minutes and kept per isolate for a minute; a tile is matched against regions by
bounding box first, and only those few ownership trees are decoded.

**Off until configured.** With `MAP_CITY_MANIFEST` unset — production now —
every tile is 404, the coverage document covers nothing (the client draws the
basemap's buildings, as today), and no request touches storage. The production
document carries no `archives` boxes, so a client that only knew boxes would
see no coverage rather than a region's bounding box.

The client accepts both coverage forms: development's boxes (the dev route,
unchanged for city-sized archives) and production's owned-tile set, which it
passes on encoded; the decoder lives in the engine's chunk only
(`coverageIndex.ts`), never in the first-paint `__common`. The dev route
(`scripts/dev-city-tiles.js`) also serves regional archives the way the Worker
does.

## Measured

On the build machine (one core of 32, load average 15–30, Bun 1.4.2), extracts
of 2026-10-08:

| Extract | Compiler | Time | Peak RSS | Archive | Tiles | Features |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Portugal, 425 MB | buildings, before this change | 37.8 s | 8,170 MB | 51.8 MB | 49,472 | 2,226,514 |
| | buildings | 34.8 s | **3,753 MB** (4,016 by the OS) | 51.7 MB | 49,254 | 2,223,356 |
| | roads, before | 46.7 s | 6,304 MB | 91.8 MB | 102,778 | 1,495,525 ways |
| | roads | 46.1 s | **5,391 MB** (5,752) | 91.2 MB | 100,718 | |
| Netherlands, 1,405 MB | buildings | 137.2 s | **19,076 MB** | 244.1 MB | 55,841 | 11,612,382 |
| | roads | 57.7 s | 5,660 MB | 80.3 MB | 63,685 | 2,253,806 ways |

"Before" is `origin/main`'s compiler over the whole extract; after releases
each pass's memory before the next allocates (the way map, the node arrays, the
footprints once tiled) and keeps footprints as mercator rings until their tile
is encoded — the whole-extract archives are **byte-identical** before and
after. The regional build owns 1,857,772 z15 tiles (ownership: 25 ms, 6.9 kB of
base64) and drops 218 border tiles (3,158 buildings) to Spain's side or the
basemap. A region costs **0.14–0.19 s per MB of extract** for both compilers
together, and **14 MB of RAM per MB of extract** at the dense end (the
Netherlands' 11.6 M buildings), the number the planner sizes regions with.

The planet, from the catalogue:

| | Value | How |
| --- | --- | --- |
| Ownership, all 416 regions | 3.5 s; 1.53 MB of base64, 3.7 kB a region | computed from Geofabrik's polygons |
| Client coverage (z14 union) | 297 kB base64, **131 kB gzipped**, 891,565 nodes | the same |
| Manifest | ~1.9 MB | ownership + ~0.8 kB of metadata a region |
| Building archives | **12–17 GB** | 21–23 B a feature × ~700 M buildings and parts; 0.12–0.17 of the extract |
| Road archives | **5–18 GB** (~10 GB likely) | 0.06–0.21 of the extract (the Netherlands' footways vs Portugal's tracks) |
| Compute | **4–9 runner-hours** a full rebuild | 82.9 GB × 0.14–0.19 s/MB, × 1–2 for a hosted runner's core; plus ~83 GB of downloads and 4 osmium splits |
| Wall time | **~45–90 min** | 42 jobs of ≤ 2 GB of extract, 20 at a time; the slowest job is `us-south` (5 parts) |

## Cost

| | Cost | Notes |
| --- | --- | --- |
| R2 storage | **$0.25–0.55 / month**; ≤ $1.10 while two generations overlap | 17–35 GB × $0.015/GB-month. The basemap (84 GB) already uses the free 10 GB |
| R2 writes | ~$0.02 a full rebuild | ~5,000 Class A operations (multipart parts, receipts, manifest) at $4.50/M, inside the free million a month |
| R2 reads | $0.36 per million uncached tiles | one Class B per uncached tile; directories and the manifest are edge-cached |
| R2 egress | $0 | |
| Worker | $0.30 per million requests over the paid plan's 10 M | a 3D view asks ~9–16 city tiles (and as many road tiles with city life on); edge hits are still Worker requests because the paths run Worker-first |
| Runners | **$0** | GitHub's standard hosted runners are free for a public repository; the same run on a private one would be ~$5–9 at $0.016/min |
| Geofabrik | $0 | ~83 GB a run. Monthly is fair use; daily would not be — build regions on demand instead |

## The workflow

`.github/workflows/build-city-tiles.yml`, **manual dispatch only** (the monthly
schedule is written and commented out):

- `regions`: `all`, or ids and prefixes (`europe/portugal`, `europe/spain/`)
  — a name not in the catalogue fails the run.
- `publish` (default **off**): off is a dry run — every region downloaded
  (md5-checked), compiled, verified with the Worker's reader, entries,
  receipts and the would-be manifest kept as artifacts, nothing leaves GitHub.
  On: archives and receipts uploaded under dated keys (an existing key fails
  the job), then the manifest — the dated copy first, the live one last.
- `keep_archives`: keep a dry run's archives as artifacts for 3 days.
- `official` (default **off**): fetch and merge the official 3D data the
  catalogue lists for a region ([below](#official-data)).

Jobs: `plan` (the matrix, no install), `build` (≤ 20 at a time, `fail-fast:
false`; entries are kept only after every upload of the job succeeded, so the
manifest never names an archive that did not reach R2), `manifest` (runs after
a partial failure too: a failed region keeps its previous entry, and then
checks the edge serves the new manifest and every new region's densest tile
— `scripts/city-check-live.ts`). Uploads go through `wrangler r2 object`
(`scripts/city-r2.sh`) with the org's existing `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID`, only with `publish`: no key is overwritten (one
holding the same bytes, from a re-run, is skipped), every object is read back
and hashed, an unreadable manifest stops the run rather than counting as none,
and an archive over wrangler's 300 MiB limit fails its job (the catalogue's
parts stay under ~220 MB). Exclude regions with `-`:
`regions: all,-europe/spain/madrid`.

**Runner.** Everything is sized to `ubuntu-24.04` (4 vCPU, 16 GB, ~70 GB on
`/mnt`); no larger or self-hosted runner is needed. A larger one (the tiles
machine) would build the same catalogue faster with fewer parts after a
re-plan with its memory — or from one planet file cut by `osmium extract
--config` per region, which also gives every region the same snapshot date
(today regions are as consistent as Geofabrik's daily extracts, which share a
replication timestamp per day).

### Official data

The catalogue tags regions with the official 3D datasets
[`MAP_3D_SOURCES.md`](./MAP_3D_SOURCES.md) merges (`feat/city-lod2`, #135):
`es-catastro` for Spain's communities except País Vasco and Navarra (foral
cadastres) and the Canary Islands; `nyc-3dbm` for the New York state extract.
With the workflow's `official` input on, the build step fetches them like the
extract — the Catastro's municipality zips for the region's box
(`map:catastro-list`), NYC's `DA_WISE_GML.zip` — and the region builder passes
them to the compiler's `--lod2` (a directory stands for its files: Castilla y
León's 2,248 municipalities would not fit one argument). Official surfaces that
fall in tiles the region does not own are dropped like everything else; the
entry's `official` names what was merged, and each source's credit is drawn
while its tiles are (#135).

**Measured on La Rioja** (the workflow step itself, run locally): 220
municipalities, 53 MB of zips, 702 MB of GML; 116,205 cadastral buildings,
21,360 OSM buildings that had no height given one; the building compile
20.1 s and **3.0 GB** peak against ~0.2 GB for OpenStreetMap alone. That is
~4 GB of RAM per GB of GML inside the build's box, so **`official` is off by
default**: a large community (Catalonia, Andalucía, Madrid) would not fit a
16 GB runner whole. Before turning it on, dry-run one large community with
`official: true` and give the regions that do not fit more parts (`MIN_PARTS`
in `plan-city-regions.ts`, then re-plan; each part reads only the official
buildings inside its rectangle) — the planner sizes by extract bytes alone.

## Dry run (done)

Portugal, end to end, on the build machine: `map:city-region` (both archives,
verified, entry) → `map:city-manifest` → the objects put in a local R2
(`wrangler r2 object put --local`) → **the real Worker** under
`wrangler dev` with the repository's `wrangler.toml`, `MAP_CITY_MANIFEST` set
and a web export with the city flags on. Answers: tile 200 (169 kB decoded),
road tile 200, owned sea 204, Spain 404, z14 404, coverage, manifest, a receipt
and a 206 range of an archive from `/map/city/data`, and the basemap still
served. In headless Chromium: Lisbon's Baixa and Porto's Ribeira (dark) drawn
from the Portugal archive (gabled tile roofs, storey rhythm, OSM trees, the
simulated traffic on the road archive), and Valença with Tui across the Minho —
Portugal from the city tiles, Spain (not built) from the basemap, the Spanish
road tiles 404 — with no console errors. The workflow's own build and assemble steps (extracted
from the YAML and run unchanged but for `/mnt`) built Kiribati — which crosses
the antimeridian — and the Seychelles, and assembled a three-region manifest;
served the same way, Kiribati answers on both sides of 180° (Tarawa,
Kiritimati) and Betio draws from its archive.

```bash
# Locally, any region of the catalogue:
bun run --cwd packages/frontend map:city-region --region=europe/portugal \
  --pbf=<portugal-latest.osm.pbf> --poly=<portugal.poly> --stamp=20261011-local --out=<dir>
bun run --cwd packages/frontend map:city-manifest --entries=<dir>/entries --out=<dir>/manifest.json
# Through the real Worker: put the objects in a local R2, then
#   (packages/frontend, with dist/ a development export, opened with ?city3d=1&cityTiles=1)
bunx wrangler@4 r2 object put goway-map-tiles/<key> --file=<dir>/<key> --local --persist-to=<state>
bunx wrangler@4 dev --local --persist-to=<state> --var MAP_CITY_MANIFEST:city/manifest.json --var MAP_TILE_ARCHIVE:
```

## Published

The first regions were built by hand on 2026-10-12 with `map:city-region` on
`main`'s compiler (building schema 2 with official data, road schema 3),
extracts of 2026-10-11, uploaded with `wrangler r2 object put --remote`, and
each object downloaded back and hashed against the local file:

| Region | Official data | `city/20261012-1/…` | `city-roads/20261012-1/…` | Owned z15 tiles |
| --- | --- | ---: | ---: | ---: |
| `europe/spain/cataluna` | Catastro, 17 Barcelona-area municipalities (127,744 buildings drawn; 47,260 OSM buildings that had no height given one) | 49.9 MB | 60.5 MB | 68,447 |
| `europe/spain/madrid` | Catastro, Madrid (111,508 drawn; 94,202 given a height) | 31.6 MB | 17.6 MB | 9,343 |
| `north-america/us/new-york` | NYC 3D Building Model, delivery areas 10, 12, 13 — Manhattan (92,332 drawn) | 113.6 MB | 83.9 MB | 178,710 |

Peaks: Catalonia 12.9 GB, Madrid 8.7 GB, New York 23.5 GB (buildings with
official data) — the measurement behind "Official data" above, and why the
workflow's `official` input stays off for hosted runners. The manifest is
`city/manifest.json` (= `city/manifests/20261012-1.json`, 12.8 kB). Landmark
checks passed on each archive (`--verify --area=barcelona|madrid|manhattan`:
the Sagrada Família's and the cathedral's roofs, the Carrer de Mallorca
block's official height, the Empire State Building's model).

## Approval

Steps 1–3 were done by hand for the first three regions (above) with the
account's Cloudflare API token instead of R2 keys; steps 4–5 are the PR that
set `MAP_CITY_MANIFEST` and added the database to `/attribution`. In order:

1. **R2 credentials.** None to create: the workflow uploads with
   `wrangler r2 object put` and the org's `CLOUDFLARE_API_TOKEN`, which must
   carry R2 write on `goway-map-tiles`.
2. **A dry run in CI**: dispatch with `regions: europe/portugal`, `publish:
   false`; read the artifacts (entries, receipts, manifest).
3. **A first published region**: the same with `publish: true`. Check
   `city/manifest.json`, the archive and its receipt in the bucket.
4. **Serve it**: uncomment `MAP_CITY_MANIFEST = "city/manifest.json"` in
   `packages/frontend/wrangler.toml` and merge (the frontend deploy ships it).
   Check `https://goway.to/map/city/coverage.json`, a Lisbon tile
   (`/map/city/15/15533/12556.pbf`), `/map/city/manifest.json` and a
   `/map/city/data/…` receipt.
5. **ODbL**: add the manifest's URL (`/map/city/manifest.json`, which lists
   every archive and receipt) to `/attribution` beside the OpenStreetMap
   credit. AGENTS.md requires archive + receipt published *before* the tiles
   are served to anyone — steps 3–4 publish them; this makes them findable.
6. **Offer it**: done (2026-10-12). `cityTiles`, `cityStreets`, `cityLife` and
   `landmarks` are on by default everywhere; each asks only for what
   `coverage.json` says is published (its `tiles` and `roads` trees), so the
   client follows the manifest with no release of its own.
7. **Official data** (optional, before or after 8): dry-run `regions:
   europe/spain/madrid` and `europe/spain/cataluna` with `official: true`;
   raise `MIN_PARTS` for any that does not fit; then publish them with it.
8. **The world**: dispatch `regions: all`, `publish: true` (~1 h). Then, if
   wanted, uncomment the monthly schedule — a scheduled run has no inputs, so
   make it publish deliberately (e.g. `publish: ${{ github.event_name ==
   'schedule' || inputs.publish }}`).
9. **Housekeeping**: after a new manifest has been live a while, delete the
   keys its run listed as retired. Rollback is copying a
   `city/manifests/<stamp>.json` over `city/manifest.json` (≤ 6 minutes to
   reach every colo) or commenting out `MAP_CITY_MANIFEST` and deploying.

## Limits and next steps

- **Memory per region** is the cost driver. The way map of pass 1 (~460 B a
  building way, the Netherlands: 5.3 GB before a node is read) could be one
  growable array of refs and offsets; that would roughly halve the dense peak,
  double the planner's ceiling and remove most parts.
- **Coverage on the client** is the whole world's union at z14: 131 kB gzipped,
  ~0.9 M nodes decoded once per page. Serving it as coverage tiles (per z6
  cell) would make it proportional to the view.
- **Borders**: the 108-tile strip Portugal–Spain is drawn from the basemap.
  Shrinking one side's polygon by a tile and growing the other's would close it,
  at the cost of ownership depending on neighbours.
- **Geofabrik's polygons are its own**: when one changes, the region's
  ownership changes at its next build; the manifest's `polygon.sha256` says
  which polygon each published region used.
- **Native** reads none of this yet (`MAP_3D_CITY.md` → Phase 5).

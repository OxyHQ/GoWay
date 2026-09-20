# `@goway/frontend`

The GoWay consumer app: one Expo Router codebase for web, iOS and Android, built
on `@oxy.so/services` (identity), `@oxy.so/bloom` (UI) and `@oxy.so/app-preset`
(Metro / Babel / TypeScript / native config).

```bash
bun install
bun run --cwd packages/frontend web        # web dev server
bun run --cwd packages/frontend typecheck
bun run --cwd packages/frontend lint
bun run --cwd packages/frontend export:web # static web export → dist/
```

---

## Native builds — **Expo Go will not run GoWay**

The native map renderer is `@maplibre/maplibre-react-native`, which ships real
iOS and Android SDKs (`org.maplibre.gl` on Android, the MapLibre Swift package
on iOS). Expo Go contains a fixed set of native modules and MapLibre is not one
of them, so there is **no** supported Expo Go path and no JS fallback. The
failure is a *runtime* one — a missing view manager when the map screen mounts,
not a build error — so it is worth knowing before you see it.

Use a development build:

```bash
bun run --cwd packages/frontend prebuild            # generate ios/ + android/
bun run --cwd packages/frontend ios                 # or: android
# or, for a cloud build:
bunx eas build --profile development --platform ios
```

`app.config.js` wires the Expo config plugin (`['@maplibre/maplibre-react-native', {}]`),
which is what injects the native dependencies during prebuild. It keeps
MapLibre's **default** Android location engine rather than Google Play Services:
the default is F-Droid-compatible, and centring a map does not need fused
sub-metre positioning.

Web needs none of this — `maplibre-gl` is plain JS and is bundled by Metro.
Its tile *worker* is the one file the bundle cannot carry; see the
`maplibre-gl` note under [Known gaps](#known-gaps-stated-rather-than-hidden)
below and `scripts/vendor-maplibre-worker.js`.

---

## The map seam

Feature code imports `@/components/map` and **never** a map engine. That is a
hard rule (root `AGENTS.md` → Product boundaries: "MapLibre, OpenFreeMap,
Photon, Nominatim, Valhalla … are replaceable adapters behind GoWay
interfaces"), and it is what lets the renderer or the tile host change without
touching a screen or the public `@goway.to/sdk`.

```
components/map/
  index.ts               the public surface — import from here
  types.ts               the provider-neutral contract
  MapCanvas.tsx          shared signature + the "no renderer here" fallback
  MapCanvas.web.tsx      → maplibre-gl
  MapCanvas.native.tsx   → @maplibre/maplibre-react-native
  shared.ts              the one place {lat,lng} ⇄ [lng,lat] happens
  DefaultMapMarker.tsx   Bloom's MapPriceMarker / MapClusterMarker
  MapAttribution.tsx     GoWay-owned credit line (both platforms)
  MapErrorState.tsx      the degraded state
lib/map/
  provider.ts            the ONLY place a tile/style vendor is named
  geo.ts                 bounds, distance, metres→pixels
  useUserLocation.ts     contextual, non-persisted device location
  style/                 GoWay's OWN MapLibre style document
    index.ts             buildGowayMapStyle(appearance, endpoints)
    layers.ts            the layer list + the published id contract
    palette.ts           the cartographic palette, light + dark
    schema.ts            the OpenMapTiles v3 vocabulary, read off live tiles
    tuning.ts            the three contested style decisions, one flag each
scripts/
  build-map-style.ts     renders public/map/*.json, validates, fails on drift
```

Metro resolves the platform fork; TypeScript resolves `MapCanvas.tsx`, so that
file defines the signature every call site is checked against while both forks
are checked separately against the same `./types`. A fork that drifts fails the
typecheck.

### The contract

```ts
interface GeoCoordinate { latitude: number; longitude: number }
interface GeoBounds     { west: number; south: number; east: number; north: number }

interface MapViewport { latitude: number; longitude: number; zoom: number; bearing?: number; pitch?: number }

interface MapMarker {
  id: string;
  coordinate: GeoCoordinate;
  kind?: string;        // open string: Places categories (#5), route stops (#6)
  label?: string;
  count?: number;       // > 1 renders a cluster bubble
  selected?: boolean;
  accessibilityLabel?: string;
}

interface MapOverlay {
  id: string;
  kind: 'line' | 'fill' | 'circle';
  data: GeoJSON.GeoJSON;
  paint?: { color?; width?; opacity?; outlineColor?; radius? };
  visible?: boolean;
}

interface MapApi {
  moveTo(target: GeoCoordinate | MapViewport, options?): void;
  fitBounds(bounds: GeoBounds, options?): void;
  fitCoordinates(coordinates: readonly GeoCoordinate[], options?): void;
  setBearing(bearing: number, options?): void;
  resetNorth(options?): void;
  getViewport(): Promise<ResolvedMapViewport | null>;
  getBounds(): Promise<GeoBounds | null>;
}
```

Two conventions that are silent when broken:

- GoWay speaks `{ latitude, longitude }` **objects**. Both engines use
  `[longitude, latitude]` arrays, and a swapped pair renders a plausible map of
  the wrong hemisphere with no error. The conversion lives in `shared.ts` and
  happens exactly twice.
- Every `MapApi` reader is **async**, including on web where it could be sync.
  Forking that would put a platform branch back into feature code.

`MapViewportChange` carries `source: 'user' | 'programmatic'`. This has to
travel *with* the event, because a viewport the user dragged to and one the app
flew to are the same four numbers — "Search this area" (#7) must not arm itself
against a camera move the app made in response to the search already showing.

### Supported interactions

pan · pinch/wheel zoom · rotate (bearing) · pitch · programmatic camera ·
map tap · annotation tap/selection · fit-to-bounds · fit-to-coordinates ·
GeoJSON line/fill/circle overlays · user-location indicator **only when
permission is already granted**.

Individual gestures are switched off through `interaction={{ pan, zoom, rotate, pitch }}`.

---

## Cartography — every byte of it from `goway.to`

`lib/map/provider.ts` is the only file that names a tile vendor. Everything
else asks for an *appearance* and gets a style document back.

### The four resources, and where each one comes from

A map is four separate downloads, and until recently three of them came from
somebody else. Loading GoWay made the browser talk to `tiles.openfreemap.org`
for tiles, glyphs and the sprite, and to `goway.to` for the style document
alone. All four are now `goway.to` URLs, but they get there by three different
mechanisms, because they cost three different things.

| resource | URL | how |
|---|---|---|
| style | `/map/goway-{light,dark}.json` | generated from `lib/map/style/`, committed |
| glyphs | `/map/fonts/{fontstack}/{range}.pbf` | **generated by us** from Inter Variable, committed |
| sprite | `/map/sprites/goway` | **generated by us**, SDF so it can be recoloured |
| tiles | `/map/tiles/{z}/{x}/{y}.pbf` | **proxied** by `worker/index.js`, edge-cached |

**Be precise about what the tile proxy is.** It removes the third-party origin
from the browser and it gives us a seam at which self-hosted tiles can be
swapped in with no style change, no app release and no client that ever knew.
It does **not** make GoWay independent: if OpenFreeMap is down, GoWay's map is
down, exactly as before. The planet is gigabytes and GoWay is deliberately not
storing it. Anyone describing this as "our own tiles" is describing it wrongly.

Glyphs and the sprite are a different story — those really are ours.
`scripts/build-map-glyphs.ts` renders **Inter Variable** (Bloom's
`font-bloom-sans`, SIL OFL 1.1, `fsType` unrestricted) into MapLibre SDF ranges
at four weights. That is what unblocked the type hierarchy: OpenFreeMap serves
`Noto Sans Regular`, `Bold` and `Italic` and nothing else — `Medium` and
`SemiBold` both 404 there — so the weight ladder was two rungs and an Apple-grade
hierarchy needs the steps in between. Inter's `wght` axis runs 100–900, so a
fifth weight is a regeneration rather than a negotiation.

Inter covers Latin, Greek and Cyrillic. A feature with a `name` but no
`name:latin` — much of the CJK, Arabic, Devanagari and Thai world — asks for a
range Inter does not have, and the Worker answers those by proxying the
upstream Noto ranges through `goway.to`. The label still renders; it is simply
not set in Inter, and the browser still talks to nobody but us.

| appearance | style document | notes |
|---|---|---|
| light | `/map/goway-light.json` | "GoWay Daylight" — warm sand ground |
| dark  | `/map/goway-dark.json`  | "GoWay Night" — desaturated blue-grey charcoal |

`expo export --platform web` copies `public/` into `dist/` verbatim and
`wrangler.toml` serves `dist/`, so publishing a cartography change is the same
deploy as everything else. The JSON is **committed**, not generated at build
time, so a palette change is reviewable as a diff.

```bash
bun run --cwd packages/frontend map:style          # re-render both documents
bun run --cwd packages/frontend map:style:check    # validate + fail on drift
bun run --cwd packages/frontend map:style:check --online   # also re-verify the live tile schema
```

`map:style:check` is the guard that matters, because **a broken style document
fails silently**: a wrong `source-layer` renders nothing, a missing fontstack
renders no text, a moved layer id breaks an overlay's `beforeId` — none of them
crash, log or fail a render. So the script validates the document against the
real MapLibre style spec (`validateStyleMin`), asserts every `source-layer` and
every `text-font` exists, asserts the id contract, asserts light and dark are
in step, and fails if the committed JSON has drifted from the source. Run it
before pushing a cartography change.

Two checks were added when the origins moved, and both exist because their
failure mode is invisible rather than loud:

- **First-party origins.** Not one URL in either document may point anywhere
  but `goway.to`. A style that names a vendor host renders perfectly; the only
  evidence is a hostname in a network panel nobody is looking at, so the
  mistake survives review, QA and launch and is found by the partner who
  cannot embed us. `attribution` is the deliberate exception — those links are
  a licence obligation.
- **No throwing filter.** An ordering comparison (`<`, `<=`, `>`, `>=`) whose
  operand is a bare property read is wrapped by MapLibre in a numeric assertion
  that throws on a feature lacking the property. GoWay shipped three of them on
  `admin_level`, and 518 of 2949 real `boundary` features (17.6%, measured
  across 864 tiles) hit them — every one an `aboriginal_lands` polygon. See the
  note above the boundary layers in `lib/map/style/layers.ts` for the
  measurement, for why MapLibre survives it, and for why the obvious fix
  (`to-number` with a fallback) is materially worse than the bug.

### Where every colour comes from — measured, not reasoned

The palette is **sampled from Apple Maps**, not designed to resemble it. Three
earlier versions were reasoned — first from a Google Maps style array supplied
as an "Apple Maps" reference, then twice from a description of Apple's design
language — and all three were wrong in the same direction: they assumed the
target was quiet, desaturated and near-monochrome. It is not. Apple Maps is
warm and saturated in daylight and blue-violet at night.

So this pass measured it. `.apple-maps-reference/` (gitignored — third-party
screenshots, sampled and not redistributed) holds eleven captures taken with
`shoot.ts`, which drives headless Chromium over the DevTools Protocol because
no CLI flag emulates `prefers-color-scheme` and without `Emulation.setEmulatedMedia`
you get Chrome's auto-darkened light basemap instead of Apple's real dark one:

| capture | what it is | what it was for |
|---|---|---|
| `light-city` / `dark-city` | Manhattan, z14 | land, built-up, water, roads, casings |
| `light-wide` / `dark-wide` | NY metro, z10 | motorways at region scale, forest, coastline |
| `campus-light` / `campus-dark` | upper Manhattan, z15 | hospital, university, wooded park, expressway |
| `madrid-light` / `madrid-dark` | central Madrid, z15 | a non-US road mix, POI pin colours, plazas |
| `jfk-light` / `jfk-dark` | JFK, z13 | aerodrome, runways, aprons, salt marsh |
| `rural-light` | Catskills, z9 | forest, farmland, hillshading |

Method, because it matters: single pixels are unreliable next to antialiasing
and label halos, so every value is the **dominant colour of a region**, and
nothing was accepted until it appeared in at least two independent captures.
Run-length scans across roads were used to separate a fill from its casing,
which no region sample can do. Every field in `palette.ts` carries its
measurement in a trailing comment; a field marked **(chosen)** could not be
measured and is an interpolation between neighbours — those are the ones to
distrust first.

#### The headline values

| class | light | dark |
|---|---|---|
| land | `#f6f4eb` | `#34445b` |
| built-up blocks | `#fef4df` | `#45476e` |
| water | `#8ddbf6` | `#1c347a` |
| park | `#c6e9a8` | `#005d5b` |
| motorway | `#b3b5b9` | `#7d91b1` |
| street fill | `#fefefe` | `#63758d` |
| street casing | `#e0e3e6` | `#43536b` |
| medical | `#fbebe8` | `#404458` |
| aerodrome | `#dbe5ee` | `#314d76` |
| place label | `#222222` | `#dae4ed` |

#### Four findings that changed a layer, not just a hex

1. **Motorways are a solid cool grey — not white, and certainly not yellow.**
   At every zoom from z10 to z15 Apple draws expressways as an unbroken
   `#b3b5b9` ribbon while ordinary streets are white with a cool casing. The
   hierarchy inverts the usual one: the most important road is the *darkest*
   thing in the network. Found by scanning across the Henry Hudson Parkway, the
   FDR and I-495; no region sample would have shown it.
2. **The built-up tint is zoom-gated.** `#fef4df` is 15% of a z14 Manhattan
   canvas and entirely absent from a z10 one, and the same is true of the dark
   `#45476e`. `landuse-built-up` now fades in from z10 to z13.
3. **Road casings are COOL greys on WARM land.** `#e0e3e6` and `#ced1d4` sit on
   `#f6f4eb` cream. Every previous version used warm casings, which is why the
   roads never separated from the ground the way Apple's do.
4. **Motorway fills shift hue with zoom** — `#b3baca` at z10 against `#b3b5b9`
   at z14, `#889dbf` against `#7d91b1` at night. Small, but it is the
   difference between a motorway network that reads as a system at region scale
   and one that reads as scratches. `RoadTone.fillLowZoom` reproduces it.

#### Where readability beat fidelity

The style holds a 4.5:1 contrast floor for label text against the ground it
actually sits on. Five measured Apple values fall below it, and in those five
places GoWay diverges on purpose:

| label | Apple's measured value | measured ratio | GoWay uses | ratio |
|---|---|---|---|---|
| light neighbourhood | `#747979` | 4.01:1 | `#646969` | 5.10:1 |
| light park | `#1f823d` | 3.62:1 | `#166a2f` | 4.98:1 |
| dark neighbourhood | `#a5b4c6` | 4.18:1 | `#bcc8d6` | 5.20:1 |
| light street over a **motorway** | — | 2.8:1 | `#636766` | 5.7:1 on the white street fill it normally sits on; over the grey ribbon nothing reaches 4.5:1 without going near-black, so the 1.3px white halo carries it |
| dark street over a **motorway** | — | — | `#f2f5f9` | 4.3:1 on ordinary streets. Against the `#7d91b1` motorway fill, **even pure white only reaches 3.20:1** — 4.5:1 is arithmetically unreachable for any text colour, and the dark halo is the mechanism |

#### The three contested rules from the retired source

The Google array that seeded the first two versions carried three rules that
were product decisions rather than colours. They live in
`lib/map/style/tuning.ts` — one flag each, argued in place, flippable in one
line — and they survive the move to measured colour unchanged:

| flag | supplied | shipped | why |
|---|---|---|---|
| `LOCAL_ROAD_FILL` | black, casings off | **`null`** — the palette's own recipe | the black shipped, was seen live, and was rejected: *"veo unas líneas negras en las carreteras"* |
| `SHOW_ROAD_AND_POI_LABELS` | off | **on** | a map whose streets and places have no names cannot be searched, navigated or recognised — that removes the product's job rather than restyling it |
| `SHOW_BASEMAP_POIS` | `poi.business` off | **on, restrained** | switching POIs off would deliberately ship the dark-mode gap this style exists to close |

#### What could not be matched

- **No hillshading.** `rural-light` shows Apple modulating forest green with
  terrain relief. GoWay carries no relief raster (the style has no DEM source
  and OpenFreeMap serves none that fits), so large forests render flat.
- **Built-up coverage is uneven, and that is the tiles, not the style.** The
  Madrid z14 tile carries `landuse class=residential` over 108% of its area;
  the Manhattan one carries 0.1%. So GoWay's cream block tint appears in Madrid
  and is nearly absent in Manhattan, where Apple — which has its own built-up
  dataset — tints the whole island. A GoWay-hosted tile build could add the
  layer; OpenMapTiles cannot.
- **Apple draws only *notable* buildings as distinct shapes**; ordinary ones
  melt into the block tint. GoWay draws every footprint the `building`
  source-layer carries, so its building fill is deliberately set between
  Apple's two measured values rather than at either.
- **Beach/sand, ice and ferry were never visible** in any capture, so those
  three are `(chosen)`.
- **Apple does not visibly distinguish farmland**, cemeteries or tracks at the
  zooms captured. GoWay has layers for them; they are set a hair off their
  neighbours rather than invented.

Cartography is **not** Bloom. No Bloom token appears in a geographic layer and
no cartographic colour is reachable from `components/` or `features/`: a brand
accent in a landcover fill ruins the map, and a landcover green on a button
ruins the interface.

OpenFreeMap is keyless, free, OSM-derived and OpenMapTiles-schema'd, so
development and the first production release need no API key and no $30/month
plan. **`tile.openstreetmap.org` is never a production backend** — OSM's own
tile servers are a hobby-scale raster aid whose usage policy forbids app
traffic.

Override per deployment (all optional, see `.env.example`):

```
EXPO_PUBLIC_MAP_SOURCE=goway|openfreemap
EXPO_PUBLIC_MAP_STYLE_ORIGIN=http://192.168.1.10:8081   # native dev builds
EXPO_PUBLIC_MAP_STYLE_URL_LIGHT=…
EXPO_PUBLIC_MAP_STYLE_URL_DARK=…
```

`EXPO_PUBLIC_MAP_STYLE_ORIGIN` exists because the style paths are
origin-relative and **a native app has no origin**. Web resolves them against
`window.location.origin` (so `expo start --web` and every preview deployment
style themselves from their own bundle); native falls back to `https://goway.to`
unless this is set. Point it at the Metro dev server to iterate on cartography
in a native dev build.

`EXPO_PUBLIC_MAP_SOURCE=openfreemap` is the escape hatch: it routes back to
`liberty`/`fiord` with no rebuild if a style deploy goes wrong. Setting either
`_STYLE_URL_` override also **clears the `beforeLabels` anchor**, because the
anchor is a promise about a document `provider.ts` has seen.

### Source and layer IDs

Later GoWay styles and overlays (#5 search pins, #6 route lines) depend on
these, so they are a contract rather than a description. The authoritative list
is `GOWAY_STYLE_LAYER_IDS` in `lib/map/style/layers.ts`, and it is also stamped
into each document's `metadata["goway:layers"]`.

| role | id |
|---|---|
| vector source | `openmaptiles` |
| background layer | `background` |
| **overlay anchor** | `goway:anchor:labels` |
| source-layers | `aerodrome_label`, `aeroway`, `boundary`, `building`, `housenumber`, `landcover`, `landuse`, `mountain_peak`, `park`, `place`, `poi`, `transportation`, `transportation_name`, `water`, `water_name`, `waterway` (OpenMapTiles v3) |

Layer ids, bottom to top — **identical in light and dark**, which is the
property that makes the anchor a promise:

```
background
landuse-built-up  landcover-farmland  landcover-natural  landcover-ice
landcover-wetland  landcover-sand  landuse-pitch  landuse-cemetery
landuse-medical  landuse-institution  landuse-park  park  park-outline
water  waterway
aeroway-area  aeroway-runway  aeroway-taxiway
road-tunnel-casing  road-tunnel
road-service-casing  road-track-casing  road-local-casing
road-tertiary-casing  road-secondary-casing  road-primary-casing
road-trunk-link-casing  road-trunk-casing
road-motorway-link-casing  road-motorway-casing
road-service  road-track  road-local
road-tertiary  road-secondary  road-primary
road-trunk-link  road-trunk  road-motorway-link  road-motorway
road-path  road-ferry  road-rail  road-rail-hatch
building
boundary-region  boundary-country
── goway:anchor:labels ───────────── everything below is terrain, above is type
poi-dot  poi-dot-minor  poi-transit-dot
label-waterway  label-water-line  label-water-point
label-road-local  label-road-arterial  label-road-highway
label-poi-minor  label-poi  label-poi-transit
label-aerodrome  label-park
label-place-minor  label-place-village  label-place-town  label-place-city
label-place-region  label-place-country
```

Road ids are named after the OpenMapTiles `transportation.class` they draw, so
a filter and an id cannot disagree about which roads they mean. They replaced
`road-highway*` / `road-arterial-*` when casings were added to every tier; if
you have a branch referencing the old names, that is the rename.

Three orderings in there are load-bearing and invisible in review:

- **All road casings precede all road fills.** Where a residential street meets
  a primary, the primary's fill covers the residential's casing and the
  junction reads as continuous tarmac. Interleaved per tier, every crossing
  grows a visible seam.
- **`landuse-built-up` is at the BOTTOM of the ground stratum.** `landuse
  class=residential` polygons are enormous — in a Madrid z14 tile they cover
  108% of it — and they share a source-layer with the small specific ones.
  Drawing `landcover` first and `landuse` second paints the residential blanket
  over the parks; it turned El Retiro into plain sand until the order was fixed.
- **Place labels are LAST.** MapLibre places symbols starting from the last
  symbol layer, so being last is what makes a city name win a collision.

### The road model, and the type ramp

These two are the whole "does it look like Apple Maps" question, so they are
written down rather than left in the numbers.

**Roads.** Every class has a fill and a casing — a fine line one step darker,
drawn wider and underneath — and all casings are emitted before all fills.

The **colour** model is Apple's, measured: ordinary streets (primary and below)
are `#fefefe` with a cool grey casing that darkens up the tiers (`#e0e3e6` for
a residential street, `#ced1d4` for a primary), while **motorway and trunk are
a solid cool grey** (`#b3b5b9`, `#c4c7ca`) with a casing only one step under
their own fill. So the strategic network is the *darkest* thing in the road
hierarchy in daylight and the *brightest* at night — the inverse of the usual
white-motorway convention, and the single most visible thing about Apple's
roads. Their fills also shift hue as you zoom out (`RoadTone.fillLowZoom`), and
primary/secondary casings deepen as you zoom out (`RoadTone.casingLowZoom`),
because a pale one-pixel edge at z11 is not an edge — without that ramp the
Madrid region rendered as a white tangle in which the A-roads could not be
traced. **Width still carries the ranking**: at z15 a motorway is 11.3px, a primary 7.4, a secondary
6.0, a tertiary 4.8, a residential street 3.6, a service road 1.8 — a clean
monotonic ladder with roughly 3:1 between the top and the bottom of the
drivable network, held at about the same ratio at every zoom so the map does
not re-rank as you zoom.

The casing width is **derived** from the fill width, never written down twice:
a constant pen (0.7px per side at z8 rising to 5.2px at z20), clamped to 1.2×
the fill. The constant is what makes every road look drawn with the same
instrument — a *ratio* would give a motorway a four-times-thicker edge and
start a second hierarchy competing with the width one. The clamp is what
rescues low zoom, where a flat pen on a 0.6px residential street renders a town
as warm-grey tangle with a white thread inside it.

**Type.** Apple is label-forward, and "forward" is a ranking:

```
city  >  town  >  village  >  neighbourhood  >  POI  >  street
```

Size carries most of it — a city at z12 is 23px and a street name at z16 is
10.5px, better than two to one. Colour carries the rest: place names are a
near-black warm grey, street and POI names a lighter warm grey that visibly
recedes. Weight would be the third lever, but OpenFreeMap's glyph server serves
only `Noto Sans Regular` and `Noto Sans Bold` (`Medium` and `SemiBold` both
404), so the ladder has two rungs and Bold is spent entirely on place names.
Neighbourhoods are uppercase and letter-spaced, which is Apple's one
typographic tell for "this is an area, not a point". Halos run 1.4–2.0px
throughout, because a label-forward map puts type over a busy basemap by
definition and a thin halo is how a street name dies at a park edge.

Everything **GoWay** adds is namespaced `goway:` — MapLibre keys sources and
layers in one flat namespace shared with the loaded style document, so an
unprefixed `"buildings"` overlay would collide with whatever the next style
calls its own:

```
goway:src:<overlayId>        source
goway:line:<overlayId>       line layer
goway:fill:<overlayId>       fill layer
goway:circle:<overlayId>     circle layer
goway:anchor:labels          the reserved overlay anchor (in the style itself)
```

### Known gaps, stated rather than hidden

- ~~**Dark mode has no basemap POIs.**~~ **Closed.** No OpenFreeMap *dark* style
  ships a `poi` source-layer, which is why `fiord` had none. GoWay's own style
  reads the same `poi` source-layer in both appearances, and draws POIs as
  category-tinted dots rather than sprite icons — the OpenFreeMap sprite is 264
  non-SDF dark-on-transparent PNGs that cannot be recoloured for a dark ground,
  so the dots are what make parity possible at all.
- ~~**Overlay anchoring differs by platform.**~~ **Closed.** Both adapters now
  read `MapSourceIds.anchors.beforeLabels`, which GoWay's style guarantees as
  the reserved `goway:anchor:labels` layer. The old derivation survives as the
  fallback for a style GoWay did not author (the `openfreemap` source, or an
  `EXPO_PUBLIC_MAP_STYLE_URL_*` override), where no such promise exists.
- **The type ramp has never been seen rendered.** The style is validated
  against the MapLibre style spec, every layer's filter has been evaluated
  against real decoded `.pbf` tiles over six cities, and both appearances are
  rasterised offline before every cartography change — but an offline
  rasteriser has **no glyphs and no label collision**, so it draws no type at
  all. Everything in "The road model, and the type ramp" above about sizes,
  halos and weights is reasoned from Apple's hierarchy, not observed. Label
  density at z13–z15 in a dense city is the specific thing to look at: too many
  POI labels and the map stops being quiet.
- **No road shields, no one-way arrows, no house numbers, no 3D buildings.**
  All four are in the schema and all four are deliberate omissions. Shields
  were considered for this pass and dropped: OpenFreeMap's sprite ships the
  US-centric `us-interstate_*` / `road_*` images as **non-SDF** PNGs, so they
  cannot be recoloured to match, and outside the US they would render OSM's
  shield vocabulary rather than anything Apple-like. They are worth revisiting
  for driving directions (#6) with GoWay-drawn shield images.
- **`maplibre-gl` is v6, and its worker is vendored to our own origin.** GoWay
  used to pin v5.24.0, whose UMD bundle inlined the tile worker as a Blob so
  there was nothing to vendor. That pin is gone: **GHSA-jrc7-96c5-q579**
  (critical — "XSS Sanitizer Bypass in `DOM.sanitize()` via Live NamedNodeMap
  Removal Skip") covers every release `<= 6.4.0`, the first patched version is
  6.4.1, and 5.24.0 is the last release on the 5.x line — there is no patched
  5.x and there never will be.

  v6 is ESM-only and starts its tile worker from a URL derived from
  `import.meta.url`, which inside a Metro bundle is not the package directory —
  so left alone the worker never starts, every tile request fails, and there is
  no build error and no failing test. `scripts/vendor-maplibre-worker.js` copies
  the *installed* package's `maplibre-gl-worker.mjs` + `maplibre-gl-shared.mjs`
  into `public/vendor/maplibre-gl/<version>/`, and `MapCanvas.web.tsx` calls
  `maplibregl.setWorkerUrl()` with that same version-keyed path, so a bump can
  never silently serve a stale worker against new main-thread code.

  `metro.config.js` invokes the script as a side effect *before* delegating to
  `@oxy.so/app-preset` — a call in front of the preset, not a fork of it, so
  AGENTS.md's "fix the preset, never copy config back into the app" still holds.
  Every Metro process (`expo start`, `expo export`, CI) therefore has the files
  before it serves or exports `public/`. The output is gitignored: it is a
  verbatim copy of a dependency, reproduced by any install + Metro run.

### Attribution

Rendered by `MapAttribution`, identically on both platforms, and mounted by
`MapCanvas` itself so a screen cannot forget it. Both engines' built-in
attribution ornaments are disabled, because both derive their text from an
`attribution` field on the style's sources — which the OpenFreeMap documents do
not set, so both would render an **empty** credit: the failure mode where the
obligation looks satisfied and is not.

### Reliability

A style or tile failure covers the **canvas** with `MapErrorState` (a
product-owned message plus a retry that reloads the engine). Chrome — search,
controls, sheets — are siblings of the canvas, not children, so they stay
mounted and usable. Web distinguishes `tiles` from `style` via the error's
`sourceId`; MapLibre Native surfaces no per-tile errors to JS, so native reports
`style` for both and the copy covers each case.

---

## Embedding GoWay — `/frame`

```html
<iframe
  src="https://goway.to/frame?center=41.3874,2.1686&span=0.05,0.05"
  width="600" height="450" style="border:0" loading="lazy"></iframe>
```

The parameter shape is Apple's, verbatim
(`https://maps.apple.com/frame?center=LAT%2CLON&span=A%2CB`), because anyone
putting a map on a page has already met it. GoWay's own `?lat&lng&zoom`
spelling works too; both are parsed by one module, `lib/map/embed.ts`, shared
with the app route.

| parameter | meaning |
|---|---|
| `center=LAT,LON` | camera centre (Apple's spelling) |
| `lat=` `lng=` / `lon=` | camera centre (GoWay's spelling) |
| `span=LATDEG,LONDEG` | full width and height in degrees, centred on `center` |
| `zoom=` / `z=` | 0–22. Wins over `span` when both are given |
| `bearing=` `pitch=` | degrees; pitch is clamped to 0–85 |
| `marker=LAT,LON` | repeatable, up to 20 |
| `place=<GoWay place id>` | show a real place, with its name and category |
| `interactive=0` | a still map that does not swallow the page's scroll |
| `theme=light\|dark` | otherwise follows the Bloom theme |

**A malformed parameter is ignored, never fatal.** These arrive from a
third-party page, in a frame the user cannot reload, from code that is quite
likely concatenating strings — `?center=undefined,undefined` is what a
templating bug emits, and it renders the default view rather than a blank
frame and a stack trace in someone else's console. `lib/map/__tests__/embed.test.ts`
asserts that exhaustively, including a thousand random query strings, because
the precedent is specific: a `NaN` coordinate reaching MapLibre's `LngLat`
constructor once replaced the whole application with its error boundary.

Deliberately not accepted: arbitrary GeoJSON (a parameter that can carry a
geometry can carry a megabyte), style or colour overrides (the cartography is
the product), and any kind of API key (there is nothing to meter — the read
surface is public, and a key would only be a way for the embed to break).
Anything beyond this belongs in `@goway.to/sdk`, where the caller owns the page.

The embed renders `MapCanvas` and nothing else — no top bar, no sheet, no
search, no location control, no sign-in. Three things are non-negotiable and
are rendered anyway: **the GoWay mark** in the bottom-left corner, the
attribution in the bottom-right, and a "View larger map" link, because an embed
that is a dead end is a screenshot. The first two are rendered by `MapCanvas`
itself and neither takes a prop, so there is no parameter that removes them and
no route that can forget them. See the next section.

## The brand

One drawing, everywhere: `components/brand/artwork.ts`. It is the logo as
geometry — the delivered 118 kB SVG flattened, cropped to its ink and
re-encoded at 53 kB, with the rewrite proved against the original pixel by
pixel rather than eyeballed (the numbers, and the traps, are in that file's
header).

| where | what | drawn by |
|---|---|---|
| every map, bottom-left | wordmark, 76px | `components/map/MapBrand.tsx` |
| the embed, `/frame` | the same, unconditionally | `MapCanvas` |
| tab / favicon | the "G" mark, SVG | `app/+html.tsx` → `/brand/goway-mark.svg` |
| iOS & Android icon, splash | mark / wordmark, PNG | `app.config.js` → `assets/brand/` |
| anyone else's page | `https://goway.to/brand/goway-wordmark.svg` | `public/brand/` |

Three rules, each of which is a gate and not a convention:

- **The app never fetches its own logo.** `GowayLogo` draws the geometry
  through `react-native-svg` on web and native alike, so the brand is part of
  the bundle: if the app rendered, the logo rendered. A logo that arrives over
  the network fails by being *absent*, which is the one failure a brand mark
  cannot have.
- **`public/brand/*.svg` is generated, never hand-edited.** `bun run brand`
  writes it from the same artwork; `bun run brand:check` fails CI on drift.
  Two copies of a logo diverge silently and are noticed a release later.
- **The blue is ink, not theme.** `--color-brand-goway` /
  `--color-brand-goway-tint` sit *beside* Bloom's `--primary`, never over it —
  `BloomThemeProvider` rewrites `--primary` at runtime from the user's Oxy
  theme, and a logo that followed it would be a different logo in every theme.
  `components/brand/__tests__/artwork.test.ts` fails if the CSS and the TS
  spellings ever disagree.

No light and dark variants, and no plate behind the mark on the map: the
artwork's own heavy `#004aad` outline is what separates it from the map. That
was checked by rendering it over the eight colours a GoWay map is actually made
of, from `lib/map/style/palette.ts`, not assumed — on the light ones the
outline carries it, on the dark ones the outline recedes and the `#acd0ff` and
`#ffffff` counters carry it instead.

**`app/+html.tsx` does not ship** and did not before this either. `web.output`
is `'single'`, and expo-router renders `+html.tsx` only for `'static'` /
`'server'`; the export writes Expo's own template, so the `theme-color` entries
that have been in that file all along have never reached a browser. The tab
icon works anyway, through `web.favicon` (Expo emits `dist/favicon.ico` and the
one `<link>` its template does write) and through `public/apple-touch-icon.png`
at the site root, which is the path iOS fetches when no `<link>` declares one.
The casualty is `og:image` — unfurlers do not run JavaScript, so a link to
goway.to has no share card until `output: 'static'`. The image is generated and
served at `/brand/goway-og.png`, waiting.

**The mark's honest limit is 16px.** At 32px and above the "G" is unmistakable;
at 16 the heavy outline closes its counter and it reads as a round blue
letter-shape. That is why the favicon is shipped as SVG — a 16px tab slot on a
2x display rasterises at 32 device pixels — and why no 16x16 PNG is baked from
it. The wordmark dies much earlier, below about 48px, which is why it is never
the icon.

## App shell

The map is the **public entry route** (`app/index.tsx`). There is no `(auth)`
route group and no `AuthRouter` — the scaffolder's group swap is the wrong
shape for a product whose entry is public and whose private parts are individual
*actions*.

- `OxyProvider` is still the single session authority, and sign-in is still the
  in-app `OxyAccountDialog` — never a redirect to an IdP.
- Identity is requested per feature through `useAuthGate()` (`lib/authGate.ts`):
  saves, edits, lists and contributions call `run(action)`, which opens the
  account dialog *over* the map instead of replacing it. Private API calls stay
  gated on `useAuth().canUsePrivateApi`.
- `BloomProvider` (`@oxy.so/bloom/provider`) is the root. It composes the image
  resolver, theme, scroll restoration, haptics, tab-bar minimize and the
  top/bottom edge providers, and it wraps **every** render branch — `useTheme()`
  throws outside it, which is a cold-start-only crash that `tsc` and Jest both
  pass straight over.
- Outlets are mounted **exactly once**. `PortalProvider`/`PortalOutlet` is
  mounted in `app/_layout.tsx`; `SurfaceProvider`/`SurfaceHost` and
  `ToastOutlet` are **not**, because `OxyProvider` already renders them — a
  second mount silently duplicates every surface and every toast.

Floating chrome composes over the full-bleed map with `@oxy.so/bloom/layout`:
the top bar *claims* the top edge with its measured height; the controls column
*reads* the bottom edge. A claim already folds in the safe area, so never add
`insets.bottom` on top of one.

---

## Privacy

Two rules, enforced in code rather than by convention:

1. **Opening GoWay asks for nothing.** No account, and no location permission.
   `useUserLocation()` does not run on mount — it does not even *read* the
   permission until the user presses a location-dependent control — and
   `MapCanvas` refuses to draw the location dot unless permission is already
   granted, so passing `showUserLocation` speculatively cannot produce a prompt.
2. **Precise location is transient.** The fix lives in React state for the life
   of the screen and is written to no store, no cache, no query key, no
   AsyncStorage and no backend table. There is deliberately no "last known
   location" to restore: a location history is exactly the artefact the rule
   forbids, and the cheapest way not to have one is to have no writer.

`app.config.js` declares foreground location only, with background location
explicitly disabled on both platforms.

---

## Styling

NativeWind 4-style utilities over Tailwind v4, with Bloom's tokens: spacing
`space-*`, radii `radius-*`, type `text-caption|bodySmall|body|subtitle|sectionTitle|headerBold`,
elevation `shadow-s|m`.

- There is **no** `tailwind.config.js` and there must not be. Tailwind v4 loads
  a JS config only through an explicit `@config` directive; with none, a config
  file is dead weight that re-introduces a duplicate token layer.
- `postcss.config.mjs` and the `import '../global.css'` in `app/_layout.tsx` are
  both load-bearing. Drop either and the web build emits **zero** utility CSS
  while still stamping `className` onto the DOM — colours still look right and
  only layout silently collapses.
- New top-level directories need an `@source` glob in `global.css` or their web
  `className` layout is inert. `app/`, `components/` and `lib/` are covered.
- Never restate a token Bloom defines, and never write `hsl(var(--x))` — Bloom
  writes full `rgb(...)`, so double-wrapping yields transparent.
- `--color-brand-goway` and `--color-brand-goway-tint` are the exception that
  proves it: they are GoWay's logo ink, a key Bloom does not define, and they
  are declared once beside Bloom's palette rather than over it. See
  "The brand".

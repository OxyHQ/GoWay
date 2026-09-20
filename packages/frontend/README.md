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

## Cartography — GoWay's own style, OpenFreeMap's tiles

`lib/map/provider.ts` is the only file that names a tile vendor. Everything
else asks for an *appearance* and gets a style document back.

A style document and a tile source are different things, and the split is what
this section is about. The **tiles** are OSM-derived vector data in the
**OpenMapTiles v3** schema, served free and keyless by OpenFreeMap. The
**style** — what to draw, in what order, in what colour — is GoWay's, generated
from `lib/map/style/` into `public/map/goway-{light,dark}.json`. Because the
schema is an open standard, the same style renders unchanged the day the tiles
move to GoWay-hosted PMTiles.

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

### What the palette is aiming at, and the source that was retired

The target is **Apple Maps' current cartography**, described by property:
very low contrast and a lot of light, a near-white warm-grey ground, muted
grey-blue water, sage green close in value to the land, white roads ranked by
width and casing strength, and category tints pulled below the land's own
contrast so no block is ever the brightest thing on screen.

**Nobody who worked on this has seen Apple Maps 2026.** The values are reasoned
from that design language, not matched against a sample. Treat the result as
"built to those properties", never as "matches Apple Maps".

The first two versions were built instead from a Google Maps JS API style array
supplied as an Apple reference. It is **snazzymaps.com/style/42, published 20
November 2013**, anonymous, and its own description claims only that it "largely
resembles the Apple Maps theme, albeit somewhat flatter". It imitates iOS 6/7
Apple Maps — creamy land, saturated green, bright blue water and **yellow
motorways**, which Apple retired years ago. Following it faithfully is what made
this map look unlike Apple Maps today.

That array is now recorded in `lib/map/style/palette.ts` for provenance only,
with each hex marked against what it used to drive. **It is not a target.** A
value drifting back toward one of them is a regression, not a restoration. The
translation *method* still applies to anything new: Google names abstract
feature classes and cascades, MapLibre names the tile's own `source-layer` and
`class` values and does not, so a Google style is translated feature class by
feature class and never consumed.

What survived the palette change, deliberately: the whole road *model* (casings
on every tier, white fills, width-led hierarchy, derived casing widths, the
casings-before-fills ordering), the 69-layer id contract, the anchor, light/dark
parity and the type ramp's ranking. Only colour moved.

Three rules from the retired array are contested and are hoisted into
`lib/map/style/tuning.ts` — one flag each, argued in place, flippable in one
line:

| flag | supplied | shipped | why |
|---|---|---|---|
| `LOCAL_ROAD_FILL` | black, casings off | **`null`** — the palette's Apple recipe | the black shipped, was seen live, and was rejected: *"veo unas líneas negras en las carreteras"*. Roads now use white fills with a casing on every class. Setting a colour here restores the supplied literal treatment |
| `SHOW_ROAD_AND_POI_LABELS` | off | **on** | a map whose streets and places have no names cannot be searched, navigated or recognised — this restyles nothing, it removes the product's job |
| `SHOW_BASEMAP_POIS` | `poi.business` off | **on, restrained** | switching POIs off would deliberately ship the dark-mode gap this style exists to close |

One colour decision is worth calling out because it is counter-intuitive:
**`labelWater` and `labelPark` are darker than their hue family would suggest,
and the dark mode's `labelRoad` is lighter.** Their backgrounds moved. Muted
water and sage park sit far closer to the land's lightness than 2013's bright
blue and fresh green did, so the old label colours measured 2.38:1 and 3.58:1
against their own fills — visible as marks, unreadable as words. Every label
colour in `palette.ts` is now checked against the ground it actually sits on
rather than against the land.

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
drawn wider and underneath. Fills are white or near-white the whole way up;
**motorways are not yellow**, and the retired 2013 array's `#ffe15f` is gone
entirely. The ladder is **width plus casing strength**: a motorway's casing is
`#d3ccbb` and a residential street's is `#e4e1d7`, so the firmer edge and the
wider ribbon rank together. Motorway, trunk, primary and secondary additionally
*deepen* their casing as you zoom out, reaching their normal colour by z14 —
at z11 a motorway is a 3.8px ribbon with about a pixel of edge per side, and on
a near-white ground a pale edge at that scale is not an edge. The first render
of this palette without that ramp turned the whole Madrid region into a white
tangle in which the A-roads could not be traced. **Hierarchy is carried
by width, not colour**: at z15 a motorway is 11.3px, a primary 7.4, a secondary
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

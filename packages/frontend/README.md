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

## Map source — OpenFreeMap, behind configuration

`lib/map/provider.ts` is the only file that names a tile vendor. Everything
else asks for an *appearance* and gets a style document back.

| appearance | style | notes |
|---|---|---|
| light | `https://tiles.openfreemap.org/styles/liberty` | full layer set incl. POIs |
| dark  | `https://tiles.openfreemap.org/styles/fiord`   | no `poi` source-layer — see below |

OpenFreeMap is keyless, free, OSM-derived and OpenMapTiles-schema'd, so
development and the first production release need no API key and no $30/month
plan. **`tile.openstreetmap.org` is never a production backend** — OSM's own
tile servers are a hobby-scale raster aid whose usage policy forbids app
traffic.

Override per deployment (all optional, see `.env.example`):

```
EXPO_PUBLIC_MAP_SOURCE=openfreemap
EXPO_PUBLIC_MAP_STYLE_URL_LIGHT=…
EXPO_PUBLIC_MAP_STYLE_URL_DARK=…
```

A GoWay-hosted PMTiles/vector build registers a second entry in `SOURCES` and
becomes the default by changing `EXPO_PUBLIC_MAP_SOURCE`. No feature code and no
SDK contract moves.

### Source and layer IDs

Later GoWay styles and overlays depend on these, so they are recorded rather
than rediscovered:

| role | id |
|---|---|
| vector source (both styles) | `openmaptiles` |
| raster relief source | `ne2_shaded` |
| background layer | `background` |
| source-layers GoWay reads | `building`, `landcover`, `landuse`, `park`, `place`, `poi`, `transportation`, `transportation_name`, `water`, `water_name` (OpenMapTiles schema v3) |

Everything **GoWay** adds is namespaced `goway:` — MapLibre keys sources and
layers in one flat namespace shared with the vendor's style document, so an
unprefixed `"buildings"` overlay would collide with whatever the next style
calls its own:

```
goway:src:<overlayId>        source
goway:line:<overlayId>       line layer
goway:fill:<overlayId>       fill layer
goway:circle:<overlayId>     circle layer
```

### Known gaps, stated rather than hidden

- **Dark mode has no basemap POIs.** No OpenFreeMap dark style ships a `poi`
  source-layer; `fiord` is the closest one that still keeps parks and buildings.
  Until GoWay authors its own style document, POI pins in dark mode come from
  GoWay's marker layer, not the basemap.
- **Overlay anchoring differs by platform.** Web inserts GoWay layers before
  the first symbol layer of the *loaded* style, so a route line sits under
  labels. `liberty` and `fiord` disagree about which layer that is, so the id is
  derived at runtime rather than configured. MapLibre Native cannot hand the
  loaded style back to JS, so native appends overlays on top. A GoWay style
  document with a reserved anchor id closes this (`MapSourceIds.anchors.beforeLabels`).
- **`maplibre-gl` is pinned to v5, deliberately.** v6 is ESM-only and starts its
  tile worker from a URL derived from `import.meta.url`, which inside a Metro
  bundle is not the package directory — the worker never starts, every tile
  request fails, and there is no build error and no failing test. Working around
  it means copying worker modules into `public/` from `metro.config.js`, and
  ours delegates wholesale to `@oxy.so/app-preset` (AGENTS.md: fix the preset,
  never copy config back into the app). v5's UMD bundle carries its worker
  inlined as a Blob, so there is nothing to vendor.

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

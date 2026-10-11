# Map features: the registry and the layers panel

GoWay's map has optional features: the globe, terrain, the 3D city and its
trees, GoWay's own city tiles, the route flyover. Each one used to be a
build-time `EXPO_PUBLIC_MAP_*` flag plus a development-only `?param=1`, so the
only way to see a feature on goway.to was a rebuild. They are now entries in
ONE registry, and a person turns them on or off from the map itself, in a
layers panel modelled on Apple Maps' map options.

| Piece | Where |
| --- | --- |
| Registry: what each feature is, and how its answer is decided | `packages/frontend/lib/map/mapFeatures.ts` |
| Labels, every `LABEL_LANGUAGES` language | `lib/map/mapFeatureLabels.ts` (the button's name: `lib/map/mapLayersTriggerLabel.ts`) |
| Per-device store: choices, Labs, hydration | `lib/map/mapFeatureStore.ts`; the app's one instance and hooks in `lib/map/useMapFeatures.ts` |
| Storage | `lib/map/mapFeatureStorage.web.ts` (`localStorage`, synchronous) and `mapFeatureStorage.ts` (AsyncStorage, native) |
| Each feature's own rule (dev query parameters) | `city3dFlag.ts`, `city3dTreesFlag.ts`, `cityTilesFlag.ts`, `flyoverFlag.ts`, `reliefFlag.ts` — unchanged |
| The panel | `features/explore/MapLayersButton.tsx` (first paint) and `MapLayersPanel.tsx` (loaded on first open) |
| Tests | `lib/map/__tests__/mapFeatures.test.ts`, `mapFeatureStore.test.ts`, `mapFeatureLabels.test.ts` |

## How a feature's answer is decided

For each feature, in registry order (a dependency comes first):

1. **The build's kill switch** — its variable set to `0`/`false`. The build
   does not carry the feature: it is off, it is not in the panel, and no stored
   choice can bring it back.
2. **The person's choice**, made in the panel and kept on this device.
3. **The build's default** — the variable set to `1`/`true`. What it always
   meant ("this build has it on"), except that a person can now switch it off.
4. **The registry's default** (`defaultOn`).

That answer is handed to the feature's own flag module where the build boolean
used to go, so a development build's `?city3d=1`, `?globe=0` and the rest work
exactly as before. Last, a feature is off while anything it `requires` is off
(the trees and the city tiles need the 3D city; the woods fill needs the trees).

With no stored choice, every feature answers exactly what its flag answered
before the registry: `mapFeatures.test.ts` checks every feature against the old
`lib/config.ts` + flag-module formula over every build value and query string
that mattered. The one spelling unified is padding: `EXPO_PUBLIC_MAP_CITY3D_TREES=" 0 "`
now kills the trees, as a padded `0` always killed the globe and terrain.

### Defaults

| Feature | Tier | Default | Platforms | Variable | Dev query | Applies |
| --- | --- | --- | --- | --- | --- | --- |
| `globe` | stable | **on** | web | `EXPO_PUBLIC_MAP_GLOBE` | `?globe=0/1` | redraws the map at the same camera |
| `terrain` | stable | **on** | web, native (hillshade only) | `EXPO_PUBLIC_MAP_TERRAIN` | `?terrain=0/1` | web: redraws at the same camera; native: live |
| `city3d` | labs | off | web | `EXPO_PUBLIC_MAP_CITY3D` | `?city3d=1` | live (attach/detach) |
| `cityTiles` | labs | off | web, **development builds only** | `EXPO_PUBLIC_MAP_CITY_TILES` | `?cityTiles=1` | live (re-attach) |
| `city3dTrees` | labs | on, with the city | web | `EXPO_PUBLIC_MAP_CITY3D_TREES` | `?city3dTrees=0` | live (re-attach) |
| `city3dTreeFill` | labs | off | web | `EXPO_PUBLIC_MAP_CITY3D_TREE_FILL` | `?city3dTreeFill=1` | live (re-attach) |
| `flyover` | labs | off | web, native | `EXPO_PUBLIC_MAP_FLYOVER` | `?flyover=1` | live ("Fly the route", `/studio`) |

No production default changed: globe and terrain stay on (#128), everything
else is off until somebody turns it on. City tiles are offered in the panel only
in a development build, because nothing serves them on goway.to yet and ODbL
wants the archive and its receipt published first (`MAP_3D_CITY.md` → Hosting).

## The layers panel

A button at the top right of the map, under the account button — the one corner
that neither the sheet, the side panel nor any notice covers, in either layout.
Bloom's `Popover`: a panel beside the button on the web, a bottom sheet on
native. Inside:

- **Map view: 2D / 3D.** The camera, not a feature: 3D tilts to 60° where the
  map already is, so the buildings and the terrain stand up; 2D levels it. It
  follows the map, so tilting by gesture moves the control too.
- **Layers**: the `stable` features this build carries and this platform draws.
- **Labs**, once revealed: the `labs` features, each with a one-line
  description, the note that they may be slow, "Open Camera Studio" while the
  flyover is on, and "Hide Labs".

A feature whose dependency is off shows a disabled switch and "Needs “3D
city”"; one a development query parameter is forcing shows "Set by this page's
address". Switches are named for screen readers, the button announces its
expanded state, Enter opens the panel and Escape closes it.

**Revealing Labs** is deliberately not an `.env` decision: `?labs=1` on any
goway.to address once (remembered on the device; `?labs=0` forgets), or press
and hold the layers button. It works in production — it only SHOWS switches,
every Labs feature still starts off, so a shared link can never switch an
experimental renderer on for somebody else.

### How a change reaches the map

The store notifies; components read it through `useMapFeature(id)`:

- `MapCanvas.web.tsx`: the city layer's effect depends on `city3d`,
  `cityTiles`, `city3dTrees`, `city3dTreeFill`, so a toggle detaches the old
  layer (giving `building-3d` back) and attaches a new one — no reload. A
  `globe`/`terrain` toggle rebuilds the MapLibre engine, because the globe is
  part of how the style is loaded; the new engine starts at the camera the old
  one had (an appearance change or a retry still starts at `initialViewport`,
  as before), and the relief chunk is requested the first time it is wanted.
- `MapCanvas.native.tsx`: the hillshade is a layer in the render, so it is live.
- `MapAttribution`: the elevation credit follows `terrain` live.
- `ExploreScreen`: "Fly the route" follows `flyover`; `/studio` redirects to the
  map while it is off, and on native waits for the stored choices first.

## Privacy

Preferences stay on the device: one JSON document, `goway.mapFeatures`
(`{v:1, choices, labs}`), in `localStorage` on the web and AsyncStorage on
native. No request carries it and no server learns it. Storage is a
convenience: if it throws, rejects or holds garbage, the map draws the build's
defaults; if a save fails, the choice still applies to the session. A choice
equal to what the build would decide anyway is forgotten rather than stored, so
a later change of default reaches the person.

## Adding a feature — the recipe

A branch that adds a flag adds it HERE, in three steps, and nowhere else (not
in `lib/config.ts`, and no `process.env.EXPO_PUBLIC_MAP_*` read of its own):

1. **An entry in `MAP_FEATURES`** (`lib/map/mapFeatures.ts`), after anything it
   needs, with the variable read as a literal:

   ```ts
   { id: 'citySky', tier: 'labs', defaultOn: false, build: process.env.EXPO_PUBLIC_MAP_CITY_SKY,
     requires: ['city3d'], platforms: WEB,
     request: (enabled, { development, search, on }) =>
       isCitySkyRequested({ city3d: on('city3d'), enabled, development, search }) },
   ```

   `request` is your flag module's existing pure function, given the registry's
   answer as `enabled` — that keeps your dev query parameter. A value-valued
   switch (`?cityStyle=detailed`) maps to a boolean the same way:
   `request: (enabled, c) => cityStyleRequested({ ..., build: enabled ? 'detailed' : 'classic' }) === 'detailed'`.
   Add `offer: 'development'` if production cannot serve it yet.
2. **Its labels in `MAP_FEATURE_LABELS`** (`lib/map/mapFeatureLabels.ts`): a
   name and a one-line description in all twelve languages. `tsc` refuses the
   registry entry until they exist; `mapFeatureLabels.test.ts` checks every
   language.
3. **Read it with `useMapFeature('citySky')`** where it is drawn, and put it in
   the dependencies of the effect that attaches it, so a toggle applies live.
   Hand the answer to a lazy adapter as an option rather than letting the
   adapter read a flag (`city3dLayer.web.ts` takes `cityTiles`, `trees`,
   `treeFill`). If it truly cannot apply live, make it part of what rebuilds the
   engine, as `globe` is.

Then add its row to the table above and to `.env.example`, and extend the
"answers what it did before" test with your flag's old formula.

## What it costs at first paint

`expo export --platform web`, no map variables set, `--clear`, `origin/main`
(`09ee48b`) against this branch:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,968,598 B (1,750,634 gz) | 6,979,938 B (1,754,330 gz) | +11,340 B, **+3,696 B gz** (+0.2%): registry, store, hooks, button, its name in 12 languages, the trees flag (now decided at first paint) |
| `__common` (first paint) | 81,624 B | 81,624 B | identical size |
| `MapLayersPanel` (lazy, on first open) | — | 32,700 B (10,336 gz) | the panel body and all its copy |

Bloom's `Popover` was already in the entry. Measured by A/B build, never by
per-source attribution (`~/Oxy/docs/build-and-runtime-traps.md`).

## Limits

- Native was typechecked, not run: the bottom-sheet presentation and the
  AsyncStorage hydration (defaults for the moment before storage answers, then
  the stored choices) are untested on a device.
- Bloom 6.2.1's `Switch` starts its spring animation during render, so React
  logs "Cannot update a component while rendering `Switch`" in development on
  every controlled toggle. Harmless, and Bloom's to fix.
- The 3D city attaches asynchronously: for the second or so its chunk and
  first tiles take, the flat footprints show where the extrusions were.

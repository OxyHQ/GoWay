# Map features: the registry, the settings dialog and the credit

GoWay's map has optional features: the globe, terrain, the 3D city and its
trees, GoWay's own city tiles, the simulated city life, the landmarks, the
route flyover. Each one used to be a
build-time `EXPO_PUBLIC_MAP_*` flag plus a development-only `?param=1`, so the
only way to see a feature on goway.to was a rebuild. They are now entries in
ONE registry, and a person turns them on or off from the map itself, in a
settings dialog modelled on Apple Maps' map options.

| Piece | Where |
| --- | --- |
| Registry: what each feature is, and how its answer is decided | `packages/frontend/lib/map/mapFeatures.ts` |
| Labels, every `LABEL_LANGUAGES` language | `lib/map/mapFeatureLabels.ts` (the button's name: `lib/map/mapLayersTriggerLabel.ts`) |
| Per-device store: choices, Labs, hydration | `lib/map/mapFeatureStore.ts`; the app's one instance and hooks in `lib/map/useMapFeatures.ts` |
| Storage | `lib/map/mapFeatureStorage.web.ts` (`localStorage`, synchronous) and `mapFeatureStorage.ts` (AsyncStorage, native) |
| Each feature's own rule (dev query parameters) | `city3dFlag.ts`, `city3dTreesFlag.ts`, `cityTilesFlag.ts`, `flyoverFlag.ts`, `reliefFlag.ts` — unchanged |
| The settings dialog | `features/explore/MapSettingsButton.tsx` (first paint) and `MapSettingsPanel.tsx` (loaded on first open) |
| The compact data credit | `lib/map/compactCredit.ts` (the rule), `components/map/useCompactCredit.ts`, `components/map/MapAttribution.tsx` |
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
(the trees and the city tiles need the 3D city; the woods fill needs the trees;
city life needs the city tiles; the landmarks and the sky need the 3D city).

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
| `citySky` | labs | off | web (needs `city3d`) | `EXPO_PUBLIC_MAP_CITY_SKY` | `?citysky=1` | live (re-attach; the time-of-day scrubber shows only while it draws) |
| `cityTiles` | labs | off | web, **development builds only** | `EXPO_PUBLIC_MAP_CITY_TILES` | `?cityTiles=1` | live (re-attach). Official building data merged into the archive (Catastro storeys, NYC 3D model, `MAP_3D_SOURCES.md`) rides on it: no switch of its own |
| `city3dTrees` | labs | on, with the city | web | `EXPO_PUBLIC_MAP_CITY3D_TREES` | `?city3dTrees=0` | live (re-attach) |
| `city3dTreeFill` | labs | off | web | `EXPO_PUBLIC_MAP_CITY3D_TREE_FILL` | `?city3dTreeFill=1` | live (re-attach) |
| `cityLife` | labs | off | web, **development builds only** | `EXPO_PUBLIC_MAP_CITY_LIFE` | `?cityLife=1` | live (re-attach) |
| `landmarks` | labs | off | web, **development builds only** (needs `city3d`; models draw only over city tiles) | `EXPO_PUBLIC_MAP_LANDMARKS` | `?landmarks=1` | live (re-attach; the pill and "Landmark tour" come and go, a running tour ends) |
| `live` | labs | off | web, **development builds only** (needs a backend with `LIVE_ENABLED`; `docs/MAP_LIVE.md`) | `EXPO_PUBLIC_MAP_LIVE` | `?live=1` | live (mount/unmount: the panel in the top-right stack, the layer, its credits and the coverage channel come and go) |
| `flyover` | labs | off | web, native | `EXPO_PUBLIC_MAP_FLYOVER` | `?flyover=1` | live ("Fly the route", `/studio`) |

No production default changed: globe and terrain stay on (#128), everything
else is off until somebody turns it on. City tiles, city life and the landmarks
(whose models draw only over city tiles) are offered in the panel only in a
development build, because nothing serves those archives on goway.to yet and ODbL wants each archive and its receipt published first
(`MAP_3D_CITY.md` and `MAP_CITY_LIFE.md` → Hosting).

## The settings dialog

A gear at the top right of the map, under the account button — the one corner
that neither the sheet, the side panel nor any notice covers, in either layout.

It is the first item of the explore screen's **top-right stack**: ONE column
(`items-end`, 8 px apart) under the account button holding, in order, the
settings button, the "Landmarks" pill, and a slot (`components/map/chipSlot.ts`)
the map's own DOM chips mount into — the "Simulated traffic" label. Nothing
there is absolutely positioned on its own, so nothing overlaps on desktop or
phone; a new chip (Live) is one more item in the stack. The slot is never
hidden (the simulated label must show whenever the simulation draws, a tour
included); a map with no slot — the embed — keeps the label at its own spot.

The button opens Bloom's `Dialog` — a side sheet from a tablet up, a bottom
sheet below that and on native — built from Bloom's `SettingsListGroup`,
`SettingsListItem`, `SegmentedControl` and `Switch`, so every colour is a theme
token. Its sections:

- **Map**: the view, 2D / 3D — the camera, not a feature: 3D tilts to 60°
  where the map already is, 2D levels it, and it follows a gesture tilt — and
  the `stable` features (Globe, Terrain).
- **Layers · Labs**, once revealed: the `labs` features this build carries
  and this platform draws (3D city, its tiles, trees and woods fill,
  sky and time of day, simulated traffic, landmarks, live data, the flyover), each
  with a one-line description and the note that they may be slow; "Open
  Camera Studio" while the flyover is on; "Hide Labs".
- **General**: what GoWay already lets a person set — the theme (light, dark,
  system: Bloom's own mode, persisted by `BloomProvider` under `goway.theme`)
  — and the language, which follows the device and is shown, not offered.
  GoWay has no unit setting, so none is invented.
- **About**: version and build; **Map data and credits** — every source from
  `lib/map/credits.ts` with its links and its licence notices verbatim, and
  "All credits and licence notices" → `/attribution`; **Landmark models** —
  each model's licence (SPDX), author and source link; and the privacy note
  that map settings stay on the device; **Live data sources** — while live is
  on, each feed's credit and licence (`GET /live/sources`).

A feature whose dependency is off shows a disabled switch and "Needs “3D
city”"; one a development query parameter is forcing shows "Set by this page's
address". Switches are named for screen readers, the button announces its
expanded state, and Escape closes the dialog.

**Revealing Labs** is deliberately not an `.env` decision: `?labs=1` on any
goway.to address once (remembered on the device; `?labs=0` forgets), or press
and hold the settings button. It works in production — it only SHOWS switches,
every Labs feature still starts off, so a shared link can never switch an
experimental renderer on for somebody else.

## The compact data credit

The credit bottom-right follows the OSMF Attribution Guidelines' compact form
(https://osmfoundation.org/wiki/Licence/Attribution_Guidelines): spelled out,
with its links, from the moment the map has loaded; folded into an ⓘ in the
same corner after five seconds or at the reader's first pan, zoom, rotate or
tap — never by a move the app made; and opened again by that ⓘ, after which the
timer leaves it alone (going back to the map folds it again). The list stays
dynamic: Mapterhorn while terrain is on, a landmark model's author while it is
drawn, live feeds while their data is shown. `MapCanvas` renders it on both
platforms and in the embed, with no prop to turn it off; the rule and its test
are `lib/map/compactCredit.ts` and `__tests__/compactCredit.test.ts`.

### How a change reaches the map

The store notifies; components read it through `useMapFeature(id)`:

- `MapCanvas.web.tsx`: the city layer's effect depends on `city3d`,
  `cityTiles`, `city3dTrees`, `city3dTreeFill`, `cityLife`, `landmarks`, so a toggle detaches the old
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
   `treeFill`, `cityLife`, `landmarks`); anything it shows at the top right
   goes in the top-right stack, never at its own absolute position. If it truly cannot apply live, make it part of what rebuilds the
   engine, as `globe` is.

Then add its row to the table above and to `.env.example`, and extend the
"answers what it did before" test with your flag's old formula.

## What it costs at first paint

`expo export --platform web`, no map variables set, `--clear`, `origin/main`
(`1175833`) against this branch:

| Chunk | `main` | This branch | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,971,234 B (1,751,355 gz) | 6,987,632 B (1,756,297 gz) | +16,398 B, **+4,942 B gz** (+0.3%): registry, store, hooks, the settings button and its name in 12 languages, the compact credit and its ⓘ, the city flags' pure rules |
| `__common` (first paint) | 81,624 B | 81,624 B | identical size |
| `MapSettingsPanel` (lazy, on first open) | — | 59,147 B (17,328 gz) | the dialog body, Bloom's settings list, and all its copy |

Bloom's `Dialog` was already in the entry (Oxy's own dialogs use it). Measured by A/B build, never by
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

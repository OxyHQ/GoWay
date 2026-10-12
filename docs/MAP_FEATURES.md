# Map features: the registry, the settings modal and the credit

GoWay's map has optional features: the globe, terrain, Street 3D, the 3D city and its
trees, GoWay's own city tiles, the simulated city life, the landmarks, the
route flyover. Each one used to be a build-time `EXPO_PUBLIC_MAP_*` flag plus a
development-only `?param=1`, so the only way to see a feature on goway.to was a
rebuild — and a build variable left at the wrong value silently kept a finished
feature off. They are now entries in ONE registry with **no build variable at
all**, and a person turns them on or off from the map itself, in a settings
modal — Bloom's `SettingsModal` — reached from a gear on the map.

| Piece | Where |
| --- | --- |
| Registry: what each feature is, and how its answer is decided | `packages/frontend/lib/map/mapFeatures.ts` |
| Labels, every `LABEL_LANGUAGES` language | `lib/map/mapFeatureLabels.ts` (the button's name: `lib/map/mapLayersTriggerLabel.ts`) |
| Per-device store: choices, Labs, hydration | `lib/map/mapFeatureStore.ts`; the app's one instance and hooks in `lib/map/useMapFeatures.ts` |
| Storage | `lib/map/mapFeatureStorage.web.ts` (`localStorage`, synchronous) and `mapFeatureStorage.ts` (AsyncStorage, native) |
| The settings modal | `features/explore/MapSettingsButton.tsx` (first paint), `MapSettingsModal.tsx` (loaded on first press), its pages from `lib/map/mapSettingsPages.ts` |
| The compact data credit | `lib/map/compactCredit.ts` (the rule), `components/map/useCompactCredit.ts`, `components/map/MapAttribution.tsx` |
| Tests | `lib/map/__tests__/mapFeatures.test.ts`, `mapFeatureStore.test.ts`, `mapFeatureLabels.test.ts` |

## How a feature's answer is decided

A person decides; the build never does. For each feature, in registry order (a
dependency comes first):

1. **The person's choice**, made in the panel and kept on this device.
2. Otherwise **the registry's default** (`defaultOn`).
3. In a **development build only**, the page's address overrides either:
   `?<query>=1` (or `true`) turns the feature on and `?<query>=0` (or `false`)
   off, for that tab — the feature's `query` (`?city3d=1`, `?globe=0`,
   `?city3dTrees=0`, `?citysky=1`). A production build ignores the address, so
   a goway.to link can never switch a renderer on or off for somebody else.
4. Last, a feature is off while anything it `requires` is off (the trees and
   the city tiles need the 3D city; the woods fill needs the trees; city life,
   the landmarks, the sky and street detail need the 3D city).

A feature production cannot serve yet is never switched off by a build: it is
`offer: 'development'`, offered in the panel only in a development build, and
starts off. Shipping it is deleting that line.

### Defaults

| Feature | Tier | Default | Platforms | Dev query | Applies |
| --- | --- | --- | --- | --- | --- |
| `globe` | stable | **on** | web | `?globe=0/1` | redraws the map at the same camera |
| `terrain` | stable | **on** | web, native (hillshade only) | `?terrain=0/1` | web: redraws at the same camera; native: live |
| `street3d` | stable | **on** | web, native | — | live (the coverage layer comes and goes; `/street3d/<id>` always opens) |
| `city3d` | labs | off | web | `?city3d=1` | live (attach/detach) |
| `citySky` | labs | off | web (needs `city3d`) | `?citysky=1` | live (re-attach; the time-of-day scrubber shows only while it draws) |
| `detailedCity` | labs | off | web (needs `city3d`; brings its own live-clock sky without `citySky`) | `?detailedCity=1` | live (re-attach) |
| `cityTiles` | labs | off | web, **development builds only** | `?cityTiles=1` | live (re-attach). Official building data merged into the archive (Catastro storeys, NYC 3D model, `MAP_3D_SOURCES.md`) rides on it: no switch of its own |
| `city3dTrees` | labs | on, with the city | web | `?city3dTrees=0` | live (re-attach) |
| `city3dTreeFill` | labs | off | web | `?city3dTreeFill=1` | live (re-attach) |
| `cityLife` | labs | off | web, **development builds only** | `?cityLife=1` | live (re-attach) |
| `cityStreets` | labs | off | web, **development builds only** (needs `city3d`; draws from the road archive) | `?cityStreets=1` | live (re-attach) — [`MAP_STREETS.md`](./MAP_STREETS.md) |
| `landmarks` | labs | off | web, **development builds only** (needs `city3d`; models draw only over city tiles) | `?landmarks=1` | live (re-attach; the pill and "Landmark tour" come and go, a running tour ends) |
| `live` | labs | off | web, **development builds only** (needs a backend that lists `LIVE_SOURCES`; `docs/MAP_LIVE.md`) | `?live=1` | live (mount/unmount: the panel in the top-right stack, the layer, its credits and the coverage channel come and go) |
| `flyover` | labs | off | web, native | `?flyover=1` | live ("Fly the route", `/studio`) |

Globe, terrain and Street 3D are on for everyone; everything else is off until
somebody turns it on. City tiles, city life, street detail and the landmarks
(whose models draw only over city tiles) are offered in the panel only in a
development build, because nothing serves those archives on goway.to yet and
ODbL wants each archive and its receipt published first (`MAP_3D_CITY.md` and
`MAP_CITY_LIFE.md` → Hosting).

A stored choice is honoured even for a feature this build does not offer in the
panel: that is how the benchmark turns the whole 3D stack on in a production
export (`scripts/bench-map.ts` stores the choices the panel would).

## The settings modal

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

The button opens Bloom's `SettingsModal` (`@oxy.so/bloom/settings-modal/modal`): a
rail of pages beside the open page on a wide window (871×614, the rail
narrowing on a tablet), and on a phone the section list first, then the page
pushed over it with a back control — native included, through Bloom's own
modal portal. Its pages are `SettingsSection`s of `SettingsCard`s of
`SettingsRow`s with Bloom's `Switch` and `SegmentedControl`, so every colour
is a theme token. The modal is its own lazy chunk, requested on the gear's
first press.

The rail and what each page lists come from the registry
(`lib/map/mapSettingsPages.ts`, tested): each entry names its page
(`section: 'map' | 'layers'`); a feature is listed where this build offers it
and this platform draws it; a `labs` feature only once Labs is revealed; and a
page with nothing to list leaves the rail.

- **Map**: the view, 2D / 3D — the camera, not a feature: 3D tilts to 60°
  where the map already is, 2D levels it, and it follows a gesture tilt — then
  Globe and Terrain, **Performance** (Auto, Battery saver or High quality: a
  three-way choice kept in the same store, `setPerformance`, which picks the
  map's quality profile — [`MAP_PERFORMANCE.md`](./MAP_PERFORMANCE.md); it
  applies live), and Sky & time of day once Labs is revealed.
- **Layers**, once Labs is revealed: 3D city, city tiles (and the official
  building data they carry), trees and woods fill, landmarks, simulated
  traffic, live data (development builds, until goway.to's backend serves it), and the flyover with "Open Camera
  Studio" while it is on — each with what it shows, under the note that they
  may be slow.
- **Labs**, only once revealed: what Labs is, and "Hide Labs".
- **General**: what GoWay already lets a person set — the theme (light, dark,
  system: Bloom's own mode, persisted by `BloomProvider` under `goway.theme`)
  — and the language, which follows the device and is shown, not offered.
  GoWay has no unit setting, so none is invented.
- **About**: version and build, with the privacy note that map settings stay
  on the device; every source from `lib/map/credits.ts` with its links and its
  licence notices verbatim; "All credits and licence notices" → `/attribution`;
  each landmark model's licence (SPDX), author and source link; and, while
  live is on, each live feed's credit and licence (`GET /live/sources`).

A feature whose dependency is off shows a disabled switch and "Needs “3D
city”"; one a development query parameter is forcing shows "Set by this page's
address". Switches are named for screen readers, the button announces its
expanded state, and Escape (or Android back) closes the modal — on a phone,
back first returns to the section list.

**Revealing Labs** is deliberately not an `.env` decision: `?labs=1` on any
goway.to address once (remembered on the device; `?labs=0` forgets), or press
and hold the settings button, which opens the modal on the Labs page. It works in production — it only SHOWS switches,
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
  `cityTiles`, `city3dTrees`, `city3dTreeFill`, `cityLife`, `landmarks`, `cityStreets`, so a toggle detaches the old
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
(`{v:1, choices, labs, performance?, gpu?}`), in `localStorage` on the web and
AsyncStorage on native. `gpu` is what this device's GPU measured (its
renderer string, a benchmark score and the tier they give, re-measured after
30 days or on a new GPU), so a later visit picks its quality before the first
frame (`MAP_PERFORMANCE.md`). No request carries it and no server learns it. Storage is a
convenience: if it throws, rejects or holds garbage, the map draws the
registry's defaults; if a save fails, the choice still applies to the session.
A choice equal to the default is forgotten rather than stored, so a later
change of default reaches the person.

## Adding a feature — the recipe

A branch that adds a feature adds it HERE, in three steps, and nowhere else —
no `.env` variable, no `process.env` read, nothing in `lib/config.ts`:

1. **An entry in `MAP_FEATURES`** (`lib/map/mapFeatures.ts`), after anything it
   needs:

   ```ts
   { id: 'citySky', section: 'map', tier: 'labs', defaultOn: false,
     requires: ['city3d'], platforms: WEB, query: 'citysky' },
   ```

   `query` names its development-only address parameter (`?citysky=1` on,
   `=0` off); leave it out for none. `section` puts it on the settings modal's
   Map or Layers page. Add `offer: 'development'` if production cannot serve it
   yet — never a build switch.
2. **Its labels in `MAP_FEATURE_LABELS`** (`lib/map/mapFeatureLabels.ts`): a
   name and a one-line description in all twelve languages. `tsc` refuses the
   registry entry until they exist; `mapFeatureLabels.test.ts` checks every
   language.
3. **Read it with `useMapFeature('citySky')`** where it is drawn, and put it in
   the dependencies of the effect that attaches it, so a toggle applies live.
   Hand the answer to a lazy adapter as an option rather than letting the
   adapter read a flag (`city3dLayer.web.ts` takes `cityTiles`, `trees`,
   `treeFill`, `cityLife`, `landmarks`, `streets`); anything it shows at the top right
   goes in the top-right stack, never at its own absolute position. If it truly cannot apply live, make it part of what rebuilds the
   engine, as `globe` is.

Then add its row to the table above, and to the defaults test in
`mapFeatures.test.ts`.

## What it costs at first paint

`expo export --platform web`, no map variables set, `--clear`. The registry,
store, settings button and compact credit (#134) cost the entry +4,942 B gz,
measured then. Moving from the generic `Dialog` to Bloom's `SettingsModal`,
`origin/main` (`1ae5d19`) against `feat/settings-modal`:

| Chunk | before | `SettingsModal` | |
| --- | ---: | ---: | --- |
| `entry` (first paint) | 6,998,112 B (1,759,379 gz) | 6,998,104 B (1,759,376 gz) | unchanged |
| `__common` (first paint) | 81,785 B (22,838 gz) | 97,839 B (27,523 gz) | **+4,685 B gz**: Bloom's `Select`, hoisted (below) |
| lazy, on the gear's first press | `MapSettingsPanel` 71,456 B (20,269 gz) | `MapSettingsModal` 243,718 B (69,921 gz) | the modal shell and every page Bloom's barrel links |

`@oxy.so/bloom/settings-modal` was Bloom 6.2.1's only entry to `SettingsModal`,
and that barrel also links the Storage, Tools and Plan pages. Storage uses
Bloom's `Select`, and so does Oxy's lazily loaded `EditProfileFieldScreen`.
A module shared by two `import()`-ed chunks is hoisted into `__common`, which
is unconditional at first paint (`~/Oxy/docs/build-and-runtime-traps.md` →
Metro web chunking). The fix was Bloom's: 7.33.0 (Bloom#316) adds the lean
`settings-modal/modal` entry for the shell alone, and `MapSettingsModal.tsx`
imports only that. Never import the `settings-modal` barrel here: it puts
`Select` back at first paint. An app-side resolver alias would have been
config copied out of `@oxy.so/app-preset`, which AGENTS.md forbids.

Bloom 6.2.1 → 7.33.1, same build (`--clear`, no map variables, gzip -9),
three A/B builds so each change is measured alone:

| Chunk | 6.2.1, barrel | 7.33.1, barrel | 7.33.1, `settings-modal/modal` |
| --- | ---: | ---: | ---: |
| `entry` (first paint) | 7,010,105 B (1,763,734 gz) | 7,061,853 B (1,778,378 gz) | 7,061,853 B (1,778,377 gz) |
| `__common` (first paint) | 100,520 B (28,433 gz) | 100,921 B (28,547 gz) | **84,754 B (23,839 gz)** |
| `global.css` (first paint) | 56,084 B (10,519 gz) | 89,889 B (15,192 gz) | 89,889 B (15,192 gz) |
| `MapSettingsModal` (lazy) | 258,951 B (73,603 gz) | 264,012 B (74,888 gz) | **143,275 B (40,447 gz)** |

The lean entry takes `__common` down 4,708 B gz and the modal chunk down
34,441 B gz; `Select` now ships only in Oxy's lazy `EditProfileFieldScreen`
chunk, and `FileUpload` nowhere. The version itself costs the entry
+14,644 B gz and `global.css` +4,673 B gz (Bloom 7's larger `theme.css`). The
entry growth is spread over families GoWay already draws (radio and the
collapsible it now links, layout, theme, tokens, button, text field, dialog),
not one new family. Measured by A/B build, never by per-source attribution
(`~/Oxy/docs/build-and-runtime-traps.md`).

## Limits

- Native was typechecked, not run: the bottom-sheet presentation and the
  AsyncStorage hydration (defaults for the moment before storage answers, then
  the stored choices) are untested on a device.
- Bloom's `Switch` (6.2.1 through 7.33.1) starts its spring animation during render, so React
  logs "Cannot update a component while rendering `Switch`" in development on
  every controlled toggle. Harmless, and Bloom's to fix.
- The 3D city attaches asynchronously: for the second or so its chunk and
  first tiles take, the flat footprints show where the extrusions were.

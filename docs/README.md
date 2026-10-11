# Documentation

This directory will hold product, SDK, API, data-model, privacy and integration documentation for GoWay.

## Integration guides

- [`integration/merchant-discovery.md`](integration/merchant-discovery.md) — how
  another app installs `@goway.to/sdk`, renders a GoWay map, queries nearby
  Places with a **capability filter**, presents the evidence behind a claim
  honestly, and opens the canonical `https://goway.to/place/<placeId>` link.
  FairCoin merchant discovery is the worked example; the mechanism is the
  generic one every Oxy product shares (`payments.*`, `commerce.mercaria.*`,
  `mobility.moovo.*`, `housing.homiio.*`).

## Design notes

- [`STREET3D_LIFECYCLE.md`](STREET3D_LIFECYCLE.md) — capture expiry, cleanup
  operations, crash recovery and the remaining Street 3D release gates.
- [`SDK_VISION.md`](SDK_VISION.md) — what `@goway.to/sdk` is for, and who for.
- [`SDK_MAP_MODELS.md`](SDK_MAP_MODELS.md) — 3D models anchored at
  coordinates on GoWay's map (a provider-neutral `MapModel`, GLB only, a
  three.js layer inside MapLibre on web, native still open), what was taken
  from munim-maps and what was refused.
- [`CONTRIBUTING_SCOPE.md`](CONTRIBUTING_SCOPE.md) — what the first release
  prioritizes, and what is deliberately deferred.
- [`BUSINESS_OWNERSHIP.md`](BUSINESS_OWNERSHIP.md) — a business is an Oxy
  organization: who may act for a claim, the place history and what it never
  publishes, and the moderation surface, including how a merge redirects.
- [`PLACE_DATA.md`](PLACE_DATA.md) — the category taxonomy, the typed
  capability registry, the derived timezone and dated hours exceptions, and
  how the OpenStreetMap import keeps what it reads.
- [`PLACE_DATA_CONVERSION.md`](PLACE_DATA_CONVERSION.md) — the runbook for
  converting production's legacy categories and source statements in batches
  before the places-platform release, and what the previous image does meanwhile.
- [`LABEL_TRANSLATIONS.md`](LABEL_TRANSLATIONS.md) — the twelve label
  languages, how a locale is matched to one, how to add a language, and where
  each translation stands on review.
- [`MAP_3D_CITY.md`](MAP_3D_CITY.md) — 3D buildings beyond `fill-extrusion`:
  a three.js layer inside MapLibre, meshing the current tiles now and compiling
  GoWay 3D tiles next, what native gets, the ODbL and honesty rules, the phased
  plan, and the off-by-default web prototype.
- [`MAP_CAMERA_STUDIO.md`](MAP_CAMERA_STUDIO.md) — the route flyover and Camera
  Studio (off by default): the chase camera, centripetal path smoothing,
  per-gesture undo/redo, the versioned tour link, video export with the mark
  and the credit composited, and the flyover's vehicle as phase 1 of 3D models.
- [`MAP_TERRAIN_GLOBE.md`](MAP_TERRAIN_GLOBE.md) — the off-by-default globe
  (space, a glow fitted to the limb), hillshade and 3D terrain: why Mapterhorn
  and why through GoWay's Worker, what self-hosting the DEM costs, how the 3D
  buildings stand on the terrain, and what native can and cannot draw.
- [`MAP_CITY_LIFE.md`](MAP_CITY_LIFE.md) — simulated traffic and people on the
  real street network (off by default): why the road graph is compiled from OSM
  rather than read from the basemap, the lane graph, IDM car-following and
  junction reservations, signals and crossings, the budget, GPU interpolation,
  and the honesty rule — always labelled, never read.
- [`PLACE_NAMES.md`](PLACE_NAMES.md) — how a place is named in more than one
  language, why `places.name` stayed, and what that means for duplicate
  detection, search, the SDK contract and the OpenStreetMap re-import.

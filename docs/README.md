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
- [`MAP_NATIVE_3D.md`](MAP_NATIVE_3D.md) — how the native apps get the whole
  3D map from the same engine: three.js `WebGPURenderer` with TSL materials,
  `react-native-webgpu` on native, GoWay's engine drawing the base map on both
  platforms; the evidence, the measured phase 1 prototype and the phased plan.
- [`MAP_CAMERA_STUDIO.md`](MAP_CAMERA_STUDIO.md) — the route flyover and Camera
  Studio (off by default): the chase camera, centripetal path smoothing,
  per-gesture undo/redo, the versioned tour link, video export with the mark
  and the credit composited, and the flyover's vehicle as phase 1 of 3D models.
- [`MAP_PERFORMANCE.md`](MAP_PERFORMANCE.md) — the map's performance
  contract: laptop and phone budgets, the quality profile every layer reads
  (Low/Medium/High, Settings → Performance), GPU tier detection, dynamic
  resolution, the one animation clock (render on demand, idle pause), the perf
  HUD (`?perf=1`), the benchmark, the hotspots fixed and the CI frame-budget gate.
- [`MAP_FEATURES.md`](MAP_FEATURES.md) — the map-feature registry, the
  in-app settings modal (map, Labs layers, general, About with every credit)
  and the OSMF-compact data credit: how each optional feature's on/off is decided (kill
  switch, the person's choice on the device, defaults), Labs, what applies
  live, and the three-step recipe for registering a new feature.
- [`MAP_LANDMARKS.md`](MAP_LANDMARKS.md) — hand-crafted 3D landmarks (off by
  default): the reviewed registry and why it is data, not a table; the
  licence policy; procedural modelling and the GLB profile; replacing OSM
  buildings only while a model is drawn; night lighting; the landmark tour;
  how to add a landmark.
- [`MAP_TERRAIN_GLOBE.md`](MAP_TERRAIN_GLOBE.md) — the globe
  (space, a glow fitted to the limb), hillshade and 3D terrain: why Mapterhorn
  and why through GoWay's Worker, what self-hosting the DEM costs, how the 3D
  buildings stand on the terrain, and what native can and cannot draw.
- [`MAP_CITY_PLANET.md`](MAP_CITY_PLANET.md) — the 3D city tiles and the
  road graph for the whole world: regions sized to a hosted runner, which
  tiles each owns, dated archives in R2 chosen per tile by a manifest in the
  Worker, the CI workflow, what it measured and costs, and the owner's
  approval steps (nothing is published yet).
- [`MAP_CITY_LIFE.md`](MAP_CITY_LIFE.md) — simulated traffic and people on the
  real street network (off by default): why the road graph is compiled from OSM
  rather than read from the basemap, the lane graph, IDM car-following and
  junction reservations, signals and crossings, the budget, GPU interpolation,
  and the honesty rule — always labelled, never read.
- [`MAP_3D_SOURCES.md`](MAP_3D_SOURCES.md) — official building datasets
  (Spain, Barcelona, New York, and a world survey): licence verdicts against
  ODbL city tiles, how the Spanish Catastro's storeys replace the 5 m default
  (`height_source`), and how New York City's LOD1.5/LOD2 model is conflated
  with OSM, encoded, drawn and credited.
- [`MODEL_LIBRARY.md`](MODEL_LIBRARY.md) — the one set of 3D vehicles,
  vessels and people (Kenney CC0 kits + GoWay's own bus and airliner): the
  build, the asset profile, and the runtime API city life and GoWay Live share.
- [`MAP_LIVE.md`](MAP_LIVE.md) — GoWay Live: real aircraft, transit,
  bike-share and ships from open real-time feeds — which sources, under which
  licences (and which were rejected), the adapter/hub/socket architecture,
  honest motion and staleness, rate limits, cost, and what production needs.
  Off by default.
- [`PLACE_NAMES.md`](PLACE_NAMES.md) — how a place is named in more than one
  language, why `places.name` stayed, and what that means for duplicate
  detection, search, the SDK contract and the OpenStreetMap re-import.

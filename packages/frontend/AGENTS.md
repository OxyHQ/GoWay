# Frontend

Rules on top of the root `AGENTS.md`.

- Mercaria is read through `packages/frontend/lib/mercaria` over `@mercaria.co/sdk`; feature code never imports the SDK, and GoWay stores none of Mercaria's data. A place's `commerce.mercaria.store` only decides whether to ask; render only what Mercaria returns.
- 3D city tiles (`lib/map/cityTiles.ts`) are an internal format and an ODbL Derivative Database: draw only what OSM or a licence-reviewed official model records (storeys only from `building:levels`, roofs only from `roof:shape` or the model), credit a model while drawn, and publish the archive + receipt before serving them. Served per region by manifest (`map-service/src/city.js`); archive keys are dated, never overwritten. Notes: `docs/MAP_3D_CITY.md`, `docs/MAP_3D_SOURCES.md`, `docs/MAP_CITY_PLANET.md`.
- Imagery is only a source in `lib/map/imagerySources.ts` (licence allows hosting, re-serving, commercial display; never Google, Apple, Bing, Esri, Mapbox, Maxar, NC or scraped), served from GoWay's R2, credited while on screen. Note: `docs/MAP_SATELLITE.md`.
- Every 3D vehicle and vessel drawn comes from the model library (`engine/vehicles/`, CC0 only); never a second model set. Note: `docs/MODEL_LIBRARY.md`.
- Road rules: `resolveRoadAccess`, `decideAccess` only. Note: `docs/ROAD_RULES.md`.
- City life is SIMULATED traffic: labelled whenever drawn, never read by routing, ETAs or any feature (`cityLifeIsolation.test.ts`). Note: `docs/MAP_CITY_LIFE.md`.
- A basemap style is one `MAP_STYLES` entry (`lib/map/style/catalogue.ts`) and its recipe in `themes.ts`, drawn by the one layer list; never a hand-written style JSON or a second layer list. Note: `docs/MAP_STYLES.md`.
- An optional map feature is one `MAP_FEATURES` entry (`lib/map/mapFeatures.ts`), labelled in `mapFeatureLabels.ts`, read via `useMapFeature`; never a build variable or `lib/config.ts` flag (unserved yet: `offer: 'development'`). Its choice stays on the device. Note: `docs/MAP_FEATURES.md`.
- A map layer's budgets come from the `QualityProfile` (`lib/map/quality/profile.ts`) and it animates only through the map's animation clock; a new cost is a profile knob, never a budget of its own. Note: `docs/MAP_PERFORMANCE.md`.
- The map's eye never enters a building or the ground: every camera change goes through `engine/camera/clearance.ts` (eye raised, centre and bearing kept); never a second camera rule. Note: `docs/MAP_CAMERA_CLEARANCE.md`.
- A place photo is re-encoded on the device before upload (`features/explore/placePhoto.ts`), so its EXIF location is never published.

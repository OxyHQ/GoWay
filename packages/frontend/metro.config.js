// Shared Oxy Metro config (monorepo watch folders, block list, symlink +
// package-exports resolution, web-font/wasm asset exts, minifier, NativeWind).
// See @oxy.so/app-preset/metro.
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// maplibre-gl 6 starts its tile worker BY URL, not from the bundle; put the
// worker modules where `MapCanvas.web.tsx` points `setWorkerUrl` before Metro
// serves or exports `public/`. A side effect before the preset call — NOT a
// fork of it. See scripts/vendor-maplibre-worker.js.
require('./scripts/vendor-maplibre-worker').vendorMaplibreWorker();

// No `sharedTypesPackage`: the app reaches GoWay's contracts only through the
// built `@goway.to/sdk`, never the private `@goway/contracts` package directly.
// Development only: serve published city data from the same Metro origin,
// or local archives when `GOWAY_CITY_TILES_ARCHIVE` is set. Exports serve no middleware.
const { withDevCityTiles } = require('./scripts/dev-city-tiles');
const { withDevTerrain } = require('./scripts/dev-terrain');

module.exports = withDevTerrain(
  withDevCityTiles(
    createOxyMetroConfig(__dirname, {
      // The Python/CUDA worker is not a JS workspace. Watching its virtualenv
      // and vendor trees can stall Metro before it opens the development port.
      extraBlockList: [require('node:path').resolve(__dirname, '../reconstruction-worker')],
    }),
  ),
);

// Shared Oxy Metro config (monorepo watch folders, block list, symlink +
// package-exports resolution, web-font/wasm asset exts, minifier, NativeWind).
// See @oxy.so/app-preset/metro.
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// maplibre-gl 6 starts its tile worker BY URL, not from the bundle:
// `@goway.to/maps/metro` puts the installed worker where the map points it,
// in `public/`, before Metro serves or exports it. A wrapper around the
// preset's config — NOT a fork of it.
const { withGoWayMaps } = require('@goway.to/maps/metro');

// No `sharedTypesPackage`: the app reaches GoWay's contracts only through the
// built `@goway.to/sdk`, never the private `@goway/contracts` package directly.
// Development only: serve published city data from the same Metro origin,
// or local archives when `GOWAY_CITY_TILES_ARCHIVE` is set. Exports serve no middleware.
const { withDevCityTiles } = require('./scripts/dev-city-tiles');
const { withDevTerrain } = require('./scripts/dev-terrain');

module.exports = withDevTerrain(
  withDevCityTiles(
    withGoWayMaps(
      createOxyMetroConfig(__dirname, {
        // The Python/CUDA worker is not a JS workspace. Watching its virtualenv
        // and vendor trees can stall Metro before it opens the development port.
        extraBlockList: [require('node:path').resolve(__dirname, '../reconstruction-worker')],
      }),
    ),
  ),
);

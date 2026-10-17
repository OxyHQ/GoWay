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
// Development only, and only with `GOWAY_CITY_TILES_ARCHIVE` set: serve a
// locally compiled city-tile archive at `/map/city/*` (see the file). Unset —
// every export and CI run — the preset's config is returned untouched.
const { withDevCityTiles } = require('./scripts/dev-city-tiles');

module.exports = withDevCityTiles(withGoWayMaps(createOxyMetroConfig(__dirname)));

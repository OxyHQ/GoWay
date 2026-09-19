// Shared Oxy Metro config (monorepo watch folders, block list, symlink +
// package-exports resolution, web-font/wasm asset exts, minifier, NativeWind).
// See @oxy.so/app-preset/metro.
const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');

// maplibre-gl 6 starts its tile worker BY URL, not from the bundle; put the
// worker modules where `MapCanvas.web.tsx` points `setWorkerUrl` before Metro
// serves or exports `public/`. A side effect before the preset call — NOT a
// fork of it. See scripts/vendor-maplibre-worker.js.
require('./scripts/vendor-maplibre-worker').vendorMaplibreWorker();

module.exports = createOxyMetroConfig(__dirname, {
  sharedTypesPackage: '@goway/shared-types',
});

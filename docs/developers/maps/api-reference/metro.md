# `@goway.to/maps/metro` and the config plugin

Build-time helpers. Both are CommonJS, for `metro.config.js` and `app.config.js`.

## `@goway.to/maps/metro`

| Export | Signature | What it does |
| --- | --- | --- |
| `withGoWayMaps` | `(config, options?: { projectRoot?: string }) => config` | copies the worker (below) for `projectRoot` (default: the config's own, else the working directory) and returns the Metro config unchanged |
| `vendorMaplibreWorker` | `(projectRoot: string) => string` | writes the installed `maplibre-gl`'s worker modules to `<projectRoot>/public/vendor/maplibre-gl/<version>/`, removes other versions' folders there, and returns the folder |
| `WORKER_FILES` | `['maplibre-gl-worker.mjs', 'maplibre-gl-shared.mjs']` | the files copied, from `maplibre-gl/dist/` |

`MapView` on the web loads its worker from `/vendor/maplibre-gl/<version>/maplibre-gl-worker.mjs` on the page's origin, keyed by the installed version, so the worker always matches the main thread. Files are rewritten only when their bytes differ. Add `public/vendor/` to `.gitignore`.

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withGoWayMaps } = require('@goway.to/maps/metro');

module.exports = withGoWayMaps(getDefaultConfig(__dirname));
```

## The Expo config plugin

`plugins: ['@goway.to/maps']` in `app.config.js` (resolved through `@goway.to/maps/app.plugin.js`) applies MapLibre React Native's config plugin and forwards any options to it. Native builds need it; MapLibre Native is not in Expo Go, so make a development or store build after adding it.

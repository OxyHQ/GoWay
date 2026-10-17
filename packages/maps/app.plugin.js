/**
 * `@goway.to/maps` Expo config plugin: adds MapLibre Native to a development
 * or store build (it is absent from Expo Go).
 *
 *     // app.config.js
 *     plugins: ['@goway.to/maps']
 *
 * It applies `@maplibre/maplibre-react-native`'s own plugin, so an app names
 * one map package in its config, as with `@rnmapbox/maps`. The location usage
 * strings stay the app's (`expo-location`'s plugin): only the app knows why it
 * asks.
 */
// The package exports its plugin as an ES module's default.
const loaded = require('@maplibre/maplibre-react-native/app.plugin.js');
const maplibre = typeof loaded === 'function' ? loaded : loaded.default;

module.exports = function withGoWayMaps(config, options = {}) {
  return maplibre(config, options);
};

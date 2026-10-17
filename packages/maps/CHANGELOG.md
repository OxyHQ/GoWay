# Changelog

All notable changes to `@goway.to/maps`. Semantic versioning with the 0.x rule:
while the major version is 0, a MINOR release may break the API.

## 0.1.0

The first release: GoWay's map as an SDK, with GoWay's own app as its first
consumer.

- `MapView` on MapLibre GL JS (web) and MapLibre Native (iOS, Android), in GoWay
  styles named `goway://styles/<id>` that follow the Bloom theme's light;
  `initialViewState`, a `camera` target applied by value, `projection`,
  `light`, `interaction`, `credits`, and `onPress` (with the basemap label
  under it), `onCameraChanged` (with who moved the camera), `onLabelsChange`,
  `onReady`, `onError`. The GoWay mark and the data credit on every map.
- `Markers` — Bloom's price pill and cluster bubble, clustered with Mapbox's
  source options; `selectedId`, visited state, `renderMarker`.
- `GeoJSONSource`, `RasterDEMSource`, `Layer` — sources and layers by props.
- `UserLocation` and `useUserLocation()` — Bloom's location puck, never a
  prompt on mount.
- `MapPlugin` — attach an engine plugin (web) through props.
- `useMap()`; `@goway.to/maps/plugin`, `/testing`, `/brand`, `/metro` and the
  Expo config plugin.

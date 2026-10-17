# Changelog

All notable changes to `@goway.to/maps`. Semantic versioning with the 0.x rule:
while the major version is 0, a MINOR release may break the API.

## 0.1.2

- The map resolves its style through `@goway.to/sdk/map`, which has no HTTP
  client and no zod, instead of the SDK's root entry. A web app no longer
  bundles GoWay's whole contract to draw a map: in Homiio that was about
  170 KB of gzipped JavaScript. Needs `@goway.to/sdk` 0.7.0.

## 0.1.1

- A `MapView` given a `height` keeps it. The root was `flex: 1`, a zero flex
  basis on both platforms, which overrode the caller's height: a map inside a
  scroll view (an address picker in a form) rendered 0 tall. It now grows from
  its own size, so it still fills a bounded parent when given no size.
- The GoWay mark has an accessible name on the web. `react-native-svg` hands
  its props to the DOM `<svg>` unchanged, so the logo's React Native
  accessibility props landed there as unknown attributes — no name in a
  browser, and a React warning about `accessible` on every map. The web now
  gets `role="img"` and `aria-label`; iOS and Android are unchanged.

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

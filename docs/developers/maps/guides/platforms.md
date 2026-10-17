# Platform differences

`@goway.to/maps` has one API on every platform. The web build runs on MapLibre GL JS and the iOS and Android builds on MapLibre Native; your bundler picks the right one (the `browser` export condition selects the web build). These are the differences.

| Feature | Web | iOS and Android |
| --- | --- | --- |
| `MapView`, `Markers`, `GeoJSONSource`, `Layer`, `RasterDEMSource`, `UserLocation` | yes | yes |
| `camera`, `initialViewState`, the ref's camera methods | yes | yes |
| `onPress` with basemap labels, `onLabelsChange`, `onCameraChanged` | yes | yes |
| `projection="globe"` | yes | ignored (Mercator) |
| `MapPlugin` (engine plugins) | yes | renders nothing |
| `MapViewRef.captureFrames` | yes | absent |
| `MapCameraOptions.fieldOfView` | yes | ignored |
| `pixelRatio`, `antialias` | yes | ignored |
| Setup | serve MapLibre's worker ([Web setup](../README.md#web)) | config plugin and a development or store build |

Markers are React Native views on native and DOM nodes on the web, and in both cases the same Bloom components, so they look the same everywhere.

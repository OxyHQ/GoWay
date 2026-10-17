# `@goway.to/maps`

GoWay's maps SDK for React and React Native: one declarative map for the web
(MapLibre GL JS) and iOS/Android (MapLibre Native), drawn in GoWay's styles.

```bash
bun add @goway.to/maps @goway.to/sdk maplibre-gl @maplibre/maplibre-react-native
```

```tsx
import { MapView, Markers, UserLocation, type MapViewRef } from '@goway.to/maps';

<MapView
  ref={mapRef}
  mapStyle="goway://styles/standard"      // the default; day in light mode, night in dark
  camera={{ bounds: searchedArea }}        // framed whenever its VALUE changes
  onCameraChanged={({ bounds, source, isFinal }) => …}
  onPress={({ coordinate, label }) => …}
>
  <Markers data={homes} selectedId={selected} cluster onPress={(home) => …} />
  <UserLocation />
</MapView>
```

- **Markers** are Bloom's (`@oxy.so/bloom/map-marker`) on both platforms, and
  cluster with Mapbox's source options (`cluster`, `clusterRadius`,
  `clusterMaxZoom`).
- **The camera** opens on `initialViewState` and follows `camera` by value, so
  a re-render never moves it under a reader who has panned; the ref
  (`fitBounds`, `moveTo`, …) is for event handlers.
- **User location** is drawn only against a permission already granted;
  `useUserLocation()` asks, from a tap.
- Every map carries the GoWay mark and the data credit, with no prop to turn
  either off.

## Setup

- **Native**: add the config plugin (`plugins: ['@goway.to/maps']` in
  `app.config.js`) and make a development or store build — MapLibre Native is
  not in Expo Go.
- **Web with Metro (Expo)**: wrap the Metro config, which serves MapLibre's
  worker from your origin (`maplibre-gl` 6 starts it by URL), and gitignore
  `public/vendor/`:

  ```js
  const { withGoWayMaps } = require('@goway.to/maps/metro');
  module.exports = withGoWayMaps(getDefaultConfig(__dirname));
  ```

- Render inside Bloom's `BloomProvider`: the map follows its theme and locale.

## Entry points

| import | what |
| --- | --- |
| `@goway.to/maps` | `MapView`, `Markers`, `GeoJSONSource`, `RasterDEMSource`, `Layer`, `UserLocation`, `MapPlugin`, `useMap`, `useUserLocation` |
| `@goway.to/maps/plugin` | the engine-plugin protocol and the guards every coordinate crossing into an engine goes through (no React) |
| `@goway.to/maps/testing` | a fake engine that drives the map's real camera reports, for testing a screen's camera logic |
| `@goway.to/maps/brand` | the GoWay mark as geometry |
| `@goway.to/maps/metro`, `@goway.to/maps/app.plugin.js` | the Metro helper and the Expo config plugin |

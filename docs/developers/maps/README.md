# GoWay Maps SDK

`@goway.to/maps` is GoWay's map for React and React Native. One declarative `MapView` runs on MapLibre GL JS in the browser and MapLibre Native on iOS and Android. It draws GoWay's own map styles and follows your app's Bloom theme.

```tsx
import { MapView, Markers } from '@goway.to/maps';

export function Homes({ homes, area }) {
  return (
    <MapView style={{ height: 320 }} camera={{ bounds: area }}>
      <Markers data={homes} cluster />
    </MapView>
  );
}
```

The same code renders on the web and on native. Markers are Bloom components (`@oxy.so/bloom/map-marker`) on every platform. The camera is a value you pass, not a command you issue.

## Install

```bash
bun add @goway.to/maps @goway.to/sdk maplibre-gl @maplibre/maplibre-react-native
```

| Peer dependency | Version | Why |
| --- | --- | --- |
| `react`, `react-dom` | `>=19` | |
| `react-native` | `>=0.80` | New Architecture (MapLibre Native requires it) |
| `@oxy.so/bloom` | `>=10.16` | markers, location puck, theme, locale |
| `@goway.to/sdk` | `>=0.7.0` | style names and geometry (`/map` and `/geo` only) |
| `maplibre-gl` | `>=6.10` | the web engine |
| `@maplibre/maplibre-react-native` | `>=11.4` | the native engine (optional on web-only apps) |
| `react-native-reanimated` | `>=4` | credit and chrome animation |
| `react-native-svg` | `>=15` | the GoWay mark |
| `expo-location` | any | `UserLocation` and `useUserLocation` |

## Set up

### Render inside Bloom

`MapView` reads Bloom's theme (to pick the day or night light) and locale (for its credit), so render it under Bloom's `BloomProvider` (`@oxy.so/bloom/provider`).

### iOS and Android

Add the config plugin and make a development or store build. MapLibre Native is not in Expo Go.

```js
// app.config.js
export default {
  expo: {
    plugins: ['@goway.to/maps'],
  },
};
```

The plugin applies MapLibre React Native's own config plugin; options you pass are forwarded to it.

### Web

MapLibre GL JS 6 starts its tile worker by URL. `MapView` points that URL at `/vendor/maplibre-gl/<version>/maplibre-gl-worker.mjs` on your own origin, so your app must serve the installed `maplibre-gl`'s worker modules there.

With Metro (Expo), wrap your config. It copies the worker into `public/` before Metro serves or exports it:

```js
// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');
const { withGoWayMaps } = require('@goway.to/maps/metro');

module.exports = withGoWayMaps(getDefaultConfig(__dirname));
```

With another bundler, call `vendorMaplibreWorker(projectRoot)` from `@goway.to/maps/metro` in your build (it writes to `<projectRoot>/public/vendor/maplibre-gl/<version>/`), or copy `maplibre-gl-worker.mjs` and `maplibre-gl-shared.mjs` from `maplibre-gl/dist/` to that path yourself.

Either way, `public/vendor/` is a copy of an installed dependency: add it to `.gitignore`.

## Guides

- [Map view](guides/map-view.md): sizing, styles and the theme, interaction, the degraded state.
- [Camera](guides/camera.md): the opening view, a camera target by value, and the imperative handle.
- [Events](guides/events.md): presses, basemap labels, camera changes and who caused them.
- [Markers and clusters](guides/markers.md): `Markers`, selection, visited markers, custom bodies.
- [Sources and layers](guides/sources-and-layers.md): your own GeoJSON lines and fills, hillshade.
- [User location](guides/user-location.md): the puck, and asking for permission from a tap.
- [Attribution and brand](guides/attribution-and-brand.md): the credit and the GoWay mark, and laying chrome around them.
- [Engine plugins](guides/plugins.md): web-only extensions with a lifecycle.
- [Testing](guides/testing.md): driving the map's real camera reports in a unit test.
- [Platform differences](guides/platforms.md): what is web-only.

## Examples

See the [examples index](examples/README.md). Each one is a complete component you can paste.

## API reference

- [`@goway.to/maps`](api-reference/index.md): components, hooks, types and constants.
- [`@goway.to/maps/plugin`](api-reference/plugin.md): the engine-plugin protocol and its guards.
- [`@goway.to/maps/testing`](api-reference/testing.md): a fake engine for camera tests.
- [`@goway.to/maps/brand`](api-reference/brand.md): the GoWay mark as geometry.
- [`@goway.to/maps/metro` and the config plugin](api-reference/metro.md).

## Migrating

- [From `react-native-maps`](migrate/from-react-native-maps.md)
- [From MapLibre directly](migrate/from-maplibre.md)
- [From Mapbox](migrate/from-mapbox.md)

## Related

- [Map styles and tiles](../styles/README.md): the styles `MapView` draws, and how to use them without this SDK.
- [GoWay SDK](../sdk/README.md): places, search, geocoding and routing to put on the map.

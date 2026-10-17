# `@goway.to/maps`

GoWay's maps SDK for React and React Native. One declarative map on MapLibre GL JS (web) and MapLibre Native (iOS, Android), drawn in GoWay's styles and the app's Bloom theme, with Bloom markers and clustering, a camera you pass by value, and user location that never prompts on its own.

```bash
bun add @goway.to/maps @goway.to/sdk maplibre-gl @maplibre/maplibre-react-native
```

```tsx
import { MapView, Markers, UserLocation, type GeoBoundingBox, type MapMarkerData } from '@goway.to/maps';

export function Homes({ homes, area }: { homes: MapMarkerData[]; area: GeoBoundingBox }) {
  return (
    <MapView camera={{ bounds: area }}>
      <Markers data={homes} cluster />
      <UserLocation />
    </MapView>
  );
}
```

Setup:

- **iOS and Android:** add `plugins: ['@goway.to/maps']` to `app.config.js` and make a development or store build. MapLibre Native is not in Expo Go.
- **Web with Metro:** wrap the config with `withGoWayMaps` from `@goway.to/maps/metro`, and gitignore `public/vendor/`.
- **Everywhere:** render inside Bloom's `BloomProvider`.

| Import | What |
| --- | --- |
| `@goway.to/maps` | `MapView`, `Markers`, `GeoJSONSource`, `RasterDEMSource`, `Layer`, `UserLocation`, `MapPlugin`, `useMap`, `useUserLocation`, types |
| `@goway.to/maps/plugin` | the engine-plugin protocol and the engine guards (no React) |
| `@goway.to/maps/testing` | a fake engine that drives the map's real camera reports |
| `@goway.to/maps/brand` | the GoWay mark as geometry |
| `@goway.to/maps/metro`, `@goway.to/maps/app.plugin.js` | the Metro helper and the Expo config plugin |

## Documentation

- [Overview and setup](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/maps/README.md)
- [Guides](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/maps/README.md#guides): map view, camera, events, markers, sources and layers, user location, attribution, plugins, testing
- [Examples](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/maps/examples/README.md)
- [API reference](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/maps/api-reference/index.md)
- [Migrating from react-native-maps, MapLibre or Mapbox](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/maps/README.md#migrating)

## License

See `LICENSE` and `NOTICE`.

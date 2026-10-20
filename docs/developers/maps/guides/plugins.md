# Engine plugins

An engine plugin is how you extend the web map beyond sources, layers and markers: a three.js custom layer, terrain, a camera rule. It is an object with a lifecycle that receives the live `maplibre-gl` map. `<MapPlugin>` is the one place it is bound to the engine: it attaches the plugin when the engine is ready, passes new `props` through `update`, and detaches it when the component unmounts or the engine is rebuilt (for example on a style change).

Plugins are web-only. On iOS and Android `<MapPlugin>` renders nothing, because MapLibre Native has no custom-layer API.

```tsx
import { MapPlugin, MapView } from '@goway.to/maps';
import type { MapPlugin as EnginePlugin } from '@goway.to/maps/plugin';

const fog: EnginePlugin<{ density: number }> = {
  attach(map, props) {
    const apply = (density: number) => map.setSky({ 'fog-color': '#dfe6ee', 'horizon-fog-blend': density });
    apply(props.density);
    return {
      update: (next) => apply(next.density),
      detach: () => map.setSky({}),
    };
  },
};

<MapView>
  <MapPlugin plugin={fog} props={{ density: 0.4 }} />
</MapView>;
```

Define the plugin object once (at module scope), and pass what changes as `props`.

## The protocol

`attach(map, props, host)` receives the `maplibre-gl` `Map`, the first props, and a host with the `container` element the engine draws into. It returns a handle:

| Handle member | When it is called |
| --- | --- |
| `update?(props)` | new `props` for an attached plugin |
| `detach()` | undo everything `attach` did |
| `press?(point)` | a press at a screen point, after the markers and before the basemap labels; return `true` to take it (no label is resolved and `onPress` does not fire) |
| `hover?(point)` | whether the pointer is over something the plugin draws (the cursor shows it) |
| `ownsError?(error)` | whether a source error is the plugin's to handle (a decorative source that may 404) rather than the map's degraded state |

A `MapSourceError` has `sourceId`, and `status` and `message` when known.

## Guards for engine code

`@goway.to/maps/plugin` has no React and no React Native, so engine modules and their tests can import it. Besides the types it exports the guards the SDK runs every value through before it reaches an engine:

| Export | Use |
| --- | --- |
| `toLngLat(coordinate)` | `{ latitude, longitude }` to MapLibre's `[lng, lat]` |
| `isDrawableCoordinate(value)` | finite, latitude within ±90 |
| `isDrawableBounds(bounds)` | both corners drawable |
| `isDrawableGeoJSON(data)` | every coordinate in a GeoJSON value drawable |
| `asFinite(value)` | the number if finite, else `undefined` |
| `optionalScalar(key, value)` | `{ [key]: value }` if finite, else `{}`, for spreading into engine options |
| `runEngineCommand(name, run)` | run one engine call; a throw drops the command with one warning instead of crashing the app. Returns whether it ran |
| `reportMapDefect(key, message)` | one `console.warn` per key |

## Marking your camera moves

Camera moves your plugin makes are reported to `onCameraChanged` as `user` unless they say otherwise. Pass `PROGRAMMATIC` as the event data of a MapLibre camera call to have it reported as `programmatic`, and `PROGRAMMATIC_TRANSIENT` for one frame of an animation you drive (reported as in progress, never settled):

```ts
import { PROGRAMMATIC, PROGRAMMATIC_TRANSIENT } from '@goway.to/maps/plugin';

map.easeTo({ center: [2.17, 41.39], zoom: 15 }, PROGRAMMATIC);
map.jumpTo({ bearing: frameBearing }, PROGRAMMATIC_TRANSIENT);
```

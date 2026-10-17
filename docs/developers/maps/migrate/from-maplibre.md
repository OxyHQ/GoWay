# Migrate from MapLibre directly

If you drive `maplibre-gl` or `@maplibre/maplibre-react-native` yourself, `@goway.to/maps` is the same engines behind one declarative API that runs on web and native from one tree. What changes is who calls the engine: you pass props, and the SDK binds them.

## From MapLibre GL JS

| `maplibre-gl` | `@goway.to/maps` |
| --- | --- |
| `new maplibregl.Map({ container, style, center, zoom })` | `<MapView mapStyle initialViewState>` |
| `map.setStyle(url)` | change `mapStyle`; the camera stays |
| `map.flyTo`, `easeTo`, `jumpTo` | `camera` (state-driven) or `ref.moveTo` (event-driven) |
| `map.fitBounds([[w, s], [e, n]], { padding })` | `camera={{ bounds: { west, south, east, north }, padding }}` or `ref.fitBounds` |
| `map.on('click', …)` | `onPress` |
| `map.on('move' \| 'moveend', …)` | `onCameraChanged` (`isFinal`), with who moved it |
| `map.addSource('id', { type: 'geojson', data })` | `<GeoJSONSource id data>` |
| `source.setData(data)` | a new `data` prop |
| `map.addLayer({ id, type, paint, layout, filter }, beforeId)` | `<Layer id type paint layout filter beforeId>` inside the source |
| `map.setPaintProperty`, `setLayoutProperty`, `setFilter` | new `paint`, `layout`, `filter` props |
| `new maplibregl.Marker({ element })` | `<Markers data>` (Bloom markers), or `renderMarker` for your own body |
| a custom layer, terrain, `map.on('render')` | an [engine plugin](../guides/plugins.md) via `<MapPlugin>` |
| `maplibregl.setWorkerUrl` | done for you; serve the worker with `withGoWayMaps` or `vendorMaplibreWorker` |
| `AttributionControl` | the credit is always drawn; add yours with `credits` |

Coordinates are `{ latitude, longitude }` and boxes `{ west, south, east, north }` everywhere except inside GeoJSON. A box with `west > east` crosses the antimeridian and is framed correctly.

Anything you still need the raw `maplibregl.Map` for goes in an engine plugin, which receives it in `attach` and is torn down for you when the map rebuilds.

## From MapLibre React Native

`@goway.to/maps` uses MapLibre React Native v11 on iOS and Android. Its native components map as follows:

| `@maplibre/maplibre-react-native` | `@goway.to/maps` |
| --- | --- |
| `<Map mapStyle>` | `<MapView mapStyle>` |
| `<Camera>` (`initialViewState`, stops) | `initialViewState` and `camera` on `MapView` |
| `<GeoJSONSource>`, `<Layer>` | `<GeoJSONSource>`, `<Layer>` (props by style-spec name) |
| `<Marker>` | `<Markers data>` |
| `<UserLocation>` | `<UserLocation />` |

The same component tree then also runs on the web.

# `@goway.to/maps/plugin` API reference

The engine-plugin protocol, and the guards the SDK runs every value through before it reaches an engine. This entry has no React and no React Native, so engine modules and their tests can import it. See [Engine plugins](../guides/plugins.md) for how to use it.

## Protocol

| Type | Shape |
| --- | --- |
| `MapPlugin<Props>` | `{ attach(map: maplibregl.Map, props: Props, host: MapPluginHost): MapPluginHandle<Props> }` |
| `MapPluginHost` | `{ container: HTMLElement }`: the element the engine draws into |
| `MapPluginHandle<Props>` | `{ update?(props); detach(); press?(point): boolean; hover?(point): boolean; ownsError?(error: MapSourceError): boolean }` |
| `MapPluginProps<Props>` | `{ plugin: MapPlugin<Props>; props: Props }`: the props of the `<MapPlugin>` component |
| `MapSourceError` | `{ sourceId: string; status?: number; message?: string }` |

`point` is a screen point `{ x, y }` in px.

The `MapPlugin` exported here is the protocol type. The component of the same name is exported from [`@goway.to/maps`](index.md#mapplugin).

## Guards

| Export | Signature | What it does |
| --- | --- | --- |
| `toLngLat` | `(coordinate: GeoCoordinate) => [longitude, latitude]` | to MapLibre's positional order |
| `isDrawableCoordinate` | `(value: unknown) => value is GeoCoordinate` | finite numbers, latitude within ±90 |
| `isDrawableBounds` | `(bounds) => bounds is GeoBoundingBox` | both corners drawable |
| `isDrawableGeoJSON` | `(data) => boolean` | every coordinate in the GeoJSON value drawable |
| `asFinite` | `(value: number \| null \| undefined) => number \| undefined` | the number when finite |
| `optionalScalar` | `(key, value) => { [key]: number } \| {}` | for spreading a finite option into engine options |
| `runEngineCommand` | `(command: string, run: () => void) => boolean` | runs one engine call; a throw drops it with one warning; returns whether it ran |
| `reportMapDefect` | `(key: string, message: string) => void` | one `console.warn` (prefixed `[goway/maps]`) per key |

## Move markers

Event data for MapLibre camera calls, so `onCameraChanged` reports who moved the camera.

| Export | Value | Reported as |
| --- | --- | --- |
| `PROGRAMMATIC` | `{ gowayProgrammatic: true }` | `source: 'programmatic'` |
| `PROGRAMMATIC_TRANSIENT` | `{ gowayProgrammatic: true, gowayTransient: true }` | `programmatic`, and never as a settled frame |

```ts
map.easeTo({ zoom: 15 }, PROGRAMMATIC);
```

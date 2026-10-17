# Sources and layers

For things markers are the wrong tool for (a route line, a shaded area, thousands of dots, relief), add your own MapLibre source and draw it with layers. `GeoJSONSource` and `RasterDEMSource` are sources; `Layer` draws the source it is rendered inside.

```tsx
import { GeoJSONSource, Layer, MapView } from '@goway.to/maps';

const route: GeoJSON.Feature<GeoJSON.LineString> = {
  type: 'Feature',
  properties: {},
  geometry: {
    type: 'LineString',
    coordinates: [
      [2.1686, 41.3874],
      [2.1734, 41.3851],
      [2.1801, 41.3917],
    ],
  },
};

<MapView>
  <GeoJSONSource id="route" data={route}>
    <Layer id="route-line" type="line" paint={{ 'line-color': '#1a73e8', 'line-width': 5 }} layout={{ 'line-cap': 'round' }} />
  </GeoJSONSource>
</MapView>;
```

GeoJSON itself is positional (`[longitude, latitude]`), because that is the GeoJSON format. Everywhere else the SDK uses `{ latitude, longitude }`.

## `GeoJSONSource`

| Prop | Meaning |
| --- | --- |
| `id` | the source id, unique on the map |
| `data` | any GeoJSON: a geometry, a `Feature` or a `FeatureCollection` |
| `cluster`, `clusterRadius`, `clusterMaxZoom`, `clusterMinPoints`, `clusterProperties` | MapLibre's own source clustering, for GL-drawn layers |
| `children` | the `Layer`s that draw it |

New `data` is pushed into the existing source, so its layers stay. Data that is not drawable GeoJSON (a non-finite coordinate, a latitude outside ±90) is replaced with an empty collection, with one console warning, rather than failing silently inside the engine.

On the web, MapLibre takes the clustering options only when a source is created. To change them, give the source a new `key`.

Clustering here is GL clustering: features get `cluster`, `point_count` and `cluster_id` properties for your layers to style. For clusters drawn as Bloom bubbles, use [`Markers`](markers.md) instead.

## `Layer`

| Prop | Meaning |
| --- | --- |
| `id` | the layer id, unique on the map |
| `type` | `line`, `fill`, `circle`, `symbol`, `fill-extrusion` or `hillshade` |
| `paint`, `layout` | style-spec paint and layout properties, as in a MapLibre style |
| `filter` | a style-spec filter expression |
| `beforeId` | draw under this layer of the style (for example under the labels); absent, on top |
| `minzoom`, `maxzoom` | the zoom range it draws in |

A `Layer` must be rendered inside a source; outside one it throws. Changing `paint`, `layout` or `filter` updates the layer in place. A property you remove goes back to the style default.

To put a layer under the basemap's labels, pass `beforeId="goway:anchor:labels"`: every GoWay style document has that layer, between the basemap and the labels. Other layer ids are listed in each document's metadata (see [Map styles and tiles](../../styles/README.md#style-documents)).

## `RasterDEMSource`

An elevation source for a `hillshade` layer.

```tsx
import { Layer, MapView, RasterDEMSource } from '@goway.to/maps';

<MapView>
  <RasterDEMSource id="dem" tiles={[demTileUrl]} encoding="terrarium" tileSize={256} maxzoom={12}>
    <Layer id="hillshade" type="hillshade" paint={{ 'hillshade-exaggeration': 0.4 }} />
  </RasterDEMSource>
</MapView>;
```

| Prop | Meaning |
| --- | --- |
| `id` | the source id |
| `tiles` | tile URL templates (`{z}/{x}/{y}`) |
| `encoding` | `mapbox` or `terrarium` |
| `tileSize`, `minzoom`, `maxzoom` | as in the style spec |

## Ids

Source and layer ids share a namespace with the style's own sources and layers. Prefix yours (`app-route`, `app-route-line`) to stay clear of the style's.

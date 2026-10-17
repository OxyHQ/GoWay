# Map styles

A GoWay style is a complete MapLibre style document (style spec version 8) that GoWay publishes at a stable URL on `https://goway.to`. Each one names GoWay's vector tiles, glyphs and sprite, all served from the same origin, so any MapLibre renderer can draw a GoWay map from the URL alone. This page lists the styles, explains how a style and a light combine into one document, and shows how to load a style with or without the GoWay SDK.

## Styles and lights

Every style is drawn in one or more **lights**: `day`, `dawn`, `dusk` or `night`. A style and a light together select exactly one document.

Some styles **follow** the light: they are published in several lights, and a map can switch between them as the time of day changes. Others keep a **fixed** light: they are published in one light only and ignore the one you ask for.

| Style id | Lights published | Default light | Light | Notes |
| --- | --- | --- | --- | --- |
| `standard` | `day`, `dawn`, `dusk`, `night` | `day` | follows | The default style. |
| `streets` | `day`, `night` | `day` | follows | |
| `outdoors` | `day`, `night` | `day` | follows | Carries its own hillshade and contour lines (see [Tiles](guides/tiles.md#elevation-tiles)). |
| `navigation` | `day`, `night` | `day` | follows | |
| `monochrome` | `day`, `night` | `day` | follows | |
| `light` | `day` | `day` | fixed | A muted basemap for data overlays. |
| `dark` | `night` | `night` | fixed | A muted basemap for data overlays. |

The default style is `standard`. The first light listed for a style is its default.

The catalogue also names two imagery styles, `satellite` and `hybrid` (fixed, `day` only). They are not offered yet: `index.json` leaves them out and their imagery is not published, so do not build on them.

## Style documents

Each published (style, light) pair is served at:

```text
https://goway.to/map/styles/<style>/<light>.json
```

For example, `https://goway.to/map/styles/standard/day.json` or `https://goway.to/map/styles/streets/night.json`. A pair the table above does not list (for example `streets/dawn`) has no document.

Every document:

- has one vector source, `openmaptiles`, pointing at the TileJSON `https://goway.to/map/tiles.json` (the `outdoors` documents add `goway-terrain` and `goway-contours`);
- uses the glyphs at `https://goway.to/map/fonts/{fontstack}/{range}.pbf` and the sprite at `https://goway.to/map/sprites/goway`;
- carries the data credit in each source's `attribution`, which MapLibre's attribution control shows;
- records what it is in `metadata`: `goway:style`, `goway:light`, `goway:appearance` (`light` or `dark`), `goway:schema` (`openmaptiles-v3`) and `goway:anchor:beforeLabels` (the layer id to insert your own layers before; see [Using styles](guides/using-styles.md#add-your-own-layer-under-the-labels)).

Every document draws its layers from one fixed list of layer ids, in one fixed order, recorded in its `goway:layers` metadata. The lights of a style differ only in paint and layout values. Different styles may leave out layers they do not draw (`light` and `dark` have no point-of-interest layers, and only `outdoors` has `hillshade` and the contour layers), but no style renames or reorders a layer. Every document contains the anchor layer `goway:anchor:labels`, which sits between the basemap and the labels.

The documents are served with `Access-Control-Allow-Origin: *` and `Cross-Origin-Resource-Policy: cross-origin`, so any web page can load them, and with `Cache-Control: public, max-age=300, must-revalidate`. The URLs are not versioned: a cartography update reaches clients within about five minutes.

Two older URLs are still published as exact copies, for clients built before the catalogue existed: `https://goway.to/map/goway-light.json` (`standard` in `day`) and `https://goway.to/map/goway-dark.json` (`standard` in `night`). New code should use the catalogue URLs.

### The catalogue document

`https://goway.to/map/styles/index.json` lists every offered style with its lights and the absolute URL of each document:

```json
{
  "v": 1,
  "default": "standard",
  "styles": [
    {
      "id": "streets",
      "light": "follows",
      "presets": ["day", "night"],
      "defaultPreset": "day",
      "urls": {
        "day": "https://goway.to/map/styles/streets/day.json",
        "night": "https://goway.to/map/styles/streets/night.json"
      }
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `v` | Format version, `1`. |
| `default` | The id of the default style. |
| `styles[].id` | The style id. |
| `styles[].light` | `follows` or `fixed`. |
| `styles[].presets` | The lights the style is published in; the first is its default. |
| `styles[].defaultPreset` | The style's default light. |
| `styles[].urls` | The document URL for each light, keyed by light. |

Read this document as open-ended: a future style or light may appear in it. If your code only knows some style ids, ignore the ones it does not recognise rather than failing.

## Style names: `goway://styles/<id>`

GoWay names a style independently of where its documents live:

```text
goway://styles/<id>
goway://styles/<id>?light=<light>
```

`goway://styles/outdoors` means "Outdoors, in whatever light the map is using"; `goway://styles/outdoors?light=night` pins it to night. The only query parameter is `light`. A name with an unknown style id, an unknown light or any other parameter is invalid and is rejected rather than replaced by a different style.

A `goway://` name is not a URL MapLibre can load. `@goway.to/maps` accepts these names directly, and `@goway.to/sdk/map` turns one into a document URL with `styleDocumentUrl`. Without either package, use the document URLs above.

## How a light is resolved

When you ask for a style in a light it is not published in, GoWay picks the nearest light it has. The SDK's `resolveMapStyle` and `styleDocumentUrl` apply these rules, in order:

1. No light asked for: the style's default light.
2. The style is published in that light: that light.
3. The style is published in a single light (`light`, `dark`): that light, whatever was asked.
4. `dawn` asked for: `day`. `dusk` asked for: `night`. (The sun is up at dawn and has set at dusk.)
5. Anything else: the style's default light.

| Asked for | `standard` | `streets`, `outdoors`, `navigation`, `monochrome` | `light` | `dark` |
| --- | --- | --- | --- | --- |
| nothing | `day` | `day` | `day` | `night` |
| `day` | `day` | `day` | `day` | `night` |
| `dawn` | `dawn` | `day` | `day` | `night` |
| `dusk` | `dusk` | `night` | `day` | `night` |
| `night` | `night` | `night` | `day` | `night` |

`resolveMapStyle` also takes an explicit "is the sun up" flag, so a caller that knows the real sun position can draw twilight as day or night itself.

## Use a style without the SDK

A style URL is all MapLibre needs.

### MapLibre GL JS

```ts
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';

const map = new maplibregl.Map({
  container: 'map', // the id of a sized <div>
  style: 'https://goway.to/map/styles/standard/day.json',
  // MapLibre takes [longitude, latitude].
  center: [2.1734, 41.3851],
  zoom: 13,
});
```

Keep MapLibre's attribution control enabled: it shows the credit each style source carries.

To switch light later, load the other document with `map.setStyle('https://goway.to/map/styles/standard/night.json')`. Sources and layers you added are dropped by `setStyle`, so add them again on `style.load`; a `beforeId` of `goway:anchor:labels` is valid in every document.

### MapLibre Native

MapLibre Native on iOS and Android loads a style by URL in the same way.

```swift
// iOS (MapLibre Native)
let mapView = MLNMapView(
  frame: view.bounds,
  styleURL: URL(string: "https://goway.to/map/styles/standard/day.json")
)
```

```kotlin
// Android (MapLibre Native)
mapView.getMapAsync { map ->
  map.setStyle("https://goway.to/map/styles/standard/day.json")
}
```

MapLibre Native cannot run browser-side protocols, so everything a GoWay style needs, contour lines included, is served as ordinary tiles over HTTPS.

## With the GoWay packages

- [`@goway.to/maps`](../maps/README.md) is GoWay's map component for React and React Native. It takes `goway://styles/<id>` names, follows the light for you and draws the GoWay mark and the data credit.
- [`@goway.to/sdk/map`](../sdk/api-reference/map.md) has the catalogue (`MAP_STYLE_CATALOGUE`, `MAP_STYLE_IDS`, `MAP_LIGHT_PRESETS`), the naming and resolution helpers (`gowayStyleUrl`, `parseGoWayStyleUrl`, `resolveMapStyle`, `styleDocumentUrl`, `mapStylePath`) and the tile schema constants, with no HTTP client.

```ts
import { gowayStyleUrl, styleDocumentUrl } from '@goway.to/sdk/map';

// "https://goway.to/map/styles/streets/night.json": streets has no dusk.
const url = styleDocumentUrl(gowayStyleUrl('streets'), 'dusk');
```

## Next

- [Tiles](guides/tiles.md): the vector tile schema, source layers, class values, fonts, and the elevation and contour tiles.
- [Using styles](guides/using-styles.md): pinning a light, adding your own layer, querying features.
- [Map endpoints](api-reference.md): every `goway.to/map/*` URL, with its parameters, responses and caching.

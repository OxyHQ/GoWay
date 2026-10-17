# Map view

`MapView` is the map. It holds the engine, draws a GoWay style in your theme, and renders what you put inside it: markers, sources and layers, the user's location, plugins.

```tsx
import { MapView } from '@goway.to/maps';

<MapView style={{ height: 320 }} initialViewState={{ latitude: 41.39, longitude: 2.17, zoom: 12 }} />;
```

## Size

`MapView` grows to fill its parent when the parent has a size (a screen, a flex pane), and keeps a size you give it. Inside a scroll view or any parent whose height comes from its content, give it a height:

```tsx
<ScrollView>
  <MapView style={{ height: 280 }} />
</ScrollView>
```

## Style and theme

`mapStyle` names the style. It defaults to GoWay Standard (`goway://styles/standard`, exported as `DEFAULT_MAP_STYLE`).

```tsx
<MapView mapStyle="goway://styles/outdoors" />
```

`mapStyle` accepts:

- a GoWay style name, `goway://styles/<id>`, optionally with `?light=<preset>`;
- any other MapLibre style URL, used as it is.

A GoWay style that follows the light is drawn in the Bloom theme's light: `day` in a light theme, `night` in a dark one. Pin a light with `lightPreset` (`day`, `dawn`, `dusk` or `night`). A light in the name (`?light=dusk`) wins over `lightPreset`. A style that is not published in the light asked for is drawn in the nearest one it is. See [Map styles and tiles](../../styles/README.md) for the catalogue.

```tsx
<MapView mapStyle="goway://styles/standard" lightPreset="dusk" />
```

A `goway://` name that is not a published style is not silently replaced: the map enters its degraded state with the reason `style` (see below).

Changing `mapStyle` or `lightPreset` keeps the camera where it is.

## Interaction

Each gesture can be turned off on its own. All default to on.

```tsx
<MapView interaction={{ rotate: false, pitch: false }} maxPitch={45} />
```

| `interaction` key | Gestures |
| --- | --- |
| `pan` | drag to move over the ground |
| `zoom` | scroll, pinch and double-tap zoom |
| `rotate` | turn the camera (bearing) |
| `pitch` | tilt the camera; off also clamps the maximum pitch to 0 |

`maxPitch` caps the tilt (default 60).

## Light and projection

- `light` is a MapLibre `LightSpecification` for the style's light, for example aimed from the sun.
- `projection="globe"` draws a sphere at low zooms that eases into Mercator. It rebuilds the engine when it changes and is web-only; native draws Mercator.

## What goes inside, and what goes beside

Children of `MapView` are things drawn on the map: `Markers`, `GeoJSONSource` with its `Layer`s, `RasterDEMSource`, `UserLocation`, `MapPlugin`. Chrome laid over the map (buttons, cards, a search bar) goes beside the `MapView` in your own layout, positioned over it. To reach the map from that chrome, see [`useMap`](camera.md#from-chrome-over-the-map).

## The credit and the mark

Every map shows the GoWay mark and the data credit. Neither can be turned off. See [Attribution and brand](attribution-and-brand.md).

## The degraded state

When the style document or the tiles cannot be loaded, or the device cannot render the map, `MapView` covers its canvas (only the canvas) with a message and a retry button. Your chrome stays usable above it. `onError` reports entering that state with a `MapError` and leaving it with `null`.

| `MapError['reason']` | Meaning |
| --- | --- |
| `style` | the style document failed to load, or the `goway://` name is not published |
| `tiles` | the tiles the style points at failed |
| `unsupported` | no renderer on this device |
| `runtime` | the engine threw |

```tsx
<MapView onError={(error) => setMapDown(error !== null)} />
```

`onReady` fires once the style has loaded and the first frame is on screen.

## Web-only engine options

`pixelRatio` (a cap on the device pixel ratio) and `antialias` are read when the engine is built, on the web only.

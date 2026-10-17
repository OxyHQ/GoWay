# Events

`MapView` reports presses, the basemap labels on screen, and every camera change, including who caused it.

## Presses

`onPress` fires for a press on the map that no marker took. It gives the coordinate and, when there was one, the basemap label under the finger.

```tsx
<MapView
  onPress={({ coordinate, label }) => {
    if (label?.kind === 'poi') openPlaceSheet(label.name, label.coordinate);
    else dropPin(coordinate);
  }}
/>
```

A `MapLabelFeature`:

| Field | Meaning |
| --- | --- |
| `id` | stable while the loaded tiles are; not a GoWay place id |
| `name` | the name as the map draws it (`name:latin`, else `name`) |
| `kind` | `poi`, `road`, `water` or `area` |
| `coordinate` | the label's own point, the nearest point on its line, or the tap |
| `anchored` | `false` when `coordinate` is the tap rather than the feature's position |
| `category`, `subcategory` | the tiles' `class` and `subclass`, verbatim |
| `rank` | the tiles' importance ordering, where they supply one |

A press on a marker goes to that marker's `onPress` instead (see [Markers](markers.md)). On the web, an [engine plugin](plugins.md) can also take a press before the labels are resolved.

## Labels on screen

`onLabelsChange` reports the basemap labels placed in the viewport on every settled frame: the labels the map actually drew, not every feature in the tiles. Use `sameLabelSet(a, b)` to skip work when the set has not changed.

```tsx
import { sameLabelSet, type MapLabelFeature } from '@goway.to/maps';

const [labels, setLabels] = useState<readonly MapLabelFeature[]>([]);

<MapView onLabelsChange={(next) => setLabels((prev) => (sameLabelSet(prev, next) ? prev : next))} />;
```

## Camera changes

`onCameraChanged` fires while the camera moves (`isFinal: false`, throttled) and once when it settles (`isFinal: true`). It also fires once for the camera the map opened at, before `onReady`.

```ts
interface MapCameraChange {
  viewport: ResolvedMapViewport; // latitude, longitude, zoom, bearing, pitch
  bounds: GeoBoundingBox; // the visible box
  source: 'user' | 'programmatic';
  isFinal: boolean;
}
```

`source` says who moved the camera:

- `user`: a drag, pinch, scroll or key press;
- `programmatic`: the opening camera, a `camera` target, the ref, a cluster expanding, or (on the web) the map's container resizing.

The two are otherwise the same numbers, and nothing downstream can tell them apart, which is why the map reports it. A "Search this area" button should arm only on a settled `user` move:

```tsx
<MapView
  camera={{ bounds: searchedArea }}
  onCameraChanged={({ bounds, source, isFinal }) => {
    if (isFinal && source === 'user') setPendingArea(bounds);
  }}
/>
```

The full pattern is in the [Search this area example](../examples/search-this-area.md).

## Ready and errors

- `onReady` fires once the style has loaded and the first frame is drawn.
- `onError` reports the map entering its degraded state (a `MapError`) and leaving it (`null`). See [Map view](map-view.md#the-degraded-state).

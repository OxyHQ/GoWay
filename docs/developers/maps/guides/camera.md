# Camera

The camera has three inputs, each for a different job:

- `initialViewState` is where the map opens.
- `camera` is where your state says the map should be, applied whenever its value changes.
- The ref (`MapViewRef`) is for event handlers: a button that re-frames, a press that recentres.

None of them needs an effect in your component.

## The opening view

```tsx
<MapView initialViewState={{ latitude: 41.39, longitude: 2.17, zoom: 12 }} />
<MapView initialViewState={{ bounds: { west: 2.05, south: 41.32, east: 2.25, north: 41.47 }, padding: 32 }} />
```

`initialViewState` is a `MapViewport` (`latitude`, `longitude`, `zoom`, optional `bearing` and `pitch`) or a box to frame (`bounds`, optional `padding` and `maxZoom`). It is read when the map is built. Without it, the map opens on the `camera` target if there is one, and otherwise on the whole world.

## A camera target, by value

`camera` is a `MapCameraTarget`: a box to frame, or a centre and zoom.

```tsx
const area = query.location?.bounds ?? null;

<MapView camera={{ bounds: area }} />;
```

The map compares the target by its numbers, never by object identity:

- A new box (its four edges) or a new centre and zoom moves the camera.
- A re-render with an equal target does nothing, so a reader who has panned away is not pulled back.
- Changing only `padding`, `maxZoom` or `duration` does not move the camera.

The first target is applied without animation; later ones animate over `duration` (default 500 ms; `0` jumps).

| Field | Meaning |
| --- | --- |
| `bounds` | the box to frame; wins over `center` |
| `center`, `zoom` | the point to move to, and the zoom |
| `padding` | px around a framed box: a number or `{ top, right, bottom, left }` |
| `maxZoom` | never zoom past this when framing a box |
| `duration` | animation in ms |

A box with no area (a single point, or a line) is not fitted to maximum zoom. The map moves to its centre at street zoom (15, or `maxZoom` if lower).

A box that crosses the antimeridian (`west > east`) frames the strip it describes, not the rest of the world.

To frame the same target again after the reader has panned (a "back to the area" button), call `fitBounds` on the ref from the button's handler. Setting an equal `camera` does nothing by design.

## The ref

```tsx
import { useRef } from 'react';
import { MapView, type MapViewRef } from '@goway.to/maps';

const map = useRef<MapViewRef>(null);

<MapView ref={map} />;
<Button onPress={() => map.current?.fitBounds(area, { padding: 48 })}>Back to the area</Button>;
```

| Method | What it does |
| --- | --- |
| `moveTo(target, options?)` | Moves to a `GeoCoordinate` (keeping zoom, bearing and pitch) or a `MapViewport`. Returns `false` when there is no engine yet or the target is not drawable. |
| `fitBounds(bounds, options?)` | Frames a box. Options: `padding` (default 48), `duration`, `maxZoom`. |
| `fitCoordinates(coordinates, options?)` | Frames a set of points. |
| `setBearing(bearing, options?)` | Rotates to a bearing, degrees clockwise from north. |
| `resetNorth(options?)` | North up and the pitch level. |
| `getViewport()` | The camera now, as a `ResolvedMapViewport`, or `null` before the map is ready. |
| `getBounds()` | The visible box, or `null` before the map is ready. |
| `captureFrames?(draw)` | Web only: calls `draw` with every frame drawn until the returned function is called. |

`MapCameraOptions` for `moveTo`, `setBearing` and `resetNorth`:

- `zoom`, `bearing`, `pitch`: where to end up;
- `duration`: animation in ms; `0` jumps;
- `transient`: one frame of an animation you drive yourself. It is reported as in progress, never as settled; end it with one ordinary move;
- `fieldOfView`: the vertical field of view in degrees (10 to 60). Web only.

## From chrome over the map

A component rendered inside the `MapView` can call `useMap()`, which returns the enclosing map's `MapViewRef` (and throws outside a `MapView`). Position such a control absolutely so it floats over the canvas instead of taking layout space from it:

```tsx
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { MapView, useMap, type GeoCoordinate } from '@goway.to/maps';

function RecenterButton({ point }: { point: GeoCoordinate }) {
  const map = useMap();
  return (
    <View style={{ position: 'absolute', top: 16, right: 16 }}>
      <Button onPress={() => map.moveTo({ ...point, zoom: 15 })}>Recenter</Button>
    </View>
  );
}

<MapView>
  <RecenterButton point={home} />
</MapView>;
```

A ref (`useRef<MapViewRef>`) works the same way for controls rendered beside the map.

Moves made through the ref or the `camera` prop are reported as `programmatic` in [`onCameraChanged`](events.md#camera-changes).

# Markers and clusters

`Markers` draws a list of points as Bloom map markers: the price pill (`MapPriceMarker`) for a point and the cluster bubble (`MapClusterMarker`) for a group. They are the same components on the web, iOS and Android.

```tsx
import { MapView, Markers, type MapMarkerData } from '@goway.to/maps';

const homes: MapMarkerData[] = [
  { id: 'a', coordinate: { latitude: 41.39, longitude: 2.17 }, label: '€1,250' },
  { id: 'b', coordinate: { latitude: 41.4, longitude: 2.16 }, label: '€980' },
];

<MapView camera={{ bounds: area }}>
  <Markers data={homes} cluster onPress={(home) => setSelected(home.id)} />
</MapView>;
```

## Marker data

| `MapMarkerData` field | Meaning |
| --- | --- |
| `id` | unique within the list; what selection and presses refer to |
| `coordinate` | `{ latitude, longitude }` |
| `label` | short text in the pill (a price, a name); absent, a compact pill |
| `accessibilityLabel` | read aloud; defaults to `label` |
| `kind` | an open string your `renderMarker` may branch on; the default marker ignores it |

A marker whose coordinate is not drawable (not finite, or latitude outside ±90) is dropped with one console warning (`[goway/maps] Dropped marker …`); the rest still draw.

## Selection and visited markers

`selectedId` draws one marker `active`. With `cluster`, the selected marker is never folded into a cluster: what the reader is looking at stays on the map at its own coordinate.

```tsx
<Markers data={homes} cluster selectedId={hoveredId ?? selectedId} onPress={(home) => setSelectedId(home.id)} />
```

A marker the reader pressed is remembered as `visited` for the life of that `Markers` and drawn muted, so they can see what they have already looked at.

## Clusters

`cluster` groups nearby markers into bubbles, with Mapbox's source option names:

| Prop | Default | Meaning |
| --- | --- | --- |
| `cluster` | `false` | group nearby markers |
| `clusterRadius` | `50` | radius of a cluster, in px |
| `clusterMaxZoom` | `14` | from this zoom on, markers are never clustered |
| `clusterMinPoints` | `2` | the fewest points that form a cluster |

Pressing a cluster zooms the map in to where it splits. `onClusterPress` tells you which markers it held, as a `MapMarkerCluster`:

| Field | Meaning |
| --- | --- |
| `id` | stable while the cluster's members and the zoom are |
| `coordinate` | where the bubble is drawn |
| `count` | how many markers it holds |
| `markerIds` | the `id` of every marker in it |

A cluster holding the selected marker cannot exist (the selected one is never clustered).

## Custom marker bodies

`renderMarker(item, onPress)` replaces the marker body. Call the `onPress` it gives you from your own press handler, so the marker is remembered as visited and a cluster still expands. `DefaultMapMarker` is the default body, for the cases you do not customise.

```tsx
import { DefaultMapMarker, Markers, type MapMarkerItem } from '@goway.to/maps';
import { MapClusterMarker } from '@oxy.so/bloom/map-marker';

function renderMarker(item: MapMarkerItem, onPress: () => void) {
  if (item.kind === 'cluster') {
    return (
      <MapClusterMarker
        count={item.cluster.count}
        state={item.state}
        onPress={onPress}
        accessibilityLabel={t('map.cluster', { count: item.cluster.count })}
      />
    );
  }
  return <DefaultMapMarker item={item} onPress={onPress} />;
}

<Markers data={homes} cluster renderMarker={renderMarker} />;
```

`MapMarkerItem` is either `{ kind: 'point', marker, state }` with `state` `default`, `active` or `visited`, or `{ kind: 'cluster', cluster, state }` with `state` `default` or `active`.

Keep `renderMarker` stable (`useCallback`) when you can: a new function re-renders every marker body.

## Several layers of markers

Render more than one `Markers` for sets that behave differently, for example clustered search results and a few pinned favourites that never cluster:

```tsx
<MapView>
  <Markers data={results} cluster selectedId={selectedId} />
  <Markers data={favourites} />
</MapView>
```

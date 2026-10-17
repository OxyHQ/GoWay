# Migrate from `react-native-maps`

`react-native-maps` wraps the platform's own maps (Apple Maps, Google Maps) on iOS and Android, with no web build. `@goway.to/maps` draws GoWay's cartography with MapLibre on all three platforms, from one component tree. Most concepts map one to one; the camera is the main change in approach.

## Concepts

| `react-native-maps` | `@goway.to/maps` |
| --- | --- |
| `<MapView provider=…>` | `<MapView mapStyle=…>`; the style, not a provider, decides the look |
| `initialRegion` (`latitudeDelta`, `longitudeDelta`) | `initialViewState`: a centre and `zoom`, or `{ bounds }` |
| `region` (controlled) | `camera`: a target applied when its value changes; the map is never controlled frame by frame |
| `ref.animateToRegion`, `animateCamera` | `ref.moveTo(viewport, { duration })` |
| `ref.fitToCoordinates(coords, { edgePadding })` | `ref.fitCoordinates(coords, { padding })`, or `camera={{ bounds }}` |
| `onRegionChange`, `onRegionChangeComplete` | `onCameraChanged` (`isFinal` false, then true), with `source: 'user' \| 'programmatic'` |
| `onPress` (`nativeEvent.coordinate`) | `onPress` (`coordinate`, plus the basemap `label` under the press) |
| `onPoiClick` | `onPress` with `label.kind === 'poi'` |
| `<Marker coordinate>` children | `<Markers data>`: one list, Bloom markers, clustering built in |
| `<Callout>` | your own view beside the map, shown for the selected marker |
| `<Polyline>`, `<Polygon>`, `<Circle>` | `<GeoJSONSource>` with a `line`, `fill` or `circle` `<Layer>` |
| `showsUserLocation` | `<UserLocation />` (never prompts); ask with `useUserLocation().locate()` |
| `customMapStyle` (Google JSON) | a GoWay style and `lightPreset`, or any MapLibre style URL |

## Region to viewport

A region is a centre and a span; a viewport is a centre and a zoom. To keep "show this much", pass the box instead and let the map pick the zoom:

```tsx
// Before
<MapView initialRegion={{ latitude: 41.39, longitude: 2.17, latitudeDelta: 0.1, longitudeDelta: 0.1 }} />

// After
<MapView
  initialViewState={{ bounds: { west: 2.12, south: 41.34, east: 2.22, north: 41.44 } }}
/>
```

## Markers

```tsx
// Before
{homes.map((home) => (
  <Marker key={home.id} coordinate={home.coordinate} onPress={() => select(home.id)}>
    <PricePill price={home.price} />
  </Marker>
))}

// After
<Markers
  data={homes.map((home) => ({ id: home.id, coordinate: home.coordinate, label: home.price }))}
  cluster
  selectedId={selectedId}
  onPress={(marker) => select(marker.id)}
/>
```

## A controlled region

A component that set `region` from state and fed `onRegionChangeComplete` back into that state should split the two: put the target the app wants in `camera` (it moves the map only when it changes) and read the reader's moves from `onCameraChanged`. Writing the reported camera back into `camera` is not needed and would make the map chase itself.

## Setup

Remove `react-native-maps` and its Google Maps API keys. Add `@goway.to/maps`, its config plugin and, for the web, `withGoWayMaps` (see [Set up](../README.md#set-up)). Native needs a new development or store build.

# Migrate from Mapbox

`@goway.to/maps` follows Mapbox's model where it fits: named styles with a URL scheme, source clustering options with Mapbox's names, a style that follows a light preset. If you use Mapbox GL JS or `@rnmapbox/maps`, most of your map translates directly.

## Styles

| Mapbox | GoWay |
| --- | --- |
| `mapbox://styles/mapbox/standard` | `goway://styles/standard` |
| `mapbox://styles/mapbox/streets-v12` | `goway://styles/streets` |
| `mapbox://styles/mapbox/outdoors-v12` | `goway://styles/outdoors` |
| `mapbox://styles/mapbox/navigation-day-v1`, `-night-v1` | `goway://styles/navigation`, light `day` or `night` |
| `mapbox://styles/mapbox/satellite-v9` | `goway://styles/satellite` (not offered yet: its imagery is not published) |
| `mapbox://styles/mapbox/satellite-streets-v12` | `goway://styles/hybrid` (not offered yet, as `satellite`) |
| `mapbox://styles/mapbox/light-v11`, `dark-v11` | `goway://styles/light`, `goway://styles/dark` |
| Standard's `lightPreset` config | `lightPreset` prop, or `?light=` in the name |

There is no access token: GoWay's styles and tiles are public. See [Map styles and tiles](../../styles/README.md) for the catalogue.

## Components (`@rnmapbox/maps`)

| `@rnmapbox/maps` | `@goway.to/maps` |
| --- | --- |
| `Mapbox.setAccessToken(…)` | nothing |
| `<MapView styleURL>` | `<MapView mapStyle>` |
| `<Camera centerCoordinate zoomLevel>` | `initialViewState` or `camera={{ center, zoom }}` |
| `<Camera bounds>` | `camera={{ bounds }}` |
| `cameraRef.setCamera`, `flyTo`, `fitBounds` | `ref.moveTo`, `ref.fitBounds` |
| `onCameraChanged` (`gestures.isGestureActive`) | `onCameraChanged` (`source`, `isFinal`) |
| `<ShapeSource shape cluster>` | `<GeoJSONSource data cluster>` |
| `<LineLayer>`, `<FillLayer>`, `<CircleLayer>`, `<SymbolLayer>`, `<FillExtrusionLayer>` | `<Layer type="line" \| "fill" \| "circle" \| "symbol" \| "fill-extrusion">` |
| `<RasterDemSource>` + `<HillshadeLayer>` | `<RasterDEMSource>` + `<Layer type="hillshade">` |
| `<PointAnnotation>`, `<MarkerView>` | `<Markers data>` |
| `<LocationPuck>` / `<UserLocation>` | `<UserLocation />`; ask with `useUserLocation()` |

## Mapbox GL JS

The [MapLibre GL JS table](from-maplibre.md#from-maplibre-gl-js) applies: MapLibre GL JS shares Mapbox GL JS's API lineage, so `addSource`, `addLayer`, `fitBounds` and events translate the same way. Coordinates become `{ latitude, longitude }` outside GeoJSON.

## Attribution

Mapbox requires its logo and attribution; GoWay draws its mark and the OpenMapTiles and OpenStreetMap credit on every map, and neither can be hidden. Credits for your own data go in `credits`.

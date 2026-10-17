# `@goway.to/maps` API reference

Everything the package's main entry exports. The web build (`index.web.ts`, chosen by the `browser` export condition) and the native build (`index.ts`) export the same names with the same types. Coordinates are `{ latitude, longitude }` (`GeoCoordinate`) and boxes `{ west, south, east, north }` (`GeoBoundingBox`); both types are re-exported from `@goway.to/sdk/geo`.

- [Components](#components)
- [Hooks](#hooks)
- [The map handle](#the-map-handle)
- [Types](#types)
- [Attribution, brand and chrome](#attribution-brand-and-chrome)
- [Constants and helpers](#constants-and-helpers)

## Components

### `MapView`

`MapView(props: MapViewProps)`, with a `ref` of type `MapViewRef`. The map. See the [map view](../guides/map-view.md), [camera](../guides/camera.md) and [events](../guides/events.md) guides.

| `MapViewProps` | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mapStyle` | `string` | `DEFAULT_MAP_STYLE` | a `goway://styles/<id>[?light=]` name, any MapLibre style URL |
| `lightPreset` | `'day' \| 'dawn' \| 'dusk' \| 'night'` | the theme's | pins a GoWay style's light |
| `initialViewState` | `MapInitialViewState` | `camera`'s target, else the world | the camera on first render |
| `camera` | `MapCameraTarget` | | where the camera should be, applied when its value changes |
| `projection` | `'mercator' \| 'globe'` | `'mercator'` | globe is web-only; changing it rebuilds the engine |
| `light` | MapLibre `LightSpecification` or `null` | the style's | the style's light |
| `interaction` | `MapInteractionOptions` | all on | which gestures are enabled |
| `maxPitch` | `number` | `60` | the highest pitch |
| `pixelRatio` | `number` | device | web only, read at build: device pixel ratio cap |
| `antialias` | `boolean` | `false` | web only, read at build: multisample antialiasing |
| `credits` | `readonly MapCreditLink[]` | | credits for data you draw, after the basemap's |
| `creditDisclosure` | `MapCreditDisclosure \| null` | | a line the credit carries while something it names is drawn |
| `onPress` | `(event: MapPressEvent) => void` | | a press no marker took |
| `onCameraChanged` | `(change: MapCameraChange) => void` | | live while moving, once when settled |
| `onLabelsChange` | `(labels: readonly MapLabelFeature[]) => void` | | basemap labels placed in the viewport, each settled frame |
| `onReady` | `() => void` | | the style loaded and the first frame is drawn |
| `onError` | `(error: MapError \| null) => void` | | entered (`MapError`) or left (`null`) the degraded state |
| `style` | `StyleProp<ViewStyle>` | | grows to fill its parent; keeps a size you give |
| `testID` | `string` | | |
| `children` | `ReactNode` | | what is drawn on the map |

### `Markers`

`Markers(props: MarkersProps)`. Bloom markers at their coordinates, optionally clustered. See [Markers and clusters](../guides/markers.md).

| `MarkersProps` | Type | Default | Meaning |
| --- | --- | --- | --- |
| `data` | `readonly MapMarkerData[]` | | the markers |
| `selectedId` | `string \| null` | | drawn `active`; never clustered |
| `cluster` | `boolean` | `false` | group nearby markers |
| `clusterRadius` | `number` | `50` | px |
| `clusterMaxZoom` | `number` | `14` | no clustering from this zoom |
| `clusterMinPoints` | `number` | `2` | fewest points in a cluster |
| `renderMarker` | `(item: MapMarkerItem, onPress: () => void) => ReactNode` | `DefaultMapMarker` | a custom body |
| `onPress` | `(marker: MapMarkerData) => void` | | a marker was pressed (and is now visited) |
| `onClusterPress` | `(cluster: MapMarkerCluster) => void` | | a cluster was pressed (the map zooms in by itself) |

### `DefaultMapMarker`

`DefaultMapMarker({ item, onPress })`. The body `Markers` draws when you pass no `renderMarker`: Bloom's `MapPriceMarker` for a point (`compact` when it has no `label`) and `MapClusterMarker` for a cluster.

### `GeoJSONSource`

`GeoJSONSource(props: GeoJSONSourceProps)`. A GeoJSON source; its `Layer` children draw it. See [Sources and layers](../guides/sources-and-layers.md).

| `GeoJSONSourceProps` | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | source id |
| `data` | `GeoJSON.GeoJSON` | the data; undrawable data is replaced with an empty collection and warned about |
| `cluster`, `clusterRadius`, `clusterMaxZoom`, `clusterMinPoints` | | MapLibre source clustering (web: read when the source is created) |
| `clusterProperties` | `Readonly<Record<string, unknown>>` | MapLibre cluster aggregate expressions |
| `children` | `ReactNode` | `Layer`s |

### `RasterDEMSource`

`RasterDEMSource(props: RasterDEMSourceProps)`. An elevation source for a `hillshade` layer.

| `RasterDEMSourceProps` | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | source id |
| `tiles` | `readonly string[]` | tile URL templates |
| `encoding` | `'mapbox' \| 'terrarium'` | elevation encoding |
| `tileSize`, `minzoom`, `maxzoom` | `number` | as in the style spec |
| `children` | `ReactNode` | `Layer`s |

### `Layer`

`Layer(props: LayerProps)`. Draws the source it is inside; throws outside one.

| `LayerProps` | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | layer id |
| `type` | `MapLayerType` | `line`, `fill`, `circle`, `symbol`, `fill-extrusion`, `hillshade` |
| `paint`, `layout` | `Readonly<Record<string, unknown>>` | style-spec properties; updated in place |
| `filter` | `readonly unknown[]` | style-spec filter |
| `beforeId` | `string` | draw under this layer; absent, on top |
| `minzoom`, `maxzoom` | `number` | zoom range |

### `UserLocation`

`UserLocation(props: UserLocationProps)`. Bloom's location puck at the device's position, drawn only when the permission is already granted. `UserLocationProps.visible` (default `true`) hides it. See [User location](../guides/user-location.md).

### `MapPlugin`

`MapPlugin({ plugin, props })`. Binds an engine plugin to the map (web only; renders nothing on native). The protocol is in [`@goway.to/maps/plugin`](plugin.md).

### `BrandedChromeProvider`

`BrandedChromeProvider({ children })`. Declares that the surface around the map already shows the GoWay logo, so the map's own mark stands down. `useBrandedChrome()` reads it. See [Attribution and brand](../guides/attribution-and-brand.md).

### `GowayLogo`

`GowayLogo(props: GowayLogoProps)`. The GoWay logo as a component.

| `GowayLogoProps` | Type | Default | Meaning |
| --- | --- | --- | --- |
| `width` | `number` | | px; the height follows the artwork |
| `variant` | `GowayLogoVariant` (`'wordmark' \| 'mark'`) | `'wordmark'` | the full lockup, or the "G" bubble alone (for small sizes) |
| `label` | `string` | `'GoWay'` | accessible name; `''` hides it from assistive technology |
| `testID` | `string` | | |

## Hooks

| Hook | Returns |
| --- | --- |
| `useMap()` | the enclosing `MapView`'s `MapViewRef`; throws outside a `MapView` |
| `useUserLocation()` | `UserLocationApi`: ask for the permission and a fix, from a tap |
| `useBrandedChrome()` | whether a `BrandedChromeProvider` is above |
| `useMapCreditHeight()` | the shared value a `MapCreditHeightContext` provides, or `null` |
| `useMapChromeLift()` | the `MapChromeLift` a `MapChromeLiftContext` provides, or `null` |

`UserLocationApi` extends `UserLocationState` with `locate(): Promise<GeoCoordinate | null>` and `forget(): void`. `UserLocationState` is `{ status: LocationPermissionStatus; coordinate: GeoCoordinate | null; isLocating: boolean; error: LocationErrorReason | null; canAskAgain: boolean }`. `LocationPermissionStatus` is `'unknown' | 'granted' | 'denied'`; `LocationErrorReason` is `'denied' | 'unavailable' | 'timeout' | 'insecureContext'`.

## The map handle

`MapViewRef`, from a `ref` on `MapView` or from `useMap()`. For event handlers; derive state-driven camera moves from the `camera` prop instead.

| Method | Signature |
| --- | --- |
| `moveTo` | `(target: GeoCoordinate \| MapViewport, options?: MapCameraOptions) => boolean` |
| `fitBounds` | `(bounds: GeoBoundingBox, options?: MapFitOptions) => void` |
| `fitCoordinates` | `(coordinates: readonly GeoCoordinate[], options?: MapFitOptions) => void` |
| `setBearing` | `(bearing: number, options?: MapCameraOptions) => void` |
| `resetNorth` | `(options?: MapCameraOptions) => void` |
| `getViewport` | `() => Promise<ResolvedMapViewport \| null>` |
| `getBounds` | `() => Promise<GeoBoundingBox \| null>` |
| `captureFrames` | web only, optional: `(draw: (frame: MapFrame) => void) => () => void` |

## Types

| Type | Shape |
| --- | --- |
| `GeoCoordinate` | `{ latitude: number; longitude: number }` |
| `GeoBoundingBox` | `{ west: number; south: number; east: number; north: number }`; `west > east` crosses the antimeridian |
| `MapViewport` | `{ latitude; longitude; zoom; bearing?; pitch? }` |
| `ResolvedMapViewport` | `MapViewport` with `bearing` and `pitch` always present |
| `MapInitialViewState` | `MapViewport`, or `{ bounds: GeoBoundingBox; padding?: MapPadding; maxZoom?: number }` |
| `MapCameraTarget` | `{ bounds?; center?; zoom?; padding?; maxZoom?; duration? }`; compared by value |
| `MapPadding` | `number` or `{ top; right; bottom; left }` |
| `MapCameraOptions` | `{ zoom?; bearing?; pitch?; duration?; transient?; fieldOfView? }` (`fieldOfView` web only) |
| `MapFitOptions` | `{ padding?; duration?; maxZoom? }` |
| `MapCameraChange` | `{ viewport: ResolvedMapViewport; bounds: GeoBoundingBox; source: MapMoveSource; isFinal: boolean }` |
| `MapMoveSource` | `'user' \| 'programmatic'` |
| `MapPressEvent` | `{ coordinate: GeoCoordinate; label?: MapLabelFeature }` |
| `MapLabelFeature` | `{ id; name; kind: MapLabelKind; coordinate; anchored; category?; subcategory?; rank? }` |
| `MapLabelKind` | `'poi' \| 'road' \| 'water' \| 'area'` |
| `MapMarkerData` | `{ id; coordinate; label?; accessibilityLabel?; kind? }` |
| `MapMarkerCluster` | `{ id; coordinate; count; markerIds: readonly string[] }` |
| `MapMarkerItem` | `{ kind: 'point'; marker; state: 'default' \| 'active' \| 'visited' }` or `{ kind: 'cluster'; cluster; state: 'default' \| 'active' }` |
| `MapInteractionOptions` | `{ pan?; zoom?; rotate?; pitch? }`, each default `true` |
| `MapError` | `{ reason: MapErrorReason; message?: string }` |
| `MapErrorReason` | `'style' \| 'tiles' \| 'unsupported' \| 'runtime'` |
| `MapCreditLink` | `{ label: string; href: string }` |
| `MapCreditDisclosure` | `{ text: string; detail: string; short: string }` |
| `MapFrame` | `{ canvas: HTMLCanvasElement }`, the pixels valid only during the callback |
| `MapLayerType` | `'line' \| 'fill' \| 'circle' \| 'symbol' \| 'fill-extrusion' \| 'hillshade'` |
| `MapViewProps`, `MarkersProps`, `GeoJSONSourceProps`, `RasterDEMSourceProps`, `LayerProps`, `UserLocationProps`, `GowayLogoProps` | the components' props, above |
| `UserLocationApi`, `UserLocationState`, `LocationPermissionStatus`, `LocationErrorReason` | `useUserLocation`, above |
| `MapChromeLift` | `{ lift: SharedValue<number>; opacity: SharedValue<number>; rightClearance: number }` |
| `GowayLogoVariant` | `'wordmark' \| 'mark'` |

## Attribution, brand and chrome

| Export | What it is |
| --- | --- |
| `MAP_DATA_CREDITS` | the credits every map shows: `© OpenMapTiles`, `© OpenStreetMap` |
| `MAP_CREDIT_CLEARANCE` | `36`: px the folded or one-line credit takes above the bottom edge |
| `CREDIT_GAP` | `4`: px between the credit and the edge below it |
| `creditRise(plateHeight)` | worklet: px bottom-right chrome must rise for a credit this tall |
| `MapCreditHeightContext` | provide a `SharedValue<number>`; the credit writes its measured height to it |
| `MapChromeLiftContext` | provide a `MapChromeLift` to keep the credit above a bottom sheet |
| `MAP_BRAND_WIDTH`, `MAP_BRAND_HEIGHT` | the mark's size in px |
| `MAP_BRAND_CLEARANCE` | `MAP_BRAND_WIDTH + 16`: room the mark takes from the left edge |
| `gowayLogoHeight(width, variant?)` | the height `GowayLogo` renders at for a width |

## Constants and helpers

| Export | What it is |
| --- | --- |
| `DEFAULT_MAP_STYLE` | `'goway://styles/standard'` |
| `sameLabelSet(a, b)` | whether two label lists are the same set (by `id`) |

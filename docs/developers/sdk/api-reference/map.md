# @goway.to/sdk/map

What a map renderer needs from GoWay and nothing else: style names (`goway://styles/<id>`) and the documents they stand for, the style catalogue, GoWay's tile schema, and a label in the reader's language. There is no HTTP client and no `zod` in this entry, so a map can resolve its style without loading GoWay's whole contract.

Import from it like this: `import { DEFAULT_MAP_STYLE, gowayStyleUrl, styleDocumentUrl } from '@goway.to/sdk/map';`

For a walkthrough, see the [map styles guide](../guides/map-styles.md).

## Functions

### Style names and documents

| Function | Signature | Description |
| --- | --- | --- |
| `styleDocumentUrl` | `styleDocumentUrl(url: string, light?: MapLightPreset, webBaseUrl?: string): string \| null` | The URL a renderer loads. A `goway://styles/<id>` name resolves to its document on `webBaseUrl` (default `DEFAULT_GOWAY_WEB_BASE_URL`), in the name's own `?light=` first, else `light`, else the style's default, and in the nearest light the style is published in. Any other URL is returned unchanged. `null` for an unpublished style or a `light` that is not a light. |
| `gowayStyleUrl` | `gowayStyleUrl(style: MapStyleId, light?: MapLightPreset): string` | The `goway://` name of a style, optionally pinned to one light. |
| `parseGoWayStyleUrl` | `parseGoWayStyleUrl(url: string): { style: MapStyleId; light?: MapLightPreset } \| null` | Reads a `goway://styles/<id>[?light=<preset>]` name; `null` for any other string, or an unknown id or light. |
| `resolveMapStyle` | `resolveMapStyle(style: MapStyleId, wanted?: MapLightPreset, sunUp?: boolean): MapStyleSelection` | The light a style is actually drawn in: a fixed style keeps its one; a style without dawn and dusk draws them as day or night. |
| `mapStylePath` | `mapStylePath(selection: MapStyleSelection): string` | Where a document is served, relative to the web origin: `/map/styles/<style>/<light>.json`. |
| `mapStyleDefinition` | `mapStyleDefinition(id: MapStyleId): MapStyleDefinition` | One catalogue entry. |
| `isMapStyleId` | `isMapStyleId(value: unknown): value is MapStyleId` | Narrows to a style id. |
| `isMapLightPreset` | `isMapLightPreset(value: unknown): value is MapLightPreset` | Narrows to a light. |

### Labels

| Function | Signature | Description |
| --- | --- | --- |
| `localizedLabel` | `localizedLabel(entry: LocalizedLabels, locale?: string \| null): string` | The best label for a reader's locale, English when none serves. `es-MX` reads `es`, `pt-PT` reads `pt-BR`. |

## Constants

### Styles

| Name | Value | Description |
| --- | --- | --- |
| `MAP_STYLE_IDS` | `['standard', 'streets', 'outdoors', 'navigation', 'monochrome', 'satellite', 'hybrid', 'light', 'dark']` | Every published style, in picker order. |
| `MAP_LIGHT_PRESETS` | `['day', 'dawn', 'dusk', 'night']` | The lights a style can be drawn in. |
| `MAP_STYLE_LIGHT_KINDS` | `['follows', 'fixed']` | Whether a style follows the light or keeps one of its own. |
| `MAP_STYLE_CATALOGUE` | `readonly MapStyleDefinition[]` | Which lights each style is published in. |
| `MAP_STYLE_INDEX_PATH` | `'/map/styles/index.json'` | Where the catalogue document is served. |
| `DEFAULT_MAP_STYLE` | `'standard'` | The default style. |
| `GOWAY_STYLE_URL_PREFIX` | `'goway://styles/'` | The scheme a GoWay style is named by. |
| `DEFAULT_GOWAY_WEB_BASE_URL` | `'https://goway.to'` | The origin style documents are served from unless told otherwise. |

### Tile schema (OpenMapTiles v3)

| Name | Description |
| --- | --- |
| `OPENMAPTILES_SOURCE_LAYERS` | Source-layer names inside the vector source, by role (`building`, `transportation`, `poi`, ...). |
| `OPENMAPTILES_SOURCE_LAYER_NAMES` | Every source-layer name. |
| `TRANSPORTATION_CLASSES` | Observed values of `transportation.class`. |
| `LANDCOVER_CLASSES` | Observed values of `landcover.class`. |
| `LANDUSE_CLASSES` | Observed values of `landuse.class`. |
| `PLACE_CLASSES` | Observed values of `place.class`. |
| `WATER_CLASSES` | Observed values of `water.class`. |
| `POI_CLASSES` | Observed values of `poi.class`. |
| `AVAILABLE_FONTS` | `['Inter Regular', 'Inter Medium', 'Inter SemiBold', 'Inter Bold']`: the glyph fontstacks GoWay's font server answers. |
| `FONT_STACKS` | The fontstacks as MapLibre's `text-font` wants them: `regular`, `medium`, `semibold`, `bold`. |

## Types

| Type | Description |
| --- | --- |
| `MapStyleId` | One of `MAP_STYLE_IDS`. |
| `MapLightPreset` | One of `MAP_LIGHT_PRESETS`. |
| `MapStyleLightKind` | One of `MAP_STYLE_LIGHT_KINDS`. |
| `MapStyleSelection` | `{ style: MapStyleId; preset: MapLightPreset }`: one style in one light. |
| `MapStyleDefinition` | One catalogue entry: `id`, `presets`, `light`, and optional flags. |
| `LocalizedLabels` | Labels keyed by language tag: `en` always, others as they exist. |
| `AvailableFont` | One of `AVAILABLE_FONTS`. |
| `OpenMapTilesSourceLayer` | A source-layer name. |

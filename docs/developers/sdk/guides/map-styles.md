# Map styles from a renderer

The `@goway.to/sdk/map` entry point is what a map renderer needs from GoWay: the style names, the rule that turns a name into the style document to load, the style catalogue, GoWay's vector tile schema, and `localizedLabel` for labels in the reader's language. It has no HTTP client and no `zod`, so a map can resolve its style without loading the rest of the SDK. The styles themselves (what each looks like, its lights, the tile layers) are described in the [map styles documentation](../../styles/README.md).

## Load a GoWay style

A style is named `goway://styles/<id>`, optionally with `?light=<preset>`. `styleDocumentUrl` turns a name into the URL of a complete MapLibre style document:

```ts
import { DEFAULT_MAP_STYLE, gowayStyleUrl, styleDocumentUrl } from '@goway.to/sdk/map';

const name = gowayStyleUrl(DEFAULT_MAP_STYLE);   // 'goway://styles/standard'
const url = styleDocumentUrl(name, 'night');      // 'https://goway.to/map/styles/standard/night.json'
if (url) map.setStyle(url);
```

- The name's own `?light=` wins over the `light` argument; with neither, the style's default light.
- A light the style is not published in resolves to the nearest one it is (`dark` is night only; `streets` draws dawn as day and dusk as night).
- Any URL that is not a `goway://` name is returned unchanged, so you can pass user-supplied style URLs through the same call.
- It returns `null` for a `goway://` name that is not a published style, or a light that is not one of `MAP_LIGHT_PRESETS`. It never substitutes a different map.
- The third argument is the web origin, default `DEFAULT_GOWAY_WEB_BASE_URL`.

`client.links.styleUrl` on the HTTP client applies the same rule but throws `GoWayValidationError` instead of returning `null`; see [Links](./links.md).

## The catalogue

| Name | Use |
| --- | --- |
| `MAP_STYLE_IDS` | Every style: `standard`, `streets`, `outdoors`, `navigation`, `monochrome`, `satellite`, `hybrid`, `light`, `dark`. |
| `MAP_LIGHT_PRESETS` | `day`, `dawn`, `dusk`, `night`. |
| `MAP_STYLE_CATALOGUE` | Each style's published lights and whether it `follows` the light or keeps a `fixed` one. |
| `mapStyleDefinition(id)` | One entry. |
| `resolveMapStyle(style, light?)` | The `{ style, preset }` actually drawn. |
| `mapStylePath(selection)` | `/map/styles/<style>/<preset>.json`. |
| `isMapStyleId(value)`, `isMapLightPreset(value)` | Narrow untrusted strings (a saved setting, a URL parameter). |
| `parseGoWayStyleUrl(url)` | Read a `goway://` name into `{ style, light? }`, or `null`. |

The live catalogue is also published as a document at `MAP_STYLE_INDEX_PATH` (`/map/styles/index.json`); the root entry's `parseMapStyleIndex` checks it.

## Tile schema and fonts

GoWay's vector tiles follow OpenMapTiles v3. `OPENMAPTILES_SOURCE_LAYERS` names the source layers (a wrong name renders nothing), and `TRANSPORTATION_CLASSES`, `LANDCOVER_CLASSES`, `LANDUSE_CLASSES`, `PLACE_CLASSES`, `WATER_CLASSES` and `POI_CLASSES` list the observed `class` values. For a custom layer's `text-font`, use `FONT_STACKS` (`regular`, `medium`, `semibold`, `bold`); `AVAILABLE_FONTS` lists what GoWay's glyph server answers.

```ts
import { FONT_STACKS, OPENMAPTILES_SOURCE_LAYERS } from '@goway.to/sdk/map';

const poiLabels = {
  id: 'my-poi-labels',
  type: 'symbol',
  source: 'openmaptiles', // the vector source in GoWay's style documents
  'source-layer': OPENMAPTILES_SOURCE_LAYERS.poi,
  layout: { 'text-field': ['get', 'name'], 'text-font': [...FONT_STACKS.medium] },
};
```

## Labels in the reader's language

`localizedLabel(entry, locale)` picks the best label from a `LocalizedLabels` record (English always present): `es-MX` reads `es`, `pt-PT` reads `pt-BR`, and English is the fallback.

## Using `@goway.to/maps`

If you render with GoWay's own map component, you do not need this entry directly: `MapView` takes a `goway://styles/<id>` name in `mapStyle` and resolves it the same way. See the [maps documentation](../../maps/README.md).

## See also

- [Map styles documentation](../../styles/README.md)
- [API reference: `@goway.to/sdk/map`](../api-reference/map.md)

/**
 * `@goway.to/sdk/map` — what a map renderer needs from GoWay, and nothing else.
 *
 * Style names (`goway://styles/<id>`) and the documents they stand for, the
 * style catalogue, GoWay's tile schema, and a label in the reader's language.
 * No HTTP client and no schema — there is no zod in this entry
 * (`scripts/smoke.mjs` holds it to that) — so a map (`@goway.to/maps`) can
 * resolve its style without bringing GoWay's whole contract into an app's
 * bundle.
 *
 *     import { DEFAULT_MAP_STYLE, gowayStyleUrl, styleDocumentUrl } from '@goway.to/sdk/map';
 *
 *     map.setStyle(styleDocumentUrl(gowayStyleUrl(DEFAULT_MAP_STYLE), 'night'));
 */

export {
  // Map styles
  DEFAULT_MAP_STYLE,
  GOWAY_STYLE_URL_PREFIX,
  MAP_LIGHT_PRESETS,
  MAP_STYLE_CATALOGUE,
  MAP_STYLE_IDS,
  MAP_STYLE_INDEX_PATH,
  MAP_STYLE_LIGHT_KINDS,
  gowayStyleUrl,
  isMapLightPreset,
  isMapStyleId,
  mapStyleDefinition,
  mapStylePath,
  parseGoWayStyleUrl,
  resolveMapStyle,
  // GoWay's tile schema (OpenMapTiles v3)
  AVAILABLE_FONTS,
  FONT_STACKS,
  LANDCOVER_CLASSES,
  LANDUSE_CLASSES,
  OPENMAPTILES_SOURCE_LAYERS,
  OPENMAPTILES_SOURCE_LAYER_NAMES,
  PLACE_CLASSES,
  POI_CLASSES,
  TRANSPORTATION_CLASSES,
  WATER_CLASSES,
  // A label in the reader's language
  localizedLabel,
} from './contract';

export { DEFAULT_GOWAY_WEB_BASE_URL, styleDocumentUrl } from './styleDocument';

export type {
  AvailableFont,
  LocalizedLabels,
  MapLightPreset,
  MapStyleDefinition,
  MapStyleId,
  MapStyleLightKind,
  MapStyleSelection,
  OpenMapTilesSourceLayer,
} from './contract';

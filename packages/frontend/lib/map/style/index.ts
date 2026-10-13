/**
 * `buildGowayMapStyle` — GoWay's own MapLibre style document.
 *
 * Issue #2: *"The renderer must support a GoWay-owned MapLibre style document
 * so the product can evolve toward a distinct visual identity without changing
 * map providers. Keep source/layer IDs documented because later GoWay styles
 * and overlays will depend on them."* This is that document, and `layers.ts` is
 * that id contract.
 *
 * ## Why this is possible without leaving OpenFreeMap
 *
 * A style document and a tile source are two different things that people
 * routinely confuse, because vendors ship them together. The tiles are
 * OSM-derived vector data in the **OpenMapTiles v3 schema**; the style is a
 * JSON document saying what to draw and in what colour. OpenFreeMap serves both
 * but only owns the first — the schema is an open standard, so a style written
 * against it renders identically on OpenFreeMap today and on GoWay-hosted
 * PMTiles the day that exists. Nothing in this module names a host: every
 * endpoint arrives as an argument from `lib/map/provider.ts`, which remains the
 * one place a vendor is written down.
 *
 * ## Why it is generated, not hand-written JSON
 *
 * Every style in every light × ~70 layers is well over a thousand objects
 * that must stay structurally one map and differ only where a style says so.
 * Hand-maintained that is a guarantee that survives exactly one edit.
 * Generated from ONE layer list, a theme per (style, light) (`themes.ts`) and
 * the catalogue (`catalogue.ts`), it is a property of the code:
 * `scripts/build-map-style.ts` renders the JSON into `public/map/styles/`,
 * validates it against the real MapLibre style spec, and fails if the
 * committed files have drifted from the source (`docs/MAP_STYLES.md`).
 */
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

import { BUILDINGS_LIGHT } from './buildings3d';
import type { MapLightPreset, MapStyleId, MapStyleSelection } from './catalogue';
import { buildCity3dGroundOverrides } from './city3dGround';
import {
  buildLayers,
  CONTOUR_SOURCE_ID,
  GOWAY_STYLE_LAYER_ID_LIST,
  LABEL_ANCHOR_LAYER_ID,
  TERRAIN_SOURCE_ID,
} from './layers';
import { CITY3D_GROUND_METADATA_KEY } from './palette3d';
import { buildQualityOverrides, QUALITY_LOW_METADATA_KEY } from './qualityOverrides';
import { styleTheme } from './themes';

export { LABEL_ANCHOR_LAYER_ID, GOWAY_STYLE_LAYER_IDS, GOWAY_STYLE_LAYER_ID_LIST } from './layers';
export { CARTOGRAPHY_PALETTES, DARK_PALETTE, LIGHT_PALETTE } from './palette';
export * from './catalogue';
export { styleTheme, type StyleTheme } from './themes';
export type { CartographyPalette, PoiPalette, RoadTone } from './palette';
export * from './schema';

/**
 * Everything about the tile host the style needs to name, supplied by the
 * caller so this module names nothing.
 */
export interface MapStyleEndpoints {
  /** The vector source's id inside the style. Overlays anchor against it. */
  sourceId: string;
  /** TileJSON document describing the vector tiles. */
  tileJsonUrl: string;
  /** `{fontstack}/{range}.pbf` glyph endpoint. */
  glyphs: string;
  /**
   * Sprite sheet base URL.
   *
   * No layer in this style uses an `icon-image` — POIs are drawn as tinted
   * dots, which recolour per appearance where the OpenFreeMap sprite (264
   * non-SDF, dark-on-transparent PNGs) cannot, and which is why dark mode can
   * have POIs at all. The sprite is still declared because overlays get one for
   * free by doing so: #6's route lines want the `arrow` image for direction
   * chevrons, and adding it later would mean editing the style rather than the
   * overlay.
   */
  sprite?: string;
  /** The credit line stamped onto the source, per the OSM/ODbL obligation. */
  attribution: string;
  /**
   * GoWay's elevation tiles (`{z}/{x}/{y}` Terrarium WebP) and the contour
   * tiles traced from them, with the elevation credit — read only by a style
   * that draws its own relief (Outdoors).
   */
  terrain?: { tiles: string; contours: string; attribution: string };
}

/**
 * The two sources a style with its own relief declares: the elevation tiles
 * the hillshade reads (`RELIEF_DEM`'s shape) and the contour tiles the Worker
 * traces from them (`worker/contours.js`: z9–14, over-zoomed above).
 */
function reliefSources(terrain: NonNullable<MapStyleEndpoints['terrain']>) {
  return {
    [TERRAIN_SOURCE_ID]: {
      type: 'raster-dem' as const,
      tiles: [terrain.tiles],
      encoding: 'terrarium' as const,
      tileSize: 512,
      minzoom: 0,
      maxzoom: 12,
      attribution: terrain.attribution,
    },
    [CONTOUR_SOURCE_ID]: {
      type: 'vector' as const,
      tiles: [terrain.contours],
      minzoom: 9,
      maxzoom: 14,
      attribution: terrain.attribution,
    },
  };
}

/** Human names, used in the style's `name` and in MapLibre's debug output. */
const STYLE_NAMES: Record<MapStyleId, string> = {
  standard: 'GoWay Standard',
  streets: 'GoWay Streets',
  outdoors: 'GoWay Outdoors',
  navigation: 'GoWay Navigation',
  monochrome: 'GoWay Monochrome',
  light: 'GoWay Light',
  dark: 'GoWay Dark',
};

const LIGHT_NAMES: Record<MapLightPreset, string> = {
  day: 'Day',
  dawn: 'Dawn',
  dusk: 'Dusk',
  night: 'Night',
};

/**
 * Build the complete style document for one style in one light.
 *
 * The result is a plain object: pass it to `maplibre-gl` directly, or serialise
 * it to a `.json` and serve it. `scripts/build-map-style.ts` does the latter,
 * because both map adapters take a style *URL* and MapLibre Native cannot be
 * handed an object at all.
 */
export function buildGowayMapStyle(
  selection: MapStyleSelection,
  endpoints: MapStyleEndpoints,
): StyleSpecification {
  const theme = styleTheme(selection);
  const { appearance, palette, options } = theme;
  if (options.outdoors && !endpoints.terrain) {
    throw new Error(
      `map style ${selection.style}: draws its own relief, so it needs the terrain endpoints`,
    );
  }

  return {
    version: 8,
    name: `${STYLE_NAMES[selection.style]} · ${LIGHT_NAMES[selection.preset]}`,
    // Read by nothing at runtime; present so that a style document found on
    // disk, in a cache or in a bug report can be traced back to what produced
    // it and to the contract it promises.
    metadata: {
      'goway:style': selection.style,
      'goway:light': selection.preset,
      'goway:appearance': appearance,
      'goway:schema': 'openmaptiles-v3',
      'goway:anchor:beforeLabels': LABEL_ANCHOR_LAYER_ID,
      'goway:layers': GOWAY_STYLE_LAYER_ID_LIST,
      'goway:generator': 'packages/frontend/scripts/build-map-style.ts',
      // The ground the detailed 3D city switches this document to: paint
      // overrides generated from `palette3d.ts` (`city3dGround.ts`), applied
      // and undone at runtime by the city-3D adapter only. Inert otherwise.
      [CITY3D_GROUND_METADATA_KEY]: buildCity3dGroundOverrides(theme, endpoints.sourceId),
      // The same layers at Standard's density, for the low quality tier
      // (`qualityOverrides.ts`): empty for a style already drawn at it.
      [QUALITY_LOW_METADATA_KEY]: buildQualityOverrides(palette, options, endpoints.sourceId),
    },
    // The document-level light. It shades nothing but `building-3d`, and it is
    // here rather than in `buildings3d.ts` only because MapLibre puts `light`
    // on the style rather than on the layer it lights. Leaving it unset means
    // taking MapLibre's `intensity: 0.5`, which turns pale buildings into white
    // lids on black walls. It is the one thing besides colour that differs per
    // appearance, because MapLibre's shading is multiplicative and the same
    // ratio is a far smaller difference on a dark palette — see the constant.
    light: BUILDINGS_LIGHT[appearance],
    glyphs: endpoints.glyphs,
    ...(endpoints.sprite === undefined ? {} : { sprite: endpoints.sprite }),
    sources: {
      ...(options.outdoors && endpoints.terrain ? reliefSources(endpoints.terrain) : {}),
      [endpoints.sourceId]: {
        type: 'vector',
        url: endpoints.tileJsonUrl,
        // OpenFreeMap's own style documents ship NO source attribution, which
        // is why GoWay renders the credit itself (`MapAttribution.tsx`). This
        // style sets it anyway: a style document that travels without its
        // licence obligation attached is a style document someone eventually
        // serves without one.
        attribution: endpoints.attribution,
      },
    },
    layers: buildLayers(palette, endpoints.sourceId, options),
  };
}

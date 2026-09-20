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
 * Two appearances × ~45 layers is ~90 objects that must stay structurally
 * identical and differ only in colour. Hand-maintained that is a guarantee that
 * survives exactly one edit. Generated from one layer list and two palettes, it
 * is a property of the code: `scripts/build-map-style.ts` renders the JSON into
 * `public/map/`, validates it against the real MapLibre style spec, and fails
 * if the committed files have drifted from the source.
 */
import type { StyleSpecification } from '@maplibre/maplibre-gl-style-spec';

import type { MapAppearance } from '../provider';
import { buildLayers, GOWAY_STYLE_LAYER_ID_LIST, LABEL_ANCHOR_LAYER_ID } from './layers';
import { CARTOGRAPHY_PALETTES } from './palette';

export { LABEL_ANCHOR_LAYER_ID, GOWAY_STYLE_LAYER_IDS, GOWAY_STYLE_LAYER_ID_LIST } from './layers';
export { CARTOGRAPHY_PALETTES, DARK_PALETTE, LIGHT_PALETTE } from './palette';
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
}

/** Human names, used in the style's `name` and in MapLibre's debug output. */
const STYLE_NAMES: Record<MapAppearance, string> = {
  light: 'GoWay Daylight',
  dark: 'GoWay Night',
};

/**
 * Build the complete style document for one appearance.
 *
 * The result is a plain object: pass it to `maplibre-gl` directly, or serialise
 * it to a `.json` and serve it. `scripts/build-map-style.ts` does the latter,
 * because both map adapters take a style *URL* and MapLibre Native cannot be
 * handed an object at all.
 */
export function buildGowayMapStyle(
  appearance: MapAppearance,
  endpoints: MapStyleEndpoints,
): StyleSpecification {
  const palette = CARTOGRAPHY_PALETTES[appearance];

  return {
    version: 8,
    name: STYLE_NAMES[appearance],
    // Read by nothing at runtime; present so that a style document found on
    // disk, in a cache or in a bug report can be traced back to what produced
    // it and to the contract it promises.
    metadata: {
      'goway:appearance': appearance,
      'goway:schema': 'openmaptiles-v3',
      'goway:anchor:beforeLabels': LABEL_ANCHOR_LAYER_ID,
      'goway:layers': GOWAY_STYLE_LAYER_ID_LIST,
      'goway:generator': 'packages/frontend/scripts/build-map-style.ts',
    },
    glyphs: endpoints.glyphs,
    ...(endpoints.sprite === undefined ? {} : { sprite: endpoints.sprite }),
    sources: {
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
    layers: buildLayers(palette, endpoints.sourceId),
  };
}

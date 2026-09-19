/**
 * Map SOURCE configuration — the one place a tile/style vendor is named.
 *
 * GoWay renders with MapLibre (see `components/map/`), but MapLibre is only the
 * renderer. WHERE the cartography comes from is a separate, replaceable
 * decision, and it lives here so that moving from OpenFreeMap to GoWay-hosted
 * PMTiles/vector tiles is a change to this file and nothing else — no feature
 * code, no component prop, no public SDK contract.
 *
 * Rules this file exists to enforce (GoWay AGENTS.md → "Product boundaries"):
 *
 *  - Feature code NEVER writes an OpenFreeMap URL. It asks for an appearance
 *    and gets a style back.
 *  - `tile.openstreetmap.org` is NEVER a production tile backend. OSM's tile
 *    servers are a raster debugging aid for hobby projects and their usage
 *    policy forbids app traffic; GoWay reads OSM-DERIVED vector tiles from a
 *    host that signed up to serve them.
 *  - Source and layer IDs are DOCUMENTED here, because GoWay's own style
 *    document and every overlay issue #5/#6 adds will target them by name.
 *
 * @see `packages/frontend/README.md` for the cartography notes and the native
 *      build requirement.
 */

/** Which of the two cartographic appearances a style document is for. */
export type MapAppearance = 'light' | 'dark';

/**
 * Attribution GoWay is obliged to display, in the form we render it.
 *
 * The OpenFreeMap style documents ship NO `attribution` on their sources, so
 * neither MapLibre's web `AttributionControl` nor the native attribution button
 * can derive it. GoWay therefore owns the credit line and renders it itself on
 * both platforms (`components/map/MapAttribution.tsx`), which also keeps it
 * inside our layout rather than in an engine-positioned ornament.
 */
export interface MapAttributionLink {
  label: string;
  href: string;
}

export interface MapAttribution {
  /** Leading, non-link text (may be empty). */
  prefix?: string;
  links: readonly MapAttributionLink[];
}

/**
 * The IDs a GoWay overlay or style tweak may rely on.
 *
 * These are OpenMapTiles/OpenFreeMap names, not ours — they are recorded so a
 * later GoWay-authored style document can keep the contract rather than
 * silently renaming layers that overlays are anchored to.
 */
export interface MapSourceIds {
  /** Vector source carrying the OpenMapTiles schema (roads, buildings, POIs…). */
  basemap: string;
  /** Raster relief source used at low zoom, when the style has one. */
  relief?: string;
  /**
   * Source-layers inside {@link MapSourceIds.basemap} that GoWay reads or
   * styles. OpenMapTiles schema v3 names.
   */
  sourceLayers: {
    building: string;
    landcover: string;
    landuse: string;
    park: string;
    place: string;
    poi: string;
    transportation: string;
    transportationName: string;
    water: string;
    waterName: string;
  };
  /**
   * Style-layer IDs GoWay anchors its own layers against with MapLibre's
   * `beforeId`, so overlays land under labels instead of on top of them.
   */
  anchors: {
    /**
     * Explicit "insert my overlay before this layer" hint, when the style
     * guarantees one.
     *
     * OpenFreeMap leaves this UNSET on purpose: `liberty`'s first symbol layer
     * is `road_one_way_arrow` and `fiord`'s is `water_name`, so there is no one
     * id that is correct in both appearances, and naming either would put
     * overlays in the wrong stratum half the time. The web adapter therefore
     * derives the first symbol layer from the style document it has actually
     * loaded; the native adapter, which cannot read the loaded style back,
     * appends GoWay layers on top. A GoWay-authored style document should set
     * this to a stable, reserved id and retire the derivation.
     */
    beforeLabels?: string;
    /** Background layer id, for appearance debugging. */
    background: string;
  };
}

export interface MapSourceConfig {
  /** Stable id for logging/telemetry, never shown to users. */
  id: string;
  /** Human label, e.g. for a future "map data" credit sheet. */
  label: string;
  /** Style document URL per appearance. */
  styleUrl: Record<MapAppearance, string>;
  attribution: MapAttribution;
  ids: MapSourceIds;
  minZoom: number;
  maxZoom: number;
}

/**
 * OpenMapTiles schema v3 source-layer names. Both OpenFreeMap styles below are
 * built on it, and so is every self-hosted planet build GoWay would move to, so
 * this block survives the vendor swap.
 */
const OPENMAPTILES_SOURCE_LAYERS: MapSourceIds['sourceLayers'] = {
  building: 'building',
  landcover: 'landcover',
  landuse: 'landuse',
  park: 'park',
  place: 'place',
  poi: 'poi',
  transportation: 'transportation',
  transportationName: 'transportation_name',
  water: 'water',
  waterName: 'water_name',
};

/**
 * OpenFreeMap — the initial hosted world vector source.
 *
 * Keyless, free, no plan, no per-tile billing, OSM-derived, OpenMapTiles
 * schema. `liberty` (light) carries the full layer set the product needs —
 * road hierarchy, buildings, land/water/parks, labels AND POIs. `fiord` is the
 * dark counterpart; it is the closest dark OpenFreeMap style that still keeps
 * parks and buildings, but it has NO `poi` source-layer, so POI pins are drawn
 * by GoWay's own marker layer in dark mode rather than by the basemap. Closing
 * that gap is what a GoWay-authored style document is for — the renderer
 * already accepts one, see {@link resolveMapStyleUrl}.
 */
export const OPENFREEMAP_SOURCE: MapSourceConfig = {
  id: 'openfreemap',
  label: 'OpenFreeMap',
  styleUrl: {
    light: 'https://tiles.openfreemap.org/styles/liberty',
    dark: 'https://tiles.openfreemap.org/styles/fiord',
  },
  attribution: {
    links: [
      { label: 'OpenFreeMap', href: 'https://openfreemap.org' },
      { label: '© OpenMapTiles', href: 'https://www.openmaptiles.org/' },
      { label: '© OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
    ],
  },
  ids: {
    basemap: 'openmaptiles',
    relief: 'ne2_shaded',
    sourceLayers: OPENMAPTILES_SOURCE_LAYERS,
    anchors: {
      // Deliberately no `beforeLabels` — see the field's docs.
      background: 'background',
    },
  },
  minZoom: 0,
  maxZoom: 20,
};

/**
 * Registry of the sources GoWay knows how to talk to. A GoWay-hosted PMTiles
 * build lands here as a second entry, selected by `EXPO_PUBLIC_MAP_SOURCE`.
 */
const SOURCES: Record<string, MapSourceConfig> = {
  [OPENFREEMAP_SOURCE.id]: OPENFREEMAP_SOURCE,
};

/**
 * The active source.
 *
 * Configuration-driven per AGENTS.md ("API origins and hosts are
 * configuration-driven"): a deployment picks the source with
 * `EXPO_PUBLIC_MAP_SOURCE`, and can override either style URL outright with
 * `EXPO_PUBLIC_MAP_STYLE_URL_LIGHT` / `_DARK` — which is how a GoWay style
 * document gets tried in staging without a code change. An unknown id falls
 * back to OpenFreeMap rather than throwing: a typo in an env var must not be
 * able to leave the app with no map at all.
 */
export function getMapSource(): MapSourceConfig {
  const requested = process.env.EXPO_PUBLIC_MAP_SOURCE;
  const base = (requested && SOURCES[requested]) || OPENFREEMAP_SOURCE;

  const light = process.env.EXPO_PUBLIC_MAP_STYLE_URL_LIGHT;
  const dark = process.env.EXPO_PUBLIC_MAP_STYLE_URL_DARK;
  if (!light && !dark) return base;

  return {
    ...base,
    styleUrl: {
      light: light || base.styleUrl.light,
      dark: dark || base.styleUrl.dark,
    },
  };
}

/** The style document URL for an appearance. The ONLY way to obtain one. */
export function resolveMapStyleUrl(appearance: MapAppearance): string {
  return getMapSource().styleUrl[appearance];
}

/** The attribution GoWay must display for the active source. */
export function resolveMapAttribution(): MapAttribution {
  return getMapSource().attribution;
}

/**
 * Namespace for every source/layer GoWay adds on top of the basemap.
 *
 * Prefixing is not cosmetic: MapLibre keys sources and layers in one flat
 * namespace shared with the vendor's style document, so an unprefixed
 * `"buildings"` overlay would collide with whatever the next style calls its
 * own. Everything GoWay owns starts with `goway:`.
 */
export const GOWAY_LAYER_PREFIX = 'goway:';

/** Source id for a GoWay overlay. */
export function overlaySourceId(overlayId: string): string {
  return `${GOWAY_LAYER_PREFIX}src:${overlayId}`;
}

/** Layer id for a GoWay overlay's rendered role. */
export function overlayLayerId(overlayId: string, role: string): string {
  return `${GOWAY_LAYER_PREFIX}${role}:${overlayId}`;
}

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
 * ## What changed with GoWay's own style document
 *
 * The cartography is now GoWay's (`lib/map/style/`), built against the same
 * OpenMapTiles v3 schema OpenFreeMap serves and rendered to
 * `public/map/goway-{light,dark}.json` by `scripts/build-map-style.ts`. The
 * *tiles*, *glyphs* and *sprite* are still OpenFreeMap's, and they are still
 * named only here — the style builder takes every endpoint as an argument.
 *
 * Three consequences worth knowing:
 *
 *  - {@link MapSourceIds.anchors.beforeLabels} is finally KNOWABLE, because one
 *    document defines both appearances with an identical layer list. Overlays
 *    stop guessing.
 *  - Dark mode has POIs. No OpenFreeMap dark style ships a `poi` source-layer;
 *    GoWay's does, in both appearances.
 *  - `openfreemap` remains registered as a fallback source, so a bad style
 *    deploy is one env var away from being routed around.
 *
 * @see `packages/frontend/README.md` for the cartography notes and the native
 *      build requirement.
 */
import { OPENMAPTILES_SOURCE_LAYERS } from './style/schema';

/** Which of the two cartographic appearances a style document is for. */
export type MapAppearance = 'light' | 'dark';

/**
 * Attribution GoWay is obliged to display, in the form we render it.
 *
 * The OpenFreeMap style documents ship NO `attribution` on their sources, so
 * neither MapLibre's web `AttributionControl` nor the native attribution button
 * can derive it. GoWay therefore owns the credit line and renders it itself on
 * both platforms (`components/map/MapAttribution.tsx`), which also keeps it
 * inside our layout rather than in an engine-positioned ornament. GoWay's own
 * style document additionally stamps {@link ATTRIBUTION_HTML} onto its source,
 * so the obligation travels with the document.
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
 * The reserved layer id GoWay's style document places between the basemap and
 * its labels.
 *
 * It lives here rather than in `lib/map/style/` because this file is the id
 * contract: `MapSourceIds.anchors.beforeLabels` is what both map adapters read,
 * and an id that two adapters and a style generator all depend on belongs in
 * one place. The style document realises it as a zero-opacity `background`
 * layer — it draws nothing; its entire purpose is to be a stable name.
 */
export const GOWAY_LABEL_ANCHOR_LAYER_ID = 'goway:anchor:labels';

/**
 * The IDs a GoWay overlay or style tweak may rely on.
 *
 * These are OpenMapTiles/OpenFreeMap names for the schema, and GoWay's own for
 * the anchors — recorded so that a style change keeps the contract rather than
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
  sourceLayers: typeof OPENMAPTILES_SOURCE_LAYERS;
  /**
   * Style-layer IDs GoWay anchors its own layers against with MapLibre's
   * `beforeId`, so overlays land under labels instead of on top of them.
   */
  anchors: {
    /**
     * "Insert my overlay before this layer", when the style guarantees one.
     *
     * OpenFreeMap leaves this UNSET on purpose: `liberty`'s first symbol layer
     * is `road_one_way_arrow` and `fiord`'s is `water_name`, so there is no one
     * id correct in both appearances, and naming either would put overlays in
     * the wrong stratum half the time.
     *
     * GoWay's own style document sets it, which is most of the reason to have
     * one. Both appearances are generated from a single layer list, so the
     * anchor is at the same index in both, and
     * {@link GOWAY_LABEL_ANCHOR_LAYER_ID} is a layer that exists to be named
     * rather than a label layer we happen to have noticed. Web stops deriving
     * the first symbol layer from the loaded style; native — which cannot read
     * the loaded style back at all — stops appending overlays on top.
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
  /** Style document URL per appearance. May be origin-relative; see
   *  {@link resolveMapStyleUrl}. */
  styleUrl: Record<MapAppearance, string>;
  attribution: MapAttribution;
  ids: MapSourceIds;
  minZoom: number;
  maxZoom: number;
}

/**
 * OpenFreeMap's raw endpoints — tiles, glyphs, sprite.
 *
 * This is the vendor boundary. `lib/map/style/` names no host at all; it takes
 * these three strings as arguments, which is what makes swapping in
 * GoWay-hosted PMTiles a change to this constant and nothing else.
 *
 * `tileJson` is the TileJSON *document*, not a `{z}/{x}/{y}` template: the
 * document carries the current planet build's date-stamped tile path, so the
 * style never pins a build that will later be deleted.
 */
export const OPENFREEMAP_ENDPOINTS = {
  tileJson: 'https://tiles.openfreemap.org/planet',
  glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
  sprite: 'https://tiles.openfreemap.org/sprites/ofm_f384/ofm',
} as const;

/** The credit line, as HTML, for the `attribution` field of a style source. */
export const ATTRIBUTION_HTML =
  '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> ' +
  '<a href="https://www.openmaptiles.org/" target="_blank">&copy; OpenMapTiles</a> ' +
  'Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

const ATTRIBUTION: MapAttribution = {
  links: [
    { label: 'OpenFreeMap', href: 'https://openfreemap.org' },
    { label: '© OpenMapTiles', href: 'https://www.openmaptiles.org/' },
    { label: '© OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
  ],
};

/** The vector source id inside GoWay's style document. */
export const GOWAY_BASEMAP_SOURCE_ID = 'openmaptiles';

/**
 * Where the generated style documents are served from, relative to the app's
 * own origin.
 *
 * `expo export --platform web` copies `public/` into `dist/` verbatim and
 * `wrangler.toml` serves `dist/`, so these paths are live on `goway.to` with no
 * deploy step of their own. See {@link resolveMapStyleUrl} for how a *native*
 * build — which has no origin — resolves them.
 */
const GOWAY_STYLE_PATHS: Record<MapAppearance, string> = {
  light: '/map/goway-light.json',
  dark: '/map/goway-dark.json',
};

/** GoWay's canonical origin (AGENTS.md → Product boundaries). */
const GOWAY_ORIGIN = 'https://goway.to';

/**
 * GoWay's own cartography over OpenFreeMap's tiles — the default source.
 *
 * The style document is ours (`lib/map/style/`); the tiles underneath it are
 * still OpenFreeMap's, keyless and free, in the OpenMapTiles v3 schema. That
 * split is the whole point: the visual identity can move without the data
 * moving, and the data can move without the visual identity moving.
 */
export const GOWAY_SOURCE: MapSourceConfig = {
  id: 'goway',
  label: 'GoWay (OpenFreeMap tiles)',
  styleUrl: GOWAY_STYLE_PATHS,
  attribution: ATTRIBUTION,
  ids: {
    basemap: GOWAY_BASEMAP_SOURCE_ID,
    // No relief raster: the supplied palette hides `landscape.natural.terrain`,
    // and a hillshade is a second network dependency for a decoration the
    // design does not use.
    sourceLayers: OPENMAPTILES_SOURCE_LAYERS,
    anchors: {
      beforeLabels: GOWAY_LABEL_ANCHOR_LAYER_ID,
      background: 'background',
    },
  },
  minZoom: 0,
  maxZoom: 20,
};

/**
 * OpenFreeMap's own style documents — kept as a fallback, not as the default.
 *
 * `liberty` (light) carries the full layer set including POIs. `fiord` is the
 * dark counterpart and has NO `poi` source-layer, so dark mode under this
 * source has no basemap POIs at all — the gap {@link GOWAY_SOURCE} exists to
 * close. Selecting it with `EXPO_PUBLIC_MAP_SOURCE=openfreemap` is the escape
 * hatch if a GoWay style deploy ever goes wrong: no rebuild, one env var.
 */
export const OPENFREEMAP_SOURCE: MapSourceConfig = {
  id: 'openfreemap',
  label: 'OpenFreeMap',
  styleUrl: {
    light: 'https://tiles.openfreemap.org/styles/liberty',
    dark: 'https://tiles.openfreemap.org/styles/fiord',
  },
  attribution: ATTRIBUTION,
  ids: {
    basemap: GOWAY_BASEMAP_SOURCE_ID,
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
 * build lands here as a third entry, selected by `EXPO_PUBLIC_MAP_SOURCE`.
 */
const SOURCES: Record<string, MapSourceConfig> = {
  [GOWAY_SOURCE.id]: GOWAY_SOURCE,
  [OPENFREEMAP_SOURCE.id]: OPENFREEMAP_SOURCE,
};

/**
 * The active source.
 *
 * Configuration-driven per AGENTS.md ("API origins and hosts are
 * configuration-driven"): a deployment picks the source with
 * `EXPO_PUBLIC_MAP_SOURCE`, and can override either style URL outright with
 * `EXPO_PUBLIC_MAP_STYLE_URL_LIGHT` / `_DARK`. An unknown id falls back to
 * {@link GOWAY_SOURCE} rather than throwing: a typo in an env var must not be
 * able to leave the app with no map at all.
 *
 * An outright style override also **clears `beforeLabels`**. The anchor is a
 * promise about the document at that URL, and an overridden URL is by
 * definition a document this file has not seen; keeping the anchor would have
 * overlays silently anchored to a layer that does not exist, which MapLibre
 * treats as "append on top" without complaining. Dropping it puts both adapters
 * back on their derived-anchor path, which is merely imprecise rather than
 * wrong.
 */
export function getMapSource(): MapSourceConfig {
  const requested = process.env.EXPO_PUBLIC_MAP_SOURCE;
  const base = (requested && SOURCES[requested]) || GOWAY_SOURCE;

  const light = process.env.EXPO_PUBLIC_MAP_STYLE_URL_LIGHT;
  const dark = process.env.EXPO_PUBLIC_MAP_STYLE_URL_DARK;
  if (!light && !dark) return base;

  return {
    ...base,
    styleUrl: {
      light: light || base.styleUrl.light,
      dark: dark || base.styleUrl.dark,
    },
    ids: {
      ...base.ids,
      anchors: { background: base.ids.anchors.background },
    },
  };
}

/**
 * Turn a possibly origin-relative style path into something both engines can
 * fetch.
 *
 * Web can fetch `/map/goway-light.json` as-is, but MapLibre Native cannot: a
 * native app has no origin, so a relative URL resolves against nothing. The
 * order below is the one that keeps every environment working without a branch
 * in feature code:
 *
 *  1. Already absolute → untouched. This is how `EXPO_PUBLIC_MAP_STYLE_URL_*`
 *     and the `openfreemap` fallback both work.
 *  2. `EXPO_PUBLIC_MAP_STYLE_ORIGIN` → used. This is the knob a **native dev
 *     build** needs: point it at the Metro dev server (`http://<lan-ip>:8081`)
 *     and the app renders the style you are editing instead of the deployed one.
 *  3. A browser origin → used. Covers `expo start --web` and the deployed SPA
 *     alike, and means a preview deployment styles itself from its own bundle.
 *  4. Otherwise `https://goway.to` — a native build with nothing configured
 *     reads the production style. Stated plainly because it is a real coupling:
 *     a native binary in the field depends on that path staying served.
 */
function absoluteStyleUrl(url: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;

  const configured = process.env.EXPO_PUBLIC_MAP_STYLE_ORIGIN;
  if (configured) return `${configured.replace(/\/+$/, '')}${url}`;

  const browserOrigin =
    typeof window !== 'undefined' && window.location?.origin ? window.location.origin : undefined;

  return `${browserOrigin ?? GOWAY_ORIGIN}${url}`;
}

/** The style document URL for an appearance. The ONLY way to obtain one. */
export function resolveMapStyleUrl(appearance: MapAppearance): string {
  return absoluteStyleUrl(getMapSource().styleUrl[appearance]);
}

/** The attribution GoWay must display for the active source. */
export function resolveMapAttribution(): MapAttribution {
  return getMapSource().attribution;
}

/**
 * The anchor ids for the active source.
 *
 * Both map adapters call this instead of reasoning about the style themselves.
 * `beforeLabels` is `undefined` whenever the loaded document cannot be promised
 * to contain the anchor, and the adapters fall back accordingly.
 */
export function resolveMapAnchors(): MapSourceIds['anchors'] {
  return getMapSource().ids.anchors;
}

/**
 * Namespace for every source/layer GoWay adds on top of the basemap.
 *
 * Prefixing is not cosmetic: MapLibre keys sources and layers in one flat
 * namespace shared with the vendor's style document, so an unprefixed
 * `"buildings"` overlay would collide with whatever the next style calls its
 * own. Everything GoWay owns starts with `goway:` — including the anchor layer
 * inside GoWay's own style document.
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

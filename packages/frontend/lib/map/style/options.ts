/**
 * A style's SWITCHES over the one shared layer list (`layers.ts`): which
 * layers draw and how densely. Colour is `themes.ts`'s; this is everything
 * else a style may change (`docs/MAP_STYLES.md`).
 *
 * Its own module, free of any palette or token import, because `layers.ts`
 * needs the type and Standard's defaults and nothing more.
 */
export interface StyleOptions {
  /**
   * How many places the map marks and names: `standard` is Standard's
   * curated density; `dense` lowers the caps and the zooms (Streets); `none`
   * draws no POI at all (the data basemaps).
   */
  poi: 'none' | 'standard' | 'dense';
  /** House numbers from this zoom, or never. */
  houseNumbersFrom: number | null;
  /** Street names in capitals (Standard's look) or as the sign writes them. */
  roadLabelCase: 'upper' | 'as-written';
  /** Which streets are named: every class, or arterials and up only. */
  roadLabels: 'all' | 'arterial';
  /** One-way arrows from z15. */
  oneway: boolean;
  /** The zoom building footprints start to fade in at. */
  buildingsFrom: number;
  /**
   * The terrain map (`docs/MAP_STYLES.md` → Outdoors): the document carries
   * its own hillshade and contour lines (both from GoWay's elevation tiles),
   * bare rock and glaciers, trails by difficulty, lifts, peaks with their
   * heights, and the huts, shelters, viewpoints, campsites and drinking water
   * every other style leaves out. Needs the palette's `outdoors` ink.
   */
  outdoors: boolean;
  /**
   * Over GoWay's satellite imagery (`lib/map/style/imagery.ts`): `satellite`
   * keeps only the anchors, `hybrid` the roads, boundaries and labels over a
   * photograph. Absent, the map draws its own ground.
   */
  imagery?: 'satellite' | 'hybrid';
}

/** Standard: the curated look every other style starts from. */
export const STANDARD_OPTIONS: StyleOptions = {
  poi: 'standard',
  houseNumbersFrom: 18,
  roadLabelCase: 'upper',
  roadLabels: 'all',
  oneway: true,
  buildingsFrom: 15,
  outdoors: false,
};

/** Streets: more places, earlier footprints, house numbers a zoom sooner. */
export const STREETS_OPTIONS: StyleOptions = {
  poi: 'dense',
  houseNumbersFrom: 17,
  roadLabelCase: 'as-written',
  roadLabels: 'all',
  oneway: true,
  buildingsFrom: 14,
  outdoors: false,
};

/** Light and Dark: a quiet ground for somebody else's data. */
export const DATA_OPTIONS: StyleOptions = {
  poi: 'none',
  houseNumbersFrom: null,
  roadLabelCase: 'as-written',
  roadLabels: 'arterial',
  oneway: false,
  buildingsFrom: 15,
  outdoors: false,
};

/**
 * Outdoors: Standard's density and look, plus the terrain (contours,
 * hillshade, rock, glaciers, trails, lifts, peaks, huts). Streets named as
 * written — in the mountains a road name is a way, not an address.
 */
export const OUTDOORS_OPTIONS: StyleOptions = {
  poi: 'standard',
  houseNumbersFrom: null,
  roadLabelCase: 'as-written',
  roadLabels: 'all',
  oneway: false,
  buildingsFrom: 15,
  outdoors: true,
};

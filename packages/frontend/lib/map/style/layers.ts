/**
 * The layer list — GoWay's cartography, expressed against the OpenMapTiles
 * schema in `schema.ts` and coloured from `palette.ts`.
 *
 * ## The one rule this file enforces
 *
 * **Light and dark emit the same layer ids, in the same order.** Only `paint`
 * and `layout` differ between appearances. That is what makes
 * {@link GOWAY_STYLE_LAYER_IDS} a contract rather than a description: an
 * overlay anchored with `beforeId` behaves identically in both appearances, a
 * route line lands in the same stratum, and switching the theme cannot move
 * anything but colour. It is also exactly what OpenFreeMap could not offer —
 * `liberty` and `fiord` are two unrelated documents that happen to read the
 * same tiles, which is why `MapSourceIds.anchors.beforeLabels` had to be left
 * unset until now.
 *
 * ## Stacking order
 *
 * Bottom to top: ground → green space → water → aeroways → roads → buildings →
 * boundaries → **{@link LABEL_ANCHOR_LAYER_ID}** → labels. Everything below the
 * anchor is terrain; everything above it is type. GoWay overlays insert
 * *before* the anchor, so a route line covers the roads and passes under every
 * label.
 *
 * Road casings all sit below all road fills rather than being interleaved per
 * tier, which is what gives clean junctions where a minor road meets a trunk.
 *
 * ## Collision priority
 *
 * MapLibre places symbols starting from the **last** symbol layer, so a label
 * later in this array wins a collision against an earlier one. Place labels are
 * therefore last: on a label-forward map the city name is the thing that must
 * never be the one that disappears. POI labels sit above road labels for the
 * same reason — a shop you can tap outranks the name of the street it is on.
 */
import type {
  ExpressionSpecification,
  FilterSpecification,
  LayerSpecification,
} from '@maplibre/maplibre-gl-style-spec';

import { GOWAY_LABEL_ANCHOR_LAYER_ID } from '../provider';
import type { CartographyPalette, RoadTier, RoadTone } from './palette';
import { OPENMAPTILES_SOURCE_LAYERS as SL } from './schema';
import { LOCAL_ROAD_FILL, SHOW_BASEMAP_POIS, SHOW_ROAD_AND_POI_LABELS } from './tuning';

/**
 * The reserved anchor layer, re-exported from the id contract in `provider.ts`.
 *
 * It is realised below as a zero-opacity `background` that draws nothing and
 * exists only to be a **stable id between the basemap and the labels**.
 * `provider.ts` publishes it as `MapSourceIds.anchors.beforeLabels`, and both
 * map adapters pass it to MapLibre as `beforeId`, so a GoWay overlay is
 * inserted under the type layer without either adapter having to guess which
 * layer that is.
 *
 * It carries the `goway:` prefix for the same reason every overlay does:
 * MapLibre keys layers in one flat namespace shared with whatever style is
 * loaded, so an id that could collide with a vendor's eventually will.
 */
export const LABEL_ANCHOR_LAYER_ID = GOWAY_LABEL_ANCHOR_LAYER_ID;

/**
 * Every layer id this style can emit, grouped by stratum.
 *
 * **This is the published contract.** Overlays (#5 search pins, #6 route
 * lines), later GoWay styles and anything that calls `map.setPaintProperty`
 * target these by name, so an id here is as good as public API: rename one and
 * a caller fails silently, because MapLibre ignores an unknown layer id rather
 * than raising.
 *
 * Ids marked *(flag)* are omitted when the matching constant in `tuning.ts` is
 * switched off; the validator therefore checks that what is emitted is a subset
 * of this list, not that it equals it.
 */
export const GOWAY_STYLE_LAYER_IDS = {
  /** The paint under everything. */
  base: ['background'],
  /** `landcover` + `landuse` + `park` fills. */
  ground: [
    'landuse-built-up',
    'landcover-farmland',
    'landcover-natural',
    'landcover-ice',
    'landcover-wetland',
    'landcover-sand',
    'landuse-pitch',
    'landuse-cemetery',
    'landuse-medical',
    'landuse-institution',
    'landuse-park',
    'park',
    'park-outline',
  ],
  water: ['water', 'waterway'],
  aeroway: ['aeroway-area', 'aeroway-runway', 'aeroway-taxiway'],
  /** Casings first, then fills — see the stacking note above. */
  /**
   * Every road tier twice — its casing, then its fill — with all casings
   * emitted before all fills. Ids are named after the OpenMapTiles
   * `transportation.class` they draw, so a filter and an id can never disagree
   * about which roads they mean.
   */
  roads: [
    'road-tunnel-casing',
    'road-tunnel',
    'road-service-casing',
    'road-track-casing',
    'road-local-casing',
    'road-tertiary-casing',
    'road-secondary-casing',
    'road-primary-casing',
    'road-trunk-link-casing',
    'road-trunk-casing',
    'road-motorway-link-casing',
    'road-motorway-casing',
    'road-service',
    'road-track',
    'road-local',
    'road-tertiary',
    'road-secondary',
    'road-primary',
    'road-trunk-link',
    'road-trunk',
    'road-motorway-link',
    'road-motorway',
    'road-path',
    'road-ferry',
    'road-rail',
    'road-rail-hatch',
  ],
  structures: ['building'],
  boundaries: ['boundary-region', 'boundary-country'],
  /** The reserved overlay anchor. Nothing renders it. */
  anchor: [LABEL_ANCHOR_LAYER_ID],
  /** POI markers. All *(flag)* — `SHOW_BASEMAP_POIS`. */
  poi: ['poi-dot', 'poi-dot-minor', 'poi-transit-dot'],
  /** Type. `label-road-*` and `label-poi*` are *(flag)* —
   *  `SHOW_ROAD_AND_POI_LABELS`. */
  labels: [
    'label-waterway',
    'label-water-line',
    'label-water-point',
    'label-road-local',
    'label-road-arterial',
    'label-road-highway',
    'label-poi-minor',
    'label-poi',
    'label-poi-transit',
    'label-aerodrome',
    'label-park',
    'label-place-minor',
    'label-place-village',
    'label-place-town',
    'label-place-city',
    'label-place-region',
    'label-place-country',
  ],
} as const;

/** The catalogue flattened, for validation and documentation. */
export const GOWAY_STYLE_LAYER_ID_LIST: readonly string[] = Object.values(
  GOWAY_STYLE_LAYER_IDS,
).flat();

// ---------------------------------------------------------------------------
// Expression helpers
// ---------------------------------------------------------------------------

/**
 * The style spec's `ExpressionSpecification` is a deeply recursive tuple union.
 * TypeScript cannot infer it from an array literal without an `as const` on
 * every nested level, which makes a 900-line layer list unreadable for no
 * safety gain — the layer list is validated against the *real* spec at build
 * time by `scripts/build-map-style.ts`, which is a stronger check than the
 * types are. These two casts are where that trade is made, and nowhere else.
 */
const expr = (value: unknown): ExpressionSpecification => value as ExpressionSpecification;
const filter = (value: unknown): FilterSpecification => value as FilterSpecification;

/** `[zoom, value]` stops as an exponential zoom interpolation. */
function byZoom(stops: readonly (readonly [number, number])[], base = 1.4): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['exponential', base], ['zoom']];
  for (const [zoom, value] of stops) out.push(zoom, value);
  return expr(out);
}

/** Linear `[zoom, colour]` stops, for paint that fades in rather than scales. */
function colorByZoom(stops: readonly (readonly [number, string])[]): ExpressionSpecification {
  const out: unknown[] = ['interpolate', ['linear'], ['zoom']];
  for (const [zoom, value] of stops) out.push(zoom, value);
  return expr(out);
}

const IS_POINT = expr(['match', ['geometry-type'], ['Point', 'MultiPoint'], true, false]);
const IS_LINE = expr(['match', ['geometry-type'], ['LineString', 'MultiLineString'], true, false]);
const IS_POLYGON = expr(['match', ['geometry-type'], ['Polygon', 'MultiPolygon'], true, false]);

/** `class` is one of these. */
const classIn = (...values: string[]): ExpressionSpecification =>
  expr(['match', ['get', 'class'], values, true, false]);

/**
 * The label text.
 *
 * `name:latin` first, then `name`. Deliberately NOT `name_en` first, the way
 * OpenFreeMap's styles do it: GoWay is a map of where you are, and a street in
 * Barcelona is called what the sign says it is called. `name:latin` is the
 * tile's own transliteration, so a Tokyo label still renders in a stack the
 * glyph server can serve, without forcing English onto a Spanish city.
 */
const LABEL_TEXT = expr(['coalesce', ['get', 'name:latin'], ['get', 'name'], '']);

const REGULAR = ['Noto Sans Regular'];
const BOLD = ['Noto Sans Bold'];

// ---------------------------------------------------------------------------
// POI vocabulary
// ---------------------------------------------------------------------------

/**
 * POI classes that are pure clutter on a consumer map.
 *
 * Every one of these is real, mapped, and something Apple Maps never shows you:
 * bollards, kissing gates, cycle barriers, waste baskets, payphones. OSM maps
 * the street furniture because OSM maps everything; a map you use to find a
 * restaurant should not spend a pin on a bollard. Filtering them out is the
 * single largest noise reduction in this style.
 */
const POI_CLUTTER_CLASSES = [
  'bollard', 'brownfield', 'bicycle_parking', 'cycle_barrier', 'drinking_water', 'entrance',
  'gate', 'lift_gate', 'motorcycle_parking', 'multi', 'recycling', 'sally_port', 'shelter',
  'stile', 'telephone', 'toll_booth', 'waste_basket',
];

/**
 * The classes drawn by the dedicated transit layers, from z14 — earlier than
 * any other POI, because a station is a landmark and a destination at once.
 *
 * `bus` is deliberately NOT here even though it is coloured as transit.
 * Decoding real tiles over Tokyo and London showed bus stops outnumbering every
 * other named POI combined; promoting them to z14 would bury those cities under
 * their own bus network. They stay in the general pool, where `rank` stages
 * them like any other POI.
 */
const POI_STATION_CLASSES = ['railway', 'ferry_terminal'];

/**
 * OpenMapTiles `poi.class` → {@link CartographyPalette.poi} group.
 *
 * The class list is the one observed in real tiles (`schema.ts`); anything not
 * named here falls to `other`, so an unmapped class is a quiet grey dot rather
 * than a missing one.
 */
const POI_GROUPS: readonly (readonly [keyof CartographyPalette['poi'], string[]])[] = [
  ['foodDrink', ['restaurant', 'fast_food', 'cafe', 'bar', 'beer', 'ice_cream']],
  ['shopping', ['shop', 'clothing_store', 'grocery', 'alcohol_shop', 'bakery', 'butcher', 'hairdresser', 'laundry']],
  ['outdoors', ['park', 'garden', 'playground', 'pitch', 'dog_park', 'picnic_site', 'golf', 'zoo', 'sports_centre', 'stadium', 'swimming_pool', 'ice_rink', 'athletics', 'cycling', 'running', 'yoga', 'boxing', 'gymnastics', 'equestrian']],
  ['transit', ['bus', ...POI_STATION_CLASSES]],
  ['lodging', ['lodging']],
  ['health', ['hospital', 'pharmacy', 'doctors', 'dentist', 'veterinary']],
  ['civic', ['school', 'college', 'library', 'town_hall', 'police', 'fire_station', 'post', 'office', 'bank', 'atm']],
  ['culture', ['museum', 'art_gallery', 'theatre', 'cinema', 'attraction', 'monument', 'castle', 'aquarium', 'music', 'escape_game', 'hackerspace']],
  ['worship', ['place_of_worship', 'cemetery']],
  ['vehicle', ['parking', 'fuel', 'car', 'bicycle', 'bicycle_rental', 'motorcycle']],
];

/** `match` on `poi.class` producing the group's colour. */
function poiColor(palette: CartographyPalette): ExpressionSpecification {
  const match: unknown[] = ['match', ['get', 'class']];
  for (const [group, classes] of POI_GROUPS) match.push(classes, palette.poi[group]);
  match.push(palette.poi.other);
  return expr(match);
}

/**
 * Classes held back to the minor tier regardless of how well they rank.
 *
 * Measured, not guessed: evaluating this style against real z16 tiles over
 * Manhattan put **155 bus stops** in the major POI tier — more than every other
 * category combined, and enough to turn midtown into a field of identical dots.
 * `rank` cannot fix that, because within a tile a bus stop legitimately ranks
 * high. So the very-high-frequency furniture is demoted by class instead, and
 * reappears at z17 with everything else.
 */
const POI_LATE_CLASSES = ['bus', 'atm', 'post', 'toilets', 'picnic_site', 'bicycle_rental'];

/** Which of the three POI layers a filter is for. */
type PoiTier = 'station' | 'major' | 'minor';

/**
 * The shared POI eligibility test: a named point that is not clutter.
 *
 * `has name` is doing real work — an unnamed POI cannot be recognised, tapped
 * with intent, or searched for, so drawing it only costs the map contrast.
 */
function poiFilter(tier: PoiTier): FilterSpecification {
  const notClutter = ['!', ['in', ['get', 'class'], ['literal', POI_CLUTTER_CLASSES]]];
  const rank = ['coalesce', ['get', 'rank'], 999];

  if (tier === 'station') {
    return filter([
      'all',
      IS_POINT,
      ['has', 'name'],
      ['in', ['get', 'class'], ['literal', POI_STATION_CLASSES]],
      ['<=', rank, POI_MINOR_MAX_RANK],
    ]);
  }

  const notStation = ['!', ['in', ['get', 'class'], ['literal', POI_STATION_CLASSES]]];

  if (tier === 'major') {
    return filter([
      'all',
      IS_POINT,
      ['has', 'name'],
      notClutter,
      notStation,
      ['!', ['in', ['get', 'class'], ['literal', POI_LATE_CLASSES]]],
      ['<=', rank, POI_MAJOR_MAX_RANK],
    ]);
  }

  // Everything the major tier turned away, and nothing it took.
  return filter([
    'all',
    IS_POINT,
    ['has', 'name'],
    notClutter,
    notStation,
    ['<=', rank, POI_MINOR_MAX_RANK],
    ['any', ['>', rank, POI_MAJOR_MAX_RANK], ['in', ['get', 'class'], ['literal', POI_LATE_CLASSES]]],
  ]);
}

/**
 * `rank` in the `poi` source-layer is an importance ordering *within a tile*,
 * so a cap on it is a density cap that behaves the same in Manhattan and in a
 * village — far better than a zoom threshold, which is a density cap only in
 * the city it was tuned for.
 */
const POI_MAJOR_MAX_RANK = 8;
const POI_MINOR_MAX_RANK = 24;

// ---------------------------------------------------------------------------
// Road geometry
// ---------------------------------------------------------------------------

/**
 * Widths, in px, per zoom, per tier — the **fill** width.
 *
 * This table *is* the road hierarchy. Every tier is white or near-white, so
 * colour ranks nothing; what tells you which road is the through route is how
 * wide it is. The ratios are held roughly constant across zoom — a motorway is
 * ~1.5× a primary and ~3× a residential street at every scale — which is what
 * keeps the network legible while zooming instead of re-ranking as you go.
 *
 * The ramps are tuned to be readable from z10 (a motorway at 3px, a primary at
 * 2px, residential streets not yet drawn) through z18 (ribbons wide enough to
 * carry a label inside them).
 */
const ROAD_WIDTHS = {
  motorway: [[5, 0.6], [8, 1.6], [10, 3], [12, 5], [14, 8], [16, 16], [18, 34], [20, 70]],
  motorwayLink: [[11, 1.4], [13, 2.4], [14, 3.6], [16, 7.5], [18, 16], [20, 32]],
  trunk: [[6, 0.6], [9, 1.6], [10, 2.6], [12, 4.2], [14, 6.6], [16, 13], [18, 28], [20, 58]],
  trunkLink: [[11, 1.2], [13, 2.1], [14, 3.2], [16, 6.5], [18, 14], [20, 28]],
  primary: [[7, 0.5], [10, 2], [12, 3.2], [14, 5.2], [16, 10.5], [18, 22], [20, 46]],
  secondary: [[9, 0.5], [11, 1.4], [12, 2.3], [14, 4.2], [16, 8.6], [18, 19], [20, 40]],
  tertiary: [[10, 0.5], [12, 1.6], [14, 3.3], [16, 7], [18, 16], [20, 34]],
  local: [[12, 0.6], [13, 1.2], [14, 2.2], [16, 5.5], [18, 13], [20, 28]],
  service: [[13, 0.5], [14, 1], [16, 3], [18, 7], [20, 16]],
  track: [[13, 0.5], [14, 0.9], [16, 2.2], [18, 4.5], [20, 9]],
  path: [[14, 0.8], [16, 1.4], [18, 2.4], [20, 4.5]],
  tunnel: [[12, 1.2], [14, 2.6], [16, 5.5], [18, 12], [20, 24]],
  rail: [[11, 0.5], [14, 1], [16, 1.8], [18, 3], [20, 5]],
  railHatch: [[14, 2.5], [16, 3.6], [18, 5.5], [20, 8]],
  ferry: [[8, 0.6], [12, 1], [16, 1.8], [20, 3]],
} as const satisfies Record<string, readonly (readonly [number, number])[]>;

/**
 * How much wider than its fill a casing is drawn, per zoom.
 *
 * A **constant additive**, not a ratio, and that is the whole trick. A ratio
 * makes a motorway's casing four times thicker than a residential street's, so
 * the edge weight itself becomes a second hierarchy competing with the width
 * one. A constant gives every road the same fine edge — the line looks drawn
 * with one pen — and it only grows with zoom because at z18 a one-pixel edge on
 * a 34-pixel ribbon disappears.
 */
const CASING_DELTA: readonly (readonly [number, number])[] = [
  [8, 0.7], [10, 0.8], [12, 1.0], [14, 1.4], [16, 2.2], [18, 3.4], [20, 5.2],
];

function casingDeltaAt(zoom: number): number {
  const stops = CASING_DELTA;
  if (zoom <= stops[0][0]) return stops[0][1];
  const last = stops[stops.length - 1];
  if (zoom >= last[0]) return last[1];
  for (let i = 1; i < stops.length; i += 1) {
    const [z0, d0] = stops[i - 1];
    const [z1, d1] = stops[i];
    if (zoom <= z1) return d0 + ((d1 - d0) * (zoom - z0)) / (z1 - z0);
  }
  return last[1];
}

/**
 * A tier's casing width, derived from its fill width.
 *
 * Derived rather than written down a second time: two hand-maintained ramps
 * drift, and a casing narrower than its fill at one zoom stop is a road that
 * loses its edge in a band and gets it back — visible, and almost impossible to
 * find by reading the table.
 */
function casingWidths(
  fillStops: readonly (readonly [number, number])[],
): readonly (readonly [number, number])[] {
  return fillStops.map(([zoom, width]) => {
    // CLAMPED to a share of the fill, and the clamp is what rescues low zoom.
    // A residential street is 0.6px wide at z12; adding a flat 0.9px pen to
    // each side makes the casing four times the road, so a town renders as a
    // tangle of warm-grey lines with a white thread inside them instead of a
    // street network. Past ~z14 the clamp never binds and the constant pen
    // takes over, which is where it belongs.
    const pen = Math.min(casingDeltaAt(zoom) * 2, width * 1.2);
    return [zoom, Number((width + pen).toFixed(2))] as const;
  });
}

/** Roads at or above the surface. Tunnels are drawn by their own layer. */
const NOT_TUNNEL = expr(['!=', ['get', 'brunnel'], 'tunnel']);
/** Slip roads. Rendered thinner so an interchange does not read as a junction. */
const IS_RAMP = expr(['==', ['get', 'ramp'], 1]);

/**
 * The road tiers, bottom to top, each bound to the `transportation.class`
 * values it draws.
 *
 * One table drives the casing pass, the fill pass and the id contract, so a
 * tier cannot exist in one and not the others. Order here is paint order:
 * quietest first, so a motorway is drawn over the service road it crosses.
 */
const ROAD_TIERS: readonly {
  id: string;
  tier: RoadTier;
  classes: readonly string[];
  widths: readonly (readonly [number, number])[];
  minzoom: number;
  /** Slip roads only (`ramp = 1`), or explicitly not slip roads. */
  ramp?: boolean;
  /** Dashed, and therefore casing-less. */
  dash?: number[];
}[] = [
  { id: 'road-service', tier: 'service', classes: ['service'], widths: ROAD_WIDTHS.service, minzoom: 13 },
  { id: 'road-track', tier: 'track', classes: ['track'], widths: ROAD_WIDTHS.track, minzoom: 13 },
  { id: 'road-local', tier: 'local', classes: ['minor'], widths: ROAD_WIDTHS.local, minzoom: 12 },
  { id: 'road-tertiary', tier: 'tertiary', classes: ['tertiary'], widths: ROAD_WIDTHS.tertiary, minzoom: 10 },
  { id: 'road-secondary', tier: 'secondary', classes: ['secondary'], widths: ROAD_WIDTHS.secondary, minzoom: 8 },
  { id: 'road-primary', tier: 'primary', classes: ['primary'], widths: ROAD_WIDTHS.primary, minzoom: 7 },
  { id: 'road-trunk-link', tier: 'trunkLink', classes: ['trunk'], widths: ROAD_WIDTHS.trunkLink, minzoom: 11, ramp: true },
  { id: 'road-trunk', tier: 'trunk', classes: ['trunk'], widths: ROAD_WIDTHS.trunk, minzoom: 6, ramp: false },
  { id: 'road-motorway-link', tier: 'motorwayLink', classes: ['motorway'], widths: ROAD_WIDTHS.motorwayLink, minzoom: 11, ramp: true },
  { id: 'road-motorway', tier: 'motorway', classes: ['motorway'], widths: ROAD_WIDTHS.motorway, minzoom: 5, ramp: false },
];

/** Footways, drawn after the vehicle network so a park path is not buried. */
const PATH_TIER = {
  id: 'road-path',
  tier: 'path' as RoadTier,
  classes: ['path'],
  widths: ROAD_WIDTHS.path,
  minzoom: 14,
  dash: [2, 1.6],
};

/**
 * A tier's tone, after `tuning.ts` has had its say.
 *
 * {@link LOCAL_ROAD_FILL} is the reversible half of a rejected instruction: a
 * non-null value restores the supplied literal treatment for the two local
 * tiers — flat fill, no casing — and `null`, the default, uses the palette.
 */
function toneFor(palette: CartographyPalette, tier: RoadTier): RoadTone {
  if (LOCAL_ROAD_FILL !== null && (tier === 'local' || tier === 'service')) {
    return { fill: LOCAL_ROAD_FILL, casing: null };
  }
  return palette.roads[tier];
}

// ---------------------------------------------------------------------------
// The layer list
// ---------------------------------------------------------------------------

/**
 * Build every layer for one appearance.
 *
 * @param palette - the appearance's cartographic palette.
 * @param source  - the vector source id these layers read (`provider.ts` owns it).
 */
export function buildLayers(palette: CartographyPalette, source: string): LayerSpecification[] {
  const layers: LayerSpecification[] = [];

  /** A `fill` over one source-layer. */
  const fill = (
    id: string,
    sourceLayer: string,
    layerFilter: FilterSpecification,
    color: string,
    options: { minzoom?: number; opacity?: number; outline?: string } = {},
  ): void => {
    layers.push({
      id,
      type: 'fill',
      source,
      'source-layer': sourceLayer,
      ...(options.minzoom === undefined ? {} : { minzoom: options.minzoom }),
      filter: layerFilter,
      paint: {
        'fill-color': color,
        ...(options.opacity === undefined ? {} : { 'fill-opacity': options.opacity }),
        ...(options.outline === undefined ? {} : { 'fill-outline-color': options.outline }),
      },
    });
  };

  /** A road-shaped `line`: round caps, round joins, width by zoom. */
  const line = (
    id: string,
    sourceLayer: string,
    layerFilter: FilterSpecification,
    color: string | ExpressionSpecification,
    widths: readonly (readonly [number, number])[],
    options: { minzoom?: number; dash?: number[]; opacity?: number; cap?: 'butt' | 'round' } = {},
  ): void => {
    layers.push({
      id,
      type: 'line',
      source,
      'source-layer': sourceLayer,
      ...(options.minzoom === undefined ? {} : { minzoom: options.minzoom }),
      filter: layerFilter,
      layout: { 'line-cap': options.cap ?? 'round', 'line-join': 'round' },
      paint: {
        'line-color': color,
        'line-width': byZoom(widths),
        ...(options.dash === undefined ? {} : { 'line-dasharray': options.dash }),
        ...(options.opacity === undefined ? {} : { 'line-opacity': options.opacity }),
      },
    });
  };

  // --- Ground ------------------------------------------------------------

  layers.push({ id: 'background', type: 'background', paint: { 'background-color': palette.land } });

  // ORDER MATTERS HERE, and getting it wrong is invisible in code review.
  //
  // `landuse class=residential` polygons are enormous — in a Madrid z14 tile
  // they cover 108% of the tile (they overlap) — and they arrive in the same
  // source as the small, specific ones. Drawing `landcover` first and
  // `landuse` second therefore paints a city's residential blanket straight
  // over its parks: rendering this tile with that order turned El Retiro into
  // plain sand with a pond in it. So the built-up blanket goes DOWN FIRST, and
  // everything specific is drawn on top of it, smallest last.
  //
  // `landscape.man_made`, one shade off the ground so a built-up block reads as
  // built up without becoming a second colour on the map.
  // ZOOM-GATED, because Apple's is. The built-up tint covers ~15% of a z14
  // Manhattan canvas and is entirely absent from a z10 one — the same is true
  // of the violet in dark mode. At region scale Apple wants bare land, green
  // and the motorway network and nothing else; the urban fabric arrives as you
  // come down. Rendering it at every zoom is what made GoWay's region view a
  // flat wash where Apple's has structure.
  layers.push({
    id: 'landuse-built-up',
    type: 'fill',
    source,
    'source-layer': SL.landuse,
    minzoom: 10,
    filter: filter(classIn('residential', 'suburb', 'neighbourhood', 'quarter', 'garages', 'industrial', 'commercial', 'retail', 'railway', 'quarry')),
    paint: {
      'fill-color': palette.landBuiltUp,
      'fill-opacity': byZoom([[10, 0], [13, 1]], 1),
    },
  });

  // `landscape.natural`. `rock`/`scree` are absent on purpose: the supplied
  // palette hides `landscape.natural.terrain`, and this style carries no
  // hillshade or relief raster for the same reason.
  fill('landcover-farmland', SL.landcover, filter(classIn('farmland')), palette.farmland);
  fill('landcover-natural', SL.landcover, filter(classIn('wood', 'grass')), palette.natural);
  fill('landcover-ice', SL.landcover, filter(classIn('ice')), palette.ice);
  fill('landcover-wetland', SL.landcover, filter(classIn('wetland')), palette.wetland);
  fill('landcover-sand', SL.landcover, filter(classIn('sand')), palette.sand);

  fill('landuse-pitch', SL.landuse, filter(classIn('pitch', 'playground', 'stadium', 'track')), palette.pitch);
  fill('landuse-cemetery', SL.landuse, filter(classIn('cemetery')), palette.cemetery);
  // `poi.medical` — hospital grounds, not the hospital pin.
  fill('landuse-medical', SL.landuse, filter(classIn('hospital')), palette.medical);
  fill(
    'landuse-institution',
    SL.landuse,
    filter(classIn('school', 'university', 'college', 'kindergarten', 'education', 'library', 'official_residence', 'military', 'bus_station')),
    palette.institution,
  );
  fill('landuse-park', SL.landuse, filter(classIn('park', 'theme_park', 'zoo')), palette.park);

  // `poi.park` — the protected-area source-layer. Its `class` is free text
  // (real values include "Zona de Especial Protección para las Aves"), so it
  // is never filtered on; `rank` is the only usable ordering.
  fill('park', SL.park, filter(['all']), palette.park, { opacity: 0.85 });
  layers.push({
    id: 'park-outline',
    type: 'line',
    source,
    'source-layer': SL.park,
    minzoom: 10,
    filter: filter(['all']),
    layout: { 'line-join': 'round' },
    paint: { 'line-color': palette.parkOutline, 'line-width': byZoom([[10, 0.4], [14, 0.8], [18, 1.4]]) },
  });

  // --- Water -------------------------------------------------------------

  fill('water', SL.water, filter(['all', NOT_TUNNEL]), palette.water);
  line(
    'waterway',
    SL.waterway,
    filter(['all', NOT_TUNNEL, IS_LINE]),
    palette.waterway,
    [[8, 0.5], [12, 1.2], [15, 2.4], [18, 5], [20, 9]],
    { minzoom: 8 },
  );

  // --- Aeroways ----------------------------------------------------------

  // `transit.station.airport`.
  fill('aeroway-area', SL.aeroway, filter(['all', IS_POLYGON]), palette.airport, { minzoom: 10, opacity: 0.5 });
  line('aeroway-runway', SL.aeroway, filter(['all', IS_LINE, classIn('runway')]), palette.aeroway.fill, [[10, 1], [13, 4], [16, 14], [19, 40]], { minzoom: 10, cap: 'butt' });
  line('aeroway-taxiway', SL.aeroway, filter(['all', IS_LINE, classIn('taxiway')]), palette.aeroway.fill, [[12, 0.6], [15, 2], [18, 6]], { minzoom: 12, cap: 'butt' });

  // --- Roads -------------------------------------------------------------
  //
  // ALL CASINGS FIRST, THEN ALL FILLS. That ordering is the difference between
  // a road network and a pile of lines: where a residential street meets a
  // primary, the primary's fill covers the residential's casing and the
  // junction reads as continuous tarmac. Interleaved per tier, every crossing
  // grows a visible seam.

  // Tunnels: one dimmed, dashed layer for the whole network rather than a
  // shadow copy of every tier. A road you cannot turn onto does not need a
  // hierarchy of its own.
  const tunnelTone = toneFor(palette, 'tunnel');
  const tunnelFilter = filter([
    'all',
    IS_LINE,
    ['==', ['get', 'brunnel'], 'tunnel'],
    classIn('motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'),
  ]);
  if (tunnelTone.casing) {
    line('road-tunnel-casing', SL.transportation, tunnelFilter, tunnelTone.casing, casingWidths(ROAD_WIDTHS.tunnel), { minzoom: 12 });
  }
  line('road-tunnel', SL.transportation, tunnelFilter, tunnelTone.fill, ROAD_WIDTHS.tunnel, { minzoom: 12, dash: [0.6, 0.3] });

  /** `class` + optional `ramp` test shared by a tier's casing and its fill. */
  const tierFilter = (tier: (typeof ROAD_TIERS)[number]): FilterSpecification =>
    filter([
      'all',
      IS_LINE,
      NOT_TUNNEL,
      classIn(...tier.classes),
      ...(tier.ramp === undefined ? [] : [tier.ramp ? IS_RAMP : ['!', IS_RAMP]]),
    ]);

  for (const tier of ROAD_TIERS) {
    const tone = toneFor(palette, tier.tier);
    if (!tone.casing) continue;
    // A tier that names a `casingLowZoom` deepens its edge as you zoom out,
    // reaching its normal colour by z14. See the field's docs: on a near-white
    // ground a pale one-pixel edge at z11 is not an edge, and the strategic
    // network stops being traceable.
    const casingColor = tone.casingLowZoom
      ? colorByZoom([[9, tone.casingLowZoom], [14, tone.casing]])
      : tone.casing;
    line(`${tier.id}-casing`, SL.transportation, tierFilter(tier), casingColor, casingWidths(tier.widths), {
      minzoom: tier.minzoom,
    });
  }

  for (const tier of ROAD_TIERS) {
    const tone = toneFor(palette, tier.tier);
    // Motorway and trunk shift hue as you zoom out — measured, see
    // `RoadTone.fillLowZoom`. Everything else is one colour at every zoom.
    const fillColor = tone.fillLowZoom
      ? colorByZoom([[9, tone.fillLowZoom], [13, tone.fill]])
      : tone.fill;
    line(tier.id, SL.transportation, tierFilter(tier), fillColor, tier.widths, { minzoom: tier.minzoom });
  }

  // Footways last of the road block so a park path is not buried under the
  // service road beside it. Dashed, and therefore casing-less — a dashed line
  // inside a casing reads as a ladder.
  line(
    PATH_TIER.id,
    SL.transportation,
    filter(['all', IS_LINE, NOT_TUNNEL, classIn(...PATH_TIER.classes)]),
    toneFor(palette, PATH_TIER.tier).fill,
    PATH_TIER.widths,
    { minzoom: PATH_TIER.minzoom, dash: PATH_TIER.dash },
  );

  line('road-ferry', SL.transportation, filter(['all', IS_LINE, classIn('ferry')]), palette.ferry, ROAD_WIDTHS.ferry, { minzoom: 8, dash: [3, 3] });
  line('road-rail', SL.transportation, filter(['all', IS_LINE, NOT_TUNNEL, classIn('rail', 'transit')]), palette.rail, ROAD_WIDTHS.rail, { minzoom: 11 });
  line('road-rail-hatch', SL.transportation, filter(['all', IS_LINE, NOT_TUNNEL, classIn('rail', 'transit')]), palette.railHatch, ROAD_WIDTHS.railHatch, { minzoom: 14, dash: [0.2, 4], cap: 'butt' });

  // --- Structures --------------------------------------------------------

  // Flat footprints only. No `fill-extrusion`: GoWay's map is read from above,
  // and extruded buildings at a pitch hide exactly the streets and labels a
  // person is trying to read.
  //
  // Subtle but PRESENT. The first cut faded the edge in so gently that a block
  // of footprints was indistinguishable from bare ground — quiet had become
  // absent. Apple's buildings are barely-there at z15 and clearly delineated by
  // z17, which is the zoom at which a footprint starts being information (which
  // side of the courtyard, where the entrance is) rather than texture.
  layers.push({
    id: 'building',
    type: 'fill',
    source,
    'source-layer': SL.building,
    minzoom: 14,
    paint: {
      'fill-color': palette.building,
      'fill-outline-color': colorByZoom([[14.5, palette.building], [16, palette.buildingOutline]]),
      'fill-opacity': byZoom([[14, 0], [15, 0.65], [17, 1]], 1),
    },
  });

  // --- Administrative ----------------------------------------------------

  line(
    'boundary-region',
    SL.boundary,
    filter(['all', ['>=', ['get', 'admin_level'], 3], ['<=', ['get', 'admin_level'], 6], ['!=', ['get', 'maritime'], 1]]),
    palette.boundaryRegion,
    [[4, 0.4], [8, 0.8], [12, 1.4]],
    { minzoom: 4, dash: [3, 2] },
  );
  line(
    'boundary-country',
    SL.boundary,
    filter(['all', ['<=', ['get', 'admin_level'], 2], ['!=', ['get', 'maritime'], 1]]),
    palette.boundaryCountry,
    [[2, 0.6], [6, 1.2], [10, 2]],
  );

  // --- The anchor --------------------------------------------------------

  layers.push({
    id: LABEL_ANCHOR_LAYER_ID,
    type: 'background',
    paint: { 'background-color': palette.land, 'background-opacity': 0 },
  });

  // --- POIs --------------------------------------------------------------

  if (SHOW_BASEMAP_POIS) {
    const dot = (id: string, layerFilter: FilterSpecification, minzoom: number, radius: readonly (readonly [number, number])[]): void => {
      layers.push({
        id,
        type: 'circle',
        source,
        'source-layer': SL.poi,
        minzoom,
        filter: layerFilter,
        paint: {
          'circle-color': poiColor(palette),
          'circle-radius': byZoom(radius, 1.2),
          // A ring in the ground colour is what stops a dot dissolving into a
          // park fill or a building of a similar value.
          'circle-stroke-color': palette.land,
          'circle-stroke-width': byZoom([[15, 0.6], [18, 1.2]], 1),
          'circle-opacity': 0.95,
        },
      });
    };

    dot('poi-dot', poiFilter('major'), 15, [[15, 2.4], [17, 3.4], [19, 4.4]]);
    dot('poi-dot-minor', poiFilter('minor'), 17, [[17, 2.4], [19, 3.4]]);
    dot('poi-transit-dot', poiFilter('station'), 14, [[14, 2.4], [17, 4], [19, 5]]);
  }

  // --- Type --------------------------------------------------------------

  /** A line-following label (roads, rivers). */
  const lineLabel = (
    id: string,
    sourceLayer: string,
    layerFilter: FilterSpecification,
    color: string,
    sizes: readonly (readonly [number, number])[],
    options: { minzoom?: number; halo?: string } = {},
  ): void => {
    layers.push({
      id,
      type: 'symbol',
      source,
      'source-layer': sourceLayer,
      ...(options.minzoom === undefined ? {} : { minzoom: options.minzoom }),
      filter: layerFilter,
      layout: {
        'symbol-placement': 'line',
        'text-field': LABEL_TEXT,
        'text-font': REGULAR,
        'text-size': byZoom(sizes, 1.2),
        'text-rotation-alignment': 'map',
        'text-pitch-alignment': 'viewport',
        'symbol-spacing': 280,
        'text-max-angle': 32,
      },
      paint: {
        'text-color': color,
        'text-halo-color': options.halo ?? palette.haloStrong,
        'text-halo-width': 1.3,
        'text-halo-blur': 0.4,
      },
    });
  };

  /** A point label (places, POIs, parks). */
  const pointLabel = (
    id: string,
    sourceLayer: string,
    layerFilter: FilterSpecification,
    color: string,
    sizes: readonly (readonly [number, number])[],
    options: {
      minzoom?: number;
      maxzoom?: number;
      font?: string[];
      halo?: string;
      haloWidth?: number;
      offset?: [number, number];
      anchor?: 'center' | 'top' | 'bottom';
      uppercase?: boolean;
      letterSpacing?: number;
      maxWidth?: number;
      sortKey?: ExpressionSpecification;
    } = {},
  ): void => {
    layers.push({
      id,
      type: 'symbol',
      source,
      'source-layer': sourceLayer,
      ...(options.minzoom === undefined ? {} : { minzoom: options.minzoom }),
      ...(options.maxzoom === undefined ? {} : { maxzoom: options.maxzoom }),
      filter: layerFilter,
      layout: {
        'text-field': LABEL_TEXT,
        'text-font': options.font ?? REGULAR,
        'text-size': byZoom(sizes, 1.2),
        'text-max-width': options.maxWidth ?? 8,
        'text-anchor': options.anchor ?? 'center',
        ...(options.offset === undefined ? {} : { 'text-offset': options.offset }),
        ...(options.uppercase ? { 'text-transform': 'uppercase' as const } : {}),
        ...(options.letterSpacing === undefined ? {} : { 'text-letter-spacing': options.letterSpacing }),
        ...(options.sortKey === undefined ? {} : { 'symbol-sort-key': options.sortKey }),
      },
      paint: {
        'text-color': color,
        'text-halo-color': options.halo ?? palette.halo,
        'text-halo-width': options.haloWidth ?? 1.4,
        'text-halo-blur': 0.4,
      },
    });
  };

  // ## The type hierarchy
  //
  // Apple's map is label-forward, and "forward" is a RANKING, not a volume
  // knob. The ordering it enforces, loudest first:
  //
  //   city  >  town  >  village  >  neighbourhood  >  POI  >  street
  //
  // Two properties carry it. SIZE: a city at z12 is ~23px and a street name at
  // z16 is ~10px, a ratio of more than two to one — the first cut had them at
  // 21 and 11.5 and the map read flat. COLOUR: place names are near-black warm
  // grey, street and POI names are a lighter warm grey that visibly recedes.
  // Weight would be the third, but OpenFreeMap's glyph server serves only
  // Regular and Bold (Medium and SemiBold both 404), so the ladder is two rungs
  // and Bold is spent entirely on place names.
  //
  // Halos are generous throughout — 1.4 to 2.0px — because a label-forward map
  // puts its type over a busy basemap by definition, and a thin halo is how a
  // street name becomes unreadable the moment it crosses a park edge.

  lineLabel('label-waterway', SL.waterway, filter(['all', IS_LINE, ['has', 'name']]), palette.labelWater, [[13, 9.5], [18, 12]], { minzoom: 13, halo: palette.halo });
  lineLabel('label-water-line', SL.waterName, filter(['all', IS_LINE]), palette.labelWater, [[10, 10.5], [16, 13.5]], { minzoom: 10, halo: palette.halo });
  pointLabel('label-water-point', SL.waterName, filter(['all', IS_POINT]), palette.labelWater, [[6, 10.5], [12, 13.5], [16, 15.5]], { minzoom: 5, halo: palette.halo, letterSpacing: 0.04 });

  if (SHOW_ROAD_AND_POI_LABELS) {
    // Streets are the quietest type on the map: small, light, and only once
    // the road carrying them is wide enough to sit inside. `haloStrong` rather
    // than the ground halo, because these sit ON the white ribbon, not beside
    // it.
    lineLabel('label-road-local', SL.transportationName, filter(['all', IS_LINE, classIn('minor', 'service', 'track')]), palette.labelRoad, [[15, 8.5], [18, 10.5], [20, 12]], { minzoom: 15 });
    lineLabel('label-road-arterial', SL.transportationName, filter(['all', IS_LINE, classIn('primary', 'secondary', 'tertiary')]), palette.labelRoad, [[13, 8.5], [16, 10.5], [20, 12.5]], { minzoom: 13 });
    lineLabel('label-road-highway', SL.transportationName, filter(['all', IS_LINE, classIn('motorway', 'trunk')]), palette.labelRoad, [[12, 9], [16, 11], [20, 13]], { minzoom: 12 });

    pointLabel('label-poi-minor', SL.poi, poiFilter('minor'), palette.labelPoi, [[17, 9.5], [19, 11]], {
      minzoom: 17, anchor: 'top', offset: [0, 0.75], maxWidth: 9, sortKey: expr(['get', 'rank']),
    });
    pointLabel('label-poi', SL.poi, poiFilter('major'), palette.labelPoi, [[15, 10], [18, 11.5], [20, 12.5]], {
      minzoom: 15, anchor: 'top', offset: [0, 0.8], maxWidth: 9, sortKey: expr(['get', 'rank']),
    });
    pointLabel('label-poi-transit', SL.poi, poiFilter('station'), palette.labelPoi, [[14, 10], [18, 12]], {
      minzoom: 14, anchor: 'top', offset: [0, 0.9], maxWidth: 9, sortKey: expr(['get', 'rank']),
    });
  }

  pointLabel('label-aerodrome', SL.aerodromeLabel, filter(['all', IS_POINT, ['has', 'iata']]), palette.labelPlaceMinor, [[10, 10.5], [14, 13]], {
    minzoom: 10, font: BOLD, letterSpacing: 0.04,
  });

  // The `park` source-layer's polygons get their name at the pole of
  // inaccessibility, which is why this is a point label over polygon geometry.
  pointLabel('label-park', SL.park, filter(['all', ['has', 'name']]), palette.labelPark, [[12, 10.5], [16, 12.5], [19, 14.5]], {
    minzoom: 12, maxWidth: 7, sortKey: expr(['get', 'rank']),
  });

  // Place labels last: MapLibre places symbols from the last layer backwards,
  // so being last is what makes these win every collision. Within the block the
  // order is smallest place to largest, so a city outranks the neighbourhood
  // it contains.
  //
  // Neighbourhoods are uppercase and letter-spaced — Apple's one typographic
  // tell for "this is an area, not a point". It also lets them stay small
  // without reading as a POI.
  pointLabel('label-place-minor', SL.place, filter(classIn('neighbourhood', 'quarter', 'suburb', 'island', 'aboriginal_lands')), palette.labelPlaceMinor, [[11, 9.5], [14, 11.5], [17, 13]], {
    minzoom: 11, uppercase: true, letterSpacing: 0.1, maxWidth: 7, haloWidth: 1.5,
  });
  pointLabel('label-place-village', SL.place, filter(classIn('village')), palette.labelPlace, [[9, 10.5], [12, 13], [16, 15.5]], { minzoom: 9, font: BOLD, haloWidth: 1.6 });
  pointLabel('label-place-town', SL.place, filter(classIn('town')), palette.labelPlace, [[6, 11], [10, 14], [13, 17], [16, 19]], { minzoom: 6, font: BOLD, haloWidth: 1.7 });
  pointLabel('label-place-city', SL.place, filter(classIn('city')), palette.labelPlace, [[3, 11], [6, 14], [9, 18], [12, 23], [15, 26]], { minzoom: 3, font: BOLD, haloWidth: 2 });
  // Regions and countries drop out once their cities can carry the map: past
  // z9 a state name is a label for something entirely off screen.
  pointLabel('label-place-region', SL.place, filter(classIn('state', 'province')), palette.labelRegion, [[4, 10], [7, 13]], {
    minzoom: 4, maxzoom: 9, font: BOLD, uppercase: true, letterSpacing: 0.13, maxWidth: 6,
  });
  pointLabel('label-place-country', SL.place, filter(classIn('country')), palette.labelRegion, [[2, 10], [5, 14], [8, 17]], {
    minzoom: 1, maxzoom: 10, font: BOLD, uppercase: true, letterSpacing: 0.15, maxWidth: 6, haloWidth: 1.7,
  });

  return layers;
}

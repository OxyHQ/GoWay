/**
 * The extruded buildings — GoWay's one `fill-extrusion` layer.
 *
 * It lives in its own module rather than inside `layers.ts` because it is the
 * only layer in the style with a *volume*: everything else is ink on a plane
 * and is tuned by colour, while this one is tuned by height, by the zoom it
 * fades in at, and by how its walls shade. `layers.ts` imports it and splices
 * it into the ordered list; nothing else here is reachable from feature code.
 *
 * ## What this is fixing
 *
 * The camera has always tilted — MapLibre's Ctrl+drag, `maxPitch` 60, both
 * forks — but the style had no `fill-extrusion` anywhere, so tilting showed
 * **flat polygons lying on the ground seen at an angle**. Under perspective a
 * footprint's far edge compresses toward the vanishing point, so every block
 * narrowed into a wedge and the hard `fill-outline-color` traced it: shapes
 * that taper away to a point, with nothing to say they are buildings. That is
 * what *"los objetos 3d se sienten muy mal… no terminan como en punta"* is
 * describing, and no amount of colour work on a flat fill can answer it. The
 * answer is a volume.
 *
 * ## The honest ceiling — read this before promising anyone a match
 *
 * `fill-extrusion` takes a footprint and extrudes it straight up into a
 * **hard-edged prism**. That is the whole primitive. Apple Maps does not do
 * this: its buildings are real meshes with bevelled edges, chamfered roof
 * lines and baked ambient occlusion in the corners, which is why they read as
 * soft. **Those rounded edges are not reproducible in MapLibre.** Nothing
 * below gets them, and nothing below should be described as getting them.
 *
 * What *is* reproducible is the shading that makes a prism stop reading as
 * cardboard:
 *
 *  1. **`fill-extrusion-vertical-gradient`** darkens each wall toward its base.
 *     It is a cheap stand-in for ambient occlusion and it is the single
 *     largest difference between "extruded OSM" and something you would ship.
 *     MapLibre defaults it to `true`; it is written out explicitly because it
 *     is the point of this layer, not an incidental default.
 *  2. **A zoom fade** so volumes grow in rather than appearing between one
 *     frame and the next. Popping is itself part of looking bad.
 *  3. **Height-aware colour**, barely. A 200 m tower and a 6 m shop are not
 *     the same flat tone on Apple's map.
 *
 * ## What the tiles actually carry (measured, not assumed)
 *
 * Decoding real z14 `building` tiles over Barcelona, Madrid, Manhattan, London
 * and Tokyo (2,372 features):
 *
 *  - `render_height` is present on **100%** of them. There is no missing-height
 *    case to design around — but there are poisoned values: Madrid carries a
 *    `render_height` of **-3** and one of **0**, and Manhattan, London and
 *    Madrid each carry features whose `render_min_height` is ABOVE their
 *    `render_height` (e.g. `{render_height: 5, render_min_height: 37}`), which
 *    is an inverted 32 m prism. Both are handled below rather than trusted.
 *  - `hide_3d` is set on a small number of features per tile and means exactly
 *    what it says: do not extrude this one. Honoured in the filter.
 *  - `colour` is present on most features in some cities (1,298 of 1,488 in a
 *    Manhattan tile) and carries the OSM `building:colour` tag — including the
 *    literal value `"black"`. It is **deliberately unused**. Apple does not
 *    tint buildings by their real-world paint, and a city rendered from this
 *    field is a patchwork with black towers in it.
 *  - At z14 OpenMapTiles **unions touching footprints**, so in Barcelona the
 *    whole layer is 38 features, one of which is a single multipolygon of
 *    4,655 rings, and in Madrid one of 5,897. An Eixample block therefore
 *    extrudes as ONE prism at one height with its courtyards punched out, not
 *    as the dozen separate buildings it really is. Nothing in a style can undo
 *    that; it is a property of the tiles, and it is why these volumes read as
 *    blocks in Barcelona and as individual towers in Manhattan.
 */
import type {
  ExpressionSpecification,
  FillExtrusionLayerSpecification,
  FilterSpecification,
  LightSpecification,
} from '@maplibre/maplibre-gl-style-spec';

import type { MapAppearance } from '../provider';
import type { CartographyPalette } from './palette';
import { OPENMAPTILES_SOURCE_LAYERS } from './schema';

/**
 * The extruded layer's id — part of the published contract in
 * `GOWAY_STYLE_LAYER_IDS`, which imports this constant rather than spelling it
 * again.
 */
export const BUILDING_3D_LAYER_ID = 'building-3d';

/**
 * The style document's `light`, which exists entirely for this layer.
 *
 * MapLibre shades extrusion walls by the angle between the wall and this light
 * before the vertical gradient is applied, and its **default `intensity` of
 * 0.5 is the single worst thing about stock `fill-extrusion`**: on a palette
 * this pale it drove the shaded walls of Barcelona's Eixample to near-charcoal
 * while the roofs stayed near-white, and a building rendered as a white lid on
 * black sides is the cardboard-cut-out look the whole layer is trying to
 * avoid. Measured on a rendered z17 frame at 60° of pitch, not reasoned about.
 *
 * ## Why the two appearances disagree about one number
 *
 * MapLibre's shading is **multiplicative**: an unlit wall is floored at
 * `(1 - intensity)` of the layer colour and then multiplied again by the
 * vertical gradient. On a near-white palette that is plenty of separation; on
 * a near-black one the same ratio is almost nothing, because a fixed *ratio*
 * of a dark colour is a tiny *difference*. Sampled off rendered frames:
 *
 * | appearance | roof | shaded wall | 8-bit gap |
 * |---|---|---|---|
 * | light, intensity 0.2  | `#eceae2` | `#c8c6c0` | ~36 |
 * | dark, intensity 0.2   | `#353940` | `#2b2e34` | ~10 |
 * | dark, intensity 0.45  | `#353940` | `#1e2126` | ~23 |
 *
 * So light takes **0.2** and dark takes **0.45**, and the result is two maps
 * where a corner reads as a corner rather than one map that looks right and
 * one that looks like fog. This is the only thing in the style that differs
 * between appearances by anything other than a colour, and it differs in order
 * to make the *same* thing legible in both.
 *
 * Light's 0.2 was picked off the pixels too. It matters most at pitch 0, which
 * is where the app opens and where most people stay: MapLibre's camera is
 * perspective even when level, so buildings away from the screen centre show
 * their sides, and at the default intensity those sides are the heaviest ink
 * on a plan view that is supposed to read as a map.
 *
 * `position` is MapLibre's default, kept deliberately: the only number this
 * style disagrees with the renderer about is the one that was wrong.
 *
 * `anchor: 'viewport'` (also the default) means the light rides with the
 * camera, so rotating the map does not sweep a shadow across the city — the
 * shading stays where the eye expects it.
 *
 * It is a property of the STYLE DOCUMENT, not of a layer, which is why
 * `index.ts` applies it and why these live next to the layer they light rather
 * than in the document builder.
 */
export const BUILDINGS_LIGHT: Record<MapAppearance, LightSpecification> = {
  light: { anchor: 'viewport', position: [1.15, 210, 30], color: '#ffffff', intensity: 0.2 },
  dark: { anchor: 'viewport', position: [1.15, 210, 30], color: '#ffffff', intensity: 0.45 },
};

/**
 * Where volumes start and where they are fully there.
 *
 * The flat `building` fill (in `layers.ts`) runs from z14 and is what carries
 * footprints below this. 15.5 is about where a footprint is big enough on
 * screen that a wall has somewhere to be; by 16.5 the buildings are the
 * subject rather than texture, which is also where Apple's own 3D has arrived.
 */
const FADE_IN_START = 15.5;
const FADE_IN_END = 16.5;

/**
 * The shortest prism this layer will draw, in metres.
 *
 * Not cosmetic. A zero-height extrusion degenerates into a roof polygon lying
 * exactly on the ground — coplanar with the flat `building` fill underneath it
 * — and two coplanar surfaces z-fight into a flickering mess. Clamping to a
 * storey's worth of height means every prism is a real volume that hides its
 * own footprint, which is what keeps the 2D and 3D layers from double-drawing
 * (see the note on {@link buildBuildings3dLayer}).
 */
const MIN_HEIGHT_M = 3;

/** Heights the colour ramp is anchored at, in metres. */
const TALL_M = 60;
const VERY_TALL_M = 180;

/**
 * Blend two `#rrggbb` values, `amount` of `b` into `a`.
 *
 * Here so the height ramp can be derived from the two building tokens the
 * palette already publishes instead of adding appearance-specific colours that
 * would have to be kept in step by hand.
 */
function mix(a: string, b: string, amount: number): string {
  const parse = (hex: string): [number, number, number] => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number): string =>
    Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/**
 * Same trade as `layers.ts`: the spec's `ExpressionSpecification` is a deeply
 * recursive tuple union that cannot be inferred from an array literal, and the
 * real check is `validateStyleMin` in `scripts/build-map-style.ts`.
 */
const expr = (value: unknown): ExpressionSpecification => value as ExpressionSpecification;

/**
 * `render_height`, clamped into something that can be a prism.
 *
 * `max(..., MIN_HEIGHT_M)` absorbs the measured `-3` and `0` in Madrid's tiles
 * in the same stroke as the missing-value case, so neither can produce an
 * inside-out or zero-thickness volume.
 */
const HEIGHT = expr(['max', ['coalesce', ['get', 'render_height'], 0], MIN_HEIGHT_M]);

/**
 * `render_min_height`, but only when it is below the roof.
 *
 * A base at or above the height is a broken feature — three tiles out of five
 * had one — and MapLibre will happily draw the inverted volume it describes.
 * Those drop to the ground instead, which is wrong by a few metres rather than
 * wrong by a whole building.
 */
const BASE = expr([
  'case',
  ['>=', ['coalesce', ['get', 'render_min_height'], 0], HEIGHT],
  0,
  ['coalesce', ['get', 'render_min_height'], 0],
]);

/**
 * Everything the tile does not ask to keep flat.
 *
 * `hide_3d` is absent on most features, and `['get']` on an absent key is
 * `null`, so `!= true` passes them. Features it IS set on keep their flat
 * footprint from the `building` fill and simply gain no volume — which is
 * exactly what the flag is for.
 */
const NOT_HIDDEN: FilterSpecification = ['!=', ['get', 'hide_3d'], true] as FilterSpecification;

/**
 * Build the extrusion for one appearance.
 *
 * ## Why this does not double-draw against the flat `building` fill
 *
 * The 2D fill keeps running underneath at every zoom; nothing about it
 * changes. It does not show through, because a prism completely occludes its
 * own footprint from any camera above the ground — the footprint is the prism's
 * base, and the roof sits directly over every point of it. That only holds
 * while the prism has thickness, which is what {@link MIN_HEIGHT_M} guarantees,
 * and while the extrusion is opaque, which is what the fade below reaches at
 * {@link FADE_IN_END}. Between {@link FADE_IN_START} and that, the two are
 * *meant* to be visible at once: a translucent volume over a fading footprint
 * is the cross-fade.
 *
 * The one case where the flat fill is legitimately visible is a feature with a
 * `render_min_height` above the ground — a raised wing or a building part. Its
 * footprint showing beneath it is correct.
 *
 * @param palette - the appearance's cartographic palette.
 * @param source  - the vector source id (owned by `lib/map/provider.ts`).
 */
export function buildBuildings3dLayer(
  palette: CartographyPalette,
  source: string,
): FillExtrusionLayerSpecification {
  // Taller buildings step AWAY from the ground tone rather than toward a fixed
  // grey, which is why this is derived from the palette's own two building
  // tokens instead of new ones. In light the outline token is darker than the
  // fill, in dark it is lighter, so the same expression reads as "a tower has
  // more presence than a shop" in both appearances without either being
  // special-cased — and without touching `palette.ts`, which is being rewritten
  // against measured Apple captures in parallel.
  const low = palette.building;
  const tall = mix(palette.building, palette.buildingOutline, 0.35);
  const veryTall = mix(palette.building, palette.buildingOutline, 0.6);

  return {
    id: BUILDING_3D_LAYER_ID,
    type: 'fill-extrusion',
    source,
    'source-layer': OPENMAPTILES_SOURCE_LAYERS.building,
    // A zoom below the fade would build the whole geometry every frame to draw
    // it at zero opacity.
    minzoom: FADE_IN_START,
    filter: NOT_HIDDEN,
    paint: {
      'fill-extrusion-height': HEIGHT,
      'fill-extrusion-base': BASE,
      // THE one that matters. Shades every wall toward its base, which is what
      // reads as softening rather than as cut-out cardboard. It cannot give the
      // bevelled edge Apple has — see the module header — but it is what stops
      // a prism looking like a slab.
      'fill-extrusion-vertical-gradient': true,
      'fill-extrusion-color': expr([
        'interpolate',
        ['linear'],
        ['get', 'render_height'],
        0,
        low,
        TALL_M,
        tall,
        VERY_TALL_M,
        veryTall,
      ]),
      // Grow in. A volume that appears between two frames is its own defect,
      // and the flat fill is still doing the work below this.
      'fill-extrusion-opacity': expr([
        'interpolate',
        ['linear'],
        ['zoom'],
        FADE_IN_START,
        0,
        FADE_IN_END,
        1,
      ]),
    },
  };
}

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
import { parseHexColour } from '../colour';
import type {
  ExpressionSpecification,
  FillExtrusionLayerSpecification,
  FilterSpecification,
  LightSpecification,
} from '@maplibre/maplibre-gl-style-spec';

import type { MapAppearance } from '../provider';
import type { SunPosition } from '../sun';
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
 *
 * ## This is now the FALLBACK, not what a running map shows
 *
 * Both map adapters replace it at runtime with {@link sunLitBuildingsLight} —
 * the same intensity, aimed from where the sun really is over the viewport.
 * It stays in the style document because a style is also read by things that
 * run none of GoWay's code (a cached document, a bug report, a third-party
 * MapLibre pointed at `goway.to/map/goway-light.json`), and because it is what
 * the first frames show before the adapter has applied anything. Everything
 * said above about intensity is inherited by the sun light unchanged; only
 * the direction moves.
 */
export const BUILDINGS_LIGHT: Record<MapAppearance, LightSpecification> = {
  light: { anchor: 'viewport', position: [1.15, 210, 30], color: '#ffffff', intensity: 0.2 },
  dark: { anchor: 'viewport', position: [1.15, 210, 30], color: '#ffffff', intensity: 0.45 },
};

/**
 * The light's distance term, MapLibre's default and the static light's.
 *
 * It is NOT normalised away by the renderer: `fill-extrusion`'s shader takes
 * `dot(normal, lightPosition)` with the Cartesian position at this radius, so
 * 1.15 is a 15% gain on every face's directional term (clamped at 1). Every
 * number in the note on {@link sunLitBuildingsLight} is computed with it.
 */
const LIGHT_RADIUS = 1.15;

/**
 * The polar angle (0° = straight down from overhead) a sun at the ZENITH is
 * drawn at. The static light's own 30°, which is the one polar angle that was
 * measured legible on rendered frames.
 */
const POLAR_HIGH_SUN_DEG = 30;

/**
 * The polar angle a sun ON THE HORIZON is drawn at — the most raking the light
 * is ever allowed to get. See {@link sunLitBuildingsLight} for the arithmetic.
 */
const POLAR_LOW_SUN_DEG = 50;

/**
 * How far below the horizon the light keeps easing, in degrees: civil
 * twilight, the conventional point at which the sky stops lighting anything.
 */
const TWILIGHT_DEPTH_DEG = 6;

/**
 * The buildings' light, aimed from the real sun.
 *
 * `sun` is where the sun is over the centre of the viewport
 * (`lib/map/sun.ts`); `appearance` is the user's THEME. They are separate
 * inputs on purpose — see "Night is not dark mode" below.
 *
 * ## What is literal and what is shaped
 *
 * **The azimuth is literal.** Under `anchor: 'map'` MapLibre measures it
 * clockwise from true north, which is exactly the compass bearing `sunPosition`
 * returns, so the lit side of every block is the side the sun is actually on.
 * That is the whole feature, and it is also the reason for the anchor: under
 * `viewport` the lit side would be a fact about the screen and would turn with
 * the camera, so a rotated map would light the street's shady side. Under
 * `map` it is a fact about the city — rotate the map and the sunny side of the
 * street stays the sunny side.
 *
 * **The elevation is shaped, because the literal one wrecks legibility at both
 * ends.** The shader (read off maplibre-gl 6.10's `fill-extrusion` program)
 * gives each face a directional term `d = clamp(dot(normal, light), 0, 1)` and
 * multiplies the colour by `mix(1 − intensity, max(1 − luminance + intensity,
 * 1), d)`: `d = 0` is the unlit floor, `d = 1` full light. With
 * {@link LIGHT_RADIUS}, a roof gets `d = 1.15·cos(polar)` and the wall facing
 * the sun `1.15·sin(polar)`; every other wall gets less, and the walls facing
 * away get 0.
 *
 *  - **A literal high sun flattens the walls.** At polar 0° (overhead, which is
 *    every noon in the tropics) no wall gets any light: all four sides sit at
 *    the floor, identical, and a corner stops reading as a corner — the
 *    cardboard look the module header exists to fix. So the zenith is drawn at
 *    {@link POLAR_HIGH_SUN_DEG}, the static light's measured 30°, where the
 *    sunny wall still gets `d = 0.58` against 0 for the shady ones.
 *  - **A literal low sun darkens the roofs.** At polar 90° (on the horizon)
 *    the roof gets `d = 0`, and at pitch 0 — where the app opens and where
 *    most people stay — the roof IS the building. A city of floor-dark lids is
 *    a dimmer map at every sunrise. So the horizon is drawn at
 *    {@link POLAR_LOW_SUN_DEG}: roof `d = 0.74`, sunny wall `d = 0.88`, a
 *    visibly raking light with the walls brighter than at noon. Through the
 *    formula above with today's `building` tokens, the roof keeps **95%** of
 *    its noon brightness in light (`#f7eed9`, intensity 0.2) and **87%** in
 *    dark (`#4c4f74`, intensity 0.45 — the fragile appearance, see
 *    {@link BUILDINGS_LIGHT}). At 60° dark would keep 78%, which is the
 *    "dimmer map" again. Those are COMPUTED from the shader, not sampled off
 *    rendered frames the way the intensities were, and the angle is a named
 *    constant precisely so that a pixel measurement can move it.
 *
 * Between the two, the polar angle is a straight line in altitude, not a clamp:
 * a clamp would make every sun above some height look identical, and the whole
 * of a mid-latitude winter look like sunrise. Shaped linearly, Barcelona at
 * midsummer noon (72°) is drawn at 34° and at midwinter noon (26°) at 44°, so
 * the season and the hour both still show.
 *
 * ## Night
 *
 * There is no sun to be faithful to, so the light does the two things that
 * cost nothing in legibility and introduce no jump:
 *
 *  - **The azimuth keeps following the sun below the horizon.** Sunset in the
 *    west, round through north at midnight (in the northern hemisphere), up in
 *    the east at dawn: one smooth circle a day, with nothing to snap at dusk
 *    or at dawn. Freezing it at the sunset bearing would mean a 180° swing at
 *    sunrise; switching to the static viewport light would change the anchor,
 *    and with it whether rotating the map moves the shading.
 *  - **The polar angle eases back to the tuned 30° through civil twilight**
 *    ({@link TWILIGHT_DEPTH_DEG}). The horizon value is the most compromised
 *    look the light has; the night city goes back to the measured one, only
 *    rotated. Continuous at both ends: 50° at the horizon, 30° at −6°.
 *
 * Polar night and midnight sun need no case of their own: the sun's altitude
 * already says which of the two regimes applies, minute by minute.
 *
 * ## Night is not dark mode
 *
 * `appearance` is the user's theme and decides only the intensity, exactly as
 * it does for the static light, because intensity is a property of the
 * PALETTE — it is the number that makes a shaded wall distinguishable from a
 * roof on that particular set of colours. Coupling it to the hour would mean
 * a light-theme map at 23:00 rendering walls at a ratio measured to be fog on
 * that palette, or a dark-theme map at noon with white lids on black walls.
 * Nor does night dim anything: the user already chose how dark their map is,
 * and a second, clock-driven darkness on top of the theme is a night mode
 * nobody asked for.
 *
 * For the same reason the colour stays white. A warm low sun is a lovely idea
 * and a multiplicative tint over a palette that was matched against measured
 * captures — every building would drift off its token at every dawn.
 */
export function sunLitBuildingsLight(
  appearance: MapAppearance,
  sun: SunPosition,
): LightSpecification {
  return {
    anchor: 'map',
    position: [
      LIGHT_RADIUS,
      // Whole degrees: a degree of light is below what anyone can see on a
      // wall, and an integer is a value two samples can be compared on, which
      // is what keeps the adapters from re-applying an unchanged light.
      Math.round(sun.azimuthDeg) % 360,
      Math.round(sunPolarDeg(sun.altitudeDeg)),
    ],
    color: '#ffffff',
    intensity: BUILDINGS_LIGHT[appearance].intensity,
  };
}

/** The shaped polar angle for a sun at `altitudeDeg`. See {@link sunLitBuildingsLight}. */
export function sunPolarDeg(altitudeDeg: number): number {
  if (altitudeDeg >= 0) {
    const height = Math.min(altitudeDeg, 90) / 90;
    return POLAR_LOW_SUN_DEG - height * (POLAR_LOW_SUN_DEG - POLAR_HIGH_SUN_DEG);
  }
  const depth = Math.min(-altitudeDeg, TWILIGHT_DEPTH_DEG) / TWILIGHT_DEPTH_DEG;
  return POLAR_LOW_SUN_DEG - depth * (POLAR_LOW_SUN_DEG - POLAR_HIGH_SUN_DEG);
}

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
 * The fade as one value, for the city-3D prototype
 * (`components/map/engine/city3d/`), which replaces this layer when it is on
 * and must grow in over exactly the same zooms — otherwise switching the flag
 * would change WHEN buildings appear as well as how they look.
 */
export const BUILDINGS_3D_FADE = { start: FADE_IN_START, end: FADE_IN_END } as const;

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
  const parse = (hex: string): [number, number, number] => parseHexColour(hex) ?? [0, 0, 0];
  const [ar, ag, ab] = parse(a);
  const [br, bg, bb] = parse(b);
  const channel = (x: number, y: number): string =>
    Math.round(x + (y - x) * amount)
      .toString(16)
      .padStart(2, '0');
  return `#${channel(ar, br)}${channel(ag, bg)}${channel(ab, bb)}`;
}

/**
 * The height ramp: the colour at the ground, at {@link TALL_M} and at
 * {@link VERY_TALL_M}, for one appearance.
 *
 * Taller buildings step AWAY from the ground tone rather than toward a fixed
 * grey, which is why this is derived from the palette's own two building
 * tokens instead of new ones. In light the outline token is darker than the
 * fill, in dark it is lighter, so the same ramp reads as "a tower has more
 * presence than a shop" in both appearances without either being
 * special-cased — and without touching `palette.ts`, which is being rewritten
 * against measured Apple captures in parallel.
 *
 * Exported so the city-3D prototype colours its meshes with the very same
 * ramp: the two renderers may disagree about shading, never about colour.
 */
export function buildingHeightRamp(palette: CartographyPalette): {
  low: string;
  tall: string;
  veryTall: string;
  tallM: number;
  veryTallM: number;
} {
  return {
    low: palette.building,
    tall: mix(palette.building, palette.buildingOutline, 0.35),
    veryTall: mix(palette.building, palette.buildingOutline, 0.6),
    tallM: TALL_M,
    veryTallM: VERY_TALL_M,
  };
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
  // See `buildingHeightRamp` for why the ramp is derived from the palette.
  const { low, tall, veryTall } = buildingHeightRamp(palette);

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

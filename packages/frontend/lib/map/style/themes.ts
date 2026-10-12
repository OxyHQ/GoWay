/**
 * The style ENGINE's colour and switches: one {@link StyleTheme} per (style,
 * light), derived — never a second copy of a palette (`docs/MAP_STYLES.md`).
 *
 * A theme is everything a style changes and nothing else:
 *
 *  - **`palette`** — the 2D cartography, in `palette.ts`'s shape;
 *  - **`options`** — which of the shared layers draw, and how densely
 *    (`layers.ts` reads them; the layer LIST is one);
 *  - **`cityGround`** — the ground the detailed 3D city switches the basemap
 *    to (`city3dGround.ts` diffs it against `palette` into paint overrides);
 *  - **`materials`** and **`streets`** — the 3D city's clay and its street
 *    detail, day and night, so the buildings and pavements match the style.
 *
 * ## Where each style's colours come from
 *
 *  - **Standard** day and night ARE `palette.ts`'s measured palettes and
 *    `palette3d.ts`'s detailed ground, untouched. Dawn and dusk are not new
 *    palettes: they are day mixed part of the way to night in OKLab and
 *    washed with the low sun's colour ({@link twilight}).
 *  - **Streets** keeps Standard's ground, water and type and gives the road
 *    network a coloured hierarchy — amber expressways, honey trunks, cream
 *    primaries — so the through route reads at a glance (`STREETS_ROADS`).
 *  - **Light** and **Dark** are built from Bloom's neutral (`mono`) tokens,
 *    read from `@oxy.so/bloom/preset-vars` rather than restated, so a data
 *    basemap sits on the same greys as the dashboard around it.
 *
 * Every derived palette has its type walked back to the 4.5:1 floor the
 * measured ones keep ({@link enforceTypeContrast}); the tests hold every theme
 * to it.
 */
import type { AppColorName } from '@oxy.so/bloom/color-presets';
import { getPresetVars } from '@oxy.so/bloom/preset-vars';

import {
  ensureContrast,
  flattenColour,
  formatCssColour,
  hexToRgb,
  mapColour,
  mixColours,
  parseCssColour,
} from '../colour';
import type { MapAppearance } from '../provider';
import {
  type MapLightPreset,
  type MapStyleId,
  type MapStyleSelection,
  mapStyleDefinition,
  presetAppearance,
} from './catalogue';
import { type CartographyPalette, DARK_PALETTE, LIGHT_PALETTE, type RoadTier } from './palette';
import { CITY_GROUND_PALETTES, CITY_MATERIALS, type CityMaterial, type Rgb } from './palette3d';
import { DATA_OPTIONS, STANDARD_OPTIONS, STREETS_OPTIONS, type StyleOptions } from './options';
import { type StreetColours, STREET_PALETTES } from './streetPalette';

export type { StyleOptions } from './options';

// ---------------------------------------------------------------------------
// The theme
// ---------------------------------------------------------------------------

export interface StyleTheme {
  selection: MapStyleSelection;
  /** The cartographic appearance: dawn and dusk are lit as the light map. */
  appearance: MapAppearance;
  palette: CartographyPalette;
  options: StyleOptions;
  /** The detailed 3D city's ground under this style. */
  cityGround: CartographyPalette;
  /** The detailed clay's day and night ends, as the engine blends them. */
  materials: { day: CityMaterial; night: CityMaterial };
  /** The 3D street detail's day and night. */
  streets: { day: StreetColours; night: StreetColours };
}

/** Two palettes of the same shape, combined field by field. */
function zipPalettes(
  a: CartographyPalette,
  b: CartographyPalette,
  fn: (x: string, y: string, key: string) => string,
  appearance: MapAppearance,
): CartographyPalette {
  const walk = (x: unknown, y: unknown, key: string): unknown => {
    if (typeof x === 'string' && typeof y === 'string') return fn(x, y, key);
    if (x === null || y === null) return x ?? y;
    if (typeof x !== 'object' || typeof y !== 'object') return x;
    return Object.fromEntries(
      Object.entries(x as Record<string, unknown>).map(([k, v]) => [
        k,
        walk(v, (y as Record<string, unknown>)[k], key ? `${key}.${k}` : k),
      ]),
    );
  };
  return { ...(walk(a, b, '') as CartographyPalette), appearance };
}

/** The fields that are TYPE: inks and halos. Everything else is ground. */
const isTypeField = (key: string): boolean =>
  key.startsWith('label') || key.startsWith('poiLabel.') || key === 'halo' || key === 'haloStrong';

/** The road tiers a street label sits inside, for its contrast floor. */
const NAMED_STREET_TIERS: readonly RoadTier[] = ['primary', 'secondary', 'tertiary', 'local'];

/**
 * Walk every ink of a DERIVED palette back to 4.5:1 against what it is read
 * on — the halo over the land, and for each class its own ground — exactly as
 * `palette.ts` did by hand for its POI type. Hue is kept, so a category
 * colour stays its category.
 */
export function enforceTypeContrast(palette: CartographyPalette): CartographyPalette {
  const halo = flattenColour(palette.halo, palette.land);
  const ground = [palette.land, halo];
  const streets = NAMED_STREET_TIERS.map((tier) => palette.roads[tier].fill);
  const poiLabel = Object.fromEntries(
    Object.entries(palette.poiLabel).map(([k, v]) => [k, ensureContrast(v, ground, 4.5)]),
  ) as unknown as CartographyPalette['poiLabel'];
  return {
    ...palette,
    labelPlace: ensureContrast(palette.labelPlace, [...ground, palette.landBuiltUp], 4.5),
    labelPlaceMinor: ensureContrast(palette.labelPlaceMinor, [...ground, palette.landBuiltUp], 4.5),
    labelRegion: ensureContrast(palette.labelRegion, ground, 4.5),
    labelRoad: ensureContrast(palette.labelRoad, streets, 4.5),
    labelWater: ensureContrast(palette.labelWater, [palette.water], 4.5),
    labelPark: ensureContrast(palette.labelPark, [palette.park], 4.5),
    poiLabel,
  };
}

// ---------------------------------------------------------------------------
// Standard: measured day and night, derived dawn and dusk
// ---------------------------------------------------------------------------

/**
 * The low sun, by light. The day map is kept — the reader is still in
 * daylight — dimmed a little (`dim`, on OKLab lightness) and lit by the low
 * sun: every ground colour is pushed `warmth` along OKLab's chroma plane
 * toward the sun's hue, which tints a pale cream and a white street alike
 * without greying either (a mix toward the night palette crosses the grey
 * middle of the cream–violet axis, and looked like mud on Barcelona).
 * Water goes `waterToNight` of the way to the night's deeper blue.
 *
 * Dusk is amber and a step dimmer; dawn is rose and nearly as bright as day.
 * Chosen, not measured, side by side with day and night on Barcelona and
 * Manhattan.
 */
const TWILIGHT: Record<
  'dawn' | 'dusk',
  { dim: number; warmth: number; hue: number; waterToNight: number }
> = {
  dawn: { dim: 0.975, warmth: 0.011, hue: 350, waterToNight: 0.12 },
  dusk: { dim: 0.94, warmth: 0.017, hue: 62, waterToNight: 0.28 },
};

/** A colour lit by the low sun: lightness × `dim`, then `warmth` of chroma toward `hue`. */
function sunlit(value: string, dim: number, warmth: number, hue: number): string {
  return mapColour(value, ([L, C, h]) => {
    const rad = (hue * Math.PI) / 180;
    const own = (h * Math.PI) / 180;
    const a = C * Math.cos(own) + warmth * Math.cos(rad);
    const b = C * Math.sin(own) + warmth * Math.sin(rad);
    const hueOut = (Math.atan2(b, a) * 180) / Math.PI;
    return [L * dim, Math.hypot(a, b), hueOut < 0 ? hueOut + 360 : hueOut];
  });
}

/**
 * Dawn or dusk from a day and a night palette: the day's ground lit by the
 * low sun, the water deepened toward the night's, the POI marks kept; the
 * type stays the day's inks, walked back to 4.5:1 on the new ground, and the
 * halo is the new land.
 */
function twilight(
  day: CartographyPalette,
  night: CartographyPalette,
  preset: 'dawn' | 'dusk',
): CartographyPalette {
  const { dim, warmth, hue, waterToNight } = TWILIGHT[preset];
  const lit = zipPalettes(
    day,
    night,
    (a, b, key) => {
      if (isTypeField(key) || key.startsWith('poi.')) return a;
      if (key === 'water' || key === 'waterway' || key === 'ferry') {
        return sunlit(mixColours(a, b, waterToNight), 1, warmth * 0.5, hue);
      }
      return sunlit(a, dim, warmth, hue);
    },
    'light',
  );
  const land = parseCssColour(lit.land);
  const halo = land ? formatCssColour({ rgb: land.rgb, alpha: 0.95 }) : lit.halo;
  return enforceTypeContrast({ ...lit, halo });
}

/** A light's palette from a style's day and night recipe. */
function lit(
  preset: MapLightPreset,
  day: CartographyPalette,
  night: CartographyPalette,
): CartographyPalette {
  if (preset === 'day') return day;
  if (preset === 'night') return night;
  return twilight(day, night, preset);
}

// ---------------------------------------------------------------------------
// Streets: Standard's ground, a coloured road hierarchy
// ---------------------------------------------------------------------------

/**
 * Streets' roads. Width still ranks them; here colour ranks them too, warmest
 * for the fastest: amber expressways, honey trunks, cream primaries, white
 * streets — the convention road atlases have used for a century, in GoWay's
 * own values. Casings are the fill's own hue, deepened, so a junction reads
 * as one surface. Night keeps the order in ember tones over charcoal.
 */
const STREETS_ROADS: Record<MapAppearance, CartographyPalette['roads']> = {
  light: {
    motorway: { fill: '#f6b45c', casing: '#d48b31', fillLowZoom: '#f2a548' },
    motorwayLink: { fill: '#f8c47c', casing: '#d99a4c' },
    trunk: { fill: '#fbd08a', casing: '#d9a75c' },
    trunkLink: { fill: '#fcdb9f', casing: '#dcb06c' },
    primary: { fill: '#fdedb7', casing: '#dcc68b' },
    secondary: { fill: '#ffffff', casing: '#d2cbbb' },
    tertiary: { fill: '#ffffff', casing: '#d8d3c8' },
    local: { fill: '#ffffff', casing: '#dfdbd2' },
    service: { fill: '#fcfbf8', casing: '#e4e0d8' },
    track: { fill: '#efe9dc', casing: '#d9d1bf' },
    path: { fill: '#c4b8a4', casing: null },
    tunnel: { fill: '#efebe3', casing: '#dcd7cc' },
  },
  // Over Standard's slate-blue night: the fast roads glow ember, the city
  // streets are the night map's blue-greys a step deeper than Standard's, so
  // their white names clear 4.5:1 (Standard's lean on the halo instead), and
  // the casings sit one step under the land.
  dark: {
    motorway: { fill: '#c98c45', casing: '#2c3546', fillLowZoom: '#d09450' },
    motorwayLink: { fill: '#b3803f', casing: '#2c3546' },
    trunk: { fill: '#a87d4c', casing: '#2c3546' },
    trunkLink: { fill: '#97734c', casing: '#2c3546' },
    primary: { fill: '#76684f', casing: '#2f3a4d' },
    secondary: { fill: '#58697f', casing: '#3a4860' },
    tertiary: { fill: '#536379', casing: '#3a4860' },
    local: { fill: '#4e5d72', casing: '#3a4860' },
    service: { fill: '#48576b', casing: '#36445a' },
    track: { fill: '#4a5a6e', casing: '#3a485d' },
    path: { fill: '#64748a', casing: null },
    tunnel: { fill: '#43536b', casing: '#3a485d' },
  },
};

/**
 * Streets at night: Standard's blue-violet night — the ground the city sky's
 * moonlight is art-directed for — under the ember road hierarchy, with
 * Standard night's own type.
 */
function streetsNight(): CartographyPalette {
  return enforceTypeContrast({ ...DARK_PALETTE, roads: STREETS_ROADS.dark });
}

/** Streets by day: Standard's daylight with the coloured hierarchy, buildings drawn earlier. */
function streetsDay(): CartographyPalette {
  return enforceTypeContrast({
    ...LIGHT_PALETTE,
    land: '#f4f2ed',
    landBuiltUp: '#efebe3',
    roads: STREETS_ROADS.light,
    building: '#e6e1d7',
    buildingOutline: '#d4cdbf',
    labelRoad: '#4a4e53',
  });
}

// ---------------------------------------------------------------------------
// Light and Dark: data basemaps from Bloom's neutrals
// ---------------------------------------------------------------------------

/**
 * Bloom's neutral surface set, resolved (`mono`: pure greys, no brand hue).
 * Read through the colour engine's own resolver, so a Bloom release that
 * moves its greys moves these maps with it.
 */
function bloomNeutrals(
  mode: 'light' | 'dark',
): Record<
  | 'background'
  | 'contentArea'
  | 'card'
  | 'surface'
  | 'muted'
  | 'border'
  | 'mutedForeground'
  | 'foreground',
  string
> {
  const vars = getPresetVars('mono' as AppColorName, mode) as unknown as Record<string, string>;
  const hex = (name: string) => {
    const parsed = parseCssColour(vars[name]);
    return parsed ? formatCssColour({ rgb: parsed.rgb, alpha: 1 }) : '#808080';
  };
  return {
    background: hex('--background'),
    contentArea: hex('--content-area'),
    card: hex('--card'),
    surface: hex('--surface'),
    muted: hex('--muted'),
    border: hex('--border'),
    mutedForeground: hex('--muted-foreground'),
    foreground: hex('--foreground'),
  };
}

/**
 * The only hues a data basemap keeps: water still reads as water and green
 * space as green, each a whisper over the neutral it is mixed into. A data
 * layer drawn on top owns every other colour.
 */
const DATA_HUES = { water: '#6f9fc8', green: '#8cc28a', sand: '#d9c9a3' } as const;

function dataPalette(appearance: MapAppearance): CartographyPalette {
  const n = bloomNeutrals(appearance);
  const light = appearance === 'light';
  // By day the land is Bloom's background and the streets its card white; by
  // night the land is the surface and the streets a step up from it.
  const land = light ? n.background : n.surface;
  const built = mixColours(land, light ? n.surface : n.background, 0.5);
  const green = mixColours(land, DATA_HUES.green, light ? 0.2 : 0.16);
  const water = mixColours(light ? n.surface : n.background, DATA_HUES.water, light ? 0.42 : 0.2);
  const street = light ? n.card : n.muted;
  const casing = (by: number) => mixColours(n.border, land, by);
  const ink = n.mutedForeground;
  const quiet = mixColours(ink, land, 0.25);
  const tone = (fill: string, edge: string | null) => ({ fill, casing: edge });
  const palette: CartographyPalette = {
    appearance,
    land,
    landBuiltUp: built,
    natural: mixColours(land, DATA_HUES.green, light ? 0.12 : 0.1),
    farmland: land,
    park: green,
    parkOutline: green,
    pitch: green,
    medical: built,
    institution: built,
    airport: mixColours(land, light ? n.surface : n.muted, 0.6),
    sand: mixColours(land, DATA_HUES.sand, 0.15),
    wetland: mixColours(land, DATA_HUES.green, 0.1),
    ice: light ? n.card : mixColours(land, n.muted, 0.5),
    cemetery: green,
    water,
    waterway: water,
    roads: {
      motorway: tone(light ? n.card : n.border, light ? n.muted : land),
      motorwayLink: tone(
        light ? n.card : mixColours(n.border, n.muted, 0.5),
        light ? casing(0.2) : land,
      ),
      trunk: tone(light ? n.card : mixColours(n.border, n.muted, 0.4), light ? casing(0.2) : land),
      trunkLink: tone(street, light ? casing(0.3) : land),
      primary: tone(street, light ? casing(0.3) : land),
      secondary: tone(street, light ? casing(0.45) : land),
      tertiary: tone(street, light ? casing(0.55) : land),
      local: tone(street, light ? casing(0.65) : land),
      service: tone(mixColours(street, land, 0.3), light ? casing(0.75) : land),
      track: tone(mixColours(street, land, 0.5), casing(0.8)),
      path: tone(mixColours(n.border, land, light ? 0.3 : 0.4), null),
      tunnel: tone(mixColours(street, land, 0.5), casing(0.7)),
    },
    rail: mixColours(n.border, land, 0.2),
    railHatch: n.border,
    ferry: mixColours(water, ink, 0.25),
    aeroway: { fill: mixColours(land, n.muted, 0.7), casing: null },
    building: light ? n.surface : mixColours(land, n.muted, 0.6),
    buildingOutline: light ? n.muted : n.border,
    boundaryCountry: mixColours(ink, land, 0.45),
    boundaryRegion: mixColours(n.border, land, 0.2),
    labelPlace: ink,
    labelPlaceMinor: quiet,
    labelRegion: quiet,
    labelRoad: quiet,
    labelWater: mixColours(ink, DATA_HUES.water, 0.35),
    labelPark: mixColours(ink, DATA_HUES.green, 0.35),
    halo: formatCssColour({
      rgb: (parseCssColour(land)?.rgb ?? [128, 128, 128]) as [number, number, number],
      alpha: 0.95,
    }),
    haloStrong: light ? n.card : land,
    // No POI is drawn (`DATA_OPTIONS.poi`); the fields still exist so the
    // palette keeps its one shape.
    poi: uniformPoi(n.border),
    poiLabel: uniformPoi(ink),
  };
  return enforceTypeContrast(palette);
}

function uniformPoi(colour: string): CartographyPalette['poi'] {
  return {
    foodDrink: colour,
    shopping: colour,
    outdoors: colour,
    transit: colour,
    lodging: colour,
    health: colour,
    civic: colour,
    culture: colour,
    worship: colour,
    vehicle: colour,
    other: colour,
  };
}

// ---------------------------------------------------------------------------
// The 3D city under a style
// ---------------------------------------------------------------------------

const rgbOf = (hex: string): Rgb => hexToRgb(hex);
const hexOf = (rgb: Rgb): string =>
  formatCssColour({ rgb: rgb.map((v) => v * 255) as [number, number, number], alpha: 1 });

/** The clay's colours through an OKLCh function; every other number kept. */
function mapMaterial(
  material: CityMaterial,
  fn: (lch: [number, number, number]) => readonly [number, number, number],
): CityMaterial {
  const recolour = (rgb: Rgb): Rgb => rgbOf(mapColour(hexOf(rgb), fn));
  return {
    ...material,
    low: recolour(material.low),
    tall: recolour(material.tall),
    veryTall: recolour(material.veryTall),
    glass: recolour(material.glass),
  };
}

/** The street detail's colours through a function. */
function mapStreets(colours: StreetColours, fn: (hex: string) => string): StreetColours {
  return Object.fromEntries(
    Object.entries(colours).map(([k, v]) => [k, fn(v)]),
  ) as unknown as StreetColours;
}

/** Desaturate to a whisper of chroma: what the data basemaps do to the clay and pavements. */
const quietChroma = (lch: [number, number, number]): [number, number, number] => [
  lch[0],
  lch[1] * 0.2,
  lch[2],
];

/**
 * A city ground under a style: the ground's colours with the STYLE's type,
 * except the two inks the 3D ground re-checks on its own fills — street names
 * and park names (`palette3d.ts`'s contract). Everything else a label reads
 * stays the style's, so the 3D city cross-fades ground colours and nothing
 * else (`city3dGround.ts` refuses a type expression it cannot fade).
 */
function asCityGround(style: CartographyPalette, ground: CartographyPalette): CartographyPalette {
  const typeOf = Object.fromEntries(
    Object.entries(style).filter(
      ([key]) => isTypeField(key) || key === 'poiLabel' || key === 'poi',
    ),
  );
  const merged: CartographyPalette = { ...ground, ...typeOf, appearance: style.appearance };
  const streets = NAMED_STREET_TIERS.map((tier) => merged.roads[tier].fill);
  return {
    ...merged,
    labelRoad: ensureContrast(ground.labelRoad, streets, 4.5),
    labelPark: ensureContrast(ground.labelPark, [merged.park], 4.5),
  };
}

// ---------------------------------------------------------------------------
// The recipes
// ---------------------------------------------------------------------------

/** What one style is made of, per appearance — the engine's whole input. */
interface StyleRecipe {
  options: StyleOptions;
  palette: (preset: MapLightPreset) => CartographyPalette;
  cityGround: (preset: MapLightPreset) => CartographyPalette;
  materials?: (base: { day: CityMaterial; night: CityMaterial }) => {
    day: CityMaterial;
    night: CityMaterial;
  };
  streets?: (base: { day: StreetColours; night: StreetColours }) => {
    day: StreetColours;
    night: StreetColours;
  };
}

const STANDARD_GROUND = {
  day: CITY_GROUND_PALETTES.light,
  night: CITY_GROUND_PALETTES.dark,
};

const RECIPES: Record<MapStyleId, StyleRecipe> = {
  standard: {
    options: STANDARD_OPTIONS,
    palette: (preset) => lit(preset, LIGHT_PALETTE, DARK_PALETTE),
    // Day and night are `palette3d.ts`'s grounds as they are; dawn and dusk
    // the same twilight of them, under the twilight palette's type.
    cityGround: (preset) =>
      preset === 'day' || preset === 'night'
        ? STANDARD_GROUND[preset]
        : asCityGround(
            lit(preset, LIGHT_PALETTE, DARK_PALETTE),
            lit(preset, STANDARD_GROUND.day, STANDARD_GROUND.night),
          ),
  },
  streets: {
    options: STREETS_OPTIONS,
    palette: (preset) => lit(preset, streetsDay(), streetsNight()),
    // The detailed ground keeps the coloured hierarchy: the maquette's pale
    // land and clay footprints under Streets' roads.
    // The detailed ground is the maquette's — pale land and clay footprints
    // by day, slate at night — under Streets' roads.
    cityGround: (preset) => {
      const base = lit(preset, streetsDay(), streetsNight());
      const ground = lit(preset, STANDARD_GROUND.day, STANDARD_GROUND.night);
      return asCityGround(base, {
        ...base,
        land: ground.land,
        landBuiltUp: ground.landBuiltUp,
        building: ground.building,
      });
    },
  },
  light: {
    options: DATA_OPTIONS,
    palette: () => dataPalette('light'),
    cityGround: () => dataPalette('light'),
    materials: (base) => ({
      day: mapMaterial(base.day, quietChroma),
      night: mapMaterial(base.night, quietChroma),
    }),
    streets: (base) => ({
      day: mapStreets(base.day, (hex) => mapColour(hex, quietChroma)),
      night: mapStreets(base.night, (hex) => mapColour(hex, quietChroma)),
    }),
  },
  dark: {
    options: DATA_OPTIONS,
    palette: () => dataPalette('dark'),
    cityGround: () => dataPalette('dark'),
    materials: (base) => ({
      day: mapMaterial(base.day, quietChroma),
      night: mapMaterial(base.night, quietChroma),
    }),
    streets: (base) => ({
      day: mapStreets(base.day, (hex) => mapColour(hex, quietChroma)),
      night: mapStreets(base.night, (hex) => mapColour(hex, quietChroma)),
    }),
  },
};

const cache = new Map<string, StyleTheme>();

/**
 * The theme for one (style, light). Pure and memoised: the build script, the
 * tests and the 3D city all read the same object for the same selection.
 *
 * A light the style is not published in is a programming error here (the
 * catalogue's `resolveMapStyle` picks a published one first), and throws.
 */
export function styleTheme(selection: MapStyleSelection): StyleTheme {
  const key = `${selection.style}/${selection.preset}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const definition = mapStyleDefinition(selection.style);
  if (!definition.presets.includes(selection.preset)) {
    throw new Error(`map style "${selection.style}" is not published in "${selection.preset}"`);
  }
  const recipe = RECIPES[selection.style];
  const materials = recipe.materials ? recipe.materials(CITY_MATERIALS) : CITY_MATERIALS;
  const streets = recipe.streets ? recipe.streets(STREET_PALETTES) : STREET_PALETTES;
  const theme: StyleTheme = {
    selection,
    appearance: presetAppearance(selection.preset),
    palette: recipe.palette(selection.preset),
    options: recipe.options,
    cityGround: recipe.cityGround(selection.preset),
    materials,
    streets,
  };
  cache.set(key, theme);
  return theme;
}

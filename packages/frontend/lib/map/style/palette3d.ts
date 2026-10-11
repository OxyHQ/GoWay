/**
 * The DETAILED 3D city's palette — the art direction of the `detailedCity` map feature.
 *
 * Two halves, both read only when the 3D city is on:
 *
 *  1. **The ground** ({@link CITY_GROUND_PALETTES}): the cartographic palette
 *     the basemap switches to under the buildings, from z14.5 to z15.5
 *     (`city3dGround.ts` turns it into paint overrides, generated into the
 *     style documents by `scripts/build-map-style.ts`).
 *  2. **The buildings' material** ({@link CITY_MATERIALS}): albedo, the
 *     response to the city sky's light, occlusion, edge highlight and the
 *     night window glow, for day and for night, blended on the GPU by the
 *     engine's one night factor. The shader that reads it is
 *     `components/map/engine/city3d/materials.ts`.
 *
 * ## The target
 *
 * Apple Maps' "Detailed City Experience", by LOOK, never by asset: matte
 * clay — a maquette. By day the buildings are a near-white warm grey, the
 * shaded sides only a little darker and a touch cooler, and the massing reads
 * through soft light and soft contact shadow, not through detail. The ground
 * under them is near-white, the streets are pale ASPHALT with white kerbs
 * (the inverse of the 2D map's white streets on cream), parks are a saturated
 * light green and water a vivid light blue. At night everything goes to a
 * blue-violet: slate ground, deep teal parks, blue-grey buildings lit from a
 * moonlit sky, and warm windows.
 *
 * Every hex below was picked by eye against Apple's published images (the
 * iOS 15 newsroom set — San Francisco Ferry Building, London Royal Albert
 * Hall, London wide, the Castro — and the landmark screenshots in the owner's
 * brief), then tuned on GoWay renders of Barcelona and Lower Manhattan side by
 * side with them. None is sampled off Apple's data; the images are not
 * committed (`docs/MAP_3D_CITY.md` → Art direction describes them).
 *
 * ## What is NOT here
 *
 * The 2D cartography (`palette.ts`) is untouched: this file only ever adds a
 * variant that the 3D city switches on. Labels keep their palette colours
 * and their contrast is re-checked against the variant's ground in the tests.
 */
import type { MapAppearance } from '../provider';
import { type CartographyPalette, DARK_PALETTE, LIGHT_PALETTE } from './palette';

// ---------------------------------------------------------------------------
// 1. The ground
// ---------------------------------------------------------------------------

/** The ground fields the 3D city re-colours. Everything else (type, POIs) stays. */
export type CityGroundFields = Pick<
  CartographyPalette,
  | 'land'
  | 'landBuiltUp'
  | 'natural'
  | 'farmland'
  | 'park'
  | 'parkOutline'
  | 'pitch'
  | 'medical'
  | 'institution'
  | 'cemetery'
  | 'water'
  | 'waterway'
  | 'roads'
  | 'building'
  | 'labelRoad'
  | 'labelPark'
>;

/**
 * Daylight ground. Apple's 3D city puts near-white buildings on a near-white
 * ground and lets the STREETS carry the plan, as pale asphalt edged by white
 * kerbs — so the casings here are lighter than the fills, the inverse of the
 * 2D map, and draw as the pavement either side of the carriageway.
 */
const LIGHT_GROUND: CityGroundFields = {
  land: '#f1f0ec', // near-white warm grey (SF Embarcadero plaza, Michigan Ave)
  landBuiltUp: '#eeede8', // no cream: a yellow block tint fights white buildings
  natural: '#b5df98',
  farmland: '#eceae1',
  park: '#acdd8c', // saturated light green (Harry Bridges Plaza, Apple Park)
  parkOutline: '#a3d684',
  pitch: '#b4e298',
  medical: '#f3e9e7',
  institution: '#ebeae5',
  cemetery: '#c6e1ae',
  // Apple's 3D water is the same vivid cyan as its 2D water, which palette.ts
  // already measured; kept, and with it labelWater's 4.53:1.
  water: LIGHT_PALETTE.water,
  waterway: LIGHT_PALETTE.waterway,
  roads: {
    motorway: {
      fill: '#a9adb4',
      casing: '#9da1a8',
      fillLowZoom: LIGHT_PALETTE.roads.motorway.fillLowZoom,
    },
    motorwayLink: { fill: '#b2b5bb', casing: '#a6a9af' },
    trunk: { fill: '#babdc2', casing: '#fbfbfa' },
    trunkLink: { fill: '#c0c3c7', casing: '#fbfbfa' },
    primary: { fill: '#c6c9cd', casing: '#fbfbfa' },
    secondary: { fill: '#cbced2', casing: '#fbfbfa' },
    tertiary: { fill: '#cfd1d5', casing: '#fbfbfa' },
    local: { fill: '#d5d7da', casing: '#fbfbfa' },
    service: { fill: '#dcdddf', casing: '#f7f7f6' },
    track: { fill: '#e3e0d8', casing: '#d6d3ca' },
    path: { fill: '#d8d4ca', casing: null },
    tunnel: { fill: '#e2e3e5', casing: '#d6d8db' },
  },
  // Type on the new ground, walked down its own lightness axis until it
  // clears 4.5:1 again (the method palette.ts uses for POI type): a street
  // label on the palest asphalt (#dcdddf) and on primary (#c6c9cd); a park
  // label on the more saturated park.
  labelRoad: '#515554', // from #636766 (3.45:1 on primary) -> 4.5:1 on every street fill
  labelPark: '#15652d', // from #166a2f (4.30:1 on #acdd8c) -> 4.5:1
  // The flat footprint under the meshes, seen between z14 and the buildings'
  // fade. Its outline keeps the 2D ramp: that one cross-fades across the very
  // zooms the ground does, and the meshes cover it from 16.5.
  building: '#e6e5e1',
};

/**
 * Night ground. Apple's night city is lighter and less saturated at street
 * level than its 2D dark map, and the streets are DARKER than the ground with
 * lighter pavements — the Castro and Kensington captures agree.
 */
const DARK_GROUND: CityGroundFields = {
  land: '#3d4a66', // slate blue-violet (Kensington Gore, Liberty Island)
  landBuiltUp: '#434c6c',
  natural: '#1b4c46',
  farmland: '#38445a',
  park: '#17685c', // deep teal-green (Hyde Park, the Biosphère's island)
  parkOutline: '#1b7265',
  pitch: '#1a7062',
  medical: '#454a62',
  institution: '#3f4a68',
  cemetery: '#28564f',
  water: DARK_PALETTE.water,
  waterway: DARK_PALETTE.waterway,
  roads: {
    motorway: {
      fill: '#55647f',
      casing: '#36425a',
      fillLowZoom: DARK_PALETTE.roads.motorway.fillLowZoom,
    },
    motorwayLink: { fill: '#4f5d78', casing: '#36425a' },
    trunk: { fill: '#313b53', casing: '#53607e' },
    trunkLink: { fill: '#313b53', casing: '#53607e' },
    primary: { fill: '#303a52', casing: '#53607e' },
    secondary: { fill: '#313b53', casing: '#515e7c' },
    tertiary: { fill: '#323c54', casing: '#4f5c7a' },
    local: { fill: '#333d55', casing: '#4d5a78' },
    service: { fill: '#364058', casing: '#4a5674' },
    track: { fill: '#414c64', casing: '#38435a' },
    path: { fill: '#55617d', casing: null },
    tunnel: { fill: '#3a4560', casing: '#333d55' },
  },
  building: '#4a5574',
  labelRoad: DARK_PALETTE.labelRoad, // 9.9:1 on the dark asphalt, up from 4.3:1
  labelPark: '#8df6c7', // from #7ee0b4 (4.17:1 on #17685c) -> 4.5:1
};

/**
 * The basemap palettes the 3D city's ground switches to: each appearance's
 * cartographic palette with {@link CityGroundFields} replaced.
 */
export const CITY_GROUND_PALETTES: Record<MapAppearance, CartographyPalette> = {
  light: { ...LIGHT_PALETTE, ...LIGHT_GROUND },
  dark: { ...DARK_PALETTE, ...DARK_GROUND },
};

/**
 * The zooms the ground cross-fades over: finished before the buildings start
 * to grow in (`BUILDINGS_3D_FADE`, 15.5), so the volumes arrive on the ground
 * they are coloured for, and the region-scale map is the 2D palette, untouched.
 */
export const CITY_GROUND_FADE = { start: 14.5, end: 15.5 } as const;

/**
 * The style `metadata` key under which `scripts/build-map-style.ts` publishes
 * the ground as paint overrides (`city3dGround.ts` builds them), in each
 * appearance's own style document.
 */
export const CITY3D_GROUND_METADATA_KEY = 'goway:city3d-ground';

/** One paint property of one layer, and the value it takes while the 3D city is on. */
export interface GroundOverride {
  layer: string;
  property: string;
  value: unknown;
}

// ---------------------------------------------------------------------------
// 2. The buildings' material
// ---------------------------------------------------------------------------

/** sRGB channels in 0–1. */
export type Rgb = readonly [number, number, number];

/**
 * Everything the detailed material's shader reads, for ONE lighting state
 * (day, night, or a blend of the two). The lighting model it parameterises is
 * documented on `materials.ts`; units are factors on the albedo unless stated.
 */
export interface CityMaterial {
  /** Albedo height ramp: the colour at the ground, at `tallM` and at `veryTallM`. */
  low: Rgb;
  tall: Rgb;
  veryTall: Rgb;
  tallM: number;
  veryTallM: number;
  /** Wrap lighting: how far past the terminator the sun still reaches (0 = Lambert). */
  wrap: number;
  /** Contact occlusion at the foot of a wall (1 − brightness there) and its reach in metres. */
  aoGround: number;
  aoReachM: number;
  /** How much of the baked corner occlusion is kept (0–1). */
  aoCorner: number;
  /** Walls darken toward their base over the whole building: 1 − brightness at the base. */
  heightGradient: number;
  /** Added to the chamfered roof edge (45° faces), × the sky fill: the soft highlight. */
  edge: number;
  /** Per-building albedo variation: ± lightness, and warm/cool hue swing. */
  tintLightness: number;
  tintHue: number;
  /** How much of a tagged colour/material survives (× the classic temper). */
  tagBlend: number;
  /**
   * How much of the tempered tag's CHROMA survives, on top of the classic
   * temper: Apple's massing is uniform, so a tag is kept as a lightness hint
   * (brick a little darker, glass a little lighter) and almost none of its hue.
   */
  tagSaturation: number;
  /**
   * The response to the CITY SKY's light, which is the only light the
   * detailed look is drawn in (`materials.ts`). The sky
   * hands physical, exposed irradiance — a warm sun, a blue sky, a dim wall —
   * and the clay answers it as the approved look: the hemisphere fill × a gain
   * with only some of the sky light's hue (`skyFillChroma`, 0 grey … 1 all),
   * and the sun × a gain. The sun keeps its colour, so golden hour is golden.
   */
  skyFillGain: number;
  skyFillChroma: number;
  skySunGain: number;
  /** Window openings: how strongly they read on a lit facade (0 = invisible). */
  windowStrength: number;
  /** The glass colour of an unlit opening. */
  glass: Rgb;
  /**
   * Emissive glow of a lit window — warm — and the cooler white a minority of
   * windows drift toward (a per-window hash picks where between, and a
   * brightness), and the share of windows lit.
   */
  windowGlow: Rgb;
  windowGlowCool: Rgb;
  windowLitShare: number;
}

const hex = (value: string): Rgb => {
  const n = Number.parseInt(value.slice(1, 7), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
};

/**
 * Daylight clay. The albedo is a near-white warm grey that goes slightly
 * cooler and greyer with height (towers read as glass and steel, not as a
 * lighter cream); under the sky's light a shaded wall lands ~20% under a lit
 * one and a shade cooler — never black. Windows are barely there: Apple shows
 * clean massing by day.
 */
const DAY: CityMaterial = {
  low: hex('#dedcd7'),
  tall: hex('#dadad8'),
  veryTall: hex('#d5d6d8'),
  tallM: 60,
  veryTallM: 180,
  wrap: 0.55,
  aoGround: 0.28,
  aoReachM: 10,
  aoCorner: 0.8,
  heightGradient: 0.07,
  edge: 0.12,
  tintLightness: 0.06,
  tintHue: 0.025,
  tagBlend: 0.35,
  tagSaturation: 0.12,
  skyFillGain: 1.6,
  skyFillChroma: 0.4,
  skySunGain: 0.65,
  windowStrength: 0.1,
  glass: hex('#9aa6b8'),
  windowGlow: [0, 0, 0],
  windowGlowCool: [0, 0, 0],
  windowLitShare: 0,
};

/**
 * Moonlit night. Blue-grey buildings a step LIGHTER than the slate ground
 * (Apple's night city reads as massing, not as silhouettes), lit mostly by
 * the sky's night fill, with warm windows. Window lighting is
 * a deterministic per-window hash at {@link CityMaterial.windowLitShare}:
 * stylistic variation, never a claim about who is home (see the doc). The
 * warm light at the FOOT of the walls (street lighting, `floodlit=yes`
 * uplighting) and the night sky are the city-sky phase's, not this file's.
 */
const NIGHT: CityMaterial = {
  low: hex('#566586'),
  tall: hex('#59688a'),
  veryTall: hex('#5e6d90'),
  tallM: 60,
  veryTallM: 180,
  wrap: 0.5,
  aoGround: 0.3,
  aoReachM: 10,
  aoCorner: 0.8,
  heightGradient: 0.12,
  edge: 0.06,
  tintLightness: 0.04,
  tintHue: 0.02,
  tagBlend: 0.3,
  tagSaturation: 0.12,
  skyFillGain: 2.0,
  skyFillChroma: 0.25,
  skySunGain: 0.65,
  windowStrength: 0.75,
  glass: hex('#2b3352'),
  windowGlow: [1.0, 0.78, 0.4],
  windowGlowCool: [0.9, 0.9, 0.82],
  windowLitShare: 0.36,
};

export const CITY_MATERIALS = { day: DAY, night: NIGHT } as const;

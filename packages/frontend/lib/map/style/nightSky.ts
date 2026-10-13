/**
 * The city sky's NIGHT as each map style draws it (`docs/MAP_STYLES.md`):
 * the one light at night, the colour of the sky dome, the light at street
 * level on the walls, and the floodlights' colour. The city sky
 * (`components/map/engine/city3d/atmosphere.ts`) takes it over from the
 * physical sky through nautical twilight, the same window as `nightFactor`,
 * so a style's night and dusk both come from here; the globe's night side
 * (`globeNight.ts`) is the same night.
 *
 * Standard's is the art direction's. Every other style's is Standard's
 * through the colour function its recipe applies to its palette and clay
 * (`themes.ts`, `chroma.ts`): Monochrome's 6% chroma, the data basemaps' and
 * Navigation's quiet chroma. Each light keeps its brightness: a style changes
 * the night's colour, never how dark it is.
 *
 * Its own module, beside the theme, so the globe's night can read it without
 * the theme engine (the relief chunk loads it; the theme is the city's).
 */
import { hexToRgb, mapColour } from '../colour';
import type { MapStyleId } from './catalogue';
import { monochrome, quietChroma } from './chroma';

type Rgb = readonly [number, number, number];

export interface CityNightSky {
  /**
   * The night's only light: faint and coloured, relative to the reference
   * daylight's illuminance (linear). A moonless, city-glow-free sky. Its
   * colour is the night's tint on every building, street and the ground pass.
   */
  ambient: Rgb;
  /** The night sky's colour at the zenith and at the horizon (display sRGB). */
  zenith: Rgb;
  horizon: Rgb;
  /**
   * The light at street level on every wall at night, fading out over its
   * first metres (`atmosphere.ts` → `STREET_GLOW_HEIGHT_M`). Linear,
   * relative to the night's adapted brightness. Lighting, applied to every
   * wall alike: it says nothing about any one building.
   */
  streetGlow: Rgb;
  /**
   * The colour of the uplight on buildings that RECORD being lit at night
   * (`atmosphere.ts` → `FLOODLIGHT`: its strength and fall-off). The fact is
   * the tag; the colour is the style's.
   */
  floodlight: Rgb;
}

/**
 * Standard's night: a deep blue-violet, lighter at the horizon, and warm
 * street light. Stylised, not measured: a moonless sky over a city is a dull
 * orange-grey glow nobody wants on a map, and the art direction asks for the
 * blue-violet of an illustrated night.
 */
export const CITY_NIGHT_SKY: CityNightSky = {
  ambient: [0.0014, 0.0027, 0.0074],
  zenith: [0x14 / 255, 0x16 / 255, 0x58 / 255],
  horizon: [0x27 / 255, 0x30 / 255, 0x8c / 255],
  streetGlow: [0.3, 0.16, 0.06],
  floodlight: [1, 0.64, 0.34],
};

type ColourFn = (lch: [number, number, number]) => readonly [number, number, number];

/** Each style's colour function for its night; absent, Standard's night as it is. */
const NIGHT_COLOUR: Partial<Record<MapStyleId, ColourFn>> = {
  monochrome,
  light: quietChroma,
  dark: quietChroma,
  // Navigation's night ground is a near-neutral charcoal: its night keeps
  // only a whisper of Standard's blue-violet, so the route line stays the
  // most saturated thing on screen at night too.
  navigation: quietChroma,
};

const hexOf = (rgb: Rgb): string =>
  `#${rgb
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;

/** A night through a colour function, every light at its own luminance. */
export function mapNightSky(sky: CityNightSky, fn: ColourFn): CityNightSky {
  const recolour = (rgb: Rgb): Rgb => hexToRgb(mapColour(hexOf(rgb), fn));
  const luma = (c: Rgb) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  // A light (linear, of any brightness): its tint recoloured at full scale,
  // then put back at its own luminance.
  const retint = (light: Rgb): Rgb => {
    const peak = Math.max(...light, 1e-12);
    const shown = recolour(light.map((v) => (v / peak) ** (1 / 2.2)) as unknown as Rgb);
    const tint = shown.map((v) => v ** 2.2);
    const scale = luma(light) / Math.max(luma(tint as unknown as Rgb), 1e-12);
    return [tint[0] * scale, tint[1] * scale, tint[2] * scale];
  };
  return {
    ambient: retint(sky.ambient),
    zenith: recolour(sky.zenith),
    horizon: recolour(sky.horizon),
    streetGlow: retint(sky.streetGlow),
    floodlight: retint(sky.floodlight),
  };
}

const cache = new Map<MapStyleId, CityNightSky>();

/** A style's night (memoised: the same object for the same style, so caches can key on it). */
export function styleNightSky(style: MapStyleId): CityNightSky {
  let sky = cache.get(style);
  if (!sky) {
    const fn = NIGHT_COLOUR[style];
    sky = fn ? mapNightSky(CITY_NIGHT_SKY, fn) : CITY_NIGHT_SKY;
    cache.set(style, sky);
  }
  return sky;
}

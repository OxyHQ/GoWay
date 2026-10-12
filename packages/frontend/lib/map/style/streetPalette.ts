/**
 * The street-detail palette: asphalt, sidewalks, kerbs, paving and paint, by
 * day and by night (`docs/MAP_STREETS.md` → Look). The renderer blends the two
 * by the city's `nightFactor` (`lib/map/landmarks/night.ts`), so a time-of-day
 * scrub or the dark appearance repaints the streets with no re-meshing.
 *
 * Target: Apple Maps' detailed city, by LOOK, never by asset — against the
 * owner's references (Sixth Avenue at Rockefeller Center, night): dark
 * blue-grey asphalt, a lighter raised sidewalk, white paint dimmed so it does
 * not glare, a muted terracotta bus lane.
 *
 * ## One ground with the city's art direction
 *
 * The asphalt and the sidewalk ARE the 3D city's ground palette
 * (`palette3d.ts` → `CITY_GROUND_PALETTES`): a street's fill and its casing
 * (the kerb-side pavement), by day the light appearance's and by night the
 * dark one's — so the 3D streets and the flat roads around them are one
 * colour, and an art-direction change moves both. Everything else here (paint,
 * kerb faces, paving, tints) is this feature's own.
 */
import { hexToRgb } from '../colour';
import { CITY_GROUND_PALETTES, type Rgb } from './palette3d';

/** sRGB hex per slot. */
export interface StreetColours {
  asphalt: string;
  sidewalk: string;
  kerb: string;
  paving: string;
  paint: string;
  yellow: string;
  bus: string;
  cycle: string;
  crossing: string;
}

const ground = (appearance: 'light' | 'dark') => {
  const road = CITY_GROUND_PALETTES[appearance].roads.primary;
  return { asphalt: road.fill, sidewalk: road.casing ?? road.fill };
};

const DAY: StreetColours = {
  ...ground('light'),
  kerb: '#d8d7d2',
  paving: '#e7e4dd',
  paint: '#fbfbfa',
  yellow: '#f0c75a',
  bus: '#cf8c80',
  cycle: '#9ccf9c',
  crossing: '#d9c7b8',
};

const NIGHT: StreetColours = {
  ...ground('dark'),
  kerb: '#475068',
  paving: '#5b6479',
  paint: '#c3c9d6',
  yellow: '#c6a75c',
  bus: '#6c4a55',
  cycle: '#3f6a5d',
  crossing: '#5b5568',
};

export const STREET_PALETTES = { day: DAY, night: NIGHT } as const;

/**
 * The least WCAG contrast a marking keeps against the asphalt it is painted
 * on (`streetPalette.test.ts` holds both ends to it). White paint — lane
 * lines, crossings, stop lines, arrows, names — must read at a glance; yellow
 * (centre lines) also reads by hue, so its floor by day is lower. Measured
 * when this was set: day white 2.39:1 and yellow 1.53:1 on `#a2a5a9`; night
 * 6.83:1 and 4.90:1 on `#303a52` (the pale `#c6c9cd` asphalt gave white
 * 1.60:1 by day, which is why the ground palette's streets were darkened).
 */
export const MARKING_CONTRAST = {
  day: { paint: 2.2, yellow: 1.5 },
  night: { paint: 4.5, yellow: 3 },
} as const;

/** The renderer's input: sRGB triples in its slot order (`meshBuffers.ts` → `SURFACE`, `PAINT`). */
export function streetPaletteInput(): {
  surfaces: { day: Rgb[]; night: Rgb[] };
  paint: { day: Rgb[]; night: Rgb[] };
} {
  const surfaces = (c: StreetColours) =>
    [c.asphalt, c.sidewalk, c.kerb, c.paving].map((c) => hexToRgb(c));
  const paint = (c: StreetColours) =>
    [c.paint, c.yellow, c.bus, c.cycle, c.crossing].map((c) => hexToRgb(c));
  return {
    surfaces: { day: surfaces(DAY), night: surfaces(NIGHT) },
    paint: { day: paint(DAY), night: paint(NIGHT) },
  };
}

/**
 * The colour functions the style recipes share (OKLCh in, OKLCh out), one
 * copy: `themes.ts` recolours palettes, the clay and the street detail with
 * them, and `nightSky.ts` the city sky's night.
 */

/**
 * Every colour at a whisper of its chroma — lightness, and so the whole
 * hierarchy, kept — then the type walked back to 4.5:1 (a POI's category
 * colour goes, its name stays legible). Built FROM Standard rather than drawn
 * again, so every change to Standard's cartography reaches it.
 */
export const MONO_CHROMA = 0.06;
export const monochrome = (lch: [number, number, number]): [number, number, number] => [
  lch[0],
  lch[1] * MONO_CHROMA,
  lch[2],
];

/** Desaturate to a whisper of chroma: what the data basemaps do to the clay and pavements. */
export const quietChroma = (lch: [number, number, number]): [number, number, number] => [
  lch[0],
  lch[1] * 0.2,
  lch[2],
];

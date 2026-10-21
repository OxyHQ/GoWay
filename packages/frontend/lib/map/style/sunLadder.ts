/**
 * The sun ladder: the documents a style that follows the sun walks through
 * as the sun goes down — day, dusk where the style has one, night — and the
 * light the sun-driven darkening (the globe's night, `globeNight.ts`; the
 * city sky's ground pass, `atmosphere.ts`) lays over each, so that the map
 * is CONTINUOUS where one document hands over to the next.
 *
 * Each document is darkened from its own base curve (a day map's falling
 * light, a night map's) and, before the altitude where the next darker
 * document takes over, eases onto exactly what that document draws there:
 * its land times its light, over this document's land. The darker document
 * is drawn as it always is; a multiply can only darken, and the brighter
 * document is the one with room to. So:
 *
 * - Standard: the day map converges on dawn's or dusk's land at
 *   {@link SUN_LIGHT_BAND}`.day` (from 6° above it), and the dawn or dusk map
 *   on the night map's at `SUN_LIGHT_BAND.night` (from the altitude it
 *   stands for, {@link TWILIGHT_DOCUMENT_DEG}).
 * - A style with no dawn or dusk (`catalogue.ts` → `resolveMapStyle` changes
 *   day for night at the horizon): the day map converges on the night map's
 *   land at {@link SUN_HORIZON_DEG}, from `SUN_LIGHT_BAND.day`.
 *
 * A map whose light does NOT follow the sun (the app's theme, a fixed day or
 * night) never changes document, so a day or night document there keeps its
 * base curve. A dawn or dusk document always converges: it is only ever a
 * step between two others.
 *
 * Pure numbers: the land colours come from the caller (the documents'
 * `goway:sun-lands` metadata for the globe, the 3D city's ground palettes
 * for the city sky), and so do the base curves.
 */
import {
  type MapLightPreset,
  presetDocumentLight,
  SUN_HORIZON_DEG,
  SUN_LIGHT_BAND,
  TWILIGHT_DOCUMENT_DEG,
} from './catalogue';
import { parseHexColour } from '../colour';

export type Rgb3 = readonly [number, number, number];

/** The land each published light of a style draws, sRGB 0…1 per channel. */
export interface SunLadderLands {
  day: Rgb3;
  dawn?: Rgb3;
  dusk?: Rgb3;
  night: Rgb3;
}

/** One document on its style's ladder. */
export interface SunLadder {
  /** The light of the document drawn. */
  preset: MapLightPreset;
  /** Whether the map's light follows the sun, so its documents hand over. */
  followsSun: boolean;
  /** The style's lands; `null` (unknown) leaves every document on its base curve. */
  lands: SunLadderLands | null;
}

/** The darkening of a day document and of a night document by themselves, 0…1 per channel. */
export interface SunBaseLight {
  light(altitudeDeg: number): Rgb3;
  dark(altitudeDeg: number): Rgb3;
}

/** Where each handover happens (`at`) and where its convergence starts (`from`). */
export const SUN_HANDOVERS = {
  dayToTwilight: { from: SUN_LIGHT_BAND.day + 6, at: SUN_LIGHT_BAND.day },
  twilightToNight: { from: TWILIGHT_DOCUMENT_DEG, at: SUN_LIGHT_BAND.night },
  dayToNight: { from: SUN_LIGHT_BAND.day, at: SUN_HORIZON_DEG },
} as const;

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 0 at `from`, 1 at `at` (and past it), a smoothstep between. */
export function converging(altitudeDeg: number, handover: { from: number; at: number }): number {
  const t = clamp01((handover.from - altitudeDeg) / (handover.from - handover.at));
  return t * t * (3 - 2 * t);
}

const mix = (a: Rgb3, b: Rgb3, t: number): Rgb3 =>
  [0, 1, 2].map((c) => a[c] + (b[c] - a[c]) * t) as unknown as Rgb3;

/** What a document of land `land` must be multiplied by to draw `target` (clamped: a multiply darkens). */
const over = (target: Rgb3, land: Rgb3): Rgb3 =>
  [0, 1, 2].map((c) => clamp01(target[c] / Math.max(land[c], 1e-6))) as unknown as Rgb3;

const times = (land: Rgb3, light: Rgb3): Rgb3 =>
  [0, 1, 2].map((c) => land[c] * light[c]) as unknown as Rgb3;

/** The next darker document a ladder's document hands over to, and where. */
export interface SunHandover {
  below: MapLightPreset;
  /** Where the convergence starts. */
  from: number;
  /** Where the next document takes over. */
  at: number;
}

/**
 * Where `ladder`'s document hands over, or `null` (a night document, a day
 * document whose light does not follow the sun, or no lands to converge on).
 * `morning` picks the twilight a day document hands over to: dawn before
 * noon, dusk after.
 */
export function sunHandover(ladder: SunLadder, morning: boolean): SunHandover | null {
  const { lands, preset } = ladder;
  const document = presetDocumentLight(preset);
  if (!lands || document === 'dark') return null;
  if (document === 'twilight') {
    return lands[preset as 'dawn' | 'dusk'] ? { below: 'night', ...SUN_HANDOVERS.twilightToNight } : null;
  }
  if (!ladder.followsSun) return null;
  const twilight = morning ? 'dawn' : 'dusk';
  return lands[twilight]
    ? { below: twilight, ...SUN_HANDOVERS.dayToTwilight }
    : { below: 'night', ...SUN_HANDOVERS.dayToNight };
}

/**
 * A document's own curve, before any handover: a day map's and a night map's
 * from `base`; a dawn or dusk map's, the day's over the light it already
 * draws (the twilight at {@link TWILIGHT_DOCUMENT_DEG}), so the low sun's
 * dimming is not drawn twice.
 */
export function ownSunLight(altitudeDeg: number, preset: MapLightPreset, base: SunBaseLight): Rgb3 {
  const document = presetDocumentLight(preset);
  if (document === 'light') return base.light(altitudeDeg);
  if (document === 'dark') return base.dark(altitudeDeg);
  return over(base.light(altitudeDeg), base.light(TWILIGHT_DOCUMENT_DEG));
}

/**
 * The light over `ladder`'s document for a sun `altitudeDeg` up, 0…1 per
 * channel: its own curve, easing from {@link SunHandover.from} onto exactly
 * what the next document draws at {@link SunHandover.at} (its land times its
 * light, over this land), and that document's drawing below it.
 */
export function sunLadderLight(
  altitudeDeg: number,
  ladder: SunLadder,
  base: SunBaseLight,
  morning: boolean,
): Rgb3 {
  const own = ownSunLight(altitudeDeg, ladder.preset, base);
  const step = sunHandover(ladder, morning);
  const lands = ladder.lands;
  if (!step || !lands) return own;
  const land = lands[ladder.preset] as Rgb3;
  const belowLand = lands[step.below] as Rgb3;
  const below = (a: number) =>
    times(belowLand, sunLadderLight(a, { ...ladder, preset: step.below }, base, morning));
  if (altitudeDeg <= step.at) return over(below(altitudeDeg), land);
  return mix(own, over(below(step.at), land), converging(altitudeDeg, step));
}

/** Rec. 709 weights over sRGB values: the one number a single-channel light is matched on. */
export function landLuma(rgb: Rgb3): number {
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}

/** The lands as one luma each (a grey per light), for a light that is one number. */
export function lumaLands(lands: SunLadderLands): SunLadderLands {
  const grey = (rgb: Rgb3): Rgb3 => {
    const l = landLuma(rgb);
    return [l, l, l];
  };
  return {
    day: grey(lands.day),
    ...(lands.dawn ? { dawn: grey(lands.dawn) } : {}),
    ...(lands.dusk ? { dusk: grey(lands.dusk) } : {}),
    night: grey(lands.night),
  };
}

/**
 * The document metadata key that carries its style's lands, one `#rrggbb` per
 * published light (`index.ts` writes it, for a style whose light follows):
 * how the globe's night, in the relief chunk, knows what the next document
 * draws without the themes in its bundle.
 */
export const SUN_LANDS_METADATA_KEY = 'goway:sun-lands';

/** The lands a loaded document carries, or `null` (not GoWay's, or a fixed light). */
export function sunLandsOf(metadata: unknown): SunLadderLands | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as Record<string, unknown>)[SUN_LANDS_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return null;
  const read = (key: MapLightPreset): Rgb3 | undefined => {
    const rgb = parseHexColour((raw as Record<string, unknown>)[key]);
    return rgb ? [rgb[0] / 255, rgb[1] / 255, rgb[2] / 255] : undefined;
  };
  const day = read('day');
  const night = read('night');
  if (!day || !night) return null;
  const dawn = read('dawn');
  const dusk = read('dusk');
  return { day, night, ...(dawn ? { dawn } : {}), ...(dusk ? { dusk } : {}) };
}

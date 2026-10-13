/**
 * GoWay's style CATALOGUE: which map styles exist, which lights each is
 * published in, and where each document is served (`docs/MAP_STYLES.md`).
 *
 * This is the small, first-paint half of the style system — ids and paths,
 * no colours. The colours and the layer switches live in `themes.ts`, the
 * layers in `layers.ts`, and `scripts/build-map-style.ts` renders every
 * (style, light) pair this file lists into `public/map/styles/`. A style is
 * one entry here and one in `themes.ts`; never a hand-written JSON document.
 *
 * ## Style and light are two choices
 *
 * The STYLE is what the map is for — Standard, Streets, the muted Light and
 * Dark basemaps. The LIGHT is when it is seen: day, dawn, dusk or night. A
 * style that follows the light is published in each light it supports; a
 * style with a fixed light (the data-visualisation Light and Dark) is
 * published in one and ignores the person's.
 */
import type { MapAppearance } from '../provider';

/**
 * The vocabulary and the catalogue are the PUBLIC contract — the same ids the
 * embed takes and `@goway.to/sdk` builds URLs from — so they are defined once,
 * in `packages/contracts/src/map-style.ts`, and read here. What follows is the
 * app's own: the appearance a light belongs to, the light modes, the sun.
 */
import {
  DEFAULT_MAP_STYLE,
  isMapLightPreset,
  isMapStyleId,
  MAP_LIGHT_PRESETS,
  MAP_STYLE_CATALOGUE,
  MAP_STYLE_IDS,
  MAP_STYLE_INDEX_PATH,
  type MapLightPreset,
  type MapStyleDefinition,
  type MapStyleId,
  type MapStyleSelection,
  mapStyleDefinition,
  mapStylePath,
  resolveMapStyle,
} from '@goway.to/sdk';

export {
  DEFAULT_MAP_STYLE,
  isMapLightPreset,
  isMapStyleId,
  MAP_LIGHT_PRESETS,
  MAP_STYLE_IDS,
  MAP_STYLE_INDEX_PATH,
  mapStyleDefinition,
  mapStylePath,
  resolveMapStyle,
};
export type { MapLightPreset, MapStyleDefinition, MapStyleId, MapStyleSelection };

/** Every published style, in the order the picker shows them. */
export const MAP_STYLES: readonly MapStyleDefinition[] = MAP_STYLE_CATALOGUE;

/**
 * The cartographic appearance a light belongs to: everything but night is
 * the light map. The 3D city, the sky and the buildings' light read this,
 * so the dawn and dusk documents are lit as the day map is.
 */
export function presetAppearance(preset: MapLightPreset): MapAppearance {
  return preset === 'night' ? 'dark' : 'light';
}

/** The light a plain light/dark appearance means. */
export function appearancePreset(appearance: MapAppearance): MapLightPreset {
  return appearance === 'dark' ? 'night' : 'day';
}

/**
 * A style's picker thumbnail, rendered from its document by the real
 * renderer (`scripts/build-map-thumbs.ts`): `/map/styles/thumbs/<style>-<light>.jpg`.
 * Only day and night are rendered — the picker shows the style, not the hour.
 */
export function mapStyleThumbnailPath(selection: MapStyleSelection): string {
  return `/map/styles/thumbs/${selection.style}-${selection.preset}.jpg`;
}

// ---------------------------------------------------------------------------
// The light, as the person chooses it
// ---------------------------------------------------------------------------

/**
 * Settings → Map → Light: how the map picks its light.
 *
 *  - `app` follows the app's own theme (light → day, dark → night): what the
 *    map has always done, and the default.
 *  - `sun` follows the real sun over the map: day, dawn, dusk, night.
 *  - `day` / `night` keep that light whatever the app's theme (a light app
 *    with an always-dark map, or the reverse).
 */
export const MAP_LIGHT_MODES = ['app', 'sun', 'day', 'night'] as const;
export type MapLightMode = (typeof MAP_LIGHT_MODES)[number];

export function isMapLightMode(value: unknown): value is MapLightMode {
  return typeof value === 'string' && (MAP_LIGHT_MODES as readonly string[]).includes(value);
}

/**
 * The sun's twilight band, in degrees of altitude: above `day` it is day;
 * below `night` it is night (the end of civil twilight, when streetlights are
 * what a street is seen by); between, dawn in the morning and dusk in the
 * evening.
 */
export const SUN_LIGHT_BAND = { day: 4, night: -6 } as const;

/** The sun's apparent horizon: the upper limb with refraction. */
const HORIZON_DEG = -0.833;

/**
 * The light the real sun gives at one place and instant.
 *
 * `azimuthDeg` tells morning from evening: the sun is in the eastern half of
 * the sky before noon. Returns whether it is still above the horizon too, so
 * a style without twilight lights can choose between day and night.
 */
export function lightPresetFromSun(sun: { altitudeDeg: number; azimuthDeg: number }): {
  preset: MapLightPreset;
  sunUp: boolean;
} {
  if (!Number.isFinite(sun.altitudeDeg)) return { preset: 'day', sunUp: true };
  const sunUp = sun.altitudeDeg >= HORIZON_DEG;
  if (sun.altitudeDeg >= SUN_LIGHT_BAND.day) return { preset: 'day', sunUp };
  if (sun.altitudeDeg <= SUN_LIGHT_BAND.night) return { preset: 'night', sunUp };
  const morning = sun.azimuthDeg < 180;
  return { preset: morning ? 'dawn' : 'dusk', sunUp };
}

/**
 * The selection a map draws: the style the person (or the embedder) chose,
 * in the light their mode gives — the app theme, the sun, or a fixed light.
 */
export function selectMapStyle(input: {
  style: MapStyleId;
  mode: MapLightMode;
  themeDark: boolean;
  /** The sun over the map, for `sun`; absent, `sun` falls back to the app theme. */
  sun?: { altitudeDeg: number; azimuthDeg: number } | null;
}): MapStyleSelection {
  const { style, mode, themeDark, sun } = input;
  if (mode === 'day' || mode === 'night') return resolveMapStyle(style, mode);
  if (mode === 'sun' && sun) {
    const { preset, sunUp } = lightPresetFromSun(sun);
    return resolveMapStyle(style, preset, sunUp);
  }
  return resolveMapStyle(style, themeDark ? 'night' : 'day');
}

/** What a screen asks of `useMapStyle`: anything it leaves out is the device's. */
export interface MapStyleRequest {
  /** The style, when the screen decides it (the embed). */
  style?: MapStyleId;
  /** The light, when the screen decides it. */
  lightPreset?: MapLightPreset;
  /** The older spelling of a day or night light. */
  appearance?: MapAppearance;
}

/**
 * Which (style, light) a map draws: the screen's request first (the embed
 * decides, never the visitor's device), then the device's choices. Pure, for
 * `components/map/useMapStyle.ts` and its tests.
 */
export function resolveMapStyleRequest(
  request: MapStyleRequest,
  device: { style: MapStyleId; light: MapLightMode },
  themeDark: boolean,
  sun: { altitudeDeg: number; azimuthDeg: number } | null,
): MapStyleSelection {
  const style = request.style ?? device.style;
  if (request.lightPreset) return resolveMapStyle(style, request.lightPreset);
  if (request.appearance) return resolveMapStyle(style, appearancePreset(request.appearance));
  return selectMapStyle({ style, mode: device.light, themeDark, sun });
}

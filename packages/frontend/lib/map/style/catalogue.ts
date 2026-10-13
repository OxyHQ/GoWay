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
import type { MapImageryMode } from '../imagery';
import type { MapAppearance } from '../provider';

/** Every style GoWay publishes, in the order the picker shows them. */
export const MAP_STYLE_IDS = [
  'standard',
  'streets',
  'outdoors',
  'satellite',
  'hybrid',
  'light',
  'dark',
] as const;
export type MapStyleId = (typeof MAP_STYLE_IDS)[number];

/** The lights a style can be drawn in. */
export const MAP_LIGHT_PRESETS = ['day', 'dawn', 'dusk', 'night'] as const;
export type MapLightPreset = (typeof MAP_LIGHT_PRESETS)[number];

/** One style, as the catalogue publishes it. */
export interface MapStyleDefinition {
  id: MapStyleId;
  /**
   * The lights it is published in. A style that `follows` the light lists
   * `day` and `night` at least; `fixed` lists exactly one.
   */
  presets: readonly MapLightPreset[];
  /** Whether it follows the person's light, or keeps its own. */
  light: 'follows' | 'fixed';
  /**
   * The documents carry their own terrain — a hillshade and contour lines
   * from GoWay's elevation tiles — so the map credits the elevation data
   * whatever the Terrain switch says, and the relief adapters add no second
   * hillshade over it.
   */
  relief?: true;
  /**
   * Drawn over GoWay's satellite imagery (`docs/MAP_SATELLITE.md`): the
   * imagery alone, or under the roads and labels. The canvas credits each
   * imagery source while it is on screen.
   */
  imagery?: MapImageryMode;
  /**
   * `development`: offered by the picker and the embed only in a development
   * build — a style whose data is not published yet (the imagery, until the
   * owner approves its first published run). Defaults to `always`.
   */
  offer?: 'always' | 'development';
}

export const MAP_STYLES: readonly MapStyleDefinition[] = [
  // The default: GoWay's own look, in all four lights.
  { id: 'standard', presets: ['day', 'dawn', 'dusk', 'night'], light: 'follows' },
  // Denser places, a coloured road hierarchy, house numbers.
  { id: 'streets', presets: ['day', 'night'], light: 'follows' },
  // The terrain map: contours, hillshade, trails, peaks, huts.
  { id: 'outdoors', presets: ['day', 'night'], light: 'follows', relief: true },
  // The imagery alone, and the imagery under GoWay's roads and labels. A
  // photograph has one light: these keep it (and skip the globe's night pass).
  { id: 'satellite', presets: ['day'], light: 'fixed', imagery: 'satellite', offer: 'development' },
  { id: 'hybrid', presets: ['day'], light: 'fixed', imagery: 'hybrid', offer: 'development' },
  // Quiet basemaps for data drawn over them, from Bloom's neutral tokens.
  { id: 'light', presets: ['day'], light: 'fixed' },
  { id: 'dark', presets: ['night'], light: 'fixed' },
];

export const DEFAULT_MAP_STYLE: MapStyleId = 'standard';

/** A style in one light: what a document is built for, and what a map loads. */
export interface MapStyleSelection {
  style: MapStyleId;
  preset: MapLightPreset;
}

export function isMapStyleId(value: unknown): value is MapStyleId {
  return typeof value === 'string' && (MAP_STYLE_IDS as readonly string[]).includes(value);
}

export function isMapLightPreset(value: unknown): value is MapLightPreset {
  return typeof value === 'string' && (MAP_LIGHT_PRESETS as readonly string[]).includes(value);
}

/** Whether a style is offered to people on this build (`MapStyleDefinition.offer`). */
export function isMapStyleOffered(id: MapStyleId, development: boolean): boolean {
  return mapStyleDefinition(id).offer !== 'development' || development;
}

export function mapStyleDefinition(id: MapStyleId): MapStyleDefinition {
  // The list is closed over `MapStyleId`, so this always finds one.
  return MAP_STYLES.find((entry) => entry.id === id) as MapStyleDefinition;
}

/**
 * The light a style is actually drawn in when `wanted` is asked for.
 *
 * A fixed style has one. A style without dawn and dusk draws twilight as day
 * while the sun is still up and as night once it has set — which is what
 * `wanted` already encodes: {@link lightPresetFromSun} only says `dawn` or
 * `dusk` for the twilight band, and the band's two halves are told apart
 * by `sunUp`.
 */
export function resolveMapStyle(
  style: MapStyleId,
  wanted: MapLightPreset,
  sunUp = wanted !== 'dusk',
): MapStyleSelection {
  const { presets } = mapStyleDefinition(style);
  if (presets.includes(wanted)) return { style, preset: wanted };
  if (presets.length === 1) return { style, preset: presets[0] };
  if (wanted === 'dawn' || wanted === 'dusk') {
    return { style, preset: sunUp ? 'day' : 'night' };
  }
  return { style, preset: presets[0] };
}

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

/** Where a document is served, relative to GoWay's origin: `/map/styles/<style>/<light>.json`. */
export function mapStylePath(selection: MapStyleSelection): string {
  return `/map/styles/${selection.style}/${selection.preset}.json`;
}

/**
 * A style's picker thumbnail, rendered from its document by the real
 * renderer (`scripts/build-map-thumbs.ts`): `/map/styles/thumbs/<style>-<light>.jpg`.
 * Only day and night are rendered — the picker shows the style, not the hour.
 */
export function mapStyleThumbnailPath(selection: MapStyleSelection): string {
  return `/map/styles/thumbs/${selection.style}-${selection.preset}.jpg`;
}

/** The catalogue document that lists every style and its documents (`/map/styles/index.json`). */
export const MAP_STYLE_INDEX_PATH = '/map/styles/index.json';

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

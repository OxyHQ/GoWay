/**
 * GoWay's map styles, as integrators name them (`docs/MAP_STYLES.md`).
 *
 * A style is a published MapLibre document at a stable URL on GoWay's origin,
 * `/map/styles/<style>/<light>.json`, one per (style, light) the catalogue
 * below lists; `/map/styles/index.json` lists them all. These are STATIC
 * documents served by the web origin, not `/api/v1` operations, so nothing
 * here is in `API_OPERATIONS`: the vocabulary, the catalogue and the index's
 * schema are the contract.
 *
 * The app (`packages/frontend/lib/map/style/catalogue.ts`), the embed
 * (`/frame?style=…&light=…`) and `@goway.to/sdk` all read the ids from here,
 * so a style is named the same way everywhere.
 */
import { z } from 'zod';

/** Every published style, in the order GoWay's picker shows them. */
export const MAP_STYLE_IDS = [
  'standard',
  'streets',
  'outdoors',
  'navigation',
  'monochrome',
  'satellite',
  'hybrid',
  'light',
  'dark',
] as const;
export const mapStyleIdSchema = z.enum(MAP_STYLE_IDS);
export type MapStyleId = z.infer<typeof mapStyleIdSchema>;

/** The lights a style can be drawn in. */
export const MAP_LIGHT_PRESETS = ['day', 'dawn', 'dusk', 'night'] as const;
export const mapLightPresetSchema = z.enum(MAP_LIGHT_PRESETS);
export type MapLightPreset = z.infer<typeof mapLightPresetSchema>;

/** Whether a style follows the light, or keeps one of its own (the data basemaps). */
export const MAP_STYLE_LIGHT_KINDS = ['follows', 'fixed'] as const;
export type MapStyleLightKind = (typeof MAP_STYLE_LIGHT_KINDS)[number];

/** One published style. */
export interface MapStyleDefinition {
  id: MapStyleId;
  /** The lights it is published in; the first is its default. */
  presets: readonly MapLightPreset[];
  light: MapStyleLightKind;
  /**
   * Its documents carry their own terrain — a hillshade and contour lines
   * from GoWay's elevation tiles — and so the elevation credit.
   */
  relief?: true;
  /**
   * Drawn over GoWay's satellite imagery (`docs/MAP_SATELLITE.md`): the
   * imagery alone (`satellite`), or under GoWay's roads and labels (`hybrid`).
   */
  imagery?: 'satellite' | 'hybrid';
  /**
   * `development`: not offered yet — its data is not published (the imagery,
   * until its first published run). GoWay's picker and embed list it only in a
   * development build, and `/map/styles/index.json` leaves it out. Absent: offered.
   */
  offer?: 'development';
}

/** The catalogue: which lights each style is published in. */
export const MAP_STYLE_CATALOGUE: readonly MapStyleDefinition[] = [
  { id: 'standard', presets: ['day', 'dawn', 'dusk', 'night'], light: 'follows' },
  { id: 'streets', presets: ['day', 'night'], light: 'follows' },
  { id: 'outdoors', presets: ['day', 'night'], light: 'follows', relief: true },
  { id: 'navigation', presets: ['day', 'night'], light: 'follows' },
  { id: 'monochrome', presets: ['day', 'night'], light: 'follows' },
  // A photograph has one light: these keep it.
  { id: 'satellite', presets: ['day'], light: 'fixed', imagery: 'satellite', offer: 'development' },
  { id: 'hybrid', presets: ['day'], light: 'fixed', imagery: 'hybrid', offer: 'development' },
  { id: 'light', presets: ['day'], light: 'fixed' },
  { id: 'dark', presets: ['night'], light: 'fixed' },
];

export const DEFAULT_MAP_STYLE: MapStyleId = 'standard';

/** A style in one light: one document. */
export interface MapStyleSelection {
  style: MapStyleId;
  preset: MapLightPreset;
}

export function isMapStyleId(value: unknown): value is MapStyleId {
  return mapStyleIdSchema.safeParse(value).success;
}

export function isMapLightPreset(value: unknown): value is MapLightPreset {
  return mapLightPresetSchema.safeParse(value).success;
}

export function mapStyleDefinition(id: MapStyleId): MapStyleDefinition {
  // The catalogue is closed over `MapStyleId`, so this always finds one.
  return MAP_STYLE_CATALOGUE.find((entry) => entry.id === id) as MapStyleDefinition;
}

/**
 * The light a style is actually drawn in when `wanted` is asked for: a fixed
 * style keeps its one; a style without dawn and dusk draws twilight as day
 * while the sun is up (`sunUp`, true unless the light is dusk) and as night
 * once it has set; absent, the style's default.
 */
export function resolveMapStyle(
  style: MapStyleId,
  wanted?: MapLightPreset,
  sunUp = wanted !== 'dusk',
): MapStyleSelection {
  const { presets } = mapStyleDefinition(style);
  // Every entry lists at least one light; its first is its default.
  const first = presets[0] ?? 'day';
  if (wanted === undefined) return { style, preset: first };
  if (presets.includes(wanted)) return { style, preset: wanted };
  if (presets.length === 1) return { style, preset: first };
  if (wanted === 'dawn' || wanted === 'dusk') return { style, preset: sunUp ? 'day' : 'night' };
  return { style, preset: first };
}

/** Where a document is served, relative to GoWay's origin. */
export function mapStylePath(selection: MapStyleSelection): string {
  return `/map/styles/${selection.style}/${selection.preset}.json`;
}

/** Where the catalogue document is served, relative to GoWay's origin. */
export const MAP_STYLE_INDEX_PATH = '/map/styles/index.json';

/**
 * `/map/styles/index.json`. OPEN on purpose: a style or a light GoWay adds
 * after an SDK was built is listed, not a parse failure — `id` and the light
 * names are strings here, and a consumer that only knows today's ids picks
 * those with `isMapStyleId`.
 */
export const mapStyleIndexSchema = z.object({
  v: z.literal(1),
  default: z.string().min(1),
  styles: z.array(
    z.object({
      id: z.string().min(1),
      light: z.string().min(1),
      presets: z.array(z.string().min(1)).min(1),
      defaultPreset: z.string().min(1),
      urls: z.record(z.string(), z.url()),
    }),
  ),
});
export type MapStyleIndex = z.infer<typeof mapStyleIndexSchema>;

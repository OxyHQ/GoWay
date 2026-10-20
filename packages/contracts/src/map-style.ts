/**
 * GoWay's map styles (`map-style-names.ts`: the vocabulary, the catalogue and
 * `goway://` names, with no zod in it, so a renderer can resolve a style
 * without loading the schemas) and the schemas they are validated with.
 */
import { z } from 'zod';

import { MAP_LIGHT_PRESETS, MAP_STYLE_IDS } from './map-style-names';

export * from './map-style-names';

/** {@link MAP_STYLE_IDS} as a request parameter. */
export const mapStyleIdSchema = z.enum(MAP_STYLE_IDS);

/** {@link MAP_LIGHT_PRESETS} as a request parameter. */
export const mapLightPresetSchema = z.enum(MAP_LIGHT_PRESETS);

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

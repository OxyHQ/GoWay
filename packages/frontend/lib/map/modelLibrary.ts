/**
 * The model library: GoWay's ONE set of generic vehicles, vessels and people,
 * shared by everything that draws them — the city-life simulation
 * (`components/map/engine/cityLife/`) and the live layer — so there is never
 * a second, parallel model set. Design note: `docs/MODEL_LIBRARY.md`.
 *
 * Built by `scripts/build-model-library.ts` into `public/models/library/`:
 * one GLB per model (a `near` and a `far` level of detail, quantised and
 * meshopt-compressed by the same writer as the landmarks) and this manifest,
 * which records every asset's licence and provenance with the landmarks' own
 * licence record (`assetLicenceSchema`). The manifest is validated here, by
 * the build, in the tests and when the app reads it.
 *
 * ## The asset profile (what a consumer may rely on)
 *
 *  - glTF frame: metres, +Y up, front towards +Z, +X to the model's left,
 *    origin on the ground at the centre of its footprint.
 *  - Two nodes, `near` and `far`, sharing one quantisation grid.
 *  - Materials: `paint` is the body colour a consumer tints (white in the
 *    file); `body` carries fixed colours as `COLOR_0` vertex colours (glass,
 *    trim, tyres, lamps, clothes, skin). No textures, no lettering, no logos.
 *  - People (`kind: 'person'`) carry their animation as morph targets on the
 *    `near` node: frames of each clip in `clips`, deltas from the base pose.
 */
import { z } from 'zod';

import { assetLicenceSchema, checkAssetLicence } from './assetLicence';

/** Where the library is served from, on the app's own origin. */
export const MODEL_LIBRARY_PATH = '/models/library';
export const MODEL_LIBRARY_MANIFEST = `${MODEL_LIBRARY_PATH}/manifest.json`;

export const MODEL_KINDS = [
  'car',
  'van',
  'truck',
  'bus',
  'tram',
  'train',
  'metro',
  'vessel',
  'aircraft',
  'person',
] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/** Triangle budgets per level of detail, by kind (enforced by the build and the tests). */
export const MODEL_BUDGETS: Record<ModelKind, { near: number; far: number }> = {
  car: { near: 800, far: 150 },
  van: { near: 800, far: 150 },
  truck: { near: 800, far: 150 },
  bus: { near: 800, far: 150 },
  tram: { near: 1200, far: 150 },
  train: { near: 1200, far: 150 },
  metro: { near: 1200, far: 150 },
  vessel: { near: 1200, far: 150 },
  aircraft: { near: 800, far: 150 },
  person: { near: 600, far: 80 },
};

const clipSchema = z.object({
  /** First morph-target frame of the clip. */
  first: z.number().int().min(0),
  /** Frames in the loop. */
  count: z.number().int().min(1),
  /** Frames per second of the loop. */
  fps: z.number().positive(),
});
export type ModelClip = z.infer<typeof clipSchema>;

const entrySchema = z
  .object({
    /** Catalogue key, namespaced like the model catalogue's (`vehicle.sedan`). */
    key: z.string().regex(/^[a-z]+\.[a-z0-9-]+$/),
    kind: z.enum(MODEL_KINDS),
    /** File name in {@link MODEL_LIBRARY_PATH}. */
    file: z.string().regex(/^[a-z0-9.-]+\.glb$/),
    bytes: z.number().int().positive(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    triangles: z.object({ near: z.number().int().positive(), far: z.number().int().positive() }),
    /** Width (x), height (y), length (z), metres, as built. */
    size: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
    /** People only: `move` (walking, or pushing a wheelchair) and `idle` loops. */
    clips: z.object({ move: clipSchema, idle: clipSchema }).optional(),
    licence: assetLicenceSchema,
  })
  .superRefine((entry, ctx) => {
    checkAssetLicence(entry.licence, ctx, ['licence']);
    const budget = MODEL_BUDGETS[entry.kind];
    if (entry.triangles.near > budget.near) {
      ctx.addIssue({ code: 'custom', path: ['triangles', 'near'], message: `over ${budget.near}` });
    }
    if (entry.triangles.far > budget.far) {
      ctx.addIssue({ code: 'custom', path: ['triangles', 'far'], message: `over ${budget.far}` });
    }
    if ((entry.kind === 'person') !== Boolean(entry.clips)) {
      ctx.addIssue({
        code: 'custom',
        path: ['clips'],
        message: 'people, and only people, have clips',
      });
    }
  });
export type ModelLibraryEntry = z.infer<typeof entrySchema>;

export const modelLibrarySchema = z
  .object({ version: z.literal(1), models: z.array(entrySchema).min(1) })
  .superRefine((library, ctx) => {
    const keys = library.models.map((m) => m.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({ code: 'custom', path: ['models'], message: 'duplicate key' });
    }
  });
export type ModelLibrary = z.infer<typeof modelLibrarySchema>;

export function parseModelLibrary(input: unknown): ModelLibrary {
  return modelLibrarySchema.parse(input);
}

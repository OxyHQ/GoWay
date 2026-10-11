/**
 * The model library: GoWay's ONE set of generic vehicles and vessels,
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
 *    trim, tyres, lamps). No textures, no lettering, no logos.
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
] as const;
export type ModelKind = (typeof MODEL_KINDS)[number];

/**
 * Triangle budgets per level of detail, by kind (enforced by the build and
 * the tests). A near level is the kit's body as drawn plus low-poly wheels —
 * never a decimated body — so the near budgets are what the kits' bodies
 * need; a far level is three boxes.
 */
export const MODEL_BUDGETS: Record<ModelKind, { near: number; far: number }> = {
  car: { near: 1100, far: 150 },
  van: { near: 1100, far: 150 },
  truck: { near: 1100, far: 150 },
  bus: { near: 800, far: 150 },
  tram: { near: 1300, far: 150 },
  train: { near: 1300, far: 150 },
  metro: { near: 1300, far: 150 },
  vessel: { near: 1800, far: 150 },
  aircraft: { near: 800, far: 150 },
};

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

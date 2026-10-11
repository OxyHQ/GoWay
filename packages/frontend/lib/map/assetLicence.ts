/**
 * The licence record every 3D asset GoWay ships carries — landmarks
 * (`landmarks/registry.ts`) and the model library (`modelLibrary.ts`) alike —
 * and the licence rule as code: an allow-listed SPDX id, a method, an author,
 * a source and when that was verified. CC BY requires the credit text the map
 * shows while the model is drawn; NC, ND, "unknown" and anything not on the
 * list fail to parse, so they cannot ship.
 *
 * Its own module so the model library reads it without pulling in the
 * landmark registry, which is loaded on demand (`landmarks/load.ts`).
 */
import { z } from 'zod';

/**
 * Licences a landmark asset may carry. Public redistribution with the app,
 * modification allowed, commercial use allowed — so no NC, no ND.
 */
export const LANDMARK_LICENCES = ['CC0-1.0', 'CC-BY-4.0', 'CC-BY-3.0'] as const;
export type LandmarkLicence = (typeof LANDMARK_LICENCES)[number];

/** Licences whose terms oblige a visible credit. */
const CREDIT_REQUIRED: ReadonlySet<LandmarkLicence> = new Set(['CC-BY-4.0', 'CC-BY-3.0']);

/**
 * How the asset was made (`docs/MAP_LANDMARKS.md` → Sourcing):
 * `procedural` is GoWay's own geometry code; `osm-enriched` is GoWay's code
 * over OpenStreetMap's own recorded geometry (an ODbL Produced Work — the
 * map's "© OpenStreetMap" credit covers it); `third-party` is a licensed
 * asset from an outside author.
 */
export const LANDMARK_METHODS = ['procedural', 'osm-enriched', 'third-party'] as const;

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/**
 * Where a shipped 3D asset comes from and under which licence — the same
 * record for a landmark (`landmarks/registry.ts`) and for the model library
 * (`modelLibrary.ts`).
 */
export const assetLicenceSchema = z.object({
  spdx: z.enum(LANDMARK_LICENCES),
  method: z.enum(LANDMARK_METHODS),
  author: z.string().min(1),
  /** Where the asset (or its generator) comes from: a URL or a repository path. */
  source: z.string().min(1),
  /** The credit the map shows while this model is drawn, or `null` when none is owed. */
  credit: z.string().min(1).nullable(),
  /** Data that informed the geometry (each already credited on every map). */
  derivedFrom: z.array(z.enum(['openstreetmap'])),
  /** When a person checked the licence at its source. */
  verifiedAt: isoDate,
  notes: z.string().min(1),
});
export type AssetLicence = z.infer<typeof assetLicenceSchema>;

/** The licence rules beyond the shape: a credit where owed, a third party's source a URL. */
export function checkAssetLicence(
  licence: AssetLicence,
  ctx: z.RefinementCtx,
  path: (string | number)[],
): void {
  if (CREDIT_REQUIRED.has(licence.spdx) && !licence.credit) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'credit'],
      message: `${licence.spdx} requires a credit`,
    });
  }
  if (licence.method === 'third-party' && !/^https:\/\//.test(licence.source)) {
    ctx.addIssue({
      code: 'custom',
      path: [...path, 'source'],
      message: 'a third-party asset names the https URL its licence was verified at',
    });
  }
}

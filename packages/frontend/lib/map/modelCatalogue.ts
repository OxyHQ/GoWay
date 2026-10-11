/**
 * The model catalogue, STUBBED — phase 1 of `docs/SDK_MAP_MODELS.md`.
 *
 * Phase 2 serves the catalogue (`GET /models/catalogue`, content-addressed
 * GLBs behind the CDN, a `modelAssetSchema` with licence and SHA-256). Until
 * then a `{ kind: 'catalogue', key }` model resolves here, against assets the
 * app ships in `public/models/`, each with its licence recorded beside it
 * (`public/models/LICENSE.md`). Keys are namespaced (`vehicle.car`) as the
 * served catalogue's will be, so a caller written against this stub keeps
 * working when the stub becomes a request.
 */

export interface CatalogueEntry {
  /** Path on this app's own origin. */
  url: string;
  /** SPDX id of the asset's licence. */
  license: string;
}

export const MODEL_CATALOGUE_FIXTURE: Readonly<Record<string, CatalogueEntry>> = {
  // The model library's saloon (`docs/MODEL_LIBRARY.md`): Kenney Car Kit, CC0-1.0.
  // The model layer draws a library file's `near` level only.
  'vehicle.car': { url: '/models/library/vehicle.sedan.glb', license: 'CC0-1.0' },
};

/** The URL a model's asset resolves to, or `null` for an unknown key. */
export function resolveModelAssetUrl(
  asset: { kind: 'url'; url: string } | { kind: 'catalogue'; key: string },
): string | null {
  if (asset.kind === 'url') return asset.url;
  return MODEL_CATALOGUE_FIXTURE[asset.key]?.url ?? null;
}

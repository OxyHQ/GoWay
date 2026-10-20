/**
 * The NaN gate and the marker fallback for `MapCanvasProps.models`, shared by
 * both forks (`docs/SDK_MAP_MODELS.md` → "Rules that come with it").
 *
 *  - **The contract schema is the gate.** Each placement goes through
 *    `parseModelPlacement` (the zod schema in `packages/contracts`, via the
 *    SDK). A model that does not parse is dropped with one console line and
 *    costs that model alone — the same rule `drawableMarkers` applies to pins.
 *  - **A model always degrades to a marker.** Wherever a model is not drawn in
 *    3D — the native fork, outside its zoom window, while it loads, after a
 *    failed or over-budget load — its `fallback` is drawn through the ordinary
 *    marker path, at `placement.position`.
 */
import { parseModelPlacement, type ModelPlacement } from '@goway.to/sdk';

import { resolveModelAssetUrl } from '@/lib/map/modelCatalogue';

import { reportMapDefect } from '@goway.to/maps/plugin';
import type { MapMarker, MapModel } from './types';

/** Fallback markers live in the marker registry under this prefix. */
export const MODEL_MARKER_PREFIX = 'goway-model:';

export interface DrawableModel {
  model: MapModel;
  placement: ModelPlacement;
  /** The GLB to load, or `null` when the asset does not resolve (marker only). */
  url: string | null;
}

const EMPTY: readonly DrawableModel[] = [];

/** The models a renderer may draw, each with its parsed placement. */
export function drawableModels(models: readonly MapModel[] | undefined): readonly DrawableModel[] {
  if (!models || models.length === 0) return EMPTY;
  const out: DrawableModel[] = [];
  for (const model of models) {
    const placement = parseModelPlacement(model.placement);
    if (!placement) {
      reportMapDefect(
        `model:${model.id}`,
        `Dropped model "${model.id}": its placement does not parse.`,
      );
      continue;
    }
    out.push({ model, placement, url: resolveModelAssetUrl(model.asset) });
  }
  return out;
}

/** The marker that stands in for a model wherever it is not drawn in 3D. */
export function modelFallbackMarker(model: MapModel, placement: ModelPlacement): MapMarker {
  return {
    id: `${MODEL_MARKER_PREFIX}${model.id}`,
    coordinate: placement.position,
    kind: model.fallback?.kind ?? 'model',
    ...(model.fallback?.label ? { label: model.fallback.label } : {}),
    accessibilityLabel: model.accessibilityLabel,
  };
}

/** The model a fallback marker stands for, or `null` for an ordinary marker. */
export function modelIdOfMarker(markerId: string): string | null {
  return markerId.startsWith(MODEL_MARKER_PREFIX)
    ? markerId.slice(MODEL_MARKER_PREFIX.length)
    : null;
}

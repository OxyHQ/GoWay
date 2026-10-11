/**
 * Which vehicles of the shared library (`lib/map/modelLibrary.ts`) the
 * simulation fields, how many of each, and how big. The renderer draws each
 * as `${namespace}.${model}` from the library; the simulation only ever sees
 * the names and the slot ranges.
 *
 * The car pool is split into one contiguous slot range per model, so the renderer uploads and draws a model's instances as one
 * sub-array — no per-frame sorting.
 */
import type { RealClass } from '../realCoverage';
import type { Rng } from './rng';

/** The vehicle models, in slot order; drawn as `vehicle.<model>`. */
export const CAR_MODELS = ['hatchback', 'sedan', 'suv', 'taxi', 'van', 'truck', 'bus'] as const;
export type CarModel = (typeof CAR_MODELS)[number];

/**
 * Share of the car budget per model, and the length range in metres a car of
 * it is simulated (and drawn) at. The kits' toy proportions are short; the
 * renderer stretches each model along its length to the car's real one.
 */
export const CAR_MODEL_SPECS: Record<CarModel, { share: number; length: [number, number] }> = {
  hatchback: { share: 0.26, length: [3.9, 4.2] },
  sedan: { share: 0.26, length: [4.3, 4.7] },
  suv: { share: 0.16, length: [4.3, 4.7] },
  // Only where a city's taxis wear a statutory livery (`liveries.ts`).
  taxi: { share: 0.06, length: [4.4, 4.6] },
  van: { share: 0.12, length: [4.6, 5.2] },
  truck: { share: 0.09, length: [6.0, 6.8] },
  bus: { share: 0.05, length: [11.5, 12.0] },
};

/**
 * The real vehicle class a simulated model stands in for, where a real feed
 * can carry that class (`realCoverage.ts`). Cars, SUVs, vans, trucks and
 * taxis have no open real source: they stay simulated everywhere.
 */
export const REAL_CLASS_OF_MODEL: Partial<Record<CarModel, RealClass>> = { bus: 'bus' };

/** Split `capacity` slots into one `[start, end)` range per model by share; the last takes the rest. */
export function slotRanges<M extends string>(
  models: readonly M[],
  share: (model: M) => number,
  capacity: number,
): Record<M, [number, number]> {
  const ranges = {} as Record<M, [number, number]>;
  let start = 0;
  models.forEach((model, i) => {
    const end =
      i === models.length - 1
        ? capacity
        : Math.min(capacity, start + Math.round(capacity * share(model)));
    ranges[model] = [start, end];
    start = end;
  });
  return ranges;
}

/** A model by share. */
export function pickModel<M extends string>(
  rng: Rng,
  models: readonly M[],
  share: (model: M) => number,
): M {
  let pick = rng.next();
  for (const model of models) {
    pick -= share(model);
    if (pick <= 0) return model;
  }
  return models[0];
}

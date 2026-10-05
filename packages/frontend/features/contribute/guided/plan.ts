/**
 * The guided-capture route: a short checklist the contributor advances.
 *
 * Reconstruction needs each façade seen from several directions and the walk
 * to close on itself, and walking forward once does neither. So the plan is a
 * loop: each pavement facing the buildings, the middle looking along the
 * street, and back to the start so the reconstruction can close the loop.
 *
 * The user advances the steps; GoWay does not try to detect them. The timer is
 * advice ("2–3 minutes a stretch"), never a gate.
 */

export const GUIDED_STEPS = ['left', 'right', 'middle', 'finish'] as const;
export type GuidedStep = (typeof GUIDED_STEPS)[number];

/** Message key for a step's instruction. */
export function stepMessageKey(step: GuidedStep): string {
  return `contribute.guided.step.${step}`;
}

/** A stretch of street, walked slowly, takes about this long. The last step has no target. */
export const STRETCH_TARGET_SECONDS = { min: 120, max: 180 } as const;

export function hasStretchTarget(step: GuidedStep): boolean {
  return step !== 'finish';
}

export type StretchPace = 'short' | 'onTarget' | 'long';

export function stretchPace(seconds: number): StretchPace {
  if (seconds < STRETCH_TARGET_SECONDS.min) return 'short';
  if (seconds <= STRETCH_TARGET_SECONDS.max) return 'onTarget';
  return 'long';
}

export interface PlanState {
  /** Index into {@link GUIDED_STEPS} of the current step. */
  index: number;
  /** When each started step began, in ms; `startedAt[index]` is the current one. */
  startedAt: number[];
}

export function startPlan(t: number): PlanState {
  return { index: 0, startedAt: [t] };
}

/** Mark the current step done and start the next. The last step stays current. */
export function advancePlan(state: PlanState, t: number): PlanState {
  if (state.index >= GUIDED_STEPS.length - 1) return state;
  return { index: state.index + 1, startedAt: [...state.startedAt, t] };
}

export function currentStep(state: PlanState): GuidedStep {
  return GUIDED_STEPS[Math.min(state.index, GUIDED_STEPS.length - 1)];
}

export function isLastStep(state: PlanState): boolean {
  return state.index >= GUIDED_STEPS.length - 1;
}

/** Seconds spent on the current step at time `t`. */
export function stepSeconds(state: PlanState, t: number): number {
  const started = state.startedAt[state.index];
  return started === undefined ? 0 : Math.max(0, (t - started) / 1000);
}

export type StepStatus = 'done' | 'current' | 'todo';

export function stepStatus(state: PlanState, index: number): StepStatus {
  if (index < state.index) return 'done';
  return index === state.index ? 'current' : 'todo';
}

/** `m:ss`, or `h:mm:ss` past an hour. Negative and non-finite read as zero. */
export function formatClock(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

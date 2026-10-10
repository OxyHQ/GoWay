/**
 * The guided-capture coach: frame signals in, warnings out.
 *
 * A small state machine over timestamped samples, so the UI never flickers a
 * warning on one bad frame and never leaves one up after the user corrected:
 *
 *  - BLUR. A sample is blurry when its sharpness is under an absolute floor or
 *    well under the recent sharp reference (a decaying peak). Laplacian
 *    variance depends on what is in front of the camera — a brick façade
 *    scores far higher than a smooth render — so a relative test is the one
 *    that follows the scene; the floor catches a frame that is mush whatever
 *    the scene. The warning turns on after `blurHoldMs` of continuous blurry
 *    samples and off after `clearHoldMs` of sharp ones.
 *  - EXPOSURE. A jump in mean luma between consecutive samples bigger than
 *    `exposureJump` is the camera re-exposing (or the user swinging into the
 *    sky); either way the frames around it reconstruct badly. Shown for
 *    `exposureHoldMs`, and counted.
 *  - DARK. Mean luma under `darkLuma` for `darkHoldMs`.
 *
 * The thresholds are heuristics tuned on downscaled phone video and are kept
 * in one config object so they can be retuned without touching the logic.
 */

export interface CoachConfig {
  /** Laplacian variance under which a sample is blurry whatever the scene. */
  blurFloor: number;
  /** A sample under this fraction of the sharp reference is blurry. */
  blurRelative: number;
  /** Half-life of the sharp reference, in ms. */
  referenceHalfLifeMs: number;
  /** Continuous blurry time before the warning shows. */
  blurHoldMs: number;
  /** Continuous sharp time before the warning clears. */
  clearHoldMs: number;
  /** Mean-luma change between consecutive samples that counts as a jump. */
  exposureJump: number;
  /** How long an exposure warning stays up. */
  exposureHoldMs: number;
  /** Mean luma under which the scene is too dark. */
  darkLuma: number;
  /** Continuous dark time before the warning shows. */
  darkHoldMs: number;
  /** A gap between samples longer than this resets the timers (the tab was hidden, say). */
  maxGapMs: number;
}

export const DEFAULT_COACH_CONFIG: Readonly<CoachConfig> = {
  blurFloor: 40,
  blurRelative: 0.35,
  referenceHalfLifeMs: 8000,
  blurHoldMs: 500,
  clearHoldMs: 750,
  exposureJump: 30,
  exposureHoldMs: 2000,
  darkLuma: 30,
  darkHoldMs: 1000,
  maxGapMs: 2000,
};

export interface CoachSample {
  /** Monotonic time in ms. */
  t: number;
  sharpness: number;
  brightness: number;
}

export interface CoachState {
  lastT: number | null;
  /** Decaying peak of recent sharpness. */
  reference: number;
  blurry: boolean;
  /** When the current run of blurry (or, while warning, sharp) samples began. */
  runSince: number | null;
  lastBrightness: number | null;
  exposureUntil: number;
  exposureJumps: number;
  darkSince: number | null;
  dark: boolean;
  /** Time covered by samples, and the part of it spent warning about blur. */
  sampledMs: number;
  blurryMs: number;
}

export type CoachWarning = 'blur' | 'exposure' | 'dark';

export function initialCoach(): CoachState {
  return {
    lastT: null,
    reference: 0,
    blurry: false,
    runSince: null,
    lastBrightness: null,
    exposureUntil: -Infinity,
    exposureJumps: 0,
    darkSince: null,
    dark: false,
    sampledMs: 0,
    blurryMs: 0,
  };
}

/** Is this one sample blurry against the reference it would be judged by? */
export function isBlurrySample(
  sharpness: number,
  reference: number,
  config: CoachConfig = DEFAULT_COACH_CONFIG,
): boolean {
  return sharpness < config.blurFloor || sharpness < config.blurRelative * reference;
}

export function stepCoach(
  state: CoachState,
  sample: CoachSample,
  config: CoachConfig = DEFAULT_COACH_CONFIG,
): CoachState {
  if (
    !Number.isFinite(sample.sharpness) ||
    !Number.isFinite(sample.brightness) ||
    !Number.isFinite(sample.t)
  )
    return state;
  const gap = state.lastT === null ? null : sample.t - state.lastT;
  // Out of order, or after a long pause: start the timers over rather than
  // turning a pause into "blurry for 30 seconds".
  if (gap === null || gap < 0 || gap > config.maxGapMs) {
    return {
      ...state,
      lastT: sample.t,
      reference: Math.max(sample.sharpness, state.reference),
      blurry: false,
      runSince: null,
      lastBrightness: sample.brightness,
      darkSince: sample.brightness < config.darkLuma ? sample.t : null,
      dark: false,
    };
  }

  const decay = Math.pow(0.5, gap / config.referenceHalfLifeMs);
  // Judge against the reference BEFORE this sample raises it, or a single
  // sharp frame would never be compared with anything but itself.
  const judgedAgainst = state.reference * decay;
  const sampleBlurry = isBlurrySample(sample.sharpness, judgedAgainst, config);
  const reference = Math.max(sample.sharpness, judgedAgainst);

  let { blurry, runSince } = state;
  if (!blurry) {
    if (sampleBlurry) {
      runSince ??= sample.t;
      if (sample.t - runSince >= config.blurHoldMs) {
        blurry = true;
        runSince = null;
      }
    } else {
      runSince = null;
    }
  } else if (!sampleBlurry) {
    runSince ??= sample.t;
    if (sample.t - runSince >= config.clearHoldMs) {
      blurry = false;
      runSince = null;
    }
  } else {
    runSince = null;
  }

  let { exposureUntil, exposureJumps } = state;
  if (
    state.lastBrightness !== null &&
    Math.abs(sample.brightness - state.lastBrightness) >= config.exposureJump
  ) {
    exposureUntil = sample.t + config.exposureHoldMs;
    exposureJumps += 1;
  }

  let { darkSince, dark } = state;
  if (sample.brightness < config.darkLuma) {
    darkSince ??= sample.t;
    dark = sample.t - darkSince >= config.darkHoldMs;
  } else {
    darkSince = null;
    dark = false;
  }

  return {
    lastT: sample.t,
    reference,
    blurry,
    runSince,
    lastBrightness: sample.brightness,
    exposureUntil,
    exposureJumps,
    darkSince,
    dark,
    sampledMs: state.sampledMs + gap,
    blurryMs: state.blurryMs + (state.blurry ? gap : 0),
  };
}

/** The warnings to show at time `t`, most urgent first. */
export function coachWarnings(state: CoachState, t: number): CoachWarning[] {
  const warnings: CoachWarning[] = [];
  if (state.blurry) warnings.push('blur');
  if (t < state.exposureUntil) warnings.push('exposure');
  if (state.dark) warnings.push('dark');
  return warnings;
}

/** Share of the sampled time the blur warning was up, 0–1. */
export function blurryFraction(state: CoachState): number {
  return state.sampledMs > 0 ? Math.min(1, state.blurryMs / state.sampledMs) : 0;
}

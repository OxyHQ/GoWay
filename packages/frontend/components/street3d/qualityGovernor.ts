/**
 * The level-of-detail budget a scene draws at, steered by how the device is
 * actually keeping up.
 *
 * `deviceProfile.ts` can only guess before anything is drawn, and its guess has
 * to be safe for a laptop's integrated GPU — which leaves a desktop GPU drawing
 * a fraction of what it could, and a weak phone still too much. This closes the
 * loop: every frame's interval is fed in, and the budget climbs a fixed ladder
 * of (splat budget, pixel ratio) steps while frames keep the display's pace,
 * and steps down the moment they stop.
 *
 * The animation loop is paced by the display, so a frame interval never shows
 * spare capacity directly. The governor therefore PROBES: it steps up after
 * two calm windows, and a step that drops frames is stepped back down and not
 * retried for a while. Pure, so the policy is a test, not a comment.
 */

/** One rung: Spark's `lodSplatScale` and the canvas pixel ratio. */
export interface QualityStep {
  lodScale: number;
  pixelRatio: number;
}

export interface QualityBounds {
  /** Where the device assessment starts the scene. */
  start: QualityStep;
  /** The most it may climb to — what its page pool was sized for. */
  max: QualityStep;
  /** The least it may fall to. */
  min: QualityStep;
}

/** Each budget rung is this much larger than the one below it. */
const SCALE_RATIO = 1.25;

/** Geometric rungs from `from` up to `to`, both included. */
function rungs(from: number, to: number): number[] {
  const out = [from];
  while (out[out.length - 1] * SCALE_RATIO < to - 1e-6) out.push(out[out.length - 1] * SCALE_RATIO);
  if (to > from + 1e-6) out.push(to);
  return out;
}

/**
 * The ladder, cheapest first, and where on it the scene starts.
 *
 * Below the start the pixel ratio drops to the floor before the budget does —
 * fewer pixels cost a sharp image less than fewer splats cost the scene. Above
 * it the budget climbs first, and the pixel ratio rises only at the top: on a
 * street, coarse far splats read as blur long before a 1.5× canvas does.
 */
export function qualityLadder(bounds: QualityBounds): { ladder: QualityStep[]; start: number } {
  const { start, max, min } = bounds;
  const ladder: QualityStep[] = [];
  for (const lodScale of rungs(min.lodScale, start.lodScale).slice(0, -1))
    ladder.push({ lodScale, pixelRatio: min.pixelRatio });
  if (start.pixelRatio > min.pixelRatio)
    ladder.push({ lodScale: start.lodScale, pixelRatio: min.pixelRatio });
  const startIndex = ladder.length;
  for (const lodScale of rungs(start.lodScale, max.lodScale))
    ladder.push({ lodScale, pixelRatio: start.pixelRatio });
  if (max.pixelRatio > start.pixelRatio)
    ladder.push({ lodScale: max.lodScale, pixelRatio: max.pixelRatio });
  return { ladder, start: startIndex };
}

/** Frames judged together. About a second at 60 Hz. */
export const WINDOW_FRAMES = 48;
/** A window whose median frame is this much slower than the display is dropping frames. */
const SLOW_RATIO = 1.45;
/** A window whose 90th-percentile frame is within this of the display is calm. */
const CALM_RATIO = 1.15;
/** Calm windows in a row before probing a step up. */
const CALM_WINDOWS_TO_CLIMB = 2;
/** How long a step that dropped frames stays out of reach. */
export const FAILED_STEP_COOLDOWN_MS = 30_000;
/** Intervals past this are a stall (a hidden tab, a GC, a debugger), not a pace. */
const MAX_SAMPLE_MS = 250;
/** Faster than this is not a display (a 240 Hz panel is 4.2 ms). */
const MIN_REFRESH_MS = 4;

export interface QualityGovernor {
  /** The step the scene draws at now. */
  readonly index: number;
  /**
   * One drawn frame. `busy` while chunks are streaming: the budget never climbs
   * then (the spike is the download, not the device), but it may still fall.
   * Returns the new step index when it changed, `null` otherwise.
   */
  frame(intervalMs: number, now: number, busy: boolean): number | null;
}

export function createQualityGovernor(
  ladder: readonly QualityStep[],
  start: number,
): QualityGovernor {
  let index = Math.max(0, Math.min(ladder.length - 1, start));
  let window: number[] = [];
  // The display's frame interval: the fastest window median seen.
  let refresh = Number.POSITIVE_INFINITY;
  let calm = 0;
  // A change re-sorts and re-streams; the next window shows that, not the step.
  let settling = false;
  // The lowest step that dropped frames, and until when it is out of reach.
  let failedAt = ladder.length;
  let failedUntil = 0;

  return {
    get index() {
      return index;
    },
    frame(intervalMs, now, busy) {
      if (!(intervalMs > 0) || intervalMs > MAX_SAMPLE_MS) return null;
      window.push(intervalMs);
      if (window.length < WINDOW_FRAMES) return null;

      const sorted = window.sort((a, b) => a - b);
      window = [];
      const median = sorted[Math.floor(sorted.length / 2)];
      const p90 = sorted[Math.floor(sorted.length * 0.9)];
      refresh = Math.max(MIN_REFRESH_MS, Math.min(refresh, median));
      if (settling) {
        settling = false;
        return null;
      }

      if (median > refresh * SLOW_RATIO) {
        calm = 0;
        if (index === 0) return null;
        failedAt = index;
        failedUntil = now + FAILED_STEP_COOLDOWN_MS;
        index -= 1;
        settling = true;
        return index;
      }

      if (p90 > refresh * CALM_RATIO || busy) {
        calm = 0;
        return null;
      }
      calm += 1;
      const ceiling = now < failedUntil ? failedAt - 1 : ladder.length - 1;
      if (calm < CALM_WINDOWS_TO_CLIMB || index >= ceiling) return null;
      calm = 0;
      index += 1;
      settling = true;
      return index;
    },
  };
}

/**
 * Dynamic resolution: lower the map canvas's pixel ratio while frames are
 * over the quality profile's budget, raise it again when there is headroom
 * (`docs/MAP_PERFORMANCE.md` → "Adaptive quality"). Fill rate is what a weak
 * GPU runs out of first in this map — three full-screen sky passes, terrain,
 * thousands of building and tree fragments per pixel row — and the pixel
 * ratio is the one knob that scales all of it at once.
 *
 * Pure: frame samples in, a new ratio (or `null`: keep it) out; the MapLibre
 * side (`map.setPixelRatio`) is `mapRuntime.web.ts`'s. Tested in
 * `__tests__/dynamicResolution.test.ts`.
 *
 * Two kinds of evidence. `costMs` — what the frame actually cost (main-thread
 * time, and GPU time where the browser exposes a timer) — is exact both ways.
 * Without a GPU timer only the frame INTERVAL is known, and on a 60 Hz screen
 * that never reads below 16.7 ms, so "is there headroom" cannot be seen: the
 * controller then PROBES one step up after a calm stretch, and backs the next
 * probe off (×2, up to a minute) whenever a probe had to be undone.
 */
import { percentile } from './frameStats';

export interface DynamicResolutionOptions {
  min: number;
  max: number;
  targetMs: number;
  now: () => number;
  /** Starting ratio; defaults to `max`. */
  initial?: number;
}

/** A frame the host drew while the map was continuously rendering. */
export interface FrameSample {
  /** Time since the previous frame, ms; `null` after an idle gap. */
  intervalMs: number | null;
  /** What the frame cost (main thread, and GPU when timed), ms; `null` when unknown. */
  costMs: number | null;
}

const STEP_DOWN = 0.85;
const STEP_UP = 1.1;
const MIN_SAMPLES = 20;
const SETTLE_MS = 750;
const PROBE_MS = 4000;
const PROBE_MAX_MS = 60_000;

export class DynamicResolution {
  ratio: number;
  private loads: number[] = [];
  private costs: number[] = [];
  private changedAt: number;
  private probeDelay = PROBE_MS;
  private probedAt = -Infinity;

  constructor(private options: DynamicResolutionOptions) {
    this.ratio = options.initial ?? options.max;
    this.changedAt = options.now();
  }

  /** New limits (the quality profile changed); the ratio is clamped into them. */
  configure(next: { min: number; max: number; targetMs: number }): number | null {
    this.options = { ...this.options, ...next };
    const clamped = Math.min(next.max, Math.max(next.min, this.ratio));
    return this.set(clamped === this.ratio ? null : clamped);
  }

  sample(frame: FrameSample): number | null {
    const load = frame.costMs ?? frame.intervalMs;
    if (load === null || !Number.isFinite(load)) return null;
    this.loads.push(load);
    if (frame.costMs !== null) this.costs.push(frame.costMs);
    if (this.loads.length > 60) this.loads.shift();
    if (this.costs.length > 60) this.costs.shift();
    const now = this.options.now();
    if (this.loads.length < MIN_SAMPLES || now - this.changedAt < SETTLE_MS) return null;
    const { min, max, targetMs } = this.options;

    if (percentile(this.loads, 80) > targetMs * 1.2 && this.ratio > min) {
      // A probe that had to be undone at once: wait longer before the next.
      if (now - this.probedAt < PROBE_MS)
        this.probeDelay = Math.min(PROBE_MAX_MS, this.probeDelay * 2);
      return this.set(Math.max(min, this.ratio * STEP_DOWN));
    }
    if (this.ratio >= max) return null;
    if (this.costs.length >= MIN_SAMPLES) {
      // Exact: the frame costs well under budget at this ratio.
      if (percentile(this.costs, 90) < targetMs * 0.6)
        return this.set(Math.min(max, this.ratio * STEP_UP));
      return null;
    }
    if (now - this.changedAt >= this.probeDelay && percentile(this.loads, 80) <= targetMs * 1.1) {
      this.probedAt = now;
      return this.set(Math.min(max, this.ratio * STEP_UP));
    }
    return null;
  }

  private set(next: number | null): number | null {
    if (next === null) return null;
    // Quantised, so a ratio does not creep by fractions of a pixel.
    const value = Math.round(next * 20) / 20;
    if (value === this.ratio) return null;
    this.ratio = value;
    this.changedAt = this.options.now();
    this.loads = [];
    this.costs = [];
    return value;
  }
}

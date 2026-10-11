/**
 * Frame-time arithmetic shared by the HUD (`mapRuntime.web.ts`) and the
 * benchmark (`scripts/bench-map.ts`): percentiles over a window, and a
 * per-section timer. Pure; tested in `__tests__/frameStats.test.ts`.
 */

/** The `p`-th percentile (0…100) of `values`, nearest-rank; `NaN` for none. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank))];
}

export interface Summary {
  n: number;
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

export function summarise(values: readonly number[]): Summary {
  const n = values.length;
  if (n === 0) return { n: 0, p50: Number.NaN, p95: Number.NaN, max: Number.NaN, mean: Number.NaN };
  let sum = 0;
  let max = -Infinity;
  for (const v of values) {
    sum += v;
    if (v > max) max = v;
  }
  return { n, p50: percentile(values, 50), p95: percentile(values, 95), max, mean: sum / n };
}

/** A fixed-size window of the most recent samples. */
export class Window {
  private readonly values: number[] = [];
  constructor(private readonly size: number) {}
  push(value: number): void {
    this.values.push(value);
    if (this.values.length > this.size) this.values.shift();
  }
  get samples(): readonly number[] {
    return this.values;
  }
  clear(): void {
    this.values.length = 0;
  }
}

/**
 * Main-thread time per named section of a frame (`city`, `sky`, `shadow`,
 * `life`…). `enter`/`leave` nest; a section's time excludes the sections
 * entered inside it, so the parts add up to the whole.
 */
export class SectionTimer {
  private readonly stack: Array<{ name: string; started: number; child: number }> = [];
  private readonly frame = new Map<string, number>();
  readonly windows = new Map<string, Window>();

  constructor(
    private readonly now: () => number,
    private readonly windowSize = 120,
  ) {}

  enter(name: string): void {
    this.stack.push({ name, started: this.now(), child: 0 });
  }

  leave(): void {
    const top = this.stack.pop();
    if (!top) return;
    const total = this.now() - top.started;
    this.frame.set(top.name, (this.frame.get(top.name) ?? 0) + total - top.child);
    const parent = this.stack[this.stack.length - 1];
    if (parent) parent.child += total;
  }

  /** The section being timed now, or `''`. */
  get current(): string {
    return this.stack[this.stack.length - 1]?.name ?? '';
  }

  /** Close the frame: each section's time goes into its window; returns this frame's times. */
  endFrame(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [name, ms] of this.frame) {
      out[name] = ms;
      let window = this.windows.get(name);
      if (!window) {
        window = new Window(this.windowSize);
        this.windows.set(name, window);
      }
      window.push(ms);
    }
    this.frame.clear();
    return out;
  }
}

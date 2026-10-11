/**
 * A seeded, deterministic random source for the simulation.
 *
 * `Math.random` is never used anywhere in `cityLife/`: the same seed, the same
 * road tiles and the same sequence of views produce the same city, step for
 * step, which is what lets `__tests__/cityLifeSim.test.ts` assert behaviour
 * instead of sampling it. mulberry32 — 32 bits of state, fast, and plenty for
 * choosing turns and paint colours.
 */
export interface Rng {
  /** Uniform in `[0, 1)`. */
  next(): number;
  /** Uniform in `[min, max)`. */
  range(min: number, max: number): number;
  /** An integer in `[0, n)`. */
  int(n: number): number;
}

export function createRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (n) => Math.min(n - 1, Math.floor(next() * n)),
  };
}

/** A stable 32-bit hash of an integer pair, for per-junction phase offsets. */
export function hash2(a: number, b: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

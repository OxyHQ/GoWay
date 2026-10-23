/**
 * The visibility gate's checks (`check-city3d-visible.ts`), and which of them
 * one CI shard runs (`--shard=K/N`).
 *
 * A check is the unit a shard takes: its views and the assertions comparing
 * them, self-contained (no check reads another's screenshots). The cost is
 * the check's MEDIAN seconds on CI's two-core SwiftShader runner, read off
 * the gate's per-view log lines over 17 runs of 2026-10-21/23; it only
 * balances the shards, so a stale number makes one shard longer, never a
 * check skipped.
 */
export const CHECK_COSTS = {
  /** Trees and buildings, sky on: trees, no trees, no city. */
  'sky-city': 350,
  /** Streets over a junction, sky on: on and off. */
  'sky-streets': 230,
  /** A pan holds still: the sky's sun shadows. */
  'sky-pan': 140,
  /** No speckle at night, the city sky over the walls. */
  'sky-night': 80,
  /** Trees and buildings, sky off. */
  'nosky-city': 260,
  /** Streets, sky off, on flat and on creased ground. */
  'nosky-streets': 325,
  /** Mid-fade the city draws as one solid layer. */
  fade: 75,
  /** The landmark on the screen, and the camera never inside it. */
  models: 110,
  /** City life's traffic on the screen. */
  life: 105,
} as const;

export type CheckName = keyof typeof CHECK_COSTS;

export const CHECK_NAMES = Object.keys(CHECK_COSTS) as CheckName[];

/**
 * The checks shard `index` (0-based) of `total` runs. Every check lands in
 * exactly one shard, by construction: longest first, each onto the shard
 * with the least work so far (ties to the lowest index), the same order on
 * every runner. CI passes `strategy.job-index` / `strategy.job-total`, so a
 * shard added to or removed from the matrix cannot leave a check unrun.
 */
export function shardChecks(index: number, total: number): CheckName[] {
  if (!Number.isInteger(total) || !Number.isInteger(index) || index < 0 || index >= total) {
    throw new Error(`--shard=${index}/${total}: want K/N with 0 <= K < N`);
  }
  const load = Array.from({ length: total }, () => 0);
  const mine: CheckName[] = [];
  const longestFirst = [...CHECK_NAMES].sort(
    (a, b) => CHECK_COSTS[b] - CHECK_COSTS[a] || a.localeCompare(b),
  );
  for (const name of longestFirst) {
    let to = 0;
    for (let s = 1; s < total; s++) if (load[s] < load[to]) to = s;
    load[to] += CHECK_COSTS[name];
    if (to === index) mine.push(name);
  }
  return mine;
}

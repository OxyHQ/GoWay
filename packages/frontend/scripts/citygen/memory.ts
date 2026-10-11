/**
 * Resident memory, as the compilers report it per pass.
 *
 * Memory, not time, is what decides how big a region one build machine can
 * compile (`docs/MAP_CITY_PLANET.md` → "Sizing"), so every pass logs it and
 * the receipt records the highest value seen. It is sampled at the end of
 * each pass, so it is a floor on the true peak, not the peak itself; the
 * region builder also records the OS's peak for the whole process.
 */
let peak = 0;

/** The process's resident set now, in MB; also raises {@link peakRssMb}. */
export function rssMb(): number {
  const mb = Math.round(process.memoryUsage.rss() / 1e6);
  if (mb > peak) peak = mb;
  return mb;
}

/** The highest {@link rssMb} sampled so far in this process. */
export function peakRssMb(): number {
  return peak;
}

/**
 * A full collection, where the runtime offers one (Bun), so that what a pass
 * released is gone before the next pass allocates. Without it the collector
 * runs when it likes and the peaks of consecutive passes add up.
 */
export function collectGarbage(): void {
  (globalThis as { Bun?: { gc(force: boolean): void } }).Bun?.gc(true);
}

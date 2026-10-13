/**
 * Whether this backend serves GoWay Live — asked before any socket opens, and
 * asked AGAIN while the answer is no: a backend switches live on
 * (`LIVE_SOURCES`) independently of the maps already open, and those must
 * find out without a reload. Pure: the check and the timer are injected.
 */

/** Waits between asks while the answer is "not served": then every 5 min. */
export const AVAILABILITY_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000, 300_000];

export type LiveAvailability = 'yes' | 'no';

export interface WatchAvailabilityOptions {
  /** `'no'` only for "this deployment has no live" (503); anything else is `'yes'`. */
  check: () => Promise<LiveAvailability>;
  onAvailable: () => void;
  /** `setTimeout`, injectable; returns a cancel. */
  schedule?: (run: () => void, ms: number) => () => void;
}

/** Start asking; resolves `onAvailable` once. Returns the stop. */
export function watchLiveAvailability(options: WatchAvailabilityOptions): () => void {
  const schedule =
    options.schedule ??
    ((run: () => void, ms: number) => {
      const timer = setTimeout(run, ms);
      return () => clearTimeout(timer);
    });
  let stopped = false;
  let cancel: (() => void) | null = null;
  let attempt = 0;
  const ask = () => {
    cancel = null;
    if (stopped) return;
    void options.check().then(
      (answer) => {
        if (stopped) return;
        if (answer === 'yes') {
          options.onAvailable();
          return;
        }
        const wait =
          AVAILABILITY_RETRY_MS[Math.min(attempt, AVAILABILITY_RETRY_MS.length - 1)] ?? 300_000;
        attempt++;
        cancel = schedule(ask, wait);
      },
      () => {
        // `check` reports failures as answers; a throw is a bug — say yes and
        // let the socket report what is wrong.
        if (!stopped) options.onAvailable();
      },
    );
  };
  ask();
  return () => {
    stopped = true;
    cancel?.();
  };
}

/**
 * `scheduler.yield()` (WICG Prioritized Task Scheduling) on every platform the
 * app runs on, installed once at startup (`app/_layout.tsx`). Where the API is
 * native (Chrome, Edge, Firefox) nothing is touched.
 *
 * It matters to the 3D city: three's `compileAsync` (the material warm-up,
 * `docs/MAP_NATIVE_3D.md`) yields through `self.scheduler.yield()` when there
 * is one, and otherwise waits a whole animation frame per yield, about 100 of
 * them, which put the city 1.7–2.3 s behind its tiles in Safari and on Hermes.
 *
 * - **Web without it (Safari):** the spec authors' own polyfill,
 *   `scheduler-polyfill` (GoogleChromeLabs, Apache-2.0, pinned): the whole
 *   `scheduler` (`postTask`, `yield`, `TaskController`), on a `MessageChannel`.
 * - **Hermes (React Native):** no `MessageChannel`, so the polyfill would fall
 *   back to `setTimeout(0)`, which React Native runs on the next frame (iOS's
 *   `RCTTiming` on the display link; measured on Android: 12.7 ms a yield).
 *   Its `setImmediate` is a microtask, which never lets a frame through. The
 *   macrotask it offers is `requestIdleCallback`, a task on its runtime
 *   scheduler behind every timer and frame callback that is due (measured:
 *   0.03 ms a yield, frames on time). Only `yield()` is installed there, in
 *   the API's shape: a promise for the continuation.
 */
interface SchedulerScope {
  scheduler?: { yield?: () => Promise<void> } & Record<string, unknown>;
}

/** Install `scheduler.yield()` where it is missing; resolves once it is there (or cannot be). */
export async function installSchedulerYield(
  scope: SchedulerScope = globalThis as SchedulerScope,
): Promise<void> {
  if (typeof scope.scheduler?.yield === 'function') return;
  if (typeof MessageChannel === 'function') {
    // Installs onto `self`, the global the browser and three both read.
    await import('scheduler-polyfill');
    return;
  }
  if (typeof requestIdleCallback === 'function') {
    const idle = requestIdleCallback;
    scope.scheduler = {
      ...scope.scheduler,
      yield: () =>
        new Promise<void>((resolve) => {
          idle(() => resolve());
        }),
    };
  }
}

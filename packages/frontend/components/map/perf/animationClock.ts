/**
 * The map's ONE animation clock (`docs/MAP_PERFORMANCE.md` → "Render on
 * demand"). MapLibre draws only when something asks; everything that moves by
 * itself — simulated city life, live vehicles, an animated model — asks
 * through this clock instead of a timer of its own, so:
 *
 *  - the map redraws at most {@link AnimationClockOptions.hz} times a second
 *    for ALL of them together (one repaint per tick, never one per feature);
 *  - nothing redraws while nothing animates (a still map costs nothing);
 *  - everything pauses together when the tab is hidden or nobody has touched
 *    the map for {@link AnimationClockOptions.idleMs} — the battery rule —
 *    and resumes on the next interaction.
 *
 * Pure: timers, the clock and visibility are injected, so the rules are tests
 * (`__tests__/animationClock.test.ts`). The MapLibre wiring (repaint,
 * interaction events, `visibilitychange`) is `mapRuntime.web.ts`'s.
 */

export interface AnimationTicket {
  /** While `true` the clock asks the host for frames at its rate. */
  setAnimating(on: boolean): void;
  /** Paused (hidden or idle): stop simulating, keep what is drawn. */
  readonly paused: boolean;
  /** Leave the clock (the feature went away). */
  dispose(): void;
}

export interface AnimationClock {
  /**
   * Join the clock. `onPausedChange` is told when the clock pauses or resumes
   * (a simulation worker stops and starts with it); `onTick`, on every tick
   * while this member animates, just before the one repaint (a layer that
   * updates a source rather than a uniform does its update there).
   */
  join(
    name: string,
    onPausedChange?: (paused: boolean) => void,
    onTick?: () => void,
  ): AnimationTicket;
  /** Someone touched the map (pan, zoom, tap, key): the idle timer restarts, a paused clock resumes. */
  noteInteraction(): void;
  /** The page became hidden or visible. */
  setHidden(hidden: boolean): void;
  /** A new rate or idle limit (the quality profile changed). */
  configure(options: { hz: number; idleMs: number }): void;
  readonly paused: boolean;
  /** Names of the features animating now (the HUD shows them). */
  animating(): string[];
  dispose(): void;
}

export interface AnimationClockOptions {
  hz: number;
  idleMs: number;
  /** Ask the host for one frame. */
  requestFrame: () => void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export function createAnimationClock(options: AnimationClockOptions): AnimationClock {
  const now = options.now ?? (() => performance.now());
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let hz = options.hz;
  let idleMs = options.idleMs;
  let hidden = false;
  let idle = false;
  let lastInteraction = now();
  let tickTimer: unknown = null;
  let idleTimer: unknown = null;
  let disposed = false;

  interface Member {
    name: string;
    animating: boolean;
    onPausedChange?: (paused: boolean) => void;
    onTick?: () => void;
  }
  const members = new Set<Member>();

  const isPaused = () => hidden || idle;
  const anyAnimating = () => {
    for (const m of members) if (m.animating) return true;
    return false;
  };

  const schedule = () => {
    if (disposed || tickTimer !== null || isPaused() || !anyAnimating()) return;
    tickTimer = setTimer(tick, 1000 / Math.max(1, hz));
  };
  const tick = () => {
    tickTimer = null;
    if (disposed || isPaused() || !anyAnimating()) return;
    for (const m of [...members]) if (m.animating) m.onTick?.();
    options.requestFrame();
    schedule();
  };

  const armIdle = () => {
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = null;
    if (disposed || !Number.isFinite(idleMs) || idleMs <= 0) return;
    const remaining = lastInteraction + idleMs - now();
    idleTimer = setTimer(
      () => {
        idleTimer = null;
        if (now() - lastInteraction >= idleMs) setIdle(true);
        else armIdle();
      },
      Math.max(0, remaining),
    );
  };

  let wasPaused = false;
  const notify = () => {
    const paused = isPaused();
    if (paused === wasPaused) return;
    wasPaused = paused;
    if (paused && tickTimer !== null) {
      clearTimer(tickTimer);
      tickTimer = null;
    }
    for (const m of [...members]) m.onPausedChange?.(paused);
    // One frame on resume, so what was frozen moves again at once.
    if (!paused && anyAnimating()) {
      for (const m of [...members]) if (m.animating) m.onTick?.();
      options.requestFrame();
      schedule();
    }
  };
  const setIdle = (next: boolean) => {
    if (idle === next) return;
    idle = next;
    notify();
  };

  armIdle();

  return {
    join(name, onPausedChange, onTick) {
      const member: Member = { name, animating: false, onPausedChange, onTick };
      members.add(member);
      return {
        setAnimating(on) {
          if (member.animating === on) return;
          member.animating = on;
          if (on) schedule();
        },
        get paused() {
          return isPaused();
        },
        dispose() {
          members.delete(member);
        },
      };
    },
    noteInteraction() {
      lastInteraction = now();
      setIdle(false);
      armIdle();
    },
    setHidden(next) {
      if (hidden === next) return;
      hidden = next;
      notify();
    },
    configure(next) {
      hz = next.hz;
      idleMs = next.idleMs;
      armIdle();
    },
    get paused() {
      return isPaused();
    },
    animating() {
      return [...members].filter((m) => m.animating).map((m) => m.name);
    },
    dispose() {
      disposed = true;
      if (tickTimer !== null) clearTimer(tickTimer);
      if (idleTimer !== null) clearTimer(idleTimer);
      tickTimer = null;
      idleTimer = null;
      members.clear();
    },
  };
}

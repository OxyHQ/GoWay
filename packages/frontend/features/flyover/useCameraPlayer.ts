/**
 * The playback clock shared by the route flyover and Camera Studio's preview.
 *
 * It owns TIME and nothing else: play, pause, seek, skip between chapters.
 * Every tick it calls `onFrame(timeMs)`, and the caller turns a time into a
 * camera (`FlyoverPlan.frameAt`, `CompiledTour.cameraAt`) and hands it to the
 * map. That split is what makes scrubbing, skipping and video export free —
 * each is just "ask for another time" — and what keeps this hook the same on
 * web and native: `requestAnimationFrame` exists on both.
 *
 * ## Reduced motion
 *
 * With the system's reduce-motion setting on, nothing flies. Play steps
 * through the chapters as STILLS — the camera cuts to each one and rests
 * there for {@link STILL_MS} — which keeps the information (here is each turn,
 * here is the end) without the continuous camera movement the setting asks
 * apps to avoid. Seeking and skipping cut the same way.
 *
 * ## Re-rendering
 *
 * The camera moves every animation frame, but React does not need to: the
 * time the UI shows (the scrubber, the clock) is published at most every
 * {@link UI_TICK_MS}, so a minute of flyover is ~600 renders of the controls
 * rather than 3,600 of the screen.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/** How long each still rests under reduced motion. */
export const STILL_MS = 3_500;
/** How often the UI's notion of the time is refreshed while playing. */
const UI_TICK_MS = 100;
/** A "skip back" this close after a chapter goes to the one before it. */
const SKIP_BACK_GRACE_MS = 800;

export interface CameraPlayerOptions {
  durationMs: number;
  /** Times worth jumping to, ascending; the reduced-motion stills. */
  chapters: readonly number[];
  /** Called with every new time; turn it into a camera. */
  onFrame: (timeMs: number, info: { settled: boolean }) => void;
  reducedMotion: boolean;
  /** Called once when playback reaches the end. */
  onEnd?: () => void;
}

export interface CameraPlayer {
  playing: boolean;
  /** The time the UI shows (refreshed at ~10 Hz while playing). */
  timeMs: number;
  durationMs: number;
  play(): void;
  pause(): void;
  toggle(): void;
  seek(timeMs: number): void;
  /** To the next (+1) or previous (−1) chapter. */
  skip(direction: 1 | -1): void;
}

export function nextChapter(chapters: readonly number[], time: number, direction: 1 | -1): number {
  if (direction > 0)
    return chapters.find((c) => c > time + 1) ?? chapters[chapters.length - 1] ?? 0;
  const earlier = chapters.filter((c) => c < time - SKIP_BACK_GRACE_MS);
  return earlier[earlier.length - 1] ?? 0;
}

export function useCameraPlayer(options: CameraPlayerOptions): CameraPlayer {
  const { durationMs, chapters, reducedMotion } = options;
  const [playing, setPlaying] = useState(false);
  const [timeMs, setTimeMs] = useState(0);

  const time = useRef(0);
  // The latest callbacks, for the loop and the timers to call without being
  // restarted by a parent's new function identity.
  const frameRef = useRef(options.onFrame);
  const endRef = useRef(options.onEnd);
  useLayoutEffect(() => {
    frameRef.current = options.onFrame;
    endRef.current = options.onEnd;
  });
  const shown = useRef(0);

  const publish = useCallback((t: number, force: boolean) => {
    if (force || Math.abs(t - shown.current) >= UI_TICK_MS) {
      shown.current = t;
      setTimeMs(t);
    }
  }, []);

  const seek = useCallback(
    (target: number) => {
      const t = Math.max(0, Math.min(durationMs, Number.isFinite(target) ? target : 0));
      time.current = t;
      frameRef.current(t, { settled: true });
      publish(t, true);
    },
    [durationMs, publish],
  );

  // The animation loop (full motion).
  useEffect(() => {
    if (!playing || reducedMotion) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const t = Math.min(durationMs, time.current + (now - last));
      last = now;
      time.current = t;
      const done = t >= durationMs;
      frameRef.current(t, { settled: done });
      publish(t, done);
      if (done) {
        setPlaying(false);
        endRef.current?.();
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, reducedMotion, durationMs, publish]);

  // The stills (reduced motion): cut to each chapter and rest.
  useEffect(() => {
    if (!playing || !reducedMotion) return;
    const timer = setInterval(() => {
      const next = nextChapter(chapters, time.current, 1);
      time.current = next;
      frameRef.current(next, { settled: true });
      publish(next, true);
      if (next >= durationMs) {
        setPlaying(false);
        endRef.current?.();
      }
    }, STILL_MS);
    return () => clearInterval(timer);
  }, [playing, reducedMotion, chapters, durationMs, publish]);

  const play = useCallback(() => {
    // Play at the end starts over.
    if (time.current >= durationMs) seek(0);
    else frameRef.current(time.current, { settled: reducedMotion });
    setPlaying(true);
  }, [durationMs, reducedMotion, seek]);

  const pause = useCallback(() => {
    setPlaying(false);
    // Settle the camera where it stopped.
    frameRef.current(time.current, { settled: true });
    publish(time.current, true);
  }, [publish]);

  const toggle = useCallback(() => (playing ? pause() : play()), [pause, play, playing]);

  const skip = useCallback(
    (direction: 1 | -1) => seek(nextChapter(chapters, time.current, direction)),
    [chapters, seek],
  );

  return { playing, timeMs, durationMs, play, pause, toggle, seek, skip };
}

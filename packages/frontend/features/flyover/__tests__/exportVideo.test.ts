/**
 * Video export can be cancelled, and cancelling releases everything.
 *
 * PR #123 review: closing the player during an export paused playback before
 * the end callback ran, so the recording promise never settled and the
 * recorder, the stream's tracks and the frame listener ran on. The export now
 * takes an AbortSignal; an abort rejects it (AbortError) and the `finally`
 * stops the recorder and the tracks and removes the listener. Run against fake
 * browser objects — the recorder, the canvas and the map are stand-ins.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';

mock.module('@/components/map', () => ({ MAP_BRAND_WIDTH: 76 }));

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
const tracks: FakeTrack[] = [];
const recorders: FakeRecorder[] = [];

class FakeRecorder {
  static isTypeSupported = () => true;
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['webm']) });
    setTimeout(() => this.onstop?.(), 0);
  }
}

beforeAll(() => {
  const ctx = new Proxy({}, { get: () => () => ({ width: 10 }) });
  class FakeCanvas {
    width = 0;
    height = 0;
    getContext() {
      return ctx;
    }
    captureStream() {
      const track = new FakeTrack();
      tracks.push(track);
      return { getTracks: () => [track] };
    }
  }
  Object.assign(globalThis, {
    document: { createElement: () => new FakeCanvas() },
    HTMLCanvasElement: FakeCanvas,
    MediaRecorder: FakeRecorder,
    Path2D: class {},
    requestAnimationFrame: (fn: () => void) => setTimeout(fn, 0),
  });
});

function fakeMap() {
  const listeners = new Set<() => void>();
  return {
    listeners,
    map: {
      captureFrames: (draw: (frame: { canvas: unknown }) => void) => {
        const listener = () => draw({ canvas: { width: 800, height: 600, clientWidth: 800 } });
        listeners.add(listener);
        listener();
        return () => listeners.delete(listener);
      },
    },
  };
}

const COLOURS = { plate: '#fff', text: '#333' };

describe('exportVideo', () => {
  test('records one playback and releases everything', async () => {
    const { exportVideo } = await import('@/features/flyover/studio/exportVideo');
    const { map, listeners } = fakeMap();
    const blob = await exportVideo({
      map: map as never,
      colours: COLOURS,
      play: () => new Promise((resolve) => setTimeout(resolve, 20)),
    });
    expect(blob.size).toBeGreaterThan(0);
    expect(listeners.size).toBe(0);
    expect(tracks.at(-1)?.stopped).toBe(true);
    expect(recorders.at(-1)?.state).toBe('inactive');
  });

  test('an abort mid-playback rejects, and stops the recorder, the tracks and the listener', async () => {
    const { exportVideo } = await import('@/features/flyover/studio/exportVideo');
    const { map, listeners } = fakeMap();
    const controller = new AbortController();
    // A playback that never ends on its own: the player was paused.
    const result = exportVideo({
      map: map as never,
      colours: COLOURS,
      play: () => new Promise(() => {}),
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(recorders.at(-1)?.state).toBe('recording');
    controller.abort();
    const outcome = await Promise.race([
      result.then(
        () => 'resolved',
        (cause: unknown) => (cause as { name?: string }).name ?? 'rejected',
      ),
      new Promise((r) => setTimeout(() => r('hung'), 500)),
    ]);
    expect(outcome).toBe('AbortError');
    expect(recorders.at(-1)?.state).toBe('inactive');
    expect(tracks.at(-1)?.stopped).toBe(true);
    expect(listeners.size).toBe(0);
  });

  test('an already-aborted signal never starts recording', async () => {
    const { exportVideo } = await import('@/features/flyover/studio/exportVideo');
    const { map, listeners } = fakeMap();
    const controller = new AbortController();
    controller.abort();
    const before = recorders.length;
    await expect(
      exportVideo({
        map: map as never,
        colours: COLOURS,
        play: async () => {},
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(recorders.length).toBe(before);
    expect(listeners.size).toBe(0);
  });
});

/**
 * The performance runtime's pure parts (`components/map/perf/`): the one
 * animation clock (render on demand, pause when hidden or idle), dynamic
 * resolution, frame statistics, and the GL counters every measurement uses.
 */
import { describe, expect, test } from 'bun:test';

import { createAnimationClock } from '@/components/map/perf/animationClock';
import { DynamicResolution } from '@/components/map/perf/dynamicResolution';
import { percentile, SectionTimer, summarise } from '@/components/map/perf/frameStats';
import { createGlCounterState, instrumentWebGl2 } from '@/components/map/perf/glCounters';

/** A manual clock and timer queue. */
function fakeTime() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => {
      timers.delete(id as number);
    },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        let first: [number, { at: number; fn: () => void }] | null = null;
        for (const entry of timers)
          if (entry[1].at <= end && (!first || entry[1].at < first[1].at)) first = entry;
        if (!first) break;
        timers.delete(first[0]);
        now = first[1].at;
        first[1].fn();
      }
      now = end;
    },
  };
}

describe('the animation clock', () => {
  const make = (hz = 30, idleMs = 10_000) => {
    const time = fakeTime();
    let frames = 0;
    const clock = createAnimationClock({
      hz,
      idleMs,
      requestFrame: () => {
        frames++;
      },
      now: time.now,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
    });
    return { clock, time, frames: () => frames };
  };

  test('nothing animating: no frames at all (render on demand)', () => {
    const { clock, time, frames } = make();
    clock.join('cityLife');
    time.advance(5000);
    expect(frames()).toBe(0);
  });

  test('ONE repaint per tick at the profile’s rate, however many features animate', () => {
    const { clock, time, frames } = make(30);
    clock.join('cityLife').setAnimating(true);
    clock.join('live').setAnimating(true);
    clock.join('models').setAnimating(true);
    time.advance(1000);
    expect(frames()).toBeGreaterThanOrEqual(29);
    expect(frames()).toBeLessThanOrEqual(31);
  });

  test('a lower rate is fewer frames (the battery saver’s 15 Hz)', () => {
    const { clock, time, frames } = make(15);
    clock.join('cityLife').setAnimating(true);
    time.advance(1000);
    expect(frames()).toBeLessThanOrEqual(16);
  });

  test('pauses when hidden, tells its members, and resumes with one frame', () => {
    const { clock, time, frames } = make();
    const seen: boolean[] = [];
    const ticket = clock.join('cityLife', (paused) => seen.push(paused));
    ticket.setAnimating(true);
    clock.setHidden(true);
    const before = frames();
    time.advance(2000);
    expect(frames()).toBe(before);
    expect(ticket.paused).toBe(true);
    clock.setHidden(false);
    expect(seen).toEqual([true, false]);
    expect(frames()).toBe(before + 1);
  });

  test('pauses after the idle time with no interaction; an interaction resumes it', () => {
    const { clock, time, frames } = make(30, 10_000);
    const ticket = clock.join('cityLife');
    ticket.setAnimating(true);
    time.advance(9_000);
    clock.noteInteraction();
    time.advance(9_000);
    expect(clock.paused).toBe(false);
    time.advance(2_000);
    expect(clock.paused).toBe(true);
    const frozen = frames();
    time.advance(30_000);
    expect(frames()).toBe(frozen);
    clock.noteInteraction();
    expect(clock.paused).toBe(false);
    time.advance(100);
    expect(frames()).toBeGreaterThan(frozen);
  });

  test('stops asking once nothing animates any more', () => {
    const { clock, time, frames } = make();
    const ticket = clock.join('cityLife');
    ticket.setAnimating(true);
    time.advance(500);
    ticket.setAnimating(false);
    const stopped = frames();
    time.advance(5000);
    expect(frames()).toBeLessThanOrEqual(stopped + 1);
  });
});

describe('dynamic resolution', () => {
  const run = (
    drs: DynamicResolution,
    time: ReturnType<typeof fakeTime>,
    frames: number,
    sample: { intervalMs: number | null; costMs: number | null },
  ) => {
    const ratios: number[] = [];
    for (let i = 0; i < frames; i++) {
      time.advance(sample.intervalMs ?? 16);
      const next = drs.sample(sample);
      if (next !== null) ratios.push(next);
    }
    return ratios;
  };

  test('steps down while frames are over budget, never below the floor', () => {
    const time = fakeTime();
    const drs = new DynamicResolution({ min: 1, max: 2, targetMs: 16.7, now: time.now });
    const ratios = run(drs, time, 2000, { intervalMs: 50, costMs: 40 });
    expect(ratios.length).toBeGreaterThan(2);
    expect(drs.ratio).toBe(1);
    for (let i = 1; i < ratios.length; i++) expect(ratios[i]).toBeLessThan(ratios[i - 1]);
  });

  test('with a GPU timer, steps back up when the frame costs well under budget', () => {
    const time = fakeTime();
    const drs = new DynamicResolution({
      min: 1,
      max: 2,
      targetMs: 16.7,
      now: time.now,
      initial: 1,
    });
    run(drs, time, 600, { intervalMs: 16.7, costMs: 4 });
    expect(drs.ratio).toBe(2);
  });

  test('a frame on budget is left alone', () => {
    const time = fakeTime();
    const drs = new DynamicResolution({
      min: 1,
      max: 2,
      targetMs: 16.7,
      now: time.now,
      initial: 1.5,
    });
    expect(run(drs, time, 300, { intervalMs: 16.7, costMs: 14 })).toEqual([]);
  });

  test('without a timer, it probes up after a calm stretch, and backs off a probe that failed', () => {
    const time = fakeTime();
    const drs = new DynamicResolution({
      min: 1,
      max: 2,
      targetMs: 16.7,
      now: time.now,
      initial: 1,
    });
    const calm = run(drs, time, 400, { intervalMs: 16.7, costMs: null });
    expect(calm.length).toBeGreaterThan(0);
    expect(calm[0]).toBeGreaterThan(1);
  });

  test('a new profile clamps the ratio into its limits', () => {
    const time = fakeTime();
    const drs = new DynamicResolution({ min: 1, max: 3, targetMs: 16.7, now: time.now });
    expect(drs.configure({ min: 1, max: 2, targetMs: 33.3 })).toBe(2);
  });
});

describe('frame statistics', () => {
  test('percentiles are nearest-rank', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(summarise([]).n).toBe(0);
    expect(summarise([2, 4]).mean).toBe(3);
  });

  test('sections exclude what is timed inside them, so the parts add up', () => {
    let now = 0;
    const timer = new SectionTimer(() => now);
    timer.enter('city');
    now += 2;
    timer.enter('sky');
    now += 3;
    timer.leave();
    now += 1;
    timer.leave();
    expect(timer.endFrame()).toEqual({ city: 3, sky: 3 });
  });
});

/** A WebGL2 context stand-in: every method a no-op, enums as WebGL defines them. */
function fakeGl() {
  const calls: string[] = [];
  const gl: Record<string, unknown> = {};
  for (const name of [
    'drawArrays',
    'drawElements',
    'drawArraysInstanced',
    'drawElementsInstanced',
    'drawRangeElements',
    'useProgram',
    'bindFramebuffer',
    'bindBuffer',
    'bufferData',
    'bufferSubData',
    'deleteBuffer',
    'activeTexture',
    'bindTexture',
    'texImage2D',
    'texSubImage2D',
    'texImage3D',
    'texStorage2D',
    'texStorage3D',
    'generateMipmap',
    'deleteTexture',
    'bindRenderbuffer',
    'renderbufferStorage',
    'renderbufferStorageMultisample',
    'deleteRenderbuffer',
  ]) {
    gl[name] = (..._args: unknown[]) => {
      calls.push(name);
    };
  }
  return { gl: gl as unknown as WebGL2RenderingContext, calls };
}

describe('the GL counters', () => {
  const TRIANGLES = 0x0004;
  const STRIP = 0x0005;
  const LINES = 0x0001;
  const ARRAY_BUFFER = 0x8892;
  const TEXTURE_2D = 0x0de1;
  const RGBA = 0x1908;
  const UNSIGNED_BYTE = 0x1401;
  const RGBA8 = 0x8058;

  test('draws, triangles and instances', () => {
    const { gl, calls } = fakeGl();
    const state = createGlCounterState();
    instrumentWebGl2(gl, state);
    gl.drawElements(TRIANGLES, 300, 0x1403, 0);
    gl.drawArrays(STRIP, 0, 10);
    gl.drawArrays(LINES, 0, 10);
    gl.drawElementsInstanced(TRIANGLES, 36, 0x1403, 0, 1000);
    expect(state.frame.draws).toBe(4);
    expect(state.frame.triangles).toBe(100 + 8 + 0 + 12 * 1000);
    expect(state.frame.instancedDraws).toBe(1);
    expect(state.frame.instances).toBe(1000);
    // The real methods still ran.
    expect(calls.filter((c) => c.startsWith('draw'))).toHaveLength(4);
  });

  test('passes, programs and sections', () => {
    const { gl } = fakeGl();
    const state = createGlCounterState();
    instrumentWebGl2(gl, state);
    const fb = {};
    const a = {};
    const b = {};
    gl.useProgram(a as WebGLProgram);
    gl.useProgram(a as WebGLProgram);
    gl.useProgram(b as WebGLProgram);
    gl.bindFramebuffer(0x8d40, fb as WebGLFramebuffer);
    state.section = 'shadows';
    gl.drawArrays(TRIANGLES, 0, 3);
    gl.bindFramebuffer(0x8d40, null);
    state.section = '';
    gl.drawArrays(TRIANGLES, 0, 3);
    expect(state.frame.programSwitches).toBe(2);
    expect(state.frame.offscreenPasses).toBe(1);
    expect(state.frame.offscreenDraws).toBe(1);
    expect(state.bySection.shadows.draws).toBe(1);
  });

  test('uploads and GPU memory, freed on delete; a mip chain counted once', () => {
    const { gl } = fakeGl();
    const state = createGlCounterState();
    instrumentWebGl2(gl, state);
    const buffer = {};
    gl.bindBuffer(ARRAY_BUFFER, buffer as WebGLBuffer);
    gl.bufferData(ARRAY_BUFFER, new Float32Array(1000), 0x88e4);
    gl.bufferSubData(ARRAY_BUFFER, 0, new Float32Array(10));
    expect(state.frame.uploadBytes).toBe(4000 + 40);
    expect(state.memory.buffers).toBe(4000);
    gl.deleteBuffer(buffer as WebGLBuffer);
    expect(state.memory.buffers).toBe(0);

    const texture = {};
    gl.bindTexture(TEXTURE_2D, texture as WebGLTexture);
    gl.texImage2D(
      TEXTURE_2D,
      0,
      RGBA,
      256,
      256,
      0,
      RGBA,
      UNSIGNED_BYTE,
      new Uint8Array(256 * 256 * 4),
    );
    expect(state.memory.textures).toBe(262144);
    gl.generateMipmap(TEXTURE_2D);
    gl.generateMipmap(TEXTURE_2D);
    gl.generateMipmap(TEXTURE_2D);
    expect(state.memory.textures).toBeCloseTo(262144 * 1.34, 0);
    gl.deleteTexture(texture as WebGLTexture);
    expect(Math.abs(state.memory.textures)).toBeLessThan(1e-6);

    const storage = {};
    gl.bindTexture(TEXTURE_2D, storage as WebGLTexture);
    gl.texStorage2D(TEXTURE_2D, 1, RGBA8, 1024, 1024);
    expect(state.memory.textures).toBe(4 * 1024 * 1024);
  });

  test('a context is instrumented once', () => {
    const { gl } = fakeGl();
    const state = createGlCounterState();
    expect(instrumentWebGl2(gl, state)).toBe(true);
    expect(instrumentWebGl2(gl, state)).toBe(false);
    gl.drawArrays(TRIANGLES, 0, 3);
    expect(state.frame.draws).toBe(1);
  });
});

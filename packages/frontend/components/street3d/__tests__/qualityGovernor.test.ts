import { describe, expect, test } from 'bun:test';

import {
  createQualityGovernor,
  FAILED_STEP_COOLDOWN_MS,
  qualityLadder,
  WINDOW_FRAMES,
} from '../qualityGovernor';

const DESKTOP = {
  start: { lodScale: 1, pixelRatio: 1.5 },
  max: { lodScale: 2, pixelRatio: 2 },
  min: { lodScale: 0.3, pixelRatio: 1 },
};

/** Feed one window of identical frames; return the last answer. */
function window(
  governor: ReturnType<typeof createQualityGovernor>,
  intervalMs: number,
  now: number,
  busy = false,
) {
  let changed: number | null = null;
  for (let i = 0; i < WINDOW_FRAMES; i += 1) changed = governor.frame(intervalMs, now, busy);
  return changed;
}

describe('qualityLadder', () => {
  test('cheapest first; below the start the pixel ratio drops first, above it the budget climbs first', () => {
    const { ladder, start } = qualityLadder(DESKTOP);
    expect(ladder[start]).toEqual(DESKTOP.start);
    expect(ladder[0]).toEqual(DESKTOP.min);
    expect(ladder[ladder.length - 1]).toEqual(DESKTOP.max);
    expect(ladder[start - 1]).toEqual({ lodScale: 1, pixelRatio: 1 });
    expect(ladder[ladder.length - 2]).toEqual({ lodScale: 2, pixelRatio: 1.5 });
    for (let i = 1; i < ladder.length; i += 1) {
      const cost = (step: (typeof ladder)[number]) => step.lodScale * step.pixelRatio ** 2;
      expect(cost(ladder[i])).toBeGreaterThan(cost(ladder[i - 1]));
    }
  });

  test('a device with no headroom has nothing above its start', () => {
    const { ladder, start } = qualityLadder({ ...DESKTOP, max: DESKTOP.start });
    expect(start).toBe(ladder.length - 1);
  });
});

describe('createQualityGovernor', () => {
  test('climbs after two calm windows at the display pace, one step at a time', () => {
    const { ladder, start } = qualityLadder(DESKTOP);
    const governor = createQualityGovernor(ladder, start);
    expect(window(governor, 16.7, 0)).toBeNull();
    expect(window(governor, 16.7, 1000)).toBe(start + 1);
    // The window after a change is the change settling, not the device.
    expect(window(governor, 30, 2000)).toBeNull();
    expect(governor.index).toBe(start + 1);
  });

  test('steps down on dropped frames and does not retry that step during the cooldown', () => {
    const { ladder, start } = qualityLadder(DESKTOP);
    const governor = createQualityGovernor(ladder, start);
    window(governor, 16.7, 0);
    window(governor, 16.7, 1000); // up to start + 1
    window(governor, 16.7, 2000); // settling
    expect(window(governor, 33, 3000)).toBe(start);
    window(governor, 16.7, 4000); // settling
    for (let t = 5000; t < 3000 + FAILED_STEP_COOLDOWN_MS; t += 1000) {
      expect(window(governor, 16.7, t)).toBeNull();
    }
    // Calm all through the cooldown: it retries as soon as the cooldown ends.
    expect(window(governor, 16.7, 3000 + FAILED_STEP_COOLDOWN_MS + 1000)).toBe(start + 1);
  });

  test('a slow device falls all the way to the floor, and no further', () => {
    const { ladder, start } = qualityLadder(DESKTOP);
    const governor = createQualityGovernor(ladder, start);
    window(governor, 16.7, 0); // learns the display's pace
    let t = 1000;
    for (let i = 0; i < ladder.length * 2 + 4; i += 1) {
      window(governor, 50, t);
      t += 1000;
    }
    expect(governor.index).toBe(0);
  });

  test('never climbs while chunks are streaming, and ignores stalls', () => {
    const { ladder, start } = qualityLadder(DESKTOP);
    const governor = createQualityGovernor(ladder, start);
    for (let t = 0; t < 5000; t += 1000) expect(window(governor, 16.7, t, true)).toBeNull();
    // A hidden tab's resume is one huge interval: not a sample.
    expect(governor.frame(5_000, 6000, false)).toBeNull();
    expect(governor.index).toBe(start);
  });

  test('a 120 Hz display is held to its own pace', () => {
    const { ladder, start } = qualityLadder(DESKTOP);
    const governor = createQualityGovernor(ladder, start);
    window(governor, 8.3, 0);
    // 60 fps on a 120 Hz panel is dropping half the frames.
    expect(window(governor, 16.7, 1000)).toBe(start - 1);
  });
});

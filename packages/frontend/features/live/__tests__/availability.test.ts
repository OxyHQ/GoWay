/**
 * An open map finds out when its backend switches live on: a "not served"
 * answer is asked again, on a widening interval, and stops when unmounted.
 */
import { describe, expect, test } from 'bun:test';

import {
  AVAILABILITY_RETRY_MS,
  type LiveAvailability,
  watchLiveAvailability,
} from '../availability';

function harness(answers: LiveAvailability[]) {
  const timers: { run: () => void; ms: number; cancelled: boolean }[] = [];
  let available = 0;
  let asked = 0;
  const stop = watchLiveAvailability({
    check: async () => answers[Math.min(asked++, answers.length - 1)] as LiveAvailability,
    onAvailable: () => {
      available++;
    },
    schedule: (run, ms) => {
      const timer = { run, ms, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  });
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const fire = async () => {
    const timer = timers.at(-1);
    if (timer && !timer.cancelled) timer.run();
    await flush();
  };
  return { timers, stop, flush, fire, available: () => available, asked: () => asked };
}

describe('watchLiveAvailability', () => {
  test('a backend that enables live later is found without a reload', async () => {
    const h = harness(['no', 'no', 'yes']);
    await h.flush();
    expect(h.available()).toBe(0);
    expect(h.timers.map((t) => t.ms)).toEqual([AVAILABILITY_RETRY_MS[0]]);
    await h.fire();
    expect(h.timers.map((t) => t.ms)).toEqual([AVAILABILITY_RETRY_MS[0], AVAILABILITY_RETRY_MS[1]]);
    await h.fire();
    expect(h.available()).toBe(1);
    expect(h.asked()).toBe(3);
  });

  test('available at once: no retry', async () => {
    const h = harness(['yes']);
    await h.flush();
    expect(h.available()).toBe(1);
    expect(h.timers).toHaveLength(0);
  });

  test('stops asking when the map goes away', async () => {
    const h = harness(['no', 'yes']);
    await h.flush();
    h.stop();
    expect(h.timers[0]?.cancelled).toBe(true);
    await h.fire();
    expect(h.available()).toBe(0);
  });
});

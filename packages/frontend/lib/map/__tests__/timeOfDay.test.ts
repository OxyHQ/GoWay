/**
 * The time-of-day scrubber's arithmetic (`lib/map/timeOfDay.ts`): slider
 * minutes and day steps to an instant on the device's clock, and the caption's
 * sun phases.
 */
import { describe, expect, test } from 'bun:test';

import {
  dayOffsetBetween,
  MAX_DAY_OFFSET,
  MINUTES_PER_DAY,
  minutesOfDay,
  scrubbedInstant,
  sunPhase,
} from '@/lib/map/timeOfDay';

const base = new Date(2026, 9, 11, 15, 42, 17);

describe('scrubbedInstant', () => {
  test('a slider position is minutes since local midnight, on the base day', () => {
    const at = scrubbedInstant(base, 8 * 60 + 30, 0);
    expect([at.getFullYear(), at.getMonth(), at.getDate()]).toEqual([2026, 9, 11]);
    expect([at.getHours(), at.getMinutes(), at.getSeconds()]).toEqual([8, 30, 0]);
    expect(minutesOfDay(at)).toBe(510);
  });

  test('day steps keep the hour, across a month end', () => {
    const at = scrubbedInstant(base, 20 * 60, 25);
    expect([at.getMonth(), at.getDate(), at.getHours()]).toEqual([10, 5, 20]);
    expect(dayOffsetBetween(base, at)).toBe(25);
    expect(dayOffsetBetween(base, scrubbedInstant(base, 0, -3))).toBe(-3);
  });

  test('clamped: the day to [0, 1440), the step to half a year either way', () => {
    expect(minutesOfDay(scrubbedInstant(base, -50, 0))).toBe(0);
    expect(minutesOfDay(scrubbedInstant(base, 5000, 0))).toBe(MINUTES_PER_DAY - 1);
    expect(dayOffsetBetween(base, scrubbedInstant(base, 600, 10_000))).toBe(MAX_DAY_OFFSET);
    expect(dayOffsetBetween(base, scrubbedInstant(base, 600, -10_000))).toBe(-MAX_DAY_OFFSET);
  });

  test('does not touch the base date', () => {
    const before = base.getTime();
    scrubbedInstant(base, 100, 3);
    expect(base.getTime()).toBe(before);
  });

  test('every slider position of a day is that day, whatever the clock does', () => {
    // A daylight-saving change day in the zones that have one; elsewhere an
    // ordinary day. Either way each position must land on its own date, and
    // the instants must never go backwards.
    const spring = new Date(2026, 2, 29, 12, 0, 0);
    let previous = -Infinity;
    for (let m = 0; m < MINUTES_PER_DAY; m += 5) {
      const at = scrubbedInstant(spring, m, 0);
      expect(at.getDate()).toBe(29);
      expect(at.getTime()).toBeGreaterThanOrEqual(previous);
      previous = at.getTime();
    }
  });
});

describe('sunPhase', () => {
  test('the conventional boundaries', () => {
    expect(sunPhase(40)).toBe('day');
    expect(sunPhase(6)).toBe('day');
    expect(sunPhase(5.9)).toBe('golden');
    expect(sunPhase(-0.5)).toBe('golden');
    expect(sunPhase(-3)).toBe('civil');
    expect(sunPhase(-6)).toBe('civil');
    expect(sunPhase(-9)).toBe('nautical');
    expect(sunPhase(-30)).toBe('night');
    expect(sunPhase(Number.NaN)).toBe('night');
  });
});

/**
 * The time-of-day scrubber is hidden until asked for, offered only while the
 * sky draws, and closing it — by any way — is going back to now
 * (`lib/map/timeOfDayControl.ts`, `docs/MAP_FEATURES.md` → "The time of day").
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  INITIAL_TIME_OF_DAY,
  litInstant,
  type TimeOfDayEvent,
  timeOfDayButtonShown,
  timeOfDayReducer,
} from '@/lib/map/timeOfDayControl';

const run = (events: readonly TimeOfDayEvent[], from = INITIAL_TIME_OF_DAY) =>
  events.reduce(timeOfDayReducer, from);
const SKY: TimeOfDayEvent = { type: 'sky', drawn: true };
const NO_SKY: TimeOfDayEvent = { type: 'sky', drawn: false };

describe('the time-of-day control', () => {
  test('closed by default, even once the sky draws', () => {
    expect(INITIAL_TIME_OF_DAY.open).toBe(false);
    expect(run([SKY]).open).toBe(false);
  });

  test('the sun button is offered only while the sky draws', () => {
    expect(timeOfDayButtonShown(INITIAL_TIME_OF_DAY)).toBe(false);
    expect(timeOfDayButtonShown(run([SKY]))).toBe(true);
    expect(timeOfDayButtonShown(run([SKY, NO_SKY]))).toBe(false);
  });

  test('the button opens it and, pressed again, closes it', () => {
    const opened = run([SKY, { type: 'toggle' }]);
    expect(opened.open).toBe(true);
    expect(run([{ type: 'toggle' }], opened).open).toBe(false);
  });

  test('Settings’ "Change time…" opens it, and only opens', () => {
    expect(run([SKY, { type: 'open' }]).open).toBe(true);
    const opened = run([SKY, { type: 'open' }]);
    expect(timeOfDayReducer(opened, { type: 'open' })).toBe(opened);
  });

  test('its own close (× or Escape) closes it', () => {
    expect(run([SKY, { type: 'toggle' }, { type: 'close' }]).open).toBe(false);
    const closed = run([SKY]);
    expect(timeOfDayReducer(closed, { type: 'close' })).toBe(closed);
  });

  test('nothing opens it while there is no sky', () => {
    expect(run([{ type: 'toggle' }]).open).toBe(false);
    expect(run([{ type: 'open' }]).open).toBe(false);
  });

  test('the sky going away closes it, and coming back does not reopen it', () => {
    const gone = run([SKY, { type: 'toggle' }, NO_SKY]);
    expect(gone.open).toBe(false);
    expect(run([SKY], gone).open).toBe(false);
  });

  test('the map is lit for the chosen time only while the scrubber shows; otherwise now', () => {
    const evening = new Date('2026-10-12T19:30:00Z');
    expect(litInstant(true, evening)).toBe(evening);
    expect(litInstant(false, evening)).toBeNull();
    expect(litInstant(true, null)).toBeNull();
  });
});

describe('wired', () => {
  const read = (path: string) =>
    readFileSync(join(import.meta.dir, '..', '..', '..', path), 'utf8');

  test('the web map draws the scrubber only when opened, and lights the map through litInstant', () => {
    const web = read('components/map/MapCanvas.web.tsx');
    expect(web).toContain('const timeOfDayShown = timeOfDayOpen && citySky && skyActive;');
    expect(web).toContain('const skyAt = litInstant(timeOfDayShown, chosenSkyAt);');
    expect(web).toMatch(/\{timeOfDayShown \? \(\s*<Suspense/);
  });

  test('the explore screen runs the reducer and returns focus to the sun on close', () => {
    const screen = read('features/explore/ExploreScreen.tsx');
    expect(screen).toContain('useReducer(timeOfDayReducer, INITIAL_TIME_OF_DAY)');
    expect(screen).toContain('timeOfDayOpen={timeOfDay.open}');
    expect(screen).toContain('focusTimeOfDayButton();');
    const button = read('features/explore/TimeOfDayButton.tsx');
    expect(button).toContain('aria-expanded={open}');
  });

  test('the scrubber can be closed from the keyboard and takes focus when opened', () => {
    const scrubber = read('components/map/TimeOfDayScrubber.web.tsx');
    expect(scrubber).toContain("event.key !== 'Escape'");
    expect(scrubber).toContain('slider.current?.focus(');
    expect(scrubber).toContain('testID="goway-time-of-day-close"');
  });
});

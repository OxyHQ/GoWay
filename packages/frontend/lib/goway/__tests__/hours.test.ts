/**
 * Opening hours in words — over the SDK's own `openingStatusAt`, so what is
 * tested here is the wording and the week, never a second evaluation.
 */
import { describe, expect, test } from 'bun:test';
import type { Place } from '@goway.to/sdk';

import { FIXTURE_PLACES_BY_ID } from '../fixtures';
import { openingSummary, upcomingExceptions, weeklySchedule } from '../hours';

const WEEKDAYS: Place['openingHours'] = {
  intervals: ([1, 2, 3, 4, 5] as const).map((day) => ({ day, opens: '09:00', closes: '20:00' })),
};
// Monday 5 October 2026, 12:30 in Madrid.
const MONDAY_NOON = new Date('2026-10-05T10:30:00Z');

describe('openingSummary', () => {
  test('says open and when it closes, in the place’s clock', () => {
    expect(
      openingSummary({ openingHours: WEEKDAYS, timezone: 'Europe/Madrid' }, MONDAY_NOON),
    ).toEqual({
      state: 'open',
      text: 'Open · closes 20:00',
      spoken: 'Open now, closes 20:00',
    });
  });

  test('names the day of the next opening when it is not today', () => {
    const friday = new Date('2026-10-09T19:00:00Z');
    expect(
      openingSummary({ openingHours: WEEKDAYS, timezone: 'Europe/Madrid' }, friday)?.text,
    ).toBe('Closed · opens Mon 09:00');
  });

  test('lets a closure say why', () => {
    const summary = openingSummary(
      {
        openingHours: WEEKDAYS,
        timezone: 'Europe/Madrid',
        hoursExceptions: [
          {
            id: 'e',
            placeId: 'p',
            startsOn: '2026-10-05',
            endsOn: '2026-10-05',
            closed: true,
            intervals: [],
            note: 'Inventory',
            source: 'goway',
            verification: 'business_asserted',
            observedAt: '2026-10-01T00:00:00.000Z',
          },
        ],
      },
      MONDAY_NOON,
    );
    expect(summary?.text).toBe('Closed today · Inventory · opens tomorrow 09:00');
  });

  test('says nothing without a zone, rather than guessing the reader’s', () => {
    expect(openingSummary({ openingHours: WEEKDAYS }, MONDAY_NOON)).toBeNull();
  });
});

describe('the week and its exceptions', () => {
  test('reads Monday first, closed days included', () => {
    expect(
      weeklySchedule({ openingHours: WEEKDAYS })?.map((row) => `${row.day} ${row.text}`),
    ).toEqual([
      'Mon 09:00–20:00',
      'Tue 09:00–20:00',
      'Wed 09:00–20:00',
      'Thu 09:00–20:00',
      'Fri 09:00–20:00',
      'Sat Closed',
      'Sun Closed',
    ]);
    expect(weeklySchedule({})).toBeNull();
  });

  test('lists the fixture museum’s dated exceptions in words', () => {
    const museum = FIXTURE_PLACES_BY_ID.get('gw_museu_picasso');
    const rows = upcomingExceptions(museum ?? {});
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ text: '10:00–15:00', note: 'Reduced hours' });
    expect(rows[1]?.dates).toContain('–');
  });
});

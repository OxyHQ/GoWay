/**
 * The time-of-day scrubber's arithmetic: which instant a slider position and
 * a day offset mean, and what the sun is doing then. Pure, so the rules are
 * tests (`__tests__/timeOfDay.test.ts`), and imported only by the scrubber's
 * own lazy chunk (`components/map/TimeOfDayScrubber.web.tsx`).
 *
 * ## Whose clock
 *
 * The DEVICE's. "Now" is the user's now, and the slider reads in the hours on
 * their own clock. Over a city in another time zone that is still every hour
 * of that city's day — a whole day is a whole day — and the caption says what
 * the sun is doing THERE (its altitude over the map centre), which is the
 * thing the scrubber is for. A timezone lookup from coordinates would need a
 * boundary database in the client; GoWay derives place time zones on the
 * server (`places/timezone.ts`), and a prototype control does not justify
 * shipping one.
 *
 * Slider positions are minutes since LOCAL midnight. They are turned into an
 * instant with `setHours`, so a daylight-saving day is handled by the platform
 * (the 02:30 that does not exist becomes 03:30; the one that happens twice is
 * its first occurrence) rather than by adding minutes to midnight, which would
 * put every later hour of a DST day an hour off its label.
 */

export const MINUTES_PER_DAY = 24 * 60;

/** How far either way the date can be stepped, in days: a year round. */
export const MAX_DAY_OFFSET = 183;

/** Minutes since local midnight of `date`, in `[0, 1440)`. */
export function minutesOfDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * The instant `dayOffset` days after `base`'s local date, at `minutes` since
 * that day's local midnight. `minutes` is clamped to the day; `dayOffset` to
 * {@link MAX_DAY_OFFSET}.
 */
export function scrubbedInstant(base: Date, minutes: number, dayOffset: number): Date {
  const at = new Date(base.getTime());
  const offset = Math.max(-MAX_DAY_OFFSET, Math.min(MAX_DAY_OFFSET, Math.round(dayOffset)));
  at.setDate(at.getDate() + offset);
  const m = Math.max(0, Math.min(MINUTES_PER_DAY - 1, Math.round(minutes)));
  at.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return at;
}

/** Whole local days from `base`'s date to `at`'s (DST-safe: compares calendar dates). */
export function dayOffsetBetween(base: Date, at: Date): number {
  const a = Date.UTC(base.getFullYear(), base.getMonth(), base.getDate());
  const b = Date.UTC(at.getFullYear(), at.getMonth(), at.getDate());
  return Math.round((b - a) / 86_400_000);
}

/** What the sun is doing, by its altitude: the scrubber's caption. */
export type SunPhase = 'day' | 'golden' | 'civil' | 'nautical' | 'night';

/**
 * The phase for a sun `altitudeDeg` above the horizon. Boundaries are the
 * conventional ones: golden hour below 6° up, civil twilight to −6°, nautical
 * to −12°; past that it is night as far as a map can tell.
 */
export function sunPhase(altitudeDeg: number): SunPhase {
  if (!Number.isFinite(altitudeDeg)) return 'night';
  if (altitudeDeg >= 6) return 'day';
  if (altitudeDeg >= -0.833) return 'golden';
  if (altitudeDeg >= -6) return 'civil';
  if (altitudeDeg >= -12) return 'nautical';
  return 'night';
}

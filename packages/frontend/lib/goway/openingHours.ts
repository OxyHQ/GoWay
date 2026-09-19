/**
 * "Open now?", evaluated honestly.
 *
 * `OpeningHours` carries local wall-clock `HH:mm` intervals plus the place's
 * IANA timezone, and the contract says the timezone is "required to evaluate
 * `intervals`" — a place does not change its opening hours when the reader
 * travels. So this module refuses to answer without one: an `unknown` state is
 * a correct answer, and "Open" computed in the reader's timezone is a wrong one
 * that looks exactly like a right one.
 *
 * Issue #7 → Place details: "Avoid showing fields that are absent merely to
 * imitate Google Maps density." The `unknown` state is how a caller knows to
 * render nothing at all.
 */
import type { OpeningHours, OpeningHoursInterval } from '@goway.to/sdk';

export type OpeningState =
  | { state: 'unknown' }
  | { state: 'open'; closesAt: string }
  | { state: 'closed'; opensAt?: string };

const MINUTES_PER_DAY = 1440;

function toMinutes(time: string): number | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function formatMinutes(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(wrapped / 60);
  return `${String(hours).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/**
 * The day-of-week (0 = Sunday) and minute-of-day in a given IANA timezone.
 *
 * `Intl` with an explicit `timeZone` is the only correct way to do this, and it
 * is not universally available (a Hermes build without full-icu, an exotic
 * zone name). A failure returns `null`, which becomes `unknown` upstream rather
 * than a silently wrong answer in the device's own timezone.
 */
function nowInZone(timezone: string, now: Date): { day: number; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);

    const lookup = (type: Intl.DateTimeFormatPartTypes) =>
      parts.find((part) => part.type === type)?.value;

    const weekday = lookup('weekday');
    const hour = lookup('hour');
    const minute = lookup('minute');
    if (!weekday || !hour || !minute) return null;

    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
    if (day < 0) return null;

    // `hour12: false` yields "24" for midnight in some ICU versions.
    const hours = Number(hour) % 24;
    return { day, minute: hours * 60 + Number(minute) };
  } catch {
    return null;
  }
}

/**
 * Expand one interval into absolute minute offsets from the start of Sunday,
 * splitting an interval that crosses midnight into the two days it occupies.
 *
 * The contract allows `closes <= opens` to mean "crosses midnight", which is
 * how a bar open 20:00–02:00 is expressed. Evaluating that comparison
 * numerically without the split reports the bar shut for its entire trading
 * night.
 */
function expand(interval: OpeningHoursInterval): Array<{ start: number; end: number }> {
  const opens = toMinutes(interval.opens);
  const closes = toMinutes(interval.closes);
  if (opens == null || closes == null) return [];

  const base = interval.day * MINUTES_PER_DAY;
  if (closes > opens) return [{ start: base + opens, end: base + closes }];
  // Crosses midnight (or is a 24h interval spelled `00:00`–`00:00`).
  return [{ start: base + opens, end: base + opens + (MINUTES_PER_DAY - opens + closes) }];
}

const WEEK_MINUTES = 7 * MINUTES_PER_DAY;

/**
 * Whether the place is open right now, and when that changes.
 *
 * Returns `unknown` when there are no intervals, no timezone, or the timezone
 * cannot be evaluated on this device.
 */
export function evaluateOpeningHours(hours: OpeningHours | undefined, now: Date = new Date()): OpeningState {
  if (!hours || hours.intervals.length === 0 || !hours.timezone) return { state: 'unknown' };

  const local = nowInZone(hours.timezone, now);
  if (!local) return { state: 'unknown' };

  const minute = local.day * MINUTES_PER_DAY + local.minute;
  const spans = hours.intervals.flatMap(expand);
  if (spans.length === 0) return { state: 'unknown' };

  for (const span of spans) {
    // A span may run past the end of the week; compare against both the plain
    // minute and the same minute one week later so Saturday-night-into-Sunday
    // is covered.
    if ((minute >= span.start && minute < span.end) ||
        (minute + WEEK_MINUTES >= span.start && minute + WEEK_MINUTES < span.end)) {
      return { state: 'open', closesAt: formatMinutes(span.end) };
    }
  }

  let next: number | null = null;
  for (const span of spans) {
    const delta = span.start >= minute ? span.start - minute : span.start + WEEK_MINUTES - minute;
    if (next == null || delta < next) next = delta;
  }
  // Only volunteer the next opening when it is close enough to be actionable;
  // "opens in 5 days" is trivia dressed as help.
  if (next != null && next <= MINUTES_PER_DAY) {
    return { state: 'closed', opensAt: formatMinutes(minute + next) };
  }
  return { state: 'closed' };
}

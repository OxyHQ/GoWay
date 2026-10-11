/**
 * Opening hours, put into words.
 *
 * WHETHER a place is open is not decided here: `openingStatusAt` from the SDK
 * is the one evaluation — the GoWay API and every partner use the same one —
 * and it answers `unknown` without the place's timezone rather than guessing
 * the reader's. This module only says what that answer is, what the week looks
 * like, and which dated exceptions are coming.
 *
 * Issue #7 → Place details: "Avoid showing fields that are absent merely to
 * imitate Google Maps density." Every function returns `null` (or an empty
 * list) for a place with nothing to say.
 */
import { openingStatusAt, type OpeningStatus, type Place, type TimeRange } from '@goway.to/sdk';

/** The app's chrome is English; Monday first, as a week is read in Europe. */
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function weekdayOf(date: string): string {
  return DAY_NAMES[new Date(`${date}T00:00:00Z`).getUTCDay()] ?? '';
}

/** `2026-12-25` → `25 Dec`. */
function shortDate(date: string): string {
  const [, month, day] = date.split('-');
  return `${Number(day)} ${MONTH_NAMES[Number(month) - 1] ?? ''}`;
}

/** `10:00–14:00, 17:00–20:00`; a whole day reads as such. */
function rangesText(ranges: readonly TimeRange[]): string {
  return ranges
    .map((range) =>
      range.opens === range.closes ? 'Open 24 hours' : `${range.opens}–${range.closes}`,
    )
    .join(', ');
}

/** When a change happens, relative to the place's today: `20:00`, `tomorrow 09:00`, `Mon 09:00`. */
function whenText(status: Extract<OpeningStatus, { localDate: string }>): string | null {
  const change = status.nextChange;
  if (!change) return null;
  const days = daysBetween(status.localDate, change.localDate);
  if (days === 0) return change.localTime;
  if (days === 1) return `tomorrow ${change.localTime}`;
  return `${weekdayOf(change.localDate)} ${change.localTime}`;
}

export interface OpeningSummary {
  state: 'open' | 'closed';
  /** "Open · closes 20:00", "Closed today · Christmas", "Closed · opens Mon 09:00". */
  text: string;
  /** The same, as a sentence for a screen reader. */
  spoken: string;
}

/** The one line a place card or a result row shows, or `null` when GoWay cannot say. */
export function openingSummary(
  place: Pick<Place, 'openingHours' | 'timezone' | 'hoursExceptions'>,
  now: Date = new Date(),
): OpeningSummary | null {
  const status = openingStatusAt(place, now);
  if (status.state === 'unknown') return null;
  const when = whenText(status);
  const note = status.exception?.note;

  if (status.state === 'open') {
    const special = status.exception ? 'Special hours' : 'Open';
    return {
      state: 'open',
      text: when ? `${special} · closes ${when}` : `${special} · 24 hours`,
      spoken: when ? `Open now, closes ${when}` : 'Open now, around the clock',
    };
  }
  const closed = status.exception?.closed ? `Closed today${note ? ` · ${note}` : ''}` : 'Closed';
  return {
    state: 'closed',
    text: when ? `${closed} · opens ${when}` : closed,
    spoken: when ? `Closed now, opens ${when}` : 'Closed now',
  };
}

export interface ScheduleRow {
  day: string;
  text: string;
}

/** The ordinary week, Monday first, or `null` when GoWay holds no readable schedule. */
export function weeklySchedule(place: Pick<Place, 'openingHours'>): ScheduleRow[] | null {
  const intervals = place.openingHours?.intervals ?? [];
  if (intervals.length === 0) return null;
  return WEEK_ORDER.map((day) => {
    const ranges = intervals.filter((interval) => interval.day === day);
    return { day: DAY_NAMES[day], text: ranges.length > 0 ? rangesText(ranges) : 'Closed' };
  });
}

export interface ExceptionRow {
  id: string;
  /** `25 Dec`, or `24 Dec – 6 Jan` for a range. */
  dates: string;
  /** `Closed`, or the special hours. */
  text: string;
  note: string | null;
}

/** The dated exceptions the place publishes, earliest first, in words. */
export function upcomingExceptions(place: Pick<Place, 'hoursExceptions'>): ExceptionRow[] {
  return (place.hoursExceptions ?? []).map((exception) => ({
    id: exception.id,
    dates:
      exception.startsOn === exception.endsOn
        ? shortDate(exception.startsOn)
        : `${shortDate(exception.startsOn)} – ${shortDate(exception.endsOn)}`,
    text: exception.closed ? 'Closed' : rangesText(exception.intervals),
    note: exception.note ?? null,
  }));
}

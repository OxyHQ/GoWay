/**
 * Opening hours: the weekly schedule, the dated exceptions to it, and the one
 * function that answers "is it open now, and until when".
 *
 * ## Three facts, kept apart
 *
 * - **The weekly schedule** (`Place.openingHours`) — local wall-clock intervals
 *   per weekday, plus the source's raw expression. What a place does in an
 *   ordinary week.
 * - **The timezone** (`Place.timezone`) — the IANA zone the schedule is read
 *   in. A property of WHERE the place is, so GoWay derives it from the
 *   position rather than trusting each writer to send it; it used to ride
 *   inside the schedule, where a schedule written without one could never be
 *   evaluated.
 * - **Exceptions** (`Place.hoursExceptions`) — a dated range that is closed,
 *   or open on special hours: a holiday, a refit, a festival late night. Each
 *   carries the verification tier and freshness a capability does, because
 *   "closed on the 26th" is a claim somebody makes with some strength.
 *
 * ## One evaluation, in the contract
 *
 * {@link openingStatusAt} is shared by the GoWay API, the SDK and the app, so
 * "open now" cannot mean one thing on the map and another in a partner's
 * listing. It refuses to answer without a timezone: `unknown` is a correct
 * answer, and "open" computed in the reader's zone is a wrong one that looks
 * exactly like a right one.
 */

import { z } from 'zod';
import { CAPABILITY_VERIFICATIONS, type CapabilityVerification } from './capability-registry';
import { cursorSchema, limitSchema, pageSchema } from './pagination';
import { instantSchema } from './time';

/** A local 24-hour wall-clock time, `HH:mm`. */
export const clockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be a local 24-hour time, HH:mm');

/**
 * An opening span within one day, local wall-clock.
 *
 * `closes <= opens` means the span crosses midnight — a bar open 20:00–02:00 —
 * and `00:00`–`00:00` is the whole day.
 */
export const timeRangeSchema = z.object({
  opens: clockTimeSchema,
  closes: clockTimeSchema,
});
export type TimeRange = z.infer<typeof timeRangeSchema>;

/** One interval of a weekly schedule. `day` is 0 = Sunday through 6 = Saturday. */
export const openingHoursIntervalSchema = timeRangeSchema.extend({
  day: z.literal([0, 1, 2, 3, 4, 5, 6]),
});
export type OpeningHoursInterval = z.infer<typeof openingHoursIntervalSchema>;

/**
 * A weekly schedule plus the raw source expression it came from.
 *
 * `intervals` empty with a `raw` is how a schedule GoWay could not read is
 * published: the source's own words, and no claim about when it is open.
 */
export const openingHoursSchema = z.object({
  intervals: z.array(openingHoursIntervalSchema),
  /** The source's own unparsed expression (e.g. an OSM `opening_hours` string). */
  raw: z.string().optional(),
});
export type OpeningHours = z.infer<typeof openingHoursSchema>;

export const MAX_WEEKLY_HOURS_INTERVALS = 64;

export const openingHoursInputSchema = z.object({
  intervals: z.array(openingHoursIntervalSchema).max(MAX_WEEKLY_HOURS_INTERVALS),
  raw: z.string().max(512).optional(),
});

/** Replace the intervals OPENING on this weekday; an empty list closes that day. */
export const openingHoursDayPatchSchema = z.object({
  day: openingHoursIntervalSchema.shape.day,
  intervals: z.array(timeRangeSchema).max(MAX_WEEKLY_HOURS_INTERVALS),
});
export type OpeningHoursDayPatch = z.infer<typeof openingHoursDayPatchSchema>;

/** Atomic weekday replacements, never an inferred full-week schedule. */
export const openingHoursDaysPatchSchema = z.array(openingHoursDayPatchSchema).min(1).max(7)
  .refine((days) => new Set(days.map(({ day }) => day)).size === days.length, {
    message: 'each weekday may be replaced only once',
  })
  .refine((days) => days.reduce((count, day) => count + day.intervals.length, 0) <= MAX_WEEKLY_HOURS_INTERVALS, {
    message: 'a weekly schedule carries at most 64 intervals',
  })
  .describe('Atomic replacements of unique opening weekdays (0 Sunday to 6 Saturday). Empty intervals close a day. Omitted days remain unchanged. Mutually exclusive with openingHours. Unknown schedules require all seven days, otherwise conflict. The resulting week may contain at most 64 intervals.');

/** An IANA timezone name as a response publishes it: `Europe/Madrid`. */
export const timezoneSchema = z.string().min(1).max(64);

// ── Exceptions ──────────────────────────────────────────────────────────────

/** A local calendar date, `YYYY-MM-DD`, in the place's own calendar. */
export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date, YYYY-MM-DD')
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, 'must be a real calendar date');

/** The longest range one exception may span, in days. A closure longer than a year is a status. */
export const MAX_HOURS_EXCEPTION_DAYS = 366;

/** The most special intervals one exception day carries. */
export const MAX_HOURS_EXCEPTION_INTERVALS = 8;

/** Days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/**
 * A dated exception to the weekly schedule.
 *
 * Dates rather than instants: "closed on the 26th" is said in the shop's own
 * calendar, and an instant would make its meaning depend on who read it back.
 * `endsOn` is inclusive — a one-day closure has `startsOn === endsOn`.
 */
export const placeHoursExceptionSchema = z.object({
  id: z.string().min(1),
  placeId: z.string().min(1),
  startsOn: localDateSchema,
  /** Inclusive. */
  endsOn: localDateSchema,
  /** Closed for the whole range. When `false`, `intervals` are the hours on each day of it. */
  closed: z.boolean(),
  intervals: z.array(timeRangeSchema),
  note: z.string().optional(),
  /** Who says so — `goway` for anything written through this API. */
  source: z.string().min(1),
  verification: z.enum(CAPABILITY_VERIFICATIONS),
  /** ISO 8601. When this was last asserted. */
  observedAt: instantSchema,
});
export type PlaceHoursException = z.infer<typeof placeHoursExceptionSchema>;

export const placeHoursExceptionPageSchema = pageSchema(placeHoursExceptionSchema);
export type PlaceHoursExceptionPage = z.infer<typeof placeHoursExceptionPageSchema>;

/**
 * The body of `POST /places/{placeId}/hours-exceptions` and of `PUT` on one.
 *
 * `verification` and `source` are absent for the reason they are absent from a
 * capability write — and, as there, DROPPED rather than refused when a caller
 * sends them: the server derives the tier from the caller's approved claims,
 * and an API caller is always `goway`.
 */
export const placeHoursExceptionInputSchema = z
  .object({
    startsOn: localDateSchema,
    /** Inclusive. Defaults to `startsOn`: a one-day exception. */
    endsOn: localDateSchema.optional(),
    closed: z.boolean(),
    /** Required when `closed` is false, refused when it is true. */
    intervals: z.array(timeRangeSchema).max(MAX_HOURS_EXCEPTION_INTERVALS).optional(),
    note: z.string().trim().min(1).max(280).optional(),
  })
  .refine((input) => input.endsOn === undefined || input.endsOn >= input.startsOn, {
    message: 'endsOn must not be before startsOn',
    path: ['endsOn'],
  })
  .refine((input) => input.endsOn === undefined || daysBetween(input.startsOn, input.endsOn) < MAX_HOURS_EXCEPTION_DAYS, {
    message: `an exception spans at most ${MAX_HOURS_EXCEPTION_DAYS} days`,
    path: ['endsOn'],
  })
  .refine((input) => (input.closed ? (input.intervals ?? []).length === 0 : (input.intervals ?? []).length > 0), {
    message: 'a closed exception has no intervals, and an open one needs them',
    path: ['intervals'],
  });
export type PlaceHoursExceptionInput = z.input<typeof placeHoursExceptionInputSchema>;

/** The most exceptions one page returns. */
export const MAX_HOURS_EXCEPTION_LIST_LIMIT = 100;
export const DEFAULT_HOURS_EXCEPTION_LIST_LIMIT = 50;

/** `GET /places/{placeId}/hours-exceptions` — earliest first, keyset-paged by start date. */
export const hoursExceptionListQuerySchema = z
  .object({
    limit: limitSchema(MAX_HOURS_EXCEPTION_LIST_LIMIT, DEFAULT_HOURS_EXCEPTION_LIST_LIMIT),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type HoursExceptionListQuery = z.input<typeof hoursExceptionListQuerySchema>;

// ── "Open now" ──────────────────────────────────────────────────────────────

const MINUTES_PER_DAY = 1_440;
/** How many days ahead a next change is looked for. A week covers every weekly schedule. */
const HORIZON_DAYS = 7;

/** When the state next changes, both as an instant and as the place's own clock reads it. */
export interface OpeningChange {
  /** ISO 8601 instant. */
  at: string;
  /** The place's local date of the change, `YYYY-MM-DD`. */
  localDate: string;
  /** The place's local time of the change, `HH:mm`. */
  localTime: string;
}

export type OpeningStatus =
  | { state: 'unknown' }
  | {
      state: 'open' | 'closed';
      /** Today's date in the place's own calendar. */
      localDate: string;
      /** Absent when nothing changes within a week (`24/7`), or when the next change cannot be known. */
      nextChange?: OpeningChange;
      /** The exception deciding today, when one does. */
      exception?: PlaceHoursException;
    };

/** What {@link openingStatusAt} reads: any `Place` will do. */
export interface OpeningFacts {
  openingHours?: OpeningHours | undefined;
  timezone?: string | undefined;
  hoursExceptions?: readonly PlaceHoursException[] | undefined;
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

function clockOf(minutes: number): string {
  const wrapped = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** `date` moved by `days`, both `YYYY-MM-DD`. Calendar arithmetic, so no zone is involved. */
function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * The local date and minute-of-day at `now` in `timezone`, or `null` when this
 * runtime cannot evaluate the zone (a Hermes build without full ICU, a name
 * the tz database does not know). `null` becomes `unknown`, never an answer in
 * the device's own zone.
 */
function localClock(timezone: string, now: Date): { date: string; minute: number } | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((entry) => entry.type === type)?.value;
    const [year, month, day, hour, minute] = [part('year'), part('month'), part('day'), part('hour'), part('minute')];
    if (!year || !month || !day || !hour || !minute) return null;
    return { date: `${year}-${month}-${day}`, minute: (Number(hour) % 24) * 60 + Number(minute) };
  } catch {
    return null;
  }
}

/**
 * The exception that decides a date: strongest verification tier first, then
 * the freshest — the same ranking a capability's strongest assertion uses.
 */
function exceptionOn(date: string, exceptions: readonly PlaceHoursException[]): PlaceHoursException | undefined {
  let decisive: PlaceHoursException | undefined;
  for (const exception of exceptions) {
    if (exception.startsOn > date || exception.endsOn < date) continue;
    if (
      decisive === undefined ||
      tierOf(exception.verification) > tierOf(decisive.verification) ||
      (exception.verification === decisive.verification && Date.parse(exception.observedAt) > Date.parse(decisive.observedAt))
    ) {
      decisive = exception;
    }
  }
  return decisive;
}

function tierOf(verification: CapabilityVerification): number {
  return CAPABILITY_VERIFICATIONS.indexOf(verification);
}

/** One open span in minutes from today's local midnight. */
interface Span {
  start: number;
  end: number;
}

/**
 * Whether a place is open at `now`, and when that next changes.
 *
 * Each local day from yesterday to a week out is read from its exception when
 * one covers it and from the weekly schedule otherwise; a span that crosses
 * midnight carries into the next day, and touching spans merge, so `24/7`
 * reads as open with no change rather than as a closure at every midnight.
 *
 * `unknown` without a timezone, without any schedule for today, or when the
 * zone cannot be evaluated. A next change past a day GoWay knows nothing about
 * is left out rather than guessed.
 *
 * The instant in `nextChange.at` is `now` plus the wall-clock distance, so it
 * is off by the shift when a daylight-saving change falls between the two.
 */
export function openingStatusAt(facts: OpeningFacts, now: Date = new Date()): OpeningStatus {
  if (!facts.timezone) return { state: 'unknown' };
  const clock = localClock(facts.timezone, now);
  if (!clock) return { state: 'unknown' };

  const weekly = facts.openingHours?.intervals ?? [];
  const exceptions = facts.hoursExceptions ?? [];

  const spans: Span[] = [];
  /** The first day offset GoWay knows nothing about; spans stop there. */
  let knownUntil = HORIZON_DAYS + 1;
  let todayException: PlaceHoursException | undefined;
  for (let offset = -1; offset <= HORIZON_DAYS; offset += 1) {
    const date = addDays(clock.date, offset);
    const exception = exceptionOn(date, exceptions);
    if (offset === 0) todayException = exception;
    let ranges: readonly TimeRange[];
    if (exception) {
      ranges = exception.closed ? [] : exception.intervals;
    } else if (weekly.length > 0) {
      const weekday = weekdayOf(date);
      ranges = weekly.filter((interval) => interval.day === weekday);
    } else {
      // Yesterday unknown only loses a span carried past midnight; today
      // unknown is no answer at all.
      if (offset === 0) return { state: 'unknown' };
      if (offset > 0) knownUntil = Math.min(knownUntil, offset);
      continue;
    }
    if (offset >= knownUntil) continue;
    const base = offset * MINUTES_PER_DAY;
    for (const range of ranges) {
      const opens = minutesOf(range.opens);
      const closes = minutesOf(range.closes);
      spans.push({ start: base + opens, end: base + (closes > opens ? closes : closes + MINUTES_PER_DAY) });
    }
  }

  spans.sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }

  const horizon = knownUntil * MINUTES_PER_DAY;
  const change = (minute: number): OpeningChange | undefined => {
    if (minute >= horizon) return undefined;
    const startOfMinute = now.getTime() - (now.getTime() % 60_000);
    return {
      at: new Date(startOfMinute + (minute - clock.minute) * 60_000).toISOString(),
      localDate: addDays(clock.date, Math.floor(minute / MINUTES_PER_DAY)),
      localTime: clockOf(minute),
    };
  };

  const current = merged.find((span) => span.start <= clock.minute && clock.minute < span.end);
  const status: OpeningStatus = current
    ? { state: 'open', localDate: clock.date }
    : { state: 'closed', localDate: clock.date };
  const next = current ? change(current.end) : change(merged.find((span) => span.start > clock.minute)?.start ?? horizon);
  if (next) status.nextChange = next;
  if (todayException) status.exception = todayException;
  return status;
}

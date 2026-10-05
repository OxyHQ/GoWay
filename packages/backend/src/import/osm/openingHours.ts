/**
 * OpenStreetMap `opening_hours` → GoWay's weekly schedule.
 *
 * ## Behind an interface, and deliberately a subset
 *
 * {@link OpeningHoursParser} is the boundary: the importer asks for a schedule
 * and gets the contract's `OpeningHours`, never a library's object. What sits
 * behind it is a parser for the part of the OSM syntax that IS a weekly
 * schedule — weekday ranges, time ranges, `off`, `24/7`, later rules
 * overriding earlier ones — which covers the great majority of tagged shops and
 * restaurants.
 *
 * The full grammar (opening_hours.js) was considered and not taken. It is an
 * evaluator rather than a parser — it answers "open at this instant" against
 * public-holiday and school-holiday calendars it needs a country for — and it
 * brings those calendars with it. GoWay stores a WEEK and evaluates it with the
 * contract's own `openingStatusAt`, so what it needs from a source is a week or
 * nothing.
 *
 * ## Refuse rather than guess
 *
 * Anything outside the subset — month and date ranges, week numbers, `sunrise`,
 * open-ended `18:00+`, `||` fallbacks, comments — produces NO intervals and
 * keeps the raw expression, which is how the contract publishes "the source
 * said something GoWay could not read". A schedule that is right for the
 * summer and wrong for the winter, shown as today's hours, is worse than none.
 *
 * Public holidays are the one deliberate loss: `PH off` and the `PH` in
 * `Su,PH 10:00-14:00` are dropped, because a holiday is a dated exception and
 * not part of a week. The weekly schedule that remains is exactly right on
 * every ordinary day, and the raw expression still says the rest.
 */

import type { OpeningHours, OpeningHoursInterval } from '@goway/contracts';

/** Turns a source's expression into the contract's schedule. */
export interface OpeningHoursParser {
  parse(raw: string): OpeningHours;
}

type Day = OpeningHoursInterval['day'];

/** OSM's weekday abbreviations, Sunday first to match the contract's `day`. */
const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'] as const;
const ALL_DAYS: readonly Day[] = [0, 1, 2, 3, 4, 5, 6];

/** A sentinel for "this is outside the subset". */
class Unreadable extends Error {}

function dayOf(token: string): Day {
  const index = (WEEKDAYS as readonly string[]).indexOf(token.toLowerCase());
  if (index < 0) throw new Unreadable(token);
  return index as Day;
}

/** `Mo-Fr,Su` → `[1,2,3,4,5,0]`, with `PH` dropped. `Fr-Mo` wraps. */
function daysOf(selector: string): Day[] {
  const days: Day[] = [];
  for (const item of selector.split(',')) {
    const token = item.trim();
    if (token.toUpperCase() === 'PH') continue;
    const range = /^([A-Za-z]{2})-([A-Za-z]{2})$/.exec(token);
    if (range) {
      const from = dayOf(range[1] as string);
      const to = dayOf(range[2] as string);
      for (let day = from; ; day = ((day + 1) % 7) as Day) {
        days.push(day);
        if (day === to) break;
      }
      continue;
    }
    days.push(dayOf(token));
  }
  return days;
}

/** `09:00` → 540. Hours up to 48 are legal OSM (`22:00-26:00` ends at 02:00). */
function minutesOf(time: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time);
  if (!match) throw new Unreadable(time);
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 48 || minutes > 59) throw new Unreadable(time);
  return hours * 60 + minutes;
}

function clockOf(minutes: number): string {
  const wrapped = minutes % 1_440;
  return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
}

/** `09:00-13:00,16:00-20:00` → contract ranges. A range of a day or more is the whole day. */
function rangesOf(selector: string): { opens: string; closes: string }[] {
  return selector.split(',').map((item) => {
    const range = /^(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/.exec(item.trim());
    if (!range) throw new Unreadable(item);
    const opens = minutesOf(range[1] as string);
    const closes = minutesOf(range[2] as string);
    if (opens >= 1_440 || closes === opens) throw new Unreadable(item);
    if (closes - opens >= 1_440) return { opens: clockOf(opens), closes: clockOf(opens) };
    return { opens: clockOf(opens), closes: clockOf(closes) };
  });
}

/**
 * One `;`-separated rule: an optional weekday selector, then a time selector,
 * `off`/`closed`, or nothing (the whole day). `null` for a rule that only
 * names public holidays, which the week does not carry.
 */
function ruleOf(rule: string): { days: Day[]; ranges: { opens: string; closes: string }[] } | null {
  const match = /^((?:[A-Za-z]{2}(?:-[A-Za-z]{2})?)(?:\s*,\s*[A-Za-z]{2}(?:-[A-Za-z]{2})?)*)?\s*(.*)$/.exec(rule);
  if (!match) throw new Unreadable(rule);
  const selector = match[1]?.replace(/\s+/g, '');
  const rest = (match[2] ?? '').trim();

  const days = selector === undefined ? [...ALL_DAYS] : daysOf(selector);
  if (days.length === 0) return null;

  if (rest === '') return { days, ranges: [{ opens: '00:00', closes: '00:00' }] };
  if (/^(off|closed)$/i.test(rest)) return { days, ranges: [] };
  return { days, ranges: rangesOf(rest.replace(/\s+/g, '')) };
}

/**
 * The subset parser.
 *
 * Rules apply in order and a later rule REPLACES the days it names — OSM's own
 * semantics, so `Mo-Sa 09:00-20:00; Sa 10:00-14:00` is Saturday 10–14.
 */
export const osmOpeningHoursParser: OpeningHoursParser = {
  parse(raw) {
    const expression = raw.trim();
    try {
      if (expression.length === 0 || /["|]/.test(expression)) throw new Unreadable(expression);
      const week = new Map<Day, { opens: string; closes: string }[]>();
      if (expression === '24/7') {
        for (const day of ALL_DAYS) week.set(day, [{ opens: '00:00', closes: '00:00' }]);
      } else {
        for (const part of expression.split(';')) {
          const text = part.trim();
          if (text.length === 0) continue;
          const rule = ruleOf(text);
          if (rule === null) continue;
          for (const day of rule.days) week.set(day, rule.ranges);
        }
      }
      const intervals: OpeningHoursInterval[] = [];
      for (const day of ALL_DAYS) {
        for (const range of week.get(day) ?? []) intervals.push({ day, ...range });
      }
      return { intervals, raw: expression };
    } catch (error) {
      if (error instanceof Unreadable) return { intervals: [], raw: expression };
      throw error;
    }
  },
};

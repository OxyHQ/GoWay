/**
 * The small subset of OSM `opening_hours` a zone's schedule is written in:
 * `24/7`, or rules of weekdays and times, `Mo-Fr 07:00-20:00; Sa 09:00-14:00`.
 *
 * Anything else — week numbers, months, sunrise, comments, "off" for a named
 * weekday — is NOT guessed at: it returns `null` and the caller says the
 * schedule is unknown. Public- and school-holiday clauses (`PH off`) are
 * recognised and ignored, and reported, because dropping them can only make a
 * zone look in force on a day it is not — the cautious error for a driver — and
 * says so in the returned `holidaysIgnored`.
 */

import type { OpeningHours } from '@goway/contracts';

const DAYS = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'] as const;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

function daysOf(spec: string): number[] | null {
  const days = new Set<number>();
  for (const part of spec.split(',')) {
    const range = /^([A-Z][a-z])(?:-([A-Z][a-z]))?$/.exec(part.trim());
    if (!range) return null;
    const from = DAYS.indexOf(range[1] as (typeof DAYS)[number]);
    const to = range[2] ? DAYS.indexOf(range[2] as (typeof DAYS)[number]) : from;
    if (from < 0 || to < 0) return null;
    // Weeks start on Monday in OSM: `Fr-Mo` wraps through the weekend.
    for (let d = from; ; d = (d + 1) % 7) {
      days.add(d);
      if (d === to) break;
    }
  }
  return [...days].sort((a, b) => a - b);
}

export function parseOsmHours(
  raw: string,
): { hours: OpeningHours; holidaysIgnored: boolean } | null {
  const text = raw.trim();
  if (text === '24/7') {
    return {
      hours: {
        raw: text,
        intervals: [0, 1, 2, 3, 4, 5, 6].map((day) => ({
          day: day as 0,
          opens: '00:00',
          closes: '00:00',
        })),
      },
      holidaysIgnored: false,
    };
  }
  const intervals: OpeningHours['intervals'] = [];
  let holidaysIgnored = false;
  for (const clause of text.split(';')) {
    const rule = clause.trim();
    if (rule === '') continue;
    if (/^(PH|SH)(,(PH|SH))?\s+off$/.test(rule)) {
      holidaysIgnored = true;
      continue;
    }
    const match =
      /^([A-Za-z,-]+)\s+(\d{2}:\d{2}-\d{2}:\d{2}(?:,\s*\d{2}:\d{2}-\d{2}:\d{2})*)$/.exec(rule);
    if (!match) return null;
    const days = daysOf(match[1] as string);
    if (!days) return null;
    for (const span of (match[2] as string).split(',')) {
      const [opens, closes] = span.trim().split('-') as [string, string];
      if (!TIME.test(opens) || !TIME.test(closes)) return null;
      for (const day of days) intervals.push({ day: day as 0, opens, closes });
    }
  }
  if (intervals.length === 0) return null;
  return { hours: { raw: text, intervals }, holidaysIgnored };
}

/**
 * The nearby-transit answer, turned into what Bloom's `PlaceTransit` draws.
 *
 * Pure: the clock, the language and the stop's time zone are arguments, so the
 * rules that matter are tested without React.
 *
 *  - A `scheduled` time is NEVER drawn as live. Bloom gives a `realtime`
 *    departure a dot, a tone and a spoken "live"; only `basis: 'realtime'`
 *    earns it. A scheduled departure shows its clock time, not a countdown.
 *  - A line's colour is its operator's own `route_color`. Bloom's badge measures
 *    its label against it; a line with no colour stays Bloom's neutral pill.
 *  - Only the operators that contributed a stop are credited, and each credit is
 *    the operator's own text, as the API returned it.
 */
import type { NearbyTransit, TransitDeparture, TransitLine, TransitMode } from '@goway.to/sdk';
import type { TransitLine as BadgeLine } from '@oxy.so/bloom/directions';
import type { PlaceTransitMode, PlaceTransitStop } from '@oxy.so/bloom/place-details';

type Translate = (key: string, values?: Record<string, string | number>) => string;

/** Bloom draws five glyphs; the contract has GTFS's modes. */
const MODE_GLYPH: Record<TransitMode, PlaceTransitMode | undefined> = {
  bus: 'bus',
  tram: 'tram',
  subway: 'metro',
  rail: 'train',
  ferry: 'ferry',
  cable: 'tram',
  // An operator that does not say gets Bloom's default; the line badges still name the lines.
  other: undefined,
};

/** A realtime departure closer than this reads as a countdown. */
const COUNTDOWN_MINUTES = 30;
const MAX_BADGE_CHARS = 24;

export interface TransitCredit {
  operatorId: string;
  attribution: { label: string; href: string };
  licence: { label: string; href: string };
  /**
   * When GoWay last read this operator's data (its predictions when they were
   * applied, else its timetable), spelled for the reader. Some licences ask
   * for the date of the last update next to the credit.
   */
  updated: string | null;
}

export interface TransitView {
  stops: PlaceTransitStop[];
  credits: TransitCredit[];
  /** Whether any drawn departure follows a timetable rather than a prediction. */
  anyScheduled: boolean;
  anyRealtime: boolean;
}

export interface TransitViewOptions {
  nowMs: number;
  /** A BCP 47 tag. */
  locale: string;
  /** The place's IANA zone; the device's when GoWay did not derive one. */
  timeZone?: string | undefined;
  t: Translate;
  /** `lib/goway/format`'s `formatDistance` (injected: that module pulls in the icon set). */
  formatDistance: (meters: number) => string;
}

function badgeName(line: TransitLine): string | null {
  const name = line.shortName ?? line.longName;
  if (!name) return null;
  return name.length > MAX_BADGE_CHARS ? `${name.slice(0, MAX_BADGE_CHARS - 1)}…` : name;
}

function badgeOf(line: TransitLine, headsign?: string | null): BadgeLine | null {
  const name = badgeName(line);
  if (!name) return null;
  return {
    name,
    ...(line.color ? { color: line.color } : {}),
    ...(headsign ? { headsign } : {}),
  };
}

function clock(ms: number, options: TransitViewOptions): string {
  const zone = options.timeZone;
  const format = (timeZone: string | undefined) => {
    const formatter = new Intl.DateTimeFormat(options.locale, {
      hour: '2-digit',
      minute: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    });
    const sameDay = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      ...(timeZone ? { timeZone } : {}),
    });
    const time = formatter.format(ms);
    if (sameDay.format(ms) === sameDay.format(options.nowMs)) return time;
    const weekday = new Intl.DateTimeFormat(options.locale, {
      weekday: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
    return `${weekday} ${time}`;
  };
  try {
    return format(zone);
  } catch {
    // An unknown zone name: the device's own clock beats no time at all.
    return format(undefined);
  }
}

function updatedLabel(iso: string | null, options: TransitViewOptions): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const format = (timeZone: string | undefined) =>
    new Intl.DateTimeFormat(options.locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
      ...(timeZone ? { timeZone } : {}),
    }).format(ms);
  let text: string;
  try {
    text = format(options.timeZone);
  } catch {
    text = format(undefined);
  }
  return options.t('transit.updated', { time: text });
}

/** What a departure's time column says. */
export function departureTime(departure: TransitDeparture, options: TransitViewOptions): string {
  const ms = Date.parse(departure.time);
  if (departure.basis === 'realtime') {
    const minutes = Math.floor((ms - options.nowMs) / 60_000);
    if (minutes < 1) return options.t('transit.now');
    if (minutes <= COUNTDOWN_MINUTES) return options.t('transit.minutes', { count: minutes });
  }
  return clock(ms, options);
}

export function transitView(answer: NearbyTransit, options: TransitViewOptions): TransitView {
  const stops: PlaceTransitStop[] = [];
  const credited = new Set<string>();
  let anyScheduled = false;
  let anyRealtime = false;

  for (const stop of answer.stops) {
    const lineById = new Map(stop.lines.map((line) => [line.id, line]));
    const lines: BadgeLine[] = [];
    for (const line of stop.lines) {
      const badge = badgeOf(line);
      if (badge) lines.push(badge);
    }
    const departures: NonNullable<PlaceTransitStop['departures']>[number][] = [];
    for (const [index, departure] of stop.departures.entries()) {
      const line = lineById.get(departure.lineId);
      const badge = line ? badgeOf(line, departure.headsign) : null;
      if (!badge) continue;
      const realtime = departure.basis === 'realtime';
      if (realtime) anyRealtime = true;
      else anyScheduled = true;
      departures.push({
        id: `${departure.lineId}|${departure.time}|${index}`,
        line: badge,
        ...(departure.headsign ? { headsign: departure.headsign } : {}),
        time: departureTime(departure, options),
        realtime,
      });
    }
    const glyph = MODE_GLYPH[stop.modes[0] ?? 'other'];
    credited.add(stop.operatorId);
    stops.push({
      id: stop.id,
      name: stop.name,
      ...(glyph ? { mode: glyph } : {}),
      distance: options.formatDistance(stop.distanceMeters),
      lines,
      departures,
    });
  }

  const credits = answer.operators
    .filter((operator) => credited.has(operator.id))
    .map((operator) => ({
      operatorId: operator.id,
      attribution: operator.attribution,
      licence: operator.licence,
      updated: updatedLabel(operator.realtimeAt ?? operator.scheduleReadAt, options),
    }));
  return { stops, credits, anyScheduled, anyRealtime };
}

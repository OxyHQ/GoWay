/**
 * Public transport near a point: the stops around it and what leaves them next
 * (`GET /transit/nearby`, `docs/TRANSIT_NEARBY.md`).
 *
 * Every departure says WHERE its time came from: `scheduled` is the operator's
 * published timetable, `realtime` is the operator's own live prediction for
 * that trip. A schedule is never presented as live, and a client must not draw
 * a scheduled departure with a live affordance.
 *
 * Every operator that contributed carries its credit and licence, because the
 * data is only re-served under them; a client shows them whenever it draws a
 * stop.
 *
 * Coverage is an answer, not an error: a point no served operator covers is
 * `{ stops: [], operators: [] }`.
 */

import { z } from 'zod';
import { latitudeSchema, longitudeSchema } from './geo';
import { hexColorSchema, LIVE_TRANSIT_MODES } from './live';
import { liveLinkSchema, liveSourceIdSchema } from './live-source';
import { instantSchema } from './time';

/** The nearest a search may be narrowed to, and the farthest it may reach. */
export const MIN_TRANSIT_RADIUS_METERS = 50;
export const MAX_TRANSIT_RADIUS_METERS = 1000;
export const DEFAULT_TRANSIT_RADIUS_METERS = 400;
export const MAX_TRANSIT_STOPS = 10;
export const DEFAULT_TRANSIT_STOPS = 5;
export const MAX_TRANSIT_DEPARTURES = 10;
export const DEFAULT_TRANSIT_DEPARTURES = 4;

/**
 * `GET /transit/nearby?latitude=&longitude=&radiusMeters=&maxStops=&maxDepartures=`
 *
 * The position is transient request data: it is used for this one answer and
 * never stored or logged. Values outside a bound are `validation_failed`, not
 * silently clamped.
 */
export const nearbyTransitQuerySchema = z
  .object({
    latitude: latitudeSchema,
    longitude: longitudeSchema,
    radiusMeters: z
      .number()
      .int()
      .min(MIN_TRANSIT_RADIUS_METERS)
      .max(MAX_TRANSIT_RADIUS_METERS)
      .default(DEFAULT_TRANSIT_RADIUS_METERS),
    /** The most stops answered, nearest first. */
    maxStops: z.number().int().min(1).max(MAX_TRANSIT_STOPS).default(DEFAULT_TRANSIT_STOPS),
    /** The most departures answered per stop, soonest first. */
    maxDepartures: z
      .number()
      .int()
      .min(1)
      .max(MAX_TRANSIT_DEPARTURES)
      .default(DEFAULT_TRANSIT_DEPARTURES),
  })
  .strict();
export type NearbyTransitQuery = z.input<typeof nearbyTransitQuerySchema>;

/** A mode, in GTFS `route_type` terms (the live layer's own vocabulary). */
export const transitModeSchema = z.enum(LIVE_TRANSIT_MODES);
export type TransitMode = z.infer<typeof transitModeSchema>;

const nameSchema = (max: number) => z.string().trim().min(1).max(max);

/**
 * A line calling at a stop, as its operator publishes it (`routes.txt`). The
 * colours are the operator's OWN: `null` when it publishes none, never a tint
 * GoWay picked.
 */
export const transitLineSchema = z.object({
  /** Opaque; the key departures refer to. Unique within one stop. */
  id: nameSchema(120),
  /** `route_short_name` ("L4", "R2 Nord"); `null` when the operator gives none. */
  shortName: nameSchema(40).nullable(),
  /** `route_long_name`; `null` when absent. */
  longName: nameSchema(160).nullable(),
  mode: transitModeSchema,
  /** `route_color`. */
  color: hexColorSchema.nullable(),
  /** `route_text_color`. */
  textColor: hexColorSchema.nullable(),
});
export type TransitLine = z.infer<typeof transitLineSchema>;

/**
 * Where a departure's time comes from.
 *
 * - `scheduled` — the operator's published timetable for that service day.
 *   Nobody has said the vehicle is on its way.
 * - `realtime` — the operator's own live prediction for this trip at this stop.
 */
export const TRANSIT_DEPARTURE_BASES = ['scheduled', 'realtime'] as const;
export const transitDepartureBasisSchema = z.enum(TRANSIT_DEPARTURE_BASES);
export type TransitDepartureBasis = z.infer<typeof transitDepartureBasisSchema>;

export const transitDepartureSchema = z.object({
  /** The `id` of the entry in the stop's `lines`. */
  lineId: nameSchema(120),
  /** Where the vehicle is going: the trip's headsign, else its last stop; `null` when neither is known. */
  headsign: nameSchema(160).nullable(),
  /** When it leaves this stop (the predicted time when `basis` is `realtime`). */
  time: instantSchema,
  basis: transitDepartureBasisSchema,
  /**
   * Seconds later (positive) or earlier (negative) than the timetable. Present
   * exactly when `basis` is `realtime`.
   */
  delaySeconds: z.number().int().min(-86_400).max(86_400).optional(),
});
export type TransitDeparture = z.infer<typeof transitDepartureSchema>;

export const transitStopSchema = z.object({
  /** Opaque; stable while the operator keeps the stop's id. */
  id: nameSchema(200),
  /** The operator that publishes it: an `id` of `operators`. */
  operatorId: liveSourceIdSchema,
  /** The operator's own name for the stop or station. */
  name: nameSchema(160),
  position: z.object({ latitude: latitudeSchema, longitude: longitudeSchema }),
  /** Metres from the requested point, straight line. */
  distanceMeters: z.number().int().min(0),
  /** The modes of the lines calling here, the mode with the most lines first. */
  modes: z.array(transitModeSchema).min(1),
  /** Every line calling here (at most 24), in the operator's order. */
  lines: z.array(transitLineSchema).max(24),
  /** The next departures, soonest first; empty when nothing is due in the next six hours. */
  departures: z.array(transitDepartureSchema).max(MAX_TRANSIT_DEPARTURES),
});
export type TransitStop = z.infer<typeof transitStopSchema>;

/**
 * Whether an operator's timetable was ready for this answer. A timetable is
 * read from the operator on first use, which takes seconds for a large
 * network: `preparing` means "ask again shortly", and `unavailable` that
 * reading it failed repeatedly (retried with backoff). Neither has stops in
 * `stops`.
 */
export const TRANSIT_OPERATOR_AVAILABILITY = ['ready', 'preparing', 'unavailable'] as const;

/**
 * Whether the operator's live predictions were applied.
 *
 * - `none` — the operator publishes timetables only here.
 * - `live` — its prediction feed answered recently; trips it predicts are
 *   `realtime`, the rest stay `scheduled`.
 * - `unavailable` — it has a prediction feed that is not answering: every
 *   departure is `scheduled`.
 */
export const TRANSIT_REALTIME_STATUSES = ['none', 'live', 'unavailable'] as const;

/** An operator whose data is in this answer, with the terms it is re-served under. */
export const transitOperatorSchema = z.object({
  id: liveSourceIdSchema,
  name: nameSchema(80),
  /** The credit the operator requires, shown whenever its stops are drawn. */
  attribution: liveLinkSchema,
  licence: liveLinkSchema,
  availability: z.enum(TRANSIT_OPERATOR_AVAILABILITY),
  realtime: z.enum(TRANSIT_REALTIME_STATUSES),
  /** When GoWay read the timetable (the operator republishes about daily); `null` while `preparing`. */
  scheduleReadAt: instantSchema.nullable(),
  /** The operator's prediction feed's own timestamp, when `realtime` is `live`. */
  realtimeAt: instantSchema.nullable(),
});
export type TransitOperator = z.infer<typeof transitOperatorSchema>;

/** `GET /transit/nearby` */
export const nearbyTransitSchema = z.object({
  /** Nearest first. */
  stops: z.array(transitStopSchema).max(MAX_TRANSIT_STOPS),
  /** Every operator covering the point, whether or not one of its stops was in range. */
  operators: z.array(transitOperatorSchema),
  /** When this answer was computed; `time`s are relative to it. */
  generatedAt: instantSchema,
});
export type NearbyTransit = z.infer<typeof nearbyTransitSchema>;

/**
 * GoWay Live — the feeds themselves: the kinds of thing they carry, and each
 * source's licence, credit and freshness (`GET /live/sources`).
 *
 * Split from `live.ts` (the entities and the socket protocol) so the HTTP half
 * is all `@goway.to/sdk` itself bundles; the protocol ships in
 * `@goway.to/sdk/live` alone.
 */

import { z } from 'zod';
import { geoBoundingBoxSchema } from './geo';
import { cursorSchema } from './pagination';
import { instantSchema } from './time';

/** Short display text from a feed: trimmed, bounded, never empty. */
const feedText = (max: number) => z.string().trim().min(1).max(max);

/**
 * What a live entity is. Closed: a client draws, toggles and credits per kind.
 *
 * - `aircraft` — an ADS-B/MLAT position report.
 * - `transit` — a public-transport vehicle (a GTFS-Realtime `VehiclePosition`).
 * - `bikeshare` — a bike-share STATION and how many bikes it has. It does not
 *   move; its availability does.
 * - `vessel` — an AIS position report.
 */
export const LIVE_KINDS = ['aircraft', 'transit', 'bikeshare', 'vessel'] as const;
export type LiveKind = (typeof LIVE_KINDS)[number];
export const liveKindSchema = z.enum(LIVE_KINDS);

/** A source id: lower-case, hyphenated, stable (`adsb-lol`, `renfe-cercanias`). */
export const liveSourceIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'must be a live source id');

/** A link a client renders as text: a credit or a licence. */
export const liveLinkSchema = z.object({
  label: feedText(120),
  href: z.string().regex(/^https:\/\//, 'must be an https URL'),
});
export type LiveLink = z.infer<typeof liveLinkSchema>;

/**
 * How a source is doing, as of the server's last look.
 *
 * - `idle` — nobody is looking at its coverage, so it is not being polled.
 *   Nothing is wrong; there is simply nothing to show.
 * - `starting` — being polled, no answer yet.
 * - `live` — answered within its expected interval.
 * - `stale` — the last good answer is older than three intervals.
 * - `unavailable` — failing; the server is backing off.
 */
export const LIVE_SOURCE_STATUSES = ['idle', 'starting', 'live', 'stale', 'unavailable'] as const;
export type LiveSourceStatus = (typeof LIVE_SOURCE_STATUSES)[number];

/** One feed GoWay re-serves, with its terms and freshness. */
export const liveSourceSchema = z.object({
  id: liveSourceIdSchema,
  kind: liveKindSchema,
  /** What it is, for a person (`Aircraft — adsb.lol`). */
  name: feedText(80),
  /** The credit the source requires, shown whenever its data is drawn. */
  attribution: liveLinkSchema,
  /** The licence the data is published under. */
  licence: liveLinkSchema,
  /** Where it has data; `null` for worldwide. */
  coverage: geoBoundingBoxSchema.nullable(),
  /**
   * `network`: every vehicle of its kind in its coverage is in the feed (a
   * whole operator network), so where it is live, nothing of that kind is
   * missing. `partial`: only some operators' or some vehicles — a reader must
   * not assume the rest are shown.
   */
  completeness: z.enum(['network', 'partial']),
  status: z.enum(LIVE_SOURCE_STATUSES),
  /** The last successful answer from the feed. */
  lastUpdatedAt: instantSchema.nullable(),
  /** How often GoWay asks the feed while somebody is looking. */
  pollIntervalSeconds: z.number().int().min(1).max(3600),
  /**
   * An entity whose `observedAt` is older than this is STALE: draw it where it
   * was, faded, and never move it.
   */
  staleAfterSeconds: z.number().int().min(1).max(86_400),
  /** An entity older than this is no longer served at all. */
  dropAfterSeconds: z.number().int().min(1).max(172_800),
  /** Entities currently held from it, across every tile. */
  entityCount: z.number().int().min(0),
});
export type LiveSource = z.infer<typeof liveSourceSchema>;

/** `GET /live/sources` — one page, always: a handful of configured feeds, so `nextCursor` is `null`. */
export const liveSourcePageSchema = z.object({
  items: z.array(liveSourceSchema),
  nextCursor: cursorSchema.nullable(),
});
export type LiveSourcePage = z.infer<typeof liveSourcePageSchema>;

/** A shape id from an operator's static GTFS. Opaque. */
export const liveShapeIdSchema = z.string().min(1).max(120);

/**
 * `GET /live/sources/{sourceId}/shapes/{shapeId}` — one of an operator's
 * published route shapes, as the operator published it: positions
 * `[longitude, latitude]` in order of travel, and the running length.
 */
export const liveShapeSchema = z.object({
  sourceId: liveSourceIdSchema,
  id: liveShapeIdSchema,
  coordinates: z
    .array(z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]))
    .min(2),
  /** Metres along the shape at each position; same length as `coordinates`. */
  alongMeters: z.array(z.number().min(0)).min(2),
  lengthMeters: z.number().min(0),
});
export type LiveShape = z.infer<typeof liveShapeSchema>;

/** `{sourceId}/{shapeId}` */
export const liveShapePathSchema = z.object({
  sourceId: liveSourceIdSchema,
  shapeId: liveShapeIdSchema,
});

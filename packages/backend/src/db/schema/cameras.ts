/**
 * Public cameras (`docs/CAMERAS.md`).
 *
 *  - `cameras`             — the catalogue: one row per camera a provider's
 *                            sync has seen, with where it points and what GoWay
 *                            can serve for it.
 *  - `camera_observations` — what the video worker counted in a window:
 *                            aggregates only, never a frame, a face or a plate.
 *
 * ## Providers are code, not rows
 *
 * A provider's licence, credit and freshness windows live in
 * `cameras/providers.ts`, where `licence.test.ts` refuses one without a
 * verified licence. A table of them would be a second copy to drift; a camera
 * carries only its `providerId`, with no foreign key.
 *
 * ## The upstream URL is internal
 *
 * `upstreamUrl` is where GoWay's relay fetches the picture. It is never in a
 * contract: a client asks GoWay (`/cameras/{id}/snapshot`), not the operator.
 *
 * ## Nothing is deleted by a sync that did not finish
 *
 * `retiredAt` is set only when a provider's sync read its whole catalogue and
 * the camera was not in it; a partial read retires nothing (`roadrules/` does
 * the same). A retired camera comes back when it reappears.
 */

import { sql } from 'drizzle-orm';
import {
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { createdAt, inList, timestamptz, updatedAt } from '@oxy.so/db';
import {
  CAMERA_HEALTH,
  CAMERA_KINDS,
  CAMERA_MEDIA_KINDS,
  CONGESTION_LEVELS,
  type ObservedClass,
} from '@goway/contracts';
import { closedSet, generatedGeographyPoint } from './columns';

export const cameras = pgTable(
  'cameras',
  {
    /** Stable and lower-case: `<providerId>.<sourceId>`. Never reused for another camera. */
    id: text().primaryKey(),
    providerId: text().notNull(),
    /** The provider's own id for the camera; unique within the provider. */
    sourceId: text().notNull(),
    name: text().notNull(),
    kind: text().notNull(),
    latitude: doublePrecision().notNull(),
    longitude: doublePrecision().notNull(),
    /** The PostGIS point, generated from the pair above (`columns.ts`). */
    geo: generatedGeographyPoint('longitude', 'latitude'),
    /** Degrees clockwise from true north; null when the provider does not say. */
    heading: doublePrecision(),
    roadName: text(),
    mediaKind: text().notNull(),
    mediaRefreshSeconds: integer(),
    mediaWidth: integer(),
    mediaHeight: integer(),
    /** Where the relay fetches the picture or playlist. Never published. */
    upstreamUrl: text().notNull(),
    /** When the newest frame was taken, as far as GoWay has seen; written throttled. */
    lastFrameAt: timestamptz(),
    /** The last sync that listed it. */
    lastSeenAt: timestamptz().notNull().defaultNow(),
    retiredAt: timestamptz(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('cameras_id_check', sql`${table.id} ~ '^[a-z0-9][a-z0-9._-]{2,127}$'`),
    check('cameras_provider_check', sql`${table.providerId} ~ '^[a-z0-9][a-z0-9-]{1,47}$'`),
    check('cameras_name_check', sql`btrim(${table.name}) <> ''`),
    closedSet('cameras_kind_check', table.kind, CAMERA_KINDS),
    closedSet('cameras_media_kind_check', table.mediaKind, CAMERA_MEDIA_KINDS),
    check('cameras_latitude_range_check', sql`${table.latitude} between -90 and 90`),
    check('cameras_longitude_range_check', sql`${table.longitude} between -180 and 180`),
    check(
      'cameras_heading_check',
      sql`${table.heading} is null or (${table.heading} >= 0 and ${table.heading} < 360)`,
    ),
    check(
      'cameras_snapshot_refresh_check',
      sql`(${table.mediaKind} = 'snapshot') = (${table.mediaRefreshSeconds} is not null)`,
    ),
    check('cameras_upstream_url_check', sql`${table.upstreamUrl} ~ '^https?://'`),
    uniqueIndex('cameras_provider_source_uq').on(table.providerId, table.sourceId),
    /** Every viewport read is `ST_Intersects`/`&&` against this. */
    index('cameras_geo_gist').using('gist', table.geo),
  ],
);

export const cameraObservations = pgTable(
  'camera_observations',
  {
    cameraId: text().notNull(),
    windowFrom: timestamptz().notNull(),
    windowTo: timestamptz().notNull(),
    /** `{ car?: n, … }` — distinct things that crossed the counting line. */
    counts: jsonb().notNull().$type<Partial<Record<ObservedClass, number>>>(),
    /** `{ car?: n, … }` — things in frame at the window's end. */
    present: jsonb().notNull().$type<Partial<Record<ObservedClass, number>>>(),
    flowPerMinute: doublePrecision(),
    congestion: text(),
    health: text().notNull(),
    createdAt: createdAt(),
  },
  (table) => [
    // One observation per camera and window end, so a worker's retry is idempotent.
    primaryKey({ columns: [table.cameraId, table.windowTo] }),
    check('camera_observations_window_check', sql`${table.windowFrom} <= ${table.windowTo}`),
    check(
      'camera_observations_counts_check',
      sql`jsonb_typeof(${table.counts}) = 'object' and jsonb_typeof(${table.present}) = 'object'`,
    ),
    check(
      'camera_observations_flow_check',
      sql`${table.flowPerMinute} is null or ${table.flowPerMinute} >= 0`,
    ),
    check(
      'camera_observations_congestion_check',
      sql`${table.congestion} is null or ${table.congestion} in (${sql.raw(inList(CONGESTION_LEVELS))})`,
    ),
    closedSet('camera_observations_health_check', table.health, CAMERA_HEALTH),
    // The newest observations of one camera, which is every read.
    index('camera_observations_recent_idx').on(table.cameraId, table.windowTo.desc()),
    // Retention sweeps by age across cameras.
    index('camera_observations_window_to_idx').on(table.windowTo),
  ],
);

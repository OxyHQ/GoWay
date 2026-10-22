/**
 * Cameras: the reads the API serves and the writes a sync, the relay and the
 * video worker make.
 *
 * Reads return rows; `cameras/view.ts` turns a row into the contract's
 * `Camera` with its provider's credit attached. Lists are keyset-paged by id
 * (a viewport that is re-read must not skip or repeat a camera a sync added in
 * between), and a retired camera is never listed.
 *
 * A sync's writes are idempotent: it upserts by `(providerId, sourceId)`,
 * stamps `lastSeenAt`, and a camera it did not see in a COMPLETE read is
 * retired — never deleted, and it comes back when it reappears.
 */

import { and, asc, desc, eq, gt, gte, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { CameraKind, CameraObservation, GeoBoundingBox } from '@goway/contracts';
import { cameraIdOf } from '../../cameras/normalise';
import type { CameraRecord } from '../../cameras/types';
import type { TimeKeyset } from '../../http/cursor';
import type { Database } from '../postgres';
import { cameraObservations, cameras } from '../schema';

/** Rows per INSERT: well inside Postgres's 65 535-parameter limit at 15 columns. */
const UPSERT_CHUNK = 500;

export interface UpsertReport {
  created: number;
  refreshed: number;
}

/**
 * The widest span, either way, one `geography` envelope may have. At 180° its
 * edge is antipodal and PostGIS refuses ("Antipodal (180 degrees long) edge
 * detected") — a whole-world longitude, or pole to pole in latitude — so a
 * wider box is read as several envelopes.
 */
const MAX_ENVELOPE_DEGREES = 90;

/** `[from, to]` cut into pieces no wider than {@link MAX_ENVELOPE_DEGREES}. */
function slices(from: number, to: number): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  do {
    const end = Math.min(start + MAX_ENVELOPE_DEGREES, to);
    out.push([start, end]);
    start = end;
  } while (start < to);
  return out;
}

/** The longitude intervals a box covers: split at the antimeridian, then into narrow envelopes. */
export function longitudeSpans(box: Pick<GeoBoundingBox, 'west' | 'east'>): [number, number][] {
  return box.west <= box.east
    ? slices(box.west, box.east)
    : [...slices(box.west, 180), ...slices(-180, box.east)];
}

/** Cameras inside a box (honouring `west > east` and any size), index-backed. */
export function withinBox(box: GeoBoundingBox): SQL {
  const envelopes = longitudeSpans(box).flatMap(([west, east]) =>
    slices(box.south, box.north).map(
      ([south, north]) =>
        sql`ST_Intersects(${cameras.geo}, ST_MakeEnvelope(${west}, ${south}, ${east}, ${north}, 4326)::geography)`,
    ),
  );
  return sql`(${sql.join(envelopes, sql` OR `)})`;
}

/**
 * Write every record a source read for one provider. The camera's id is
 * derived (`cameraIdOf`), so re-reading never makes a second row; a camera
 * that had been retired is restored.
 */
export async function upsertCameras(
  db: Database,
  providerId: string,
  records: readonly CameraRecord[],
  now: Date,
): Promise<UpsertReport> {
  const report: UpsertReport = { created: 0, refreshed: 0 };
  for (let offset = 0; offset < records.length; offset += UPSERT_CHUNK) {
    const chunk = records.slice(offset, offset + UPSERT_CHUNK);
    const rows = await db
      .insert(cameras)
      .values(
        chunk.map((record) => ({
          id: cameraIdOf(providerId, record.sourceId),
          providerId,
          sourceId: record.sourceId,
          name: record.name,
          kind: record.kind,
          latitude: record.position.latitude,
          longitude: record.position.longitude,
          heading: record.heading,
          roadName: record.roadName,
          mediaKind: record.media.kind,
          mediaRefreshSeconds: record.media.refreshSeconds,
          mediaWidth: record.media.width,
          mediaHeight: record.media.height,
          upstreamUrl: record.upstreamUrl,
          lastFrameAt: record.frameAt,
          lastSeenAt: now,
        })),
      )
      .onConflictDoUpdate({
        target: [cameras.providerId, cameras.sourceId],
        set: {
          name: sql`excluded.name`,
          kind: sql`excluded.kind`,
          latitude: sql`excluded.latitude`,
          longitude: sql`excluded.longitude`,
          heading: sql`excluded.heading`,
          roadName: sql`excluded.road_name`,
          mediaKind: sql`excluded.media_kind`,
          mediaRefreshSeconds: sql`excluded.media_refresh_seconds`,
          mediaWidth: sql`excluded.media_width`,
          mediaHeight: sql`excluded.media_height`,
          upstreamUrl: sql`excluded.upstream_url`,
          // A catalogue that dates its frames wins; one that does not leaves what the relay saw.
          lastFrameAt: sql`coalesce(excluded.last_frame_at, ${cameras.lastFrameAt})`,
          lastSeenAt: sql`excluded.last_seen_at`,
          retiredAt: sql`null`,
          updatedAt: sql`now()`,
        },
      })
      // `xmax = 0` is true only for a row this statement inserted.
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    for (const row of rows) report[row.inserted ? 'created' : 'refreshed']++;
  }
  return report;
}

/**
 * Retire a provider's cameras that a COMPLETE read did not list: those not
 * seen since `readStartedAt`. Returns their ids.
 */
export async function retireUnseen(
  db: Database,
  providerId: string,
  readStartedAt: Date,
  now: Date,
): Promise<string[]> {
  const rows = await db
    .update(cameras)
    .set({ retiredAt: now, updatedAt: sql`now()` })
    .where(
      and(
        eq(cameras.providerId, providerId),
        isNull(cameras.retiredAt),
        lt(cameras.lastSeenAt, readStartedAt),
      ),
    )
    .returning({ id: cameras.id });
  return rows.map((row) => row.id);
}

export interface CameraFilter {
  box: GeoBoundingBox;
  kind?: CameraKind | undefined;
  /** Only these providers (the ones the registry knows). */
  providerIds: readonly string[];
}

/** Cameras in a box, by id: `limit` rows after `after` (the caller asks for one extra). */
export async function listCameras(
  db: Database,
  filter: CameraFilter,
  window: { limit: number; after?: string | undefined },
): Promise<(typeof cameras.$inferSelect)[]> {
  if (filter.providerIds.length === 0) return [];
  return db
    .select()
    .from(cameras)
    .where(
      and(
        isNull(cameras.retiredAt),
        withinBox(filter.box),
        or(...filter.providerIds.map((id) => eq(cameras.providerId, id))),
        filter.kind ? eq(cameras.kind, filter.kind) : undefined,
        window.after ? gt(cameras.id, window.after) : undefined,
      ),
    )
    .orderBy(asc(cameras.id))
    .limit(window.limit);
}

export async function getCamera(
  db: Database,
  id: string,
): Promise<typeof cameras.$inferSelect | null> {
  const [row] = await db
    .select()
    .from(cameras)
    .where(and(eq(cameras.id, id), isNull(cameras.retiredAt)))
    .limit(1);
  return row ?? null;
}

/** Live cameras per provider id, for `GET /camera-providers`. */
export async function cameraCounts(db: Database): Promise<Map<string, number>> {
  const rows = await db
    .select({ providerId: cameras.providerId, count: sql<number>`count(*)::int` })
    .from(cameras)
    .where(isNull(cameras.retiredAt))
    .groupBy(cameras.providerId);
  return new Map(rows.map((row) => [row.providerId, row.count]));
}

/**
 * Record that a frame was seen. A no-op unless it is newer than what is
 * stored, so the relay calling it per request cannot move a camera backwards.
 */
export async function touchFrame(db: Database, id: string, frameAt: Date): Promise<void> {
  await db
    .update(cameras)
    .set({ lastFrameAt: frameAt })
    .where(
      and(eq(cameras.id, id), or(isNull(cameras.lastFrameAt), lt(cameras.lastFrameAt, frameAt))),
    );
}

// ── Observations ────────────────────────────────────────────────────────────

/** Store what the video worker counted; the same window twice is one row. */
export async function saveObservation(db: Database, observation: CameraObservation): Promise<void> {
  const values = {
    cameraId: observation.cameraId,
    windowFrom: new Date(observation.windowStart),
    windowTo: new Date(observation.windowEnd),
    counts: observation.counts,
    present: observation.present,
    flowPerMinute: observation.flowPerMinute,
    congestion: observation.congestion,
    health: observation.health,
  };
  await db
    .insert(cameraObservations)
    .values(values)
    .onConflictDoUpdate({
      target: [cameraObservations.cameraId, cameraObservations.windowTo],
      set: values,
    });
}

export interface ObservationRow {
  row: typeof cameraObservations.$inferSelect;
  /** The keyset position a page ending here resumes after (Postgres's own text, microseconds intact). */
  position: TimeKeyset;
}

/** A camera's observations, newest first, after `window.after`. */
export async function listObservations(
  db: Database,
  cameraId: string,
  filter: { since?: Date | undefined },
  window: { limit: number; after?: TimeKeyset | undefined },
): Promise<ObservationRow[]> {
  const rows = await db
    .select({
      row: cameraObservations,
      windowToText: sql<string>`${cameraObservations.windowTo}::text`,
    })
    .from(cameraObservations)
    .where(
      and(
        eq(cameraObservations.cameraId, cameraId),
        filter.since ? gte(cameraObservations.windowTo, filter.since) : undefined,
        window.after
          ? sql`${cameraObservations.windowTo} < ${window.after[0]}::timestamptz`
          : undefined,
      ),
    )
    .orderBy(desc(cameraObservations.windowTo))
    .limit(window.limit);
  return rows.map(({ row, windowToText }) => ({
    row,
    position: [windowToText, cameraId] as TimeKeyset,
  }));
}

/** Delete observations older than `before` (retention). Returns how many. */
export async function pruneObservations(db: Database, before: Date): Promise<number> {
  const rows = await db
    .delete(cameraObservations)
    .where(lt(cameraObservations.windowTo, before))
    .returning({ cameraId: cameraObservations.cameraId });
  return rows.length;
}

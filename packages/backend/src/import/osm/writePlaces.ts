/**
 * Writing a batch of imported POIs into Places.
 *
 * ## Batched statements, not `COPY`, and not row-at-a-time
 *
 * Three million places is far past what a write per row can carry: at a
 * millisecond of round trip each that is an hour of latency and nothing else.
 * `COPY` into a staging table with a set-based merge is the other end of the
 * scale and was rejected for a reason that is about correctness rather than
 * speed: the merge this importer has to perform (see `merge.ts`) compares three
 * versions of every column, and expressing that as hand-written SQL puts a
 * fifteen-column `CASE` into a string — untestable without a database, and
 * obliged to spell column names the casing authority owns.
 *
 * What is here is the middle: five statements per batch of a thousand places,
 * every one of them a drizzle query against the schema, with the merge decided
 * in TypeScript by a pure function that has its own tests. That is the shape
 * issue #63 sanctions ("`COPY` or batched inserts") and it is the one whose
 * correctness can be demonstrated on a machine with no Postgres on it.
 *
 * ## A second run must be nearly free
 *
 * `mergePlaceColumns` returns only what CHANGED, and a place whose facts are
 * unchanged produces no `places` write at all. So a re-import of an unchanged
 * country is two reads and two conflict-absorbing upserts per batch — no row
 * rewrites, no `updated_at` churn, and no client re-fetching a country because
 * the importer ran.
 *
 * ## What this never does
 *
 * It never deletes. A POI absent from today's extract is not a statement that
 * the place closed — an extract can be partial, a tag can be vandalised and
 * reverted, and `places_capabilities` and `places_names` already made this
 * trade for the same reason. Retiring a place is a moderation act that records
 * who did it.
 *
 * It never writes a name attributed to anything but `openstreetmap`, and it
 * never writes to `places.created_by_oxy_user_id`: an imported place has no
 * contributor, and putting a system identity there would make authorship a
 * value that has to be excluded from every query that means "a human said
 * this".
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { qualified, sqlColumnName, uuidv7 } from '@oxy.so/db';
import type { Database } from '../../db/postgres';
import { places, placesNames, placesSources } from '../../db/schema';
import { incomingColumns, mergePlaceColumns, type MergeablePlaceColumns } from './merge';
import { sourceDataOf, type ImportedPlace } from './placeRecord';

/**
 * The `source` key every row this importer writes carries.
 *
 * The same key space as `places_names.source` and `places_sources.source`, and
 * the counterpart of `GOWAY_NAME_SOURCE` in `placesRepository`: an HTTP caller
 * can only ever write `goway`, and this importer can only ever write
 * `openstreetmap`. Neither can forge the other's provenance.
 */
export const OSM_SOURCE = 'openstreetmap';

/**
 * `excluded."<column>"` inside an `ON CONFLICT DO UPDATE SET`.
 *
 * The same three lines as in `placesRepository`. A shared module holding one
 * expression would be a file whose entire content is an import, and the rule
 * this enforces — never spell the SQL casing by hand — is enforced by
 * `sqlColumnName` either way.
 */
function excluded(column: PgColumn): SQL {
  return sql.raw(`excluded."${sqlColumnName(column)}"`);
}

/** What a run did, accumulated across batches. */
export interface WriteStats {
  placesInserted: number;
  placesUpdated: number;
  placesUnchanged: number;
  sourcesLinked: number;
  /**
   * Translated names this run OFFERED.
   *
   * Offered rather than written: a row already carrying a newer observation is
   * left alone by the `setWhere` below, and counting the difference would mean
   * returning every row of every batch to learn a number nothing acts on.
   */
  namesOffered: number;
  /**
   * Source records a CONCURRENT writer bound to a different place between this
   * batch's read and its write.
   *
   * Zero in the ordinary case, including when a place already existed: the
   * import resolves each element to whatever place `(source, source_id)` is
   * already bound to, so there is nothing to contend over. A non-zero count
   * means two writers raced, and the guard chose the one that got there first.
   */
  conflicts: number;
}

export function emptyWriteStats(): WriteStats {
  return {
    placesInserted: 0,
    placesUpdated: 0,
    placesUnchanged: 0,
    sourcesLinked: 0,
    namesOffered: 0,
    conflicts: 0,
  };
}

/**
 * PostgreSQL refuses a statement carrying more than 65535 bound parameters.
 *
 * A thousand places at fifteen columns is well under it; a thousand places'
 * NAMES is not bounded by the batch size at all, because one element can carry
 * a dozen languages. Every insert below therefore goes through
 * {@link inParameterChunks} rather than trusting the caller's batch size.
 */
const MAX_BOUND_PARAMETERS = 60_000;

/** Split `rows` so no statement exceeds {@link MAX_BOUND_PARAMETERS}. */
function inParameterChunks<T>(rows: readonly T[], columnsPerRow: number): T[][] {
  const perStatement = Math.max(1, Math.floor(MAX_BOUND_PARAMETERS / columnsPerRow));
  const chunks: T[][] = [];
  for (let start = 0; start < rows.length; start += perStatement) {
    chunks.push(rows.slice(start, start + perStatement));
  }
  return chunks;
}

/** The `places` row an imported place becomes on first sight. */
function placeInsertValues(id: string, place: ImportedPlace) {
  return { id, ...incomingColumns(place) };
}

/**
 * Write one batch.
 *
 * `observedAt` is the RUN's timestamp, not the wall clock at each statement:
 * every row a single pass writes carries one observation time, so "what did
 * this import say" is answerable by a single equality rather than by a range.
 */
export async function writePlaceBatch(
  db: Database,
  batch: readonly ImportedPlace[],
  observedAt: Date,
  stats: WriteStats,
): Promise<void> {
  if (batch.length === 0) return;

  const sourceIds = batch.map((place) => place.sourceId);
  const linked = await db
    .select({
      sourceId: placesSources.sourceId,
      placeId: placesSources.placeId,
      sourceData: placesSources.sourceData,
    })
    .from(placesSources)
    .where(and(eq(placesSources.source, OSM_SOURCE), inArray(placesSources.sourceId, sourceIds)));

  const placeIdBySourceId = new Map(linked.map((row) => [row.sourceId, row.placeId]));
  const previousBySourceId = new Map(
    linked.map((row) => [row.sourceId, (row.sourceData ?? null) as Record<string, unknown> | null]),
  );

  const current = new Map<string, MergeablePlaceColumns>();
  if (linked.length > 0) {
    const rows = await db
      .select({
        id: places.id,
        name: places.name,
        latitude: places.latitude,
        longitude: places.longitude,
        categories: places.categories,
        addressHouseNumber: places.addressHouseNumber,
        addressStreet: places.addressStreet,
        addressLocality: places.addressLocality,
        addressCity: places.addressCity,
        addressRegion: places.addressRegion,
        addressPostalCode: places.addressPostalCode,
        addressCountryCode: places.addressCountryCode,
        contactPhone: places.contactPhone,
        contactEmail: places.contactEmail,
        contactWebsite: places.contactWebsite,
      })
      .from(places)
      .where(inArray(places.id, [...new Set(linked.map((row) => row.placeId))]));
    for (const row of rows) {
      const { id, ...columns } = row;
      current.set(id, columns);
    }
  }

  // ── New places ────────────────────────────────────────────────────────────
  const inserts: ReturnType<typeof placeInsertValues>[] = [];
  const idBySourceId = new Map(placeIdBySourceId);
  for (const place of batch) {
    if (idBySourceId.has(place.sourceId)) continue;
    const id = uuidv7();
    idBySourceId.set(place.sourceId, id);
    inserts.push(placeInsertValues(id, place));
  }
  for (const chunk of inParameterChunks(inserts, 15)) {
    await db.insert(places).values(chunk);
    stats.placesInserted += chunk.length;
  }

  // ── Provenance ────────────────────────────────────────────────────────────
  //
  // One upsert for the whole batch, new and existing alike. `observed_at` moves
  // forward with `greatest(...)` and never backward, exactly as `linkSources`
  // does it for the HTTP path: replaying an older extract must not make a
  // record look staler than the refresh that already happened.
  //
  // `setWhere` carries the same anti-theft guard `linkSources` uses, and ONLY
  // that guard: a source record bound to a DIFFERENT place is left alone rather
  // than silently reassigned, and the rows that come back are the ones that
  // were written, so a collision is counted rather than lost.
  //
  // Staleness is handled in the SET rather than in `setWhere`, which is not a
  // stylistic choice. Putting `excluded.observed_at >= observed_at` in the
  // WHERE makes an older observation indistinguishable from a stolen record:
  // both return no row and both would be counted as a conflict. They are
  // different events — one is a replayed extract, the other is two writers
  // racing — and only the second is worth a number in a log. The `case` below
  // keeps the older extract from overwriting newer facts while still reporting
  // the row as written, which is what it is.
  const sourceRows = batch.map((place) => ({
    id: uuidv7(),
    placeId: idBySourceId.get(place.sourceId) as string,
    source: OSM_SOURCE,
    sourceId: place.sourceId,
    observedAt,
    sourceData: sourceDataOf(place),
  }));
  for (const chunk of inParameterChunks(sourceRows, 6)) {
    const written = await db
      .insert(placesSources)
      .values(chunk)
      .onConflictDoUpdate({
        target: [placesSources.source, placesSources.sourceId],
        set: {
          observedAt: sql`greatest(${qualified(placesSources.observedAt)}, ${excluded(placesSources.observedAt)})`,
          sourceData: sql`case when ${excluded(placesSources.observedAt)} >= ${qualified(placesSources.observedAt)} then ${excluded(placesSources.sourceData)} else ${qualified(placesSources.sourceData)} end`,
          updatedAt: observedAt,
        },
        setWhere: sql`${qualified(placesSources.placeId)} = ${excluded(placesSources.placeId)}`,
      })
      .returning({ sourceId: placesSources.sourceId });
    stats.sourcesLinked += written.length;
    stats.conflicts += chunk.length - written.length;
  }

  // ── Merge into places that already existed ────────────────────────────────
  for (const place of batch) {
    const placeId = placeIdBySourceId.get(place.sourceId);
    if (placeId === undefined) continue;
    const held = current.get(placeId);
    if (held === undefined) continue;
    const changes = mergePlaceColumns(
      held,
      previousBySourceId.get(place.sourceId) ?? null,
      incomingColumns(place),
    );
    if (changes === null) {
      stats.placesUnchanged += 1;
      continue;
    }
    await db
      .update(places)
      .set({ ...changes, updatedAt: observedAt })
      .where(eq(places.id, placeId));
    stats.placesUpdated += 1;
  }

  // ── Names ─────────────────────────────────────────────────────────────────
  //
  // The conflict target is `(place, language, source)` with `source` pinned to
  // `openstreetmap`, which is the whole of the guarantee: this statement cannot
  // name a `goway` row, so a GoWay correction to the Spanish name of a place
  // survives every re-import as a property of the key rather than of this
  // importer's discipline. `setWhere` refuses an observation older than the one
  // stored, so replaying a stale extract is a no-op rather than a regression.
  const nameRows = batch.flatMap((place) => {
    const placeId = idBySourceId.get(place.sourceId);
    if (placeId === undefined) return [];
    return place.names.map((name) => ({
      id: uuidv7(),
      placeId,
      language: name.language,
      name: name.name,
      source: OSM_SOURCE,
      observedAt,
    }));
  });
  for (const chunk of inParameterChunks(nameRows, 6)) {
    await db
      .insert(placesNames)
      .values(chunk)
      .onConflictDoUpdate({
        target: [placesNames.placeId, placesNames.language, placesNames.source],
        set: {
          name: excluded(placesNames.name),
          observedAt: excluded(placesNames.observedAt),
          updatedAt: observedAt,
        },
        setWhere: sql`${excluded(placesNames.observedAt)} >= ${qualified(placesNames.observedAt)}`,
      });
    stats.namesOffered += chunk.length;
  }
}

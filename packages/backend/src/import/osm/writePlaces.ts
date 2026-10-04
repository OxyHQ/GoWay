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
 * `CASE` per owned column into a string — untestable without a database, and
 * obliged to spell column names the casing authority owns.
 *
 * What is here is the middle: six statements per batch of a thousand places,
 * every one of them a drizzle query against the schema, with the merge decided
 * in TypeScript by a pure function that has its own tests. That is the shape
 * issue #63 sanctions ("`COPY` or batched inserts") and it is the one whose
 * correctness can be demonstrated on a machine with no Postgres on it.
 *
 * ## A second run must be nearly free
 *
 * `mergePlaceColumns` returns only what CHANGED, and a place whose facts are
 * unchanged produces no `places` write at all. So a re-import of an unchanged
 * country is two reads and three conflict-absorbing upserts per batch — no
 * place rewrites, no `updated_at` churn, and no client re-fetching a country
 * because the importer ran.
 *
 * ## What this never does
 *
 * It never deletes. A POI absent from today's extract is not a statement that
 * the place closed — an extract can be partial, a tag can be vandalised and
 * reverted, and `places_capabilities` and `places_names` already made this
 * trade for the same reason. Retiring a place is a moderation act that records
 * who did it.
 *
 * It never writes a name attributed to anything but `openstreetmap`, never a
 * capability at any tier but `external_source` (tied to this element's own
 * `places_sources` row), and it never writes to `places.created_by_oxy_user_id`: an imported place has no
 * contributor, and putting a system identity there would make authorship a
 * value that has to be excluded from every query that means "a human said
 * this".
 */

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { qualified, sqlColumnName, uuidv7 } from '@oxy.so/db';
import { splitCapabilityKey, type CapabilityValue } from '@goway/contracts';
import type { Database } from '../../db/postgres';
import { places, placesCapabilities, placesNames, placesSources, type PlaceSourceData } from '../../db/schema';
import { assertWritableVerification } from '../../places/capabilityAuthority';
import { IMPORTED_COLUMNS, previousColumns, sameJson, type ImportedColumn, type ImportedColumns } from './fields';
import { mergePlaceColumns } from './merge';
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
  /** `external_source` capability assertions this run OFFERED, for the same reason. */
  capabilitiesOffered: number;
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
    capabilitiesOffered: 0,
    conflicts: 0,
  };
}

/**
 * PostgreSQL refuses a statement carrying more than 65535 bound parameters.
 *
 * A thousand places at twenty columns is well under it; a thousand places'
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

/** The importable columns as a drizzle selection — read back for the merge, from the one field table. */
const IMPORTED_SELECTION = Object.fromEntries(IMPORTED_COLUMNS.map((column) => [column, places[column]])) as {
  [K in ImportedColumn]: (typeof places)[K];
};

/** Bound parameters one `places` insert row carries: the id and every owned column. */
const PLACE_INSERT_PARAMETERS = IMPORTED_COLUMNS.length + 1;

/** The `places` row an imported place becomes on first sight. */
function placeInsertValues(id: string, place: ImportedPlace) {
  return { id, ...place.columns };
}

/**
 * What a previous run recorded, or `null` when there is no record this release
 * can read — a version it does not know, or a source linked by another path.
 */
function previousOf(sourceData: PlaceSourceData | null): {
  columns: Partial<ImportedColumns>;
  capabilities: Record<string, unknown>;
} | null {
  if (sourceData === null || sourceData.v !== 2) return null;
  const normalized = sourceData.normalized ?? {};
  const capabilities = normalized.capabilities;
  return {
    columns: previousColumns(normalized),
    capabilities: capabilities !== null && typeof capabilities === 'object' ? (capabilities as Record<string, unknown>) : {},
  };
}

/** Whether an element's capabilities differ from what the last run recorded. */
function capabilitiesChanged(previous: Record<string, unknown>, place: ImportedPlace): boolean {
  if (Object.keys(previous).length !== place.capabilities.length) return true;
  return place.capabilities.some((capability) => !sameJson(previous[capability.key], capability.value));
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
  const previousBySourceId = new Map(linked.map((row) => [row.sourceId, previousOf(row.sourceData)]));

  const current = new Map<string, ImportedColumns>();
  if (linked.length > 0) {
    const rows = await db
      .select({ id: places.id, ...IMPORTED_SELECTION })
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
  for (const chunk of inParameterChunks(inserts, PLACE_INSERT_PARAMETERS)) {
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
  const sourceRowIdBySourceId = new Map<string, string>();
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
      .returning({ id: placesSources.id, sourceId: placesSources.sourceId });
    for (const row of written) sourceRowIdBySourceId.set(row.sourceId, row.id);
    stats.sourcesLinked += written.length;
    stats.conflicts += chunk.length - written.length;
  }

  // ── Merge into places that already existed ────────────────────────────────
  //
  // A changed capability with no changed column still moves `updated_at`: a
  // client caching on it must not miss a shop that started taking cards
  // because the `places` row itself was untouched — the rule the HTTP path
  // keeps for a capability write.
  for (const place of batch) {
    const placeId = placeIdBySourceId.get(place.sourceId);
    if (placeId === undefined) continue;
    const held = current.get(placeId);
    if (held === undefined) continue;
    const previous = previousBySourceId.get(place.sourceId) ?? null;
    const changes = mergePlaceColumns(held, previous?.columns ?? null, place.columns);
    if (changes === null && !capabilitiesChanged(previous?.capabilities ?? {}, place)) {
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

  // ── Capabilities ──────────────────────────────────────────────────────────
  //
  // `external_source`, tied to THIS element's `places_sources` row — the tier
  // the table's CHECK requires evidence for, and the evidence is the row. The
  // conflict target includes the tier, so a business's own assertion and a
  // community report about the same key sit beside this one, untouched.
  //
  // `setWhere` makes a source speak only for itself: an `external_source` row
  // another source asserted is left alone (one whose source was unlinked, and
  // so names none, is taken over). And, as for names, an observation older than
  // the stored one changes nothing. Nothing is deleted: a tag OpenStreetMap
  // stopped carrying leaves the last assertion to age, visibly, by its
  // `observed_at`.
  const verification = assertWritableVerification('external_source');
  const capabilityRows = batch.flatMap((place) => {
    const placeId = idBySourceId.get(place.sourceId);
    const placeSourceId = sourceRowIdBySourceId.get(place.sourceId);
    // No source row means the record is bound to another place (a conflict
    // counted above): there is no evidence here to assert anything with.
    if (placeId === undefined || placeSourceId === undefined) return [];
    return place.capabilities.map((capability) => ({
      placeId,
      ...splitCapabilityKey(capability.key),
      value: capability.value as CapabilityValue,
      verification,
      observedAt,
      placeSourceId,
    }));
  });
  for (const chunk of inParameterChunks(capabilityRows, 8)) {
    await db
      .insert(placesCapabilities)
      .values(chunk)
      .onConflictDoUpdate({
        target: [
          placesCapabilities.placeId,
          placesCapabilities.namespace,
          placesCapabilities.capability,
          placesCapabilities.verification,
        ],
        set: {
          value: excluded(placesCapabilities.value),
          observedAt: excluded(placesCapabilities.observedAt),
          placeSourceId: excluded(placesCapabilities.placeSourceId),
          updatedAt: observedAt,
        },
        setWhere: sql`(${qualified(placesCapabilities.placeSourceId)} is null or ${qualified(placesCapabilities.placeSourceId)} = ${excluded(placesCapabilities.placeSourceId)}) and ${excluded(placesCapabilities.observedAt)} >= ${qualified(placesCapabilities.observedAt)}`,
      });
    stats.capabilitiesOffered += chunk.length;
  }
}

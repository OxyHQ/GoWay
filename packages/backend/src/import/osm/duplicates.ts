/**
 * Feeding `places_duplicate_candidates` from an import, without merging
 * anything and without asking Postgres for a self-join it cannot survive.
 *
 * ## Why the pairing happens here and not in SQL
 *
 * The rules are the ones `placesRepository` already encodes: an identical
 * normalized name AND proximity, or an intersecting name SET across languages
 * AND proximity. Written as a self-join over three million places —
 *
 *     from places a join places b on a.name_normalized = b.name_normalized
 *      where ST_DWithin(a.geo, b.geo, 75)
 *
 * — the planner hashes on the name and applies the distance afterwards. Spain
 * has on the order of twenty thousand places called `farmacia`, which is four
 * hundred million pairs in that one group before a single distance is measured.
 * The query is correct and it does not finish.
 *
 * So the grouping is done by the index that already exists
 * (`places_name_normalized_idx`, read in keyset pages) and the pairing inside a
 * group is done here, by a latitude sweep: sort a group by latitude and compare
 * each place only with the ones within 75 m of it in latitude. Twenty thousand
 * pharmacies spread across a country give a window of one or two, so the group
 * costs a sort and a walk. {@link pairsWithin} is pure and has its own tests.
 *
 * ## Nothing here decides anything
 *
 * A candidate is a queue entry. `recordDuplicateCandidate`'s
 * `on conflict do nothing` is mirrored exactly: a pair already in review must
 * not have its state reset because an import found it again, and the canonical
 * `place_id < candidate_place_id` ordering means A/B and B/A are one row.
 */

import { and, asc, eq, gt, gte, inArray, isNotNull, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { uuidv7 } from '@oxy.so/db';
import type { DuplicateCandidateReason } from '../../db/schema/valueSets';
import type { Database } from '../../db/postgres';
import { places, placesDuplicateCandidates, placesNames } from '../../db/schema';

/**
 * The radius both rules share, in metres.
 *
 * The same 75 m `DUPLICATE_PROXIMITY_METERS` uses in `placesRepository`, and
 * for the identical reason: at 75 m a shared name is plausibly one shopfront
 * recorded twice, and at 500 m it is two branches of a chain that must stay
 * separate records. Restated rather than imported because that constant is
 * private to the repository module, and the test below asserts the two agree.
 */
export const DUPLICATE_PROXIMITY_METERS = 75;

/** Metres per degree of latitude. Constant enough at this radius to bound a sweep. */
const METRES_PER_DEGREE_LATITUDE = 111_320;

/** Mean Earth radius, for the haversine that decides the pairs. */
const EARTH_RADIUS_METRES = 6_371_008.8;

/** One place, as the pairing needs it. */
export interface PairCandidate {
  id: string;
  latitude: number;
  longitude: number;
}

/** Great-circle distance in metres. */
export function distanceMetres(left: PairCandidate, right: PairCandidate): number {
  const toRadians = Math.PI / 180;
  const latitude1 = left.latitude * toRadians;
  const latitude2 = right.latitude * toRadians;
  const deltaLatitude = latitude2 - latitude1;
  const deltaLongitude = (right.longitude - left.longitude) * toRadians;
  const chord =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(latitude1) * Math.cos(latitude2) * Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.min(1, Math.sqrt(chord)));
}

/**
 * Every pair in `group` within `radiusMetres`, in canonical id order.
 *
 * The sweep: sorted by latitude, a pair can only be within the radius if their
 * latitudes are, so the inner loop stops at the first place more than
 * `radiusMetres` north. That turns a group's cost from quadratic in its size to
 * quadratic in its local density, which is what makes a country's worth of
 * identically named pharmacies tractable.
 */
export function pairsWithin(
  group: readonly PairCandidate[],
  radiusMetres: number,
): [string, string][] {
  const sorted = [...group].sort((left, right) => left.latitude - right.latitude);
  const latitudeWindow = radiusMetres / METRES_PER_DEGREE_LATITUDE;
  const pairs: [string, string][] = [];

  for (let index = 0; index < sorted.length; index += 1) {
    const anchor = sorted[index] as PairCandidate;
    for (let other = index + 1; other < sorted.length; other += 1) {
      const candidate = sorted[other] as PairCandidate;
      if (candidate.latitude - anchor.latitude > latitudeWindow) break;
      if (anchor.id === candidate.id) continue;
      if (distanceMetres(anchor, candidate) > radiusMetres) continue;
      pairs.push(anchor.id < candidate.id ? [anchor.id, candidate.id] : [candidate.id, anchor.id]);
    }
  }
  return pairs;
}

/** How many rows one keyset page reads. */
const PAGE_SIZE = 50_000;

/** How many candidate rows go into one INSERT. */
const CANDIDATE_INSERT_SIZE = 2_000;

/** What a detection run found. */
export interface DuplicateStats {
  proximityAndName: number;
  proximityAndTranslatedName: number;
  placesScanned: number;
  translatedNamesScanned: number;
  milliseconds: number;
}

/**
 * File a batch of pairs, never reopening one that is already in review.
 *
 * `onConflictDoNothing` on the canonical pair, exactly as
 * `recordDuplicateCandidate` does it.
 */
async function fileCandidates(
  db: Database,
  pairs: readonly [string, string][],
  reason: DuplicateCandidateReason,
): Promise<number> {
  let filed = 0;
  for (let start = 0; start < pairs.length; start += CANDIDATE_INSERT_SIZE) {
    const chunk = pairs.slice(start, start + CANDIDATE_INSERT_SIZE);
    const rows = chunk
      .filter(([placeId, candidatePlaceId]) => placeId !== candidatePlaceId)
      .map(([placeId, candidatePlaceId]) => ({
        id: uuidv7(),
        placeId,
        candidatePlaceId,
        reason,
      }));
    if (rows.length === 0) continue;
    const written = await db
      .insert(placesDuplicateCandidates)
      .values(rows)
      .onConflictDoNothing({
        target: [placesDuplicateCandidates.placeId, placesDuplicateCandidates.candidatePlaceId],
      })
      .returning({ id: placesDuplicateCandidates.id });
    filed += written.length;
  }
  return filed;
}

/** One row of a name-ordered scan: a normalized name and the row it belongs to. */
interface NamedRow {
  name: string;
  key: string;
}

/**
 * Every group of rows sharing a normalized name, read through a btree index in
 * keyset pages.
 *
 * The boundary is the whole difficulty. A page that ends inside a name holds
 * only part of that group, and yielding it would lose every pair that crossed
 * the cut — so the boundary name is dropped from the page and the next page
 * starts AT it rather than after it. A name with more members than a page
 * (`farmacia` in Spain is within an order of magnitude of that) would make that
 * a loop that never advances, so the one-name page is detected and the group is
 * fetched whole by `exact` instead.
 */
async function* nameGroups<T extends NamedRow>(
  page: (from: string | null, inclusive: boolean, limit: number) => Promise<T[]>,
  exact: (name: string) => Promise<T[]>,
): AsyncGenerator<T[], void, void> {
  let from: string | null = null;
  let inclusive = true;

  for (;;) {
    const rows: T[] = await page(from, inclusive, PAGE_SIZE);
    if (rows.length === 0) return;

    const last = rows[rows.length - 1] as T;
    const complete = rows.length < PAGE_SIZE;
    const boundary = complete ? null : last.name;

    if (boundary !== null && (rows[0] as T).name === boundary) {
      yield await exact(boundary);
      from = boundary;
      inclusive = false;
      continue;
    }

    let group: T[] = [];
    for (const row of rows) {
      if (row.name === boundary) break;
      if (group.length > 0 && (group[0] as T).name !== row.name) {
        yield group;
        group = [];
      }
      group.push(row);
    }
    if (group.length > 0) yield group;

    if (boundary === null) return;
    from = boundary;
    inclusive = true;
  }
}

/** `name > from` or `name >= from`, or nothing at all on the first page. */
function afterName(column: PgColumn, from: string | null, inclusive: boolean): SQL | undefined {
  if (from === null) return isNotNull(column);
  return and(isNotNull(column), inclusive ? gte(column, from) : gt(column, from));
}

/**
 * Both name rules, over every place that currently exists.
 *
 * Run once at the END of an import rather than per place: a candidate is only
 * discoverable once BOTH of its places are in the table, and a per-place query
 * would be three million spatial lookups where this is two indexed scans.
 */
export async function detectDuplicates(db: Database): Promise<DuplicateStats> {
  const started = Date.now();
  const stats: DuplicateStats = {
    proximityAndName: 0,
    proximityAndTranslatedName: 0,
    placesScanned: 0,
    translatedNamesScanned: 0,
    milliseconds: 0,
  };

  // ── Rule 1: the same default name, close together ─────────────────────────
  const placeColumns = {
    name: places.nameNormalized,
    key: places.id,
    latitude: places.latitude,
    longitude: places.longitude,
  };
  const groups = nameGroups<{ name: string; key: string; latitude: number; longitude: number }>(
    async (from, inclusive, limit) =>
      (
        await db
          .select(placeColumns)
          .from(places)
          .where(afterName(places.nameNormalized, from, inclusive))
          .orderBy(asc(places.nameNormalized), asc(places.id))
          .limit(limit)
      ).map(asNamedPlace),
    async (name) =>
      (
        await db.select(placeColumns).from(places).where(eq(places.nameNormalized, name))
      ).map(asNamedPlace),
  );
  for await (const group of groups) {
    stats.placesScanned += group.length;
    if (group.length < 2) continue;
    stats.proximityAndName += await fileCandidates(
      db,
      pairsWithin(
        group.map((row) => ({ id: row.key, latitude: row.latitude, longitude: row.longitude })),
        DUPLICATE_PROXIMITY_METERS,
      ),
      'proximity_and_name',
    );
  }

  // ── Rule 2: a name in common across languages, close together ─────────────
  //
  // The blind spot translations open: "Museu Picasso" and "Museo Picasso" are
  // two spellings of one museum and are not equal as DEFAULT names. Each group
  // of translated names pulls in every place whose DEFAULT name is that same
  // spelling, and pairs whose default names already match are left to rule 1 —
  // so each pair is filed under the rule that is actually true of it.
  const nameColumns = { name: placesNames.nameNormalized, key: placesNames.placeId };
  const translatedGroups = nameGroups<NamedRow>(
    async (from, inclusive, limit) =>
      (
        await db
          .select(nameColumns)
          .from(placesNames)
          .where(afterName(placesNames.nameNormalized, from, inclusive))
          .orderBy(asc(placesNames.nameNormalized), asc(placesNames.placeId))
          .limit(limit)
      ).map(asNamedRow),
    async (name) =>
      (
        await db.select(nameColumns).from(placesNames).where(eq(placesNames.nameNormalized, name))
      ).map(asNamedRow),
  );
  //
  // Groups are BUFFERED and resolved in bulk. A Spain import produces on the
  // order of thirty thousand distinct translated spellings, and two queries per
  // spelling is sixty thousand round trips for work that two queries per
  // twenty thousand rows can do.
  let buffered: TranslatedGroup[] = [];
  let bufferedRows = 0;
  for await (const group of translatedGroups) {
    stats.translatedNamesScanned += group.length;
    const first = group[0];
    if (!first) continue;
    buffered.push({ name: first.name, placeIds: group.map((row) => row.key) });
    bufferedRows += group.length;
    if (bufferedRows >= RESOLVE_BATCH) {
      stats.proximityAndTranslatedName += await pairTranslatedGroups(db, buffered);
      buffered = [];
      bufferedRows = 0;
    }
  }
  if (buffered.length > 0) {
    stats.proximityAndTranslatedName += await pairTranslatedGroups(db, buffered);
  }

  stats.milliseconds = Date.now() - started;
  return stats;
}

/** `name_normalized` is a generated column and is typed nullable; a null name cannot group. */
function asNamedRow(row: { name: string | null; key: string }): NamedRow {
  return { name: row.name ?? '', key: row.key };
}

function asNamedPlace(row: {
  name: string | null;
  key: string;
  latitude: number;
  longitude: number;
}): { name: string; key: string; latitude: number; longitude: number } {
  return { name: row.name ?? '', key: row.key, latitude: row.latitude, longitude: row.longitude };
}

/** One spelling and the places that carry it as a translation. */
interface TranslatedGroup {
  name: string;
  placeIds: string[];
}

/** How many translated-name rows accumulate before their places are resolved. */
const RESOLVE_BATCH = 20_000;

/** `IN (…)` lists are split at this width: Postgres refuses past 65535 parameters. */
const IN_LIST_WIDTH = 10_000;

/** Run a query once per chunk of `values`, concatenating the rows. */
async function inChunks<V, R>(
  values: readonly V[],
  query: (chunk: V[]) => Promise<R[]>,
): Promise<R[]> {
  const rows: R[] = [];
  for (let start = 0; start < values.length; start += IN_LIST_WIDTH) {
    rows.push(...(await query(values.slice(start, start + IN_LIST_WIDTH))));
  }
  return rows;
}

/**
 * The cross-language pairs for a buffer of spellings.
 *
 * Two families of query for the whole buffer rather than two per spelling: the
 * positions of every place that carries one of these spellings as a
 * TRANSLATION, and every place that carries one as its DEFAULT name. A pair
 * whose two default names are equal belongs to rule 1 and is left to it, so
 * each candidate is filed under the reason that is true of it.
 */
async function pairTranslatedGroups(
  db: Database,
  groups: readonly TranslatedGroup[],
): Promise<number> {
  const names = [...new Set(groups.map((group) => group.name))];
  const placeIds = [...new Set(groups.flatMap((group) => group.placeIds))];
  if (names.length === 0 || placeIds.length === 0) return 0;

  const columns = {
    id: places.id,
    nameNormalized: places.nameNormalized,
    latitude: places.latitude,
    longitude: places.longitude,
  };
  const [carriers, defaults] = await Promise.all([
    inChunks(placeIds, (chunk) => db.select(columns).from(places).where(inArray(places.id, chunk))),
    inChunks(names, (chunk) =>
      db.select(columns).from(places).where(inArray(places.nameNormalized, chunk)),
    ),
  ]);

  const position = new Map<string, { candidate: PairCandidate; defaultName: string }>();
  for (const row of [...carriers, ...defaults]) {
    position.set(row.id, {
      candidate: { id: row.id, latitude: row.latitude, longitude: row.longitude },
      defaultName: row.nameNormalized ?? '',
    });
  }

  const byName = new Map<string, Set<string>>();
  for (const group of groups) {
    const members = byName.get(group.name) ?? new Set<string>();
    for (const placeId of group.placeIds) members.add(placeId);
    byName.set(group.name, members);
  }
  for (const row of defaults) {
    const name = row.nameNormalized;
    if (name === null) continue;
    const members = byName.get(name);
    if (members) members.add(row.id);
  }

  const pairs = new Map<string, [string, string]>();
  for (const members of byName.values()) {
    if (members.size < 2) continue;
    const candidates = [...members]
      .map((id) => position.get(id)?.candidate)
      .filter((candidate): candidate is PairCandidate => candidate !== undefined);
    for (const [left, right] of pairsWithin(candidates, DUPLICATE_PROXIMITY_METERS)) {
      if (position.get(left)?.defaultName === position.get(right)?.defaultName) continue;
      pairs.set(`${left}\u0000${right}`, [left, right]);
    }
  }

  return fileCandidates(db, [...pairs.values()], 'proximity_and_translated_name');
}

/**
 * Every database access the Places API makes.
 *
 * Controllers call these functions and nothing else — no route in this package
 * imports a drizzle table, builds a predicate or sees a row. Two things follow
 * that are worth more than the indirection costs:
 *
 *  - Every read goes out through `placeMapper`, so the published shape is the
 *    contract in `@goway/shared-types` and never a table. A column added to
 *    `places` cannot reach a consumer by being spread into a response, because
 *    nothing here spreads a row.
 *  - Every spatial predicate goes through `placeGeo`, so `ST_DWithin` stays in
 *    the WHERE clause and `ST_Distance` stays out of it. That distinction is
 *    the difference between an index scan and a planet-wide sequential scan,
 *    and it is invisible in the results.
 *
 * ## Reconciliation is deterministic here, and it never merges
 *
 * Source linking keys on `(source, sourceId)` — an external system's OWN
 * identifier — and that pair is unique across `places_sources`. A second place
 * claiming an identifier another place already holds is refused as a `conflict`
 * and recorded as a duplicate CANDIDATE. Name similarity produces candidates
 * too, and only ever alongside proximity; nothing in this module merges two
 * places, because a merge is not reversible from the outside and a false
 * positive collapses two real businesses into one record that a deep link, a
 * claim and a capability now all point at wrongly.
 */

import {
  and,
  arrayOverlaps,
  eq,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { qualified, sqlColumnName } from '@oxy.so/db';
import { normalizeLanguageTag } from '@goway/shared-types';
import type {
  CapabilityVerification,
  GeoGeometry,
  OpeningHours,
  Place,
  PlaceClaim,
  PlaceClaimRole,
  PlaceContact,
  PlaceId,
  PlaceStatus,
  PlaceWithDistance,
  StructuredAddress,
} from '@goway/shared-types';
import { ApiError } from '../../http/apiError';
import {
  assertWritableVerification,
  type AssertableVerification,
} from '../../places/capabilityAuthority';
import type { Database, DatabaseOrTransaction } from '../postgres';
import {
  places,
  placesCapabilities,
  placesClaims,
  placesDuplicateCandidates,
  placesNames,
  placesSources,
  type DuplicateCandidateReason,
} from '../schema';
import { distanceTo, withinBoundingBox, withinRadius } from './placeGeo';
import {
  CAPABILITY_COLUMNS,
  CLAIM_COLUMNS,
  NAME_COLUMNS,
  PLACE_COLUMNS,
  SOURCE_COLUMNS,
  toClaim,
  toPlace,
  toPlaceWithDistance,
  type CapabilityRow,
  type ClaimRow,
  type NameRow,
  type PlaceNameView,
  type PlaceRow,
  type SourceRow,
} from './placeMapper';

/**
 * How close two identically-named places have to be before they are worth a
 * human's attention, in metres.
 *
 * Deliberately small. "Farmacia" names several thousand distinct real places in
 * Spain alone, so the name is only ever a co-signal: at 75 m the pair is
 * plausibly one shopfront recorded twice, and at 500 m it is two branches of a
 * chain that must stay separate records.
 */
const DUPLICATE_PROXIMITY_METERS = 75;

/** `excluded."<column>"` inside an `ON CONFLICT DO UPDATE SET`, named by the casing authority. */
function excluded(column: PgColumn): SQL {
  return sql.raw(`excluded."${sqlColumnName(column)}"`);
}

// ── Inputs ──────────────────────────────────────────────────────────────────

/** A source reference as a writer supplies it. `observedAt` is the server's. */
export interface SourceRefInput {
  source: string;
  sourceId: string;
}

/**
 * A capability as a writer supplies it.
 *
 * `verification` and `observedAt` are ABSENT on purpose and a caller cannot
 * send them: the server derives both. That is what stops a community report
 * from arriving labelled `oxy_verified`, and it is why the SDK strips them from
 * a write body even when a caller sets them.
 */
export interface CapabilityInput {
  namespace: string;
  capability: string;
  value: boolean | string | number;
  /** The source that asserted it, if it came from outside GoWay. */
  source?: SourceRefInput;
}

/**
 * A translated name as a writer supplies it.
 *
 * The SOURCE is absent on purpose and a caller cannot send one, exactly as
 * `verification` is absent from {@link CapabilityInput}: the write path derives
 * it. An HTTP caller always writes `goway`, because what they are doing is
 * making a GoWay-owned correction; the importer calls
 * {@link applyPlaceNames} directly and names its own source. Nothing can post a
 * name labelled `openstreetmap` that OpenStreetMap never said.
 */
export interface PlaceNameInput {
  /** Canonical BCP 47. Normalized at the edge and re-checked before the write. */
  language: string;
  name: string;
}

export interface PlaceWriteInput {
  name?: string;
  names?: PlaceNameInput[];
  location?: { latitude: number; longitude: number };
  geometry?: GeoGeometry;
  categories?: string[];
  address?: StructuredAddress;
  contact?: PlaceContact;
  openingHours?: OpeningHours;
  status?: PlaceStatus;
  sources?: SourceRefInput[];
  capabilities?: CapabilityInput[];
}

/**
 * Who is writing, and how strongly their unsourced capability claims count.
 *
 * `assertedVerification` is derived by the route from the caller's APPROVED
 * claims on the place — never from anything in the request body — and it is
 * never `oxy_verified`: that tier is an Oxy moderation act, not something an
 * API caller can assert about themselves.
 *
 * The type is `AssertableVerification`, which `places/capabilityAuthority`
 * DERIVES from the origin classification rather than spelling out. That is what
 * makes the exclusion structural instead of a convention: no value of this type
 * can be a moderation-origin tier, so a write path that tried to thread one
 * through would not compile.
 */
export interface PlaceActor {
  oxyUserId: string;
  assertedVerification: AssertableVerification;
}

export interface PlaceListFilters {
  capabilities?: readonly string[];
  categories?: readonly string[];
  limit: number;
  /**
   * Resolve each place's `localizedName` against this BCP 47 tag.
   *
   * A hint, never a predicate: a place with no name in that language is still
   * returned with its default name, because a viewport that hid everything
   * untranslated would be a map with holes in it.
   */
  locale?: string | undefined;
  /**
   * Publish the full `names` array as well.
   *
   * INTERNAL — there is no query parameter for it. Search sets it because it
   * matches typed text against every name it holds and then has to show which
   * one answered; a viewport read does not, and the asymmetry is
   * {@link PlaceNameView}'s.
   */
  includeNames?: boolean;
}

export interface NearbyQuery extends PlaceListFilters {
  latitude: number;
  longitude: number;
  radiusMeters: number;
}

export interface BoundsQuery extends PlaceListFilters {
  west: number;
  south: number;
  east: number;
  north: number;
}

/** What a caller is allowed to do to a place, and what the place already is. */
export interface PlaceAuthorization {
  exists: boolean;
  /** Whether ANY account holds an approved claim — a claimed business is not community-editable. */
  claimed: boolean;
  /** The approved roles THIS caller holds on the place. Empty for everyone else. */
  callerRoles: PlaceClaimRole[];
}

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * Capability filtering, expressed so a client never has to know the capability
 * table exists.
 *
 * A CONJUNCTION: `?capabilities=payments.faircoin.accepted,commerce.mercaria.store`
 * means both, which is what a wallet looking for somewhere to spend actually
 * wants. `count(distinct key) = n` rather than n EXISTS subqueries, so the
 * planner sees one indexed pass over `places_capabilities_key_idx` regardless
 * of how many keys were asked for.
 *
 * The subquery is NOT correlated — it groups and returns place ids — which is
 * what lets it be written with drizzle's builder instead of hand-spelled SQL,
 * and sidesteps the bare-column trap a correlated reference would carry.
 */
function matchesAllCapabilities(db: DatabaseOrTransaction, keys: readonly string[]): SQL {
  const matching = db
    .select({ placeId: placesCapabilities.placeId })
    .from(placesCapabilities)
    .where(inArray(placesCapabilities.key, [...keys]))
    .groupBy(placesCapabilities.placeId)
    .having(sql`count(distinct ${placesCapabilities.key}) = ${keys.length}`);
  return inArray(places.id, matching);
}

/**
 * The predicates every list read shares.
 *
 * `removed` places are excluded from LISTS and remain reachable by id: a place
 * withdrawn from the map must stop appearing on it, while a deep link somebody
 * already holds still has to resolve to something rather than 404 — the SDK
 * treats a 404 as "this id is dead" and a consumer may drop a persisted place
 * id on the strength of it.
 */
function listPredicates(db: DatabaseOrTransaction, filters: PlaceListFilters): SQL[] {
  const predicates: SQL[] = [ne(places.status, 'removed')];
  if (filters.capabilities && filters.capabilities.length > 0) {
    predicates.push(matchesAllCapabilities(db, filters.capabilities));
  }
  if (filters.categories && filters.categories.length > 0) {
    // A DISJUNCTION — "cafe or bakery" — because a place carries several
    // categories and asking for two is asking for either. `&&` is array
    // overlap, answered by `places_categories_gin`.
    predicates.push(arrayOverlaps(places.categories, [...filters.categories]));
  }
  return predicates;
}

// ── Hydration ───────────────────────────────────────────────────────────────

async function loadSources(
  db: DatabaseOrTransaction,
  placeIds: readonly string[],
): Promise<SourceRow[]> {
  if (placeIds.length === 0) return [];
  return db.select(SOURCE_COLUMNS).from(placesSources).where(inArray(placesSources.placeId, [...placeIds]));
}

async function loadCapabilities(
  db: DatabaseOrTransaction,
  placeIds: readonly string[],
): Promise<CapabilityRow[]> {
  if (placeIds.length === 0) return [];
  return db
    .select(CAPABILITY_COLUMNS)
    .from(placesCapabilities)
    .where(inArray(placesCapabilities.placeId, [...placeIds]));
}

/** What a list read publishes about names, from the filters it was given. */
function nameViewOf(filters: PlaceListFilters): PlaceNameView {
  return { publishAll: filters.includeNames === true, locale: filters.locale };
}

/** Whether a read has any reason to fetch name rows at all. */
function needsNames(view: PlaceNameView): boolean {
  return view.publishAll || view.locale !== undefined;
}

async function loadNames(
  db: DatabaseOrTransaction,
  placeIds: readonly string[],
): Promise<NameRow[]> {
  if (placeIds.length === 0) return [];
  return db.select(NAME_COLUMNS).from(placesNames).where(inArray(placesNames.placeId, [...placeIds]));
}

async function loadClaims(db: DatabaseOrTransaction, placeId: string): Promise<ClaimRow[]> {
  return db.select(CLAIM_COLUMNS).from(placesClaims).where(eq(placesClaims.placeId, placeId));
}

function groupByPlace<T extends { placeId: string }>(rows: readonly T[]): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.placeId);
    if (bucket) bucket.push(row);
    else grouped.set(row.placeId, [row]);
  }
  return grouped;
}

/**
 * Attach children to a page of place rows.
 *
 * Two queries for the whole page rather than two per place. The N+1 shape is
 * invisible on a test fixture and is a viewport's worth of round trips in
 * production — a 200-marker map would issue 401 queries.
 *
 * `claims` is deliberately NOT loaded for a list. The contract reads an absent
 * `claims` as "you may not see them", which is the truth for a list read: a
 * viewport query has no per-place entitlement check, and answering `[]` would
 * assert that a claimed place has no claims.
 */
async function hydrate(
  db: DatabaseOrTransaction,
  rows: readonly PlaceRow[],
  view: PlaceNameView,
): Promise<Map<string, { sources: SourceRow[]; capabilities: CapabilityRow[]; names: NameRow[] }>> {
  const ids = rows.map((row) => row.id);
  // The third query is issued only when the read was asked about names. A
  // viewport that never mentioned a locale must not pay for 200 places' worth
  // of translations to throw them away in the mapper.
  const [sources, capabilities, names] = await Promise.all([
    loadSources(db, ids),
    loadCapabilities(db, ids),
    needsNames(view) ? loadNames(db, ids) : Promise.resolve([]),
  ]);
  const sourcesByPlace = groupByPlace(sources);
  const capabilitiesByPlace = groupByPlace(capabilities);
  const namesByPlace = groupByPlace(names);
  return new Map(
    ids.map((id) => [
      id,
      {
        sources: sourcesByPlace.get(id) ?? [],
        capabilities: capabilitiesByPlace.get(id) ?? [],
        names: namesByPlace.get(id) ?? [],
      },
    ]),
  );
}

/** The empty hydration, for a row whose children somehow did not load. */
const NO_CHILDREN = { sources: [], capabilities: [], names: [] } as const;

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * One place by its GoWay id, in any status.
 *
 * `viewerOxyAccountId` decides whether claim details are published: they are
 * shown to an account that itself holds a claim on the place (its own claim and
 * the ones it is competing with), and absent for everybody else. Absent is not
 * empty — see `placeMapper`.
 */
export async function findPlaceById(
  db: DatabaseOrTransaction,
  id: string,
  viewerOxyAccountId?: string | null,
  locale?: string | undefined,
): Promise<Place | null> {
  const [row] = await db.select(PLACE_COLUMNS).from(places).where(eq(places.id, id)).limit(1);
  if (!row) return null;

  const [sources, capabilities, names, claims] = await Promise.all([
    loadSources(db, [id]),
    loadCapabilities(db, [id]),
    loadNames(db, [id]),
    viewerOxyAccountId ? loadClaims(db, id) : Promise.resolve(null),
  ]);

  const visibleClaims =
    claims !== null && claims.some((claim) => claim.oxyAccountId === viewerOxyAccountId)
      ? claims
      : undefined;

  // The single-place read ALWAYS publishes the full set — unconditionally, and
  // not only when a locale was asked for. "What else is this called" is a fact
  // about the place, and a detail view that showed it only to callers who
  // already knew which language to ask for would be useless to the caller who
  // does not.
  return toPlace(row, { sources, capabilities, names, claims: visibleClaims }, { publishAll: true, locale });
}

/**
 * Places within a radius, nearest first, with the distance each is from the
 * query point.
 *
 * `ST_DWithin` chooses the rows through the GiST index; `ST_Distance` orders
 * and measures the few that survived. Reversing that — `ST_Distance(...) < r`
 * in the WHERE clause — returns the same rows and scans the planet.
 */
export async function findPlacesNearby(
  db: DatabaseOrTransaction,
  query: NearbyQuery,
): Promise<PlaceWithDistance[]> {
  const distance = distanceTo(query.longitude, query.latitude);
  const rows = await db
    .select({ ...PLACE_COLUMNS, distanceMeters: distance })
    .from(places)
    .where(and(withinRadius(query.longitude, query.latitude, query.radiusMeters), ...listPredicates(db, query)))
    .orderBy(distance)
    .limit(query.limit);

  const view = nameViewOf(query);
  const children = await hydrate(db, rows, view);
  return rows.map(({ distanceMeters, ...row }) =>
    toPlaceWithDistance(row, children.get(row.id) ?? NO_CHILDREN, distanceMeters, view),
  );
}

/**
 * Places inside a viewport rectangle.
 *
 * Ordered by id rather than by distance from anything: a bounding-box read has
 * no query point, and a stable order is what keeps a paged or re-fetched
 * viewport from reshuffling under the user.
 */
export async function findPlacesInBounds(
  db: DatabaseOrTransaction,
  query: BoundsQuery,
): Promise<Place[]> {
  const rows = await db
    .select(PLACE_COLUMNS)
    .from(places)
    .where(and(withinBoundingBox(query), ...listPredicates(db, query)))
    .orderBy(places.id)
    .limit(query.limit);

  const view = nameViewOf(query);
  const children = await hydrate(db, rows, view);
  return rows.map((row) => toPlace(row, children.get(row.id) ?? NO_CHILDREN, view));
}

// ── Authorization inputs ────────────────────────────────────────────────────

/**
 * What the route needs to decide whether this caller may edit this place, and
 * how much their capability claims are worth.
 *
 * Returned as data rather than decided here: authorization is an HTTP-layer
 * concern (it chooses between 403, 404 and a write), and the SAME facts decide
 * the capability verification tier, so computing them twice would be two
 * chances to disagree.
 */
export async function getPlaceAuthorization(
  db: DatabaseOrTransaction,
  placeId: string,
  oxyAccountId: string,
): Promise<PlaceAuthorization> {
  const [[place], claims] = await Promise.all([
    db.select({ id: places.id }).from(places).where(eq(places.id, placeId)).limit(1),
    db
      .select({ oxyAccountId: placesClaims.oxyAccountId, role: placesClaims.role })
      .from(placesClaims)
      .where(and(eq(placesClaims.placeId, placeId), eq(placesClaims.state, 'approved'))),
  ]);

  return {
    exists: Boolean(place),
    claimed: claims.length > 0,
    callerRoles: claims
      .filter((claim) => claim.oxyAccountId === oxyAccountId)
      .map((claim) => claim.role as PlaceClaimRole),
  };
}

// ── Reconciliation ──────────────────────────────────────────────────────────

/** The GoWay place an external record is already bound to, if any. */
export async function findPlaceIdBySourceRef(
  db: DatabaseOrTransaction,
  ref: SourceRefInput,
): Promise<string | null> {
  const [row] = await db
    .select({ placeId: placesSources.placeId })
    .from(placesSources)
    .where(and(eq(placesSources.source, ref.source), eq(placesSources.sourceId, ref.sourceId)))
    .limit(1);
  return row?.placeId ?? null;
}

/**
 * Record that two places might be the same place. Never merges them.
 *
 * The pair is stored in a canonical order so A/B and B/A are one row, and a
 * repeat detection is `on conflict do nothing` — a candidate already in review
 * must not have its state reset by the importer that found it again.
 */
export async function recordDuplicateCandidate(
  db: DatabaseOrTransaction,
  placeId: string,
  otherPlaceId: string,
  reason: DuplicateCandidateReason,
  score?: number,
): Promise<void> {
  if (placeId === otherPlaceId) return;
  const [low, high] = placeId < otherPlaceId ? [placeId, otherPlaceId] : [otherPlaceId, placeId];
  await db
    .insert(placesDuplicateCandidates)
    .values({ placeId: low, candidatePlaceId: high, reason, score: score ?? null })
    .onConflictDoNothing({ target: [placesDuplicateCandidates.placeId, placesDuplicateCandidates.candidatePlaceId] });
}

/**
 * Places that share this place's normalized name AND sit within
 * {@link DUPLICATE_PROXIMITY_METERS} of it.
 *
 * Both conditions, always. The comparison is made by Postgres against the
 * GENERATED `name_normalized` column rather than by lower-casing in TypeScript,
 * so the two sides case-fold identically — a JavaScript `toLowerCase()` and a
 * SQL `lower()` do not agree on every string, and a disagreement here means a
 * duplicate that is detected on one code path and not the other.
 */
async function findProximityNameCandidates(
  db: DatabaseOrTransaction,
  placeId: string,
  name: string,
  longitude: number,
  latitude: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: places.id })
    .from(places)
    .where(
      and(
        ne(places.id, placeId),
        sql`${places.nameNormalized} = lower(btrim(${name}))`,
        withinRadius(longitude, latitude, DUPLICATE_PROXIMITY_METERS),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Write a source's statement of a place's names, in the languages it supplies.
 *
 * The importer-facing half of this schema, and the function the OpenStreetMap
 * POI import is written against. Three properties, and each is the schema's
 * rather than the caller's:
 *
 *  - **A source can only speak for itself.** The conflict target is
 *    `(place, language, source)`, so an `openstreetmap` refresh cannot name
 *    GoWay's `goway` row for the same language. A GoWay-owned correction to the
 *    Spanish name survives the next import because the import has no way to
 *    address it, not because the importer remembers not to.
 *  - **Time only moves forward.** `setWhere` refuses an observation OLDER than
 *    the one already stored, so replaying a stale planet export is a no-op
 *    instead of a regression. `places_sources` does the same for `observed_at`
 *    with `greatest(...)`; here the value itself is at stake, so the guard has
 *    to sit on the UPDATE rather than on one column of it.
 *  - **Nothing is deleted.** A language absent from this run is not a
 *    statement that the name is wrong — an import can be partial, a tag can be
 *    vandalised and reverted, and `places_capabilities` already made this
 *    trade for the same reason. Withdrawing a name is a moderation act that can
 *    record who did it, not a side effect of an import that happened to omit
 *    it.
 *
 * A tag that does not normalize is SKIPPED rather than refused: the caller is
 * typically reading keys it did not choose, and `name:etymology` should cost
 * that key and not the element.
 */
export async function applyPlaceNames(
  db: DatabaseOrTransaction,
  placeId: string,
  source: string,
  names: readonly PlaceNameInput[],
  observedAt: Date = new Date(),
): Promise<void> {
  if (names.length === 0) return;

  // Last writer wins WITHIN one call, so a source that supplies `name:es`
  // twice in one element does not deadlock against its own row.
  const byLanguage = new Map<string, string>();
  for (const entry of names) {
    const language = normalizeLanguageTag(entry.language);
    const name = entry.name.trim();
    if (language === undefined || name.length === 0) continue;
    byLanguage.set(language, name);
  }
  if (byLanguage.size === 0) return;

  const now = new Date();
  for (const [language, name] of byLanguage) {
    await db
      .insert(placesNames)
      .values({ placeId, language, name, source, observedAt })
      .onConflictDoUpdate({
        target: [placesNames.placeId, placesNames.language, placesNames.source],
        set: { name, observedAt, updatedAt: now },
        setWhere: sql`${excluded(placesNames.observedAt)} >= ${qualified(placesNames.observedAt)}`,
      });
  }
}

/**
 * The source key every name written through the HTTP API carries.
 *
 * A caller editing a place through `POST`/`PATCH /places` is making a
 * GoWay-owned correction, whatever they believe their evidence is. They cannot
 * write a row attributed to OpenStreetMap, which is the same guarantee
 * `applyCapabilities` gives about the verification tier and for the same
 * reason: provenance that a caller can assert is provenance that means nothing.
 */
export const GOWAY_NAME_SOURCE = 'goway';

/**
 * Places within {@link DUPLICATE_PROXIMITY_METERS} whose NAME SET intersects
 * this place's, where their default names do not.
 *
 * The cross-language sibling of {@link findProximityNameCandidates}, and the
 * blind spot that opens the moment translations exist: "Museu Picasso" and
 * "Museo Picasso" are two spellings of one museum, they are not equal as
 * default names, and before `places_names` there was nothing in the database
 * that could see they were the same claim.
 *
 * Still BOTH conditions, always — an intersecting name AND proximity. The
 * generic-name problem is larger across languages, not smaller: "Farmacia",
 * "Pharmacie" and "Pharmacy" collide with each other as well as with
 * themselves, and only the 75 m bound makes that a shopfront recorded twice
 * rather than two branches of a chain.
 *
 * Pairs the plain rule already covers are EXCLUDED, so a pair is reported under
 * the rule that is true of it. `recordDuplicateCandidate` is
 * `on conflict do nothing`, so whichever rule fires first names the row and a
 * candidate already in review is never restated.
 *
 * Every comparison is made against the GENERATED `name_normalized` columns, by
 * Postgres, for the reason {@link findProximityNameCandidates} gives: a
 * JavaScript `toLowerCase()` and a SQL `lower()` do not agree on every string,
 * and a disagreement means a duplicate detected on one code path and not the
 * other.
 */
async function findTranslatedNameCandidates(
  db: DatabaseOrTransaction,
  placeId: string,
  longitude: number,
  latitude: number,
): Promise<string[]> {
  // Postgres computes the normalized forms, including this place's own default
  // name: reading `places.name_normalized` back is what keeps both sides of
  // every comparison below on the same case-folding rules.
  const [[self], own] = await Promise.all([
    db.select({ normalized: places.nameNormalized }).from(places).where(eq(places.id, placeId)).limit(1),
    db
      .select({ normalized: placesNames.nameNormalized })
      .from(placesNames)
      .where(eq(placesNames.placeId, placeId)),
  ]);
  if (!self?.normalized) return [];

  const translated = own
    .map((row) => row.normalized)
    .filter((normalized): normalized is string => normalized !== null);
  const everyName = [...new Set([self.normalized, ...translated])];
  // With no translation of its own, this place can still match another place's
  // translation of ITS default name — so the query runs on the default alone.

  const rows = await db
    .select({ id: places.id })
    .from(places)
    .where(
      and(
        ne(places.id, placeId),
        withinRadius(longitude, latitude, DUPLICATE_PROXIMITY_METERS),
        // The plain rule owns the equal-default-names case.
        ne(places.nameNormalized, self.normalized),
        or(
          // Their default name is one of ours.
          inArray(places.nameNormalized, everyName),
          // One of their translations is one of our names.
          inArray(
            places.id,
            db
              .select({ placeId: placesNames.placeId })
              .from(placesNames)
              .where(inArray(placesNames.nameNormalized, everyName)),
          ),
        ),
      ),
    );
  return rows.map((row) => row.id);
}

/**
 * Bind external records to a place, without ever taking one from another place.
 *
 * `observed_at` moves forward with `greatest(...)` and never backward: an
 * importer replaying an old export must not make a record look staler than the
 * refresh that already happened. `setWhere` is what makes the write safe under
 * a race — a row that a concurrent transaction has just bound to a DIFFERENT
 * place is not updated, returns nothing, and is reported as the conflict it is
 * rather than silently stolen.
 */
async function linkSources(
  tx: DatabaseOrTransaction,
  placeId: string,
  refs: readonly SourceRefInput[],
): Promise<void> {
  for (const ref of refs) {
    const linked = await tx
      .insert(placesSources)
      .values({ placeId, source: ref.source, sourceId: ref.sourceId })
      .onConflictDoUpdate({
        target: [placesSources.source, placesSources.sourceId],
        set: {
          observedAt: sql`greatest(${qualified(placesSources.observedAt)}, ${excluded(placesSources.observedAt)})`,
          updatedAt: new Date(),
        },
        setWhere: eq(placesSources.placeId, placeId),
      })
      .returning({ id: placesSources.id });

    if (linked.length === 0) {
      throw new ApiError(
        'conflict',
        'That source record is already linked to a different GoWay place.',
      );
    }
  }
}

/** Every source reference a write mentions, including the ones on capabilities. */
function collectSourceRefs(input: PlaceWriteInput): SourceRefInput[] {
  const seen = new Map<string, SourceRefInput>();
  for (const ref of [
    ...(input.sources ?? []),
    ...(input.capabilities ?? []).flatMap((capability) => (capability.source ? [capability.source] : [])),
  ]) {
    seen.set(`${ref.source}\u0000${ref.sourceId}`, ref);
  }
  return [...seen.values()];
}

/**
 * Write the capability assertions a request carries.
 *
 * The verification tier comes from {@link PlaceActor} or, for a sourced claim,
 * is `external_source` — never from the request body. `(place, namespace,
 * capability, verification)` is the conflict target, so a new community report
 * refreshes the community report and leaves an Oxy-verified fact about the same
 * capability untouched beside it. Nothing here deletes a row: a capability is
 * withdrawn by a moderation path that can record WHO withdrew it, not by a
 * PATCH that happened to omit it.
 */
async function applyCapabilities(
  tx: DatabaseOrTransaction,
  placeId: string,
  capabilities: readonly CapabilityInput[],
  actor: PlaceActor,
): Promise<void> {
  if (capabilities.length === 0) return;

  const sourceRows = await tx
    .select({ id: placesSources.id, source: placesSources.source, sourceId: placesSources.sourceId })
    .from(placesSources)
    .where(eq(placesSources.placeId, placeId));
  const sourceIdByRef = new Map(sourceRows.map((row) => [`${row.source}\u0000${row.sourceId}`, row.id]));

  const now = new Date();
  for (const capability of capabilities) {
    const placeSourceId = capability.source
      ? sourceIdByRef.get(`${capability.source.source}\u0000${capability.source.sourceId}`) ?? null
      : null;
    // The ONLY expression in this package that produces a value for the
    // `verification` column. Both branches are server-derived — evidence on the
    // left, the caller's standing on the right — and neither reads the request
    // body. `assertWritableVerification` is the runtime half of the guarantee
    // the `PlaceActor` type makes at compile time: a moderation-only tier that
    // reached here through a cast refuses the write instead of committing it.
    const verification: CapabilityVerification = assertWritableVerification(
      capability.source ? 'external_source' : actor.assertedVerification,
    );

    await tx
      .insert(placesCapabilities)
      .values({
        placeId,
        namespace: capability.namespace,
        capability: capability.capability,
        value: capability.value,
        verification,
        observedAt: now,
        placeSourceId,
      })
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
          updatedAt: now,
        },
      });
  }
}

/** The `places` column values a write sets, address and contact flattened. */
function placeColumnValues(input: PlaceWriteInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.location !== undefined) {
    values.latitude = input.location.latitude;
    values.longitude = input.location.longitude;
  }
  if (input.geometry !== undefined) values.geometry = input.geometry;
  if (input.categories !== undefined) values.categories = input.categories;
  if (input.status !== undefined) values.status = input.status;
  if (input.openingHours !== undefined) values.openingHours = input.openingHours;
  if (input.address !== undefined) {
    values.addressHouseNumber = input.address.houseNumber ?? null;
    values.addressStreet = input.address.street ?? null;
    values.addressLocality = input.address.locality ?? null;
    values.addressCity = input.address.city ?? null;
    values.addressRegion = input.address.region ?? null;
    values.addressPostalCode = input.address.postalCode ?? null;
    values.addressCountryCode = input.address.countryCode ?? null;
    values.addressCountry = input.address.country ?? null;
    values.addressFormatted = input.address.formatted ?? null;
  }
  if (input.contact !== undefined) {
    values.contactPhone = input.contact.phone ?? null;
    values.contactEmail = input.contact.email ?? null;
    values.contactWebsite = input.contact.website ?? null;
  }
  return values;
}

// ── Writes ──────────────────────────────────────────────────────────────────

/**
 * Create a GoWay place.
 *
 * Source collisions are checked BEFORE the transaction opens, because the
 * response to one is not just a refusal: the two places have to be recorded as
 * duplicate candidates, and a write made inside the transaction that then
 * throws would roll that record back along with everything else. (On create
 * there is no second place yet, so the collision is a plain `conflict`; the
 * candidate is recorded on the UPDATE path, where both places exist.)
 *
 * The place is never assigned a verification state above `unverified` here.
 * Nothing a caller sends can raise it: verification is an Oxy act.
 */
export async function createPlace(
  db: Database,
  input: PlaceWriteInput & { name: string; location: { latitude: number; longitude: number } },
  actor: PlaceActor,
): Promise<Place> {
  const refs = collectSourceRefs(input);
  for (const ref of refs) {
    const owner = await findPlaceIdBySourceRef(db, ref);
    if (owner !== null) {
      throw new ApiError(
        'conflict',
        'That source record is already linked to a GoWay place.',
        { placeId: owner },
      );
    }
  }

  const id = await db.transaction(async (tx) => {
    const [row] = await tx
      .insert(places)
      .values({
        ...placeColumnValues(input),
        name: input.name,
        latitude: input.location.latitude,
        longitude: input.location.longitude,
        createdByOxyUserId: actor.oxyUserId,
      })
      .returning({ id: places.id });
    if (!row) throw new ApiError('internal_error', 'The place could not be created.');

    await linkSources(tx, row.id, refs);
    await applyPlaceNames(tx, row.id, GOWAY_NAME_SOURCE, input.names ?? []);
    await applyCapabilities(tx, row.id, input.capabilities ?? [], actor);
    return row.id;
  });

  // Duplicate detection runs AFTER the place is committed and outside its
  // transaction, and a failure to detect is not a failure to create: a missed
  // candidate is a review that does not happen, while a rolled-back create is a
  // contribution the user has to make again.
  await recordNameCandidates(db, id, input.name, input.location.longitude, input.location.latitude);

  const place = await findPlaceById(db, id);
  if (!place) throw new ApiError('internal_error', 'The place could not be read back.');
  return place;
}

/**
 * Update a place.
 *
 * Source refs are ADDED, never replaced: an update that omits a source does not
 * unlink it, because provenance is not a field a later writer owns. A source
 * ref already bound to a DIFFERENT place is refused — and the two places are
 * recorded as duplicate candidates first, since somebody has just told GoWay
 * they are the same record.
 */
export async function updatePlace(
  db: Database,
  id: string,
  input: PlaceWriteInput,
  actor: PlaceActor,
): Promise<Place | null> {
  const refs = collectSourceRefs(input);
  for (const ref of refs) {
    const owner = await findPlaceIdBySourceRef(db, ref);
    if (owner !== null && owner !== id) {
      // Recorded before the refusal, and outside any transaction this function
      // later aborts: the claim that these two are the same record is exactly
      // the evidence a reviewer needs, and losing it to a rollback would mean
      // the collision is rediscovered from scratch on every retry.
      await recordDuplicateCandidate(db, id, owner, 'shared_source_id');
      throw new ApiError(
        'conflict',
        'That source record is already linked to a different GoWay place.',
        { placeId: owner },
      );
    }
  }

  const updated = await db.transaction(async (tx) => {
    const values = placeColumnValues(input);
    // `updated_at` moves for ANY change the request makes, including one that
    // only touches children — a client caching on `updatedAt` must not miss a
    // new capability because the `places` row itself was untouched.
    const [row] = await tx
      .update(places)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(places.id, id))
      .returning({ id: places.id });
    if (!row) return null;

    await linkSources(tx, id, refs);
    await applyPlaceNames(tx, id, GOWAY_NAME_SOURCE, input.names ?? []);
    await applyCapabilities(tx, id, input.capabilities ?? [], actor);
    return row.id;
  });

  if (updated === null) return null;

  // A new name — in any language — is new evidence about which places are the
  // same place, so detection re-runs on the same terms `createPlace` uses. It
  // does NOT run for an update that touched neither, because re-deriving the
  // same candidates on every opening-hours edit is a write per edit that
  // `on conflict do nothing` then discards.
  if (input.name !== undefined || (input.names?.length ?? 0) > 0) {
    const [current] = await db
      .select({ name: places.name, latitude: places.latitude, longitude: places.longitude })
      .from(places)
      .where(eq(places.id, id))
      .limit(1);
    if (current) {
      await recordNameCandidates(db, id, current.name, current.longitude, current.latitude);
    }
  }

  return findPlaceById(db, id);
}

/**
 * Run both name rules over a place and file what each one finds.
 *
 * One function so the two call sites cannot come to disagree about which rules
 * apply, and so each candidate is filed under the rule that is actually true of
 * it — the plain rule for equal default names, the translated rule for an
 * intersecting name set. A reviewer who cannot tell which fired cannot weigh
 * the answer.
 */
async function recordNameCandidates(
  db: Database,
  placeId: string,
  name: string,
  longitude: number,
  latitude: number,
): Promise<void> {
  const [exact, translated] = await Promise.all([
    findProximityNameCandidates(db, placeId, name, longitude, latitude),
    findTranslatedNameCandidates(db, placeId, longitude, latitude),
  ]);
  for (const candidate of exact) {
    await recordDuplicateCandidate(db, placeId, candidate, 'proximity_and_name');
  }
  for (const candidate of translated) {
    await recordDuplicateCandidate(db, placeId, candidate, 'proximity_and_translated_name');
  }
}

// ── Capability assertions ───────────────────────────────────────────────────

/** One capability key, already split into its two parts. */
export interface CapabilityKeyParts {
  namespace: string;
  capability: string;
}

/**
 * Assert ONE capability on an existing place, at the tier the caller has
 * earned.
 *
 * The single-capability sibling of the `capabilities` array a place write
 * carries, and it goes through the SAME {@link applyCapabilities}: one conflict
 * target, one tier derivation, one `observed_at` rule. A second implementation
 * of "write a capability" is a second chance for the two to disagree about
 * which tier a caller gets, which is the one disagreement this issue exists to
 * prevent.
 *
 * Returns `null` when no place has that id — a concurrent delete between the
 * route's authorization read and this write.
 */
export async function assertPlaceCapability(
  db: Database,
  placeId: string,
  assertion: CapabilityInput,
  actor: PlaceActor,
): Promise<Place | null> {
  if (assertion.source) {
    const owner = await findPlaceIdBySourceRef(db, assertion.source);
    if (owner !== null && owner !== placeId) {
      // Recorded before the refusal and outside the transaction below, for the
      // reason `updatePlace` gives: the claim that these two places are one
      // record is the evidence a reviewer needs, and a rollback would mean
      // rediscovering the collision on every retry.
      await recordDuplicateCandidate(db, placeId, owner, 'shared_source_id');
      throw new ApiError(
        'conflict',
        'That source record is already linked to a different GoWay place.',
        { placeId: owner },
      );
    }
  }

  const written = await db.transaction(async (tx) => {
    // `updated_at` moves for a capability-only write too. A client caching on
    // it must not miss a merchant that started accepting FairCoin because the
    // `places` row itself was untouched.
    const [row] = await tx
      .update(places)
      .set({ updatedAt: new Date() })
      .where(eq(places.id, placeId))
      .returning({ id: places.id });
    if (!row) return null;

    if (assertion.source) await linkSources(tx, placeId, [assertion.source]);
    await applyCapabilities(tx, placeId, [assertion], actor);
    return row.id;
  });

  if (written === null) return null;
  return findPlaceById(db, placeId);
}

/**
 * Withdraw ONE capability assertion, at ONE verification tier.
 *
 * The tier is a parameter rather than a filter the caller composes, and its
 * type cannot hold `oxy_verified` or `external_source`. That is the whole
 * safety property of this function: the DELETE is scoped to a tier the caller
 * was entitled to write, so no API path can erase an Oxy-verified fact or an
 * external source's assertion — not by asking for it, and not by omitting the
 * predicate, because there is no predicate to omit.
 *
 * Returns whether a row was actually removed, so the route can tell "withdrawn"
 * from "you had nothing at that tier to withdraw" rather than answering 200 for
 * a request that changed nothing.
 */
export async function withdrawPlaceCapability(
  db: Database,
  placeId: string,
  key: CapabilityKeyParts,
  verification: AssertableVerification,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const deleted = await tx
      .delete(placesCapabilities)
      .where(
        and(
          eq(placesCapabilities.placeId, placeId),
          eq(placesCapabilities.namespace, key.namespace),
          eq(placesCapabilities.capability, key.capability),
          eq(placesCapabilities.verification, verification),
        ),
      )
      .returning({ id: placesCapabilities.id });
    if (deleted.length === 0) return false;

    await tx.update(places).set({ updatedAt: new Date() }).where(eq(places.id, placeId));
    return true;
  });
}

// ── Claims ──────────────────────────────────────────────────────────────────

/**
 * Record a claim over a place.
 *
 * `pending` by default, and that default is the point: a claim is a request to
 * be recognised, not recognition. Approving one is a reviewed act that belongs
 * to the claims surface (#6), which is why nothing here can create an approved
 * claim by accident — the state has to be passed explicitly.
 */
export async function createClaim(
  db: DatabaseOrTransaction,
  claim: {
    placeId: string;
    oxyAccountId: string;
    role: PlaceClaimRole;
    brandId?: string;
    state?: 'pending' | 'approved' | 'rejected' | 'revoked';
  },
): Promise<string> {
  const state = claim.state ?? 'pending';
  const [row] = await db
    .insert(placesClaims)
    .values({
      placeId: claim.placeId,
      oxyAccountId: claim.oxyAccountId,
      role: claim.role,
      brandId: claim.brandId ?? null,
      state,
      // The CHECK constraint ties these together: a decided claim has a
      // decision time and a pending one does not.
      decidedAt: state === 'pending' ? null : new Date(),
    })
    .returning({ id: placesClaims.id });
  if (!row) throw new ApiError('internal_error', 'The claim could not be recorded.');
  return row.id;
}

/**
 * Request a claim over a place, as an API caller.
 *
 * The thin, PUBLIC wrapper over {@link createClaim}: it cannot be passed a
 * state, so the only claim an HTTP caller can create is `pending`. That is not
 * a validation rule the route enforces — the parameter does not exist — which
 * matters because an approved claim is what grants `business_asserted`, so a
 * caller who could set their own state could talk their own capability
 * assertions up a tier by asking nicely.
 *
 * A second claim in the SAME role by the same account is a `conflict` rather
 * than a silent no-op or a second row: the caller needs to know their earlier
 * request is still pending instead of assuming this one is new.
 */
export async function requestClaim(
  db: DatabaseOrTransaction,
  request: { placeId: string; oxyAccountId: string; role: PlaceClaimRole; brandId?: string },
): Promise<PlaceClaim> {
  const [row] = await db
    .insert(placesClaims)
    .values({
      placeId: request.placeId,
      oxyAccountId: request.oxyAccountId,
      role: request.role,
      brandId: request.brandId ?? null,
      // Explicitly, rather than by relying on the column default: "a claim is a
      // request to be recognised, not recognition" is the rule this function
      // exists to hold, and a default is something a later migration can change.
      state: 'pending',
      decidedAt: null,
    })
    .onConflictDoNothing({
      target: [placesClaims.placeId, placesClaims.oxyAccountId, placesClaims.role],
    })
    .returning(CLAIM_COLUMNS);

  if (!row) {
    const [existing] = await db
      .select(CLAIM_COLUMNS)
      .from(placesClaims)
      .where(
        and(
          eq(placesClaims.placeId, request.placeId),
          eq(placesClaims.oxyAccountId, request.oxyAccountId),
          eq(placesClaims.role, request.role),
        ),
      )
      .limit(1);
    throw new ApiError(
      'conflict',
      'You already hold a claim on this place in that role.',
      existing ? { claimId: existing.id, state: existing.state } : undefined,
    );
  }
  return toClaim(row);
}

/**
 * The claims on a place, and whether this caller is entitled to see them.
 *
 * The entitlement rule is the one `findPlaceById` already applies to the
 * embedded `claims` field, restated here rather than reinvented: an account
 * that itself holds a claim on the place sees the claims — its own and the ones
 * it is competing with — and nobody else does. Any state counts, because a
 * pending claimant has to be able to see that their request is pending.
 *
 * `exists` is returned separately so the route can answer 404 for an unknown
 * place rather than 403, which would tell a stranger that an id they guessed is
 * real.
 */
export async function listPlaceClaims(
  db: DatabaseOrTransaction,
  placeId: string,
  viewerOxyAccountId: string,
): Promise<{ exists: boolean; entitled: boolean; claims: PlaceClaim[] }> {
  const [[place], rows] = await Promise.all([
    db.select({ id: places.id }).from(places).where(eq(places.id, placeId)).limit(1),
    loadClaims(db, placeId),
  ]);
  return {
    exists: Boolean(place),
    entitled: rows.some((row) => row.oxyAccountId === viewerOxyAccountId),
    claims: rows.map(toClaim),
  };
}

/** A claim plus the place it is over, for the "my claims" read. */
export interface AccountPlaceClaim extends PlaceClaim {
  placeId: PlaceId;
}

/**
 * Every claim one Oxy account holds, in every state.
 *
 * Keyed on the SESSION's account id and on nothing a caller can send. A
 * `?oxyAccountId=` parameter on this read would be an enumeration of who has
 * claimed what, which is a business relationship GoWay publishes to the parties
 * involved and to nobody else.
 */
export async function findAccountClaims(
  db: DatabaseOrTransaction,
  oxyAccountId: string,
): Promise<AccountPlaceClaim[]> {
  const rows = await db
    .select(CLAIM_COLUMNS)
    .from(placesClaims)
    .where(eq(placesClaims.oxyAccountId, oxyAccountId))
    .orderBy(placesClaims.claimedAt, placesClaims.id);
  return rows.map((row) => ({ ...toClaim(row), placeId: row.placeId }));
}

/** Every place one Oxy account or brand holds a claim on — the chain/franchise read. */
export async function findClaimedPlaceIds(
  db: DatabaseOrTransaction,
  by: { oxyAccountId?: string; brandId?: string },
): Promise<string[]> {
  const conditions: SQL[] = [];
  if (by.oxyAccountId) conditions.push(eq(placesClaims.oxyAccountId, by.oxyAccountId));
  if (by.brandId) conditions.push(eq(placesClaims.brandId, by.brandId));
  if (conditions.length === 0) return [];
  const rows = await db
    .selectDistinct({ placeId: placesClaims.placeId })
    .from(placesClaims)
    .where(and(eq(placesClaims.state, 'approved'), or(...conditions)));
  return rows.map((row) => row.placeId);
}

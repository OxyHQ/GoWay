/**
 * Every database access the Places API makes.
 *
 * Controllers call these functions and nothing else — no route in this package
 * imports a drizzle table, builds a predicate or sees a row. Two things follow
 * that are worth more than the indirection costs:
 *
 *  - Every read goes out through `placeMapper`, so the published shape is the
 *    contract in `@goway/contracts` and never a table. A column added to
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
  desc,
  eq,
  gt,
  inArray,
  ne,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { qualified, sqlColumnName } from '@oxy.so/db';
import {
  ABSENT_CAPABILITY_VALUES,
  CAPABILITY_VERIFICATIONS,
  capabilityFilterOf,
  categoryDescendants,
  normalizeLanguageTag,
  PUBLISHED_PLACE_STATUSES,
} from '@goway/contracts';
import type {
  CapabilityFilter,
  CapabilityValue,
  CapabilityVerification,
  DuplicateCandidateReason,
  GeoGeometry,
  OpeningHours,
  Place,
  PlaceClaim,
  PlaceClaimRole,
  PlaceClaimState,
  PlaceContact,
  PlaceHoursException,
  PlaceMediaKind,
  PlaceRating,
  PlaceRevisionChange,
  PlaceStatus,
  PlaceWithDistance,
  StructuredAddress,
  WritablePlaceStatus,
} from '@goway/contracts';
import { ApiError } from '../../http/apiError';
import type { Paged, TimeWindow } from '../../http/cursor';
import {
  assertWritableVerification,
  type AssertableVerification,
} from '../../places/capabilityAuthority';
import { timezoneAt } from '../../places/timezone';
import type { Database, DatabaseOrTransaction } from '../postgres';
import {
  placeHoursExceptions,
  placeMedia,
  placeReviewAggregates,
  places,
  placesCapabilities,
  placesClaims,
  placesDescriptions,
  placesDuplicateCandidates,
  placesNames,
  placesSources,
} from '../schema';
import { distanceTo, withinBoundingBox, withinRadius } from './placeGeo';
import {
  CAPABILITY_COLUMNS,
  CLAIM_COLUMNS,
  DESCRIPTION_COLUMNS,
  HOURS_EXCEPTION_COLUMNS,
  NAME_COLUMNS,
  PLACE_COLUMNS,
  SOURCE_COLUMNS,
  toClaim,
  toHoursException,
  toPlace,
  toPlaceWithDistance,
  type CapabilityRow,
  type ClaimRow,
  type DescriptionRow,
  type HoursExceptionRow,
  type NameRow,
  type PlaceChildren,
  type PlaceNameView,
  type PlaceRow,
  type SourceRow,
} from './placeMapper';
import {
  capabilityField,
  capabilitySnapshot,
  changeOf,
  changesBetween,
  descriptionField,
  hoursExceptionField,
  hoursExceptionSnapshot,
  nameField,
  placeFieldValues,
  recordRevision,
  type FieldValues,
  type RevisionAuthor,
} from './revisions';

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
  /** Already held to the key's registry entry by the contract schema. */
  value: CapabilityValue;
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

/**
 * A translated description as a writer supplies it — `null` withdraws GoWay's
 * own wording in that language. The source is derived, as for a name.
 */
export interface PlaceDescriptionInput {
  language: string;
  description: string | null;
}

export interface PlaceWriteInput {
  name?: string;
  names?: PlaceNameInput[];
  description?: string | null;
  descriptions?: PlaceDescriptionInput[];
  /** The Oxy file of a visible `logo` gallery item of this place; `null` clears it. Update only. */
  logoFileId?: string | null;
  /** The Oxy file of a visible `cover` gallery item of this place; `null` clears it. Update only. */
  coverFileId?: string | null;
  location?: { latitude: number; longitude: number };
  geometry?: GeoGeometry;
  categories?: string[];
  address?: StructuredAddress;
  contact?: PlaceContact;
  openingHours?: OpeningHours;
  status?: WritablePlaceStatus;
  sources?: SourceRefInput[];
  capabilities?: CapabilityInput[];
}

/**
 * Who is writing, and how strongly their unsourced capability claims count.
 *
 * `author` is what the write's revision records. `assertedVerification` is
 * derived by the route from the APPROVED claims the caller acts for — never
 * from anything in the request body — and it is never `oxy_verified`: that
 * tier is an Oxy moderation act, not something an API caller can assert about
 * themselves.
 *
 * The type is `AssertableVerification`, which `places/capabilityAuthority`
 * DERIVES from the origin classification rather than spelling out. That is what
 * makes the exclusion structural instead of a convention: no value of this type
 * can be a moderation-origin tier, so a write path that tried to thread one
 * through would not compile.
 */
export interface PlaceActor {
  author: RevisionAuthor;
  assertedVerification: AssertableVerification;
}

export interface PlaceListFilters {
  /** `key` or `key:value` filter strings, already validated by the contract. */
  capabilities?: readonly string[];
  /** Taxonomy keys; each matches itself and every key below it. */
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

/** Where a nearby page resumes: the last place served, by distance and then id. */
export type NearbyKeyset = readonly [distanceMeters: number, placeId: string];

export interface NearbyQuery extends PlaceListFilters {
  latitude: number;
  longitude: number;
  radiusMeters: number;
  /** Resume strictly after this position. */
  after?: NearbyKeyset | undefined;
}

export interface BoundsQuery extends PlaceListFilters {
  west: number;
  south: number;
  east: number;
  north: number;
  /** Resume strictly after this place id — ids are uuidv7, so this is creation order. */
  after?: string | undefined;
}

/**
 * A place's stored lifecycle: what a route needs to answer `404`, `410`, or a
 * `410` that points at the place a merged one became.
 */
export interface PlaceLifecycle {
  status: PlaceStatus;
  /** Set exactly when `status` is `merged`. */
  mergedIntoPlaceId: string | null;
}

/** One APPROVED claim: an account and the role it holds. */
export interface ApprovedClaim {
  oxyAccountId: string;
  role: PlaceClaimRole;
}

/**
 * The facts a write's authorization is decided from: whether the place can be
 * written at all, and who holds it. Who the CALLER acts for is resolved from
 * these against Oxy, in `places/claimAuthority`.
 */
export interface PlaceAuthorization {
  /** `null` when no place has the id. */
  lifecycle: PlaceLifecycle | null;
  approvedClaims: ApprovedClaim[];
}

// ── Filters ─────────────────────────────────────────────────────────────────

/**
 * A capability's verification tier as a sortable rank, in SQL — the position in
 * `CAPABILITY_VERIFICATIONS`, weakest first, exactly as `placeMapper` and the
 * contract's `strongestCapability` rank it.
 */
const verificationRank = sql`array_position(ARRAY[${sql.join(
  CAPABILITY_VERIFICATIONS.map((verification) => sql`${verification}`),
  sql`, `,
)}]::text[], ${placesCapabilities.verification})`;

/**
 * `capabilityHolds`, in SQL, over a subquery's `key` and `value`: anything but
 * `false`, `0`, `""` or `[]`, and not an enum value the registry names as the
 * absence of the thing (`accessibility.wheelchair = "no"`).
 */
function holds(key: SQL | PgColumn, value: SQL | PgColumn): SQL {
  const absent = ABSENT_CAPABILITY_VALUES.map(
    ([absentKey, absentValue]) => sql`(${key} = ${absentKey} and ${value} = ${JSON.stringify(absentValue)}::jsonb)`,
  );
  const notAbsent = absent.length > 0 ? sql` and not (${sql.join(absent, sql` or `)})` : sql``;
  return sql`${value} not in ('false'::jsonb, '0'::jsonb, '""'::jsonb, '[]'::jsonb)${notAbsent}`;
}

/**
 * One filter against the strongest assertion of its key. A value matches by
 * jsonb containment, which is equality for a scalar and membership for an enum
 * set (`["italian","pizza"] @> "italian"`).
 */
function matchesFilter(key: SQL | PgColumn, value: SQL | PgColumn, filter: CapabilityFilter): SQL {
  return filter.value === undefined
    ? sql`(${key} = ${filter.key} and ${holds(key, value)})`
    : sql`(${key} = ${filter.key} and ${value} @> ${JSON.stringify(filter.value)}::jsonb)`;
}

/**
 * Capability filtering, expressed so a client never has to know the capability
 * table exists.
 *
 * A CONJUNCTION: `?capabilities=payments.faircoin.accepted,food.cuisine:italian`
 * means both, which is what a wallet looking for somewhere to spend actually
 * wants.
 *
 * ## The VALUE decides, through the strongest assertion
 *
 * A place matches a key when its STRONGEST assertion of that key holds — the
 * same rule as the contract's `placeHasCapability` — and a `key:value` filter
 * when that strongest assertion carries the value (`placeMatchesCapabilityFilter`).
 * Matching the key alone was the original bug: a shop whose business asserted
 * `payments.faircoin.accepted = false` because it stopped accepting FairCoin
 * still came back as a FairCoin merchant, which is the most expensive wrong
 * answer this filter can give. "Strongest" is by verification tier, then
 * freshness, so a business's `false` outranks a community report's `true`, and
 * Oxy verification outranks both.
 *
 * `DISTINCT ON (place, key)` picks that assertion per key in one indexed pass
 * over `places_capabilities_key_idx`; the outer query keeps the places for
 * which EVERY filter matched one of those rows (`bool_or` per filter). Neither
 * subquery is correlated, which is what lets both be written with drizzle's
 * builder and sidesteps the bare-column trap a correlated reference would
 * carry.
 */
function matchesAllCapabilities(db: DatabaseOrTransaction, rawFilters: readonly string[]): SQL {
  const filters = rawFilters
    .map(capabilityFilterOf)
    .filter((filter): filter is CapabilityFilter => filter !== undefined);
  if (filters.length !== rawFilters.length) {
    // The contract refuses a malformed filter before here; matching nothing is
    // the only answer that cannot be a wrong one.
    return sql`false`;
  }
  const keys = [...new Set(filters.map((filter) => filter.key))];
  const strongest = db
    .selectDistinctOn([placesCapabilities.placeId, placesCapabilities.key], {
      placeId: placesCapabilities.placeId,
      key: placesCapabilities.key,
      value: placesCapabilities.value,
    })
    .from(placesCapabilities)
    .where(inArray(placesCapabilities.key, keys))
    .orderBy(placesCapabilities.placeId, placesCapabilities.key, desc(verificationRank), desc(placesCapabilities.observedAt))
    .as('strongest_capability');
  const holding = db
    .select({ placeId: strongest.placeId })
    .from(strongest)
    .groupBy(strongest.placeId)
    .having(
      sql.join(
        filters.map((filter) => sql`bool_or(${matchesFilter(strongest.key, strongest.value, filter)})`),
        sql` and `,
      ),
    );
  return inArray(places.id, holding);
}

/**
 * Only the statuses a place may be published in — never `removed` or `merged`.
 *
 * An allow-list rather than `<> 'removed'`, so a stored status added tomorrow
 * stays off the map until somebody publishes it on purpose.
 */
const isPublished = inArray(places.status, [...PUBLISHED_PLACE_STATUSES]);

/**
 * The predicates every list read shares.
 *
 * Removed and merged places are excluded from LISTS and remain reachable by id:
 * a place withdrawn from the map must stop appearing on it, while a deep link
 * somebody already holds still has to resolve to something rather than 404 —
 * the SDK treats a 404 as "this id is dead" and a consumer may drop a persisted
 * place id on the strength of it. A merged id answers with where it went.
 */
function listPredicates(db: DatabaseOrTransaction, filters: PlaceListFilters): SQL[] {
  const predicates: SQL[] = [isPublished];
  if (filters.capabilities && filters.capabilities.length > 0) {
    predicates.push(matchesAllCapabilities(db, filters.capabilities));
  }
  if (filters.categories && filters.categories.length > 0) {
    // A DISJUNCTION — "cafe or bakery" — because a place carries several
    // categories and asking for two is asking for either. A parent asks for
    // every key below it: a place stores `food.cafe`, never `food` as well.
    // `&&` is array overlap, answered by `places_categories_gin`.
    const keys = [...new Set(filters.categories.flatMap(categoryDescendants))];
    predicates.push(arrayOverlaps(places.categories, keys));
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

/** The most exceptions a single-place read embeds. Every one is still listed by `listHoursExceptions`. */
const MAX_EMBEDDED_HOURS_EXCEPTIONS = 32;

/**
 * The exceptions a single-place read publishes: those that have not ended,
 * earliest first.
 *
 * "Not ended" is judged a day early, against the database's UTC date, because
 * the place's own date is not known here: somewhere it is still yesterday, and
 * an exception that ended there yesterday may be today's. One stale exception
 * costs a reader nothing — `openingStatusAt` only applies one covering today.
 */
async function loadCurrentHoursExceptions(db: DatabaseOrTransaction, placeId: string): Promise<HoursExceptionRow[]> {
  return db
    .select(HOURS_EXCEPTION_COLUMNS)
    .from(placeHoursExceptions)
    .where(and(eq(placeHoursExceptions.placeId, placeId), sql`${placeHoursExceptions.endsOn} >= current_date - 1`))
    .orderBy(placeHoursExceptions.startsOn, placeHoursExceptions.id)
    .limit(MAX_EMBEDDED_HOURS_EXCEPTIONS);
}

async function loadDescriptions(db: DatabaseOrTransaction, placeId: string): Promise<DescriptionRow[]> {
  return db.select(DESCRIPTION_COLUMNS).from(placesDescriptions).where(eq(placesDescriptions.placeId, placeId));
}

/**
 * The rating summary of each place that has a published review, by place id.
 *
 * Read from the DERIVED aggregate row, never computed here: the row is
 * recomputed inside every review write, and a second computation would be a
 * second answer.
 */
export async function loadRatings(
  db: DatabaseOrTransaction,
  placeIds: readonly string[],
): Promise<Map<string, PlaceRating>> {
  if (placeIds.length === 0) return new Map();
  const rows = await db
    .select({
      placeId: placeReviewAggregates.placeId,
      count: placeReviewAggregates.reviewCount,
      average: placeReviewAggregates.ratingAverage,
    })
    .from(placeReviewAggregates)
    .where(and(inArray(placeReviewAggregates.placeId, [...placeIds]), gt(placeReviewAggregates.reviewCount, 0)));
  return new Map(
    rows.flatMap((row) =>
      row.average === null ? [] : [[row.placeId, { average: Math.round(row.average * 10) / 10, count: row.count }] as const],
    ),
  );
}

/**
 * The Oxy file of each VISIBLE gallery item a page's logos and covers name,
 * by item id. One query for the page, and none when no place on it has either.
 */
async function loadMediaFiles(db: DatabaseOrTransaction, rows: readonly PlaceRow[]): Promise<Map<string, string>> {
  const ids = [
    ...new Set(rows.flatMap((row) => [row.logoMediaId, row.coverMediaId].filter((id): id is string => id !== null))),
  ];
  if (ids.length === 0) return new Map();
  const media = await db
    .select({ id: placeMedia.id, fileId: placeMedia.oxyFileId })
    .from(placeMedia)
    .where(and(inArray(placeMedia.id, ids), eq(placeMedia.state, 'visible')));
  return new Map(media.map((item) => [item.id, item.fileId]));
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
): Promise<Map<string, PlaceChildren>> {
  const ids = rows.map((row) => row.id);
  // The names query is issued only when the read was asked about names. A
  // viewport that never mentioned a locale must not pay for 200 places' worth
  // of translations to throw them away in the mapper.
  const [sources, capabilities, names, ratings, mediaFiles] = await Promise.all([
    loadSources(db, ids),
    loadCapabilities(db, ids),
    needsNames(view) ? loadNames(db, ids) : Promise.resolve([]),
    loadRatings(db, ids),
    loadMediaFiles(db, rows),
  ]);
  const sourcesByPlace = groupByPlace(sources);
  const capabilitiesByPlace = groupByPlace(capabilities);
  const namesByPlace = groupByPlace(names);
  return new Map(
    ids.map((id) => {
      const children: PlaceChildren = {
        sources: sourcesByPlace.get(id) ?? [],
        capabilities: capabilitiesByPlace.get(id) ?? [],
        names: namesByPlace.get(id) ?? [],
        mediaFiles,
      };
      const rating = ratings.get(id);
      if (rating) children.rating = rating;
      return [id, children];
    }),
  );
}

/** The empty hydration, for a row whose children somehow did not load. */
const NO_CHILDREN: PlaceChildren = { sources: [], capabilities: [], names: [] };

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * One published place by its GoWay id — never a removed or merged one.
 *
 * A removed or merged place is `null` here exactly as a missing one is; a route
 * that has to tell them apart (`404` against `410`) asks
 * {@link findPlaceLifecycle}.
 *
 * `viewerOxyAccountId` decides whether claim details are published: they are
 * shown to a session that itself holds a claim on the place (its own claim and
 * the ones it is competing with), and absent for everybody else. Absent is not
 * empty — see `placeMapper`. Only the session's own account counts here, never
 * a membership: this is the public read, and it must not wait on Oxy or fail
 * with it. A member who has not switched into the organization reads the
 * claims through `GET /places/{placeId}/claims`, which does ask.
 */
export async function findPlaceById(
  db: DatabaseOrTransaction,
  id: string,
  viewerOxyAccountId?: string | null,
  locale?: string | undefined,
): Promise<Place | null> {
  const [row] = await db
    .select(PLACE_COLUMNS)
    .from(places)
    .where(and(eq(places.id, id), isPublished))
    .limit(1);
  if (!row) return null;

  const [sources, capabilities, names, hoursExceptions, claims, descriptions, ratings, mediaFiles] = await Promise.all([
    loadSources(db, [id]),
    loadCapabilities(db, [id]),
    loadNames(db, [id]),
    loadCurrentHoursExceptions(db, id),
    viewerOxyAccountId ? loadClaims(db, id) : Promise.resolve(null),
    loadDescriptions(db, id),
    loadRatings(db, [id]),
    loadMediaFiles(db, [row]),
  ]);

  const visibleClaims =
    claims !== null && claims.some((claim) => claim.oxyAccountId === viewerOxyAccountId)
      ? claims
      : undefined;

  // The single-place read ALWAYS publishes the full set — unconditionally, and
  // not only when a locale was asked for. "What else is this called" is a fact
  // about the place, and a detail view that showed it only to callers who
  // already knew which language to ask for would be useless to the caller who
  // does not. Descriptions follow the same rule.
  const children: PlaceChildren = {
    sources,
    capabilities,
    names,
    hoursExceptions,
    claims: visibleClaims,
    descriptions,
    mediaFiles,
  };
  const rating = ratings.get(id);
  if (rating) children.rating = rating;
  return toPlace(row, children, { publishAll: true, locale });
}

/**
 * Places within a radius, nearest first (ties by id), with the distance each
 * is from the query point.
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
  const predicates = [withinRadius(query.longitude, query.latitude, query.radiusMeters), ...listPredicates(db, query)];
  if (query.after) {
    // A row comparison, so a tie in distance resumes by id rather than
    // skipping or repeating the places that share it. `ST_Distance` is
    // deterministic for the same inputs and the float round-trips exactly, so
    // the position names the same row it was minted from.
    predicates.push(sql`(${distance}, ${places.id}) > (${query.after[0]}::float8, ${query.after[1]})`);
  }
  const rows = await db
    .select({ ...PLACE_COLUMNS, distanceMeters: distance })
    .from(places)
    .where(and(...predicates))
    .orderBy(distance, places.id)
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
  const predicates = [withinBoundingBox(query), ...listPredicates(db, query)];
  if (query.after !== undefined) predicates.push(gt(places.id, query.after));
  const rows = await db
    .select(PLACE_COLUMNS)
    .from(places)
    .where(and(...predicates))
    .orderBy(places.id)
    .limit(query.limit);

  const view = nameViewOf(query);
  const children = await hydrate(db, rows, view);
  return rows.map((row) => toPlace(row, children.get(row.id) ?? NO_CHILDREN, view));
}

// ── Authorization inputs ────────────────────────────────────────────────────

/**
 * A place's stored status and merge pointer, or `null` when no place has the id.
 *
 * What a route asks to answer `410 gone` for a place moderation removed or
 * merged — the second with the survivor's id — and `404 not_found` for one that
 * never existed: a consumer holding a persisted id acts differently on each.
 */
export async function findPlaceLifecycle(db: DatabaseOrTransaction, placeId: string): Promise<PlaceLifecycle | null> {
  const [row] = await db
    .select({ status: places.status, mergedIntoPlaceId: places.mergedIntoPlaceId })
    .from(places)
    .where(eq(places.id, placeId))
    .limit(1);
  return row ? { status: row.status as PlaceStatus, mergedIntoPlaceId: row.mergedIntoPlaceId } : null;
}

/**
 * What the route needs to decide whether this caller may edit this place, and
 * how much their capability claims are worth.
 *
 * Returned as data rather than decided here: authorization is an HTTP-layer
 * concern (it chooses between 403, 404, 410 and a write), and whether the
 * caller acts for a claim is a question for Oxy (`places/claimAuthority`), not
 * for this database.
 */
export async function getPlaceAuthorization(db: DatabaseOrTransaction, placeId: string): Promise<PlaceAuthorization> {
  const [lifecycle, claims] = await Promise.all([
    findPlaceLifecycle(db, placeId),
    db
      .select({ oxyAccountId: placesClaims.oxyAccountId, role: placesClaims.role })
      .from(placesClaims)
      .where(and(eq(placesClaims.placeId, placeId), eq(placesClaims.state, 'approved'))),
  ]);
  return {
    lifecycle,
    approvedClaims: claims.map((claim) => ({ oxyAccountId: claim.oxyAccountId, role: claim.role as PlaceClaimRole })),
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
 *
 * Returns a `sources` change for each record NEWLY bound. A re-confirmation of
 * a record already bound is a freshness bump, not a change to the place.
 * `xmax = 0` is Postgres's own answer to "did this upsert insert": an updated
 * row carries the updating transaction's id there.
 */
async function linkSources(
  tx: DatabaseOrTransaction,
  placeId: string,
  refs: readonly SourceRefInput[],
): Promise<PlaceRevisionChange[]> {
  const changes: PlaceRevisionChange[] = [];
  for (const ref of refs) {
    const [linked] = await tx
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
      .returning({ id: placesSources.id, inserted: sql<boolean>`(xmax = 0)` });

    if (!linked) {
      throw new ApiError(
        'conflict',
        'That source record is already linked to a different GoWay place.',
      );
    }
    if (linked.inserted) changes.push({ field: 'sources', after: { source: ref.source, sourceId: ref.sourceId } });
  }
  return changes;
}

/**
 * Write a caller's translated names as GoWay corrections, and say which changed.
 *
 * {@link applyPlaceNames} is the importer's function too, and it stays exactly
 * that: the diff is taken around it, from the `goway` rows before and after,
 * rather than threaded through a signature the import shares.
 */
async function applyGowayNames(
  tx: DatabaseOrTransaction,
  placeId: string,
  names: readonly PlaceNameInput[],
): Promise<PlaceRevisionChange[]> {
  if (names.length === 0) return [];
  const read = async (): Promise<FieldValues> => {
    const rows = await tx
      .select({ language: placesNames.language, name: placesNames.name })
      .from(placesNames)
      .where(and(eq(placesNames.placeId, placeId), eq(placesNames.source, GOWAY_NAME_SOURCE)));
    return Object.fromEntries(rows.map((row) => [nameField(row.language), { name: row.name, source: GOWAY_NAME_SOURCE }]));
  };
  const before = await read();
  await applyPlaceNames(tx, placeId, GOWAY_NAME_SOURCE, names);
  return changesBetween(before, await read());
}

/**
 * Write a caller's translated descriptions as GoWay's own wording, and say
 * which changed.
 *
 * A description is upserted on `(place, language, 'goway')` — the importer's
 * rows for the same language are other keys, untouched — and `null` deletes
 * GoWay's row for that language alone. Last writer wins within one call.
 */
async function applyGowayDescriptions(
  tx: DatabaseOrTransaction,
  placeId: string,
  descriptions: readonly PlaceDescriptionInput[],
): Promise<PlaceRevisionChange[]> {
  if (descriptions.length === 0) return [];
  const byLanguage = new Map<string, string | null>();
  for (const entry of descriptions) {
    const language = normalizeLanguageTag(entry.language);
    if (language !== undefined) byLanguage.set(language, entry.description?.trim() || null);
  }
  const read = async (): Promise<FieldValues> => {
    const rows = await tx
      .select({ language: placesDescriptions.language, description: placesDescriptions.description })
      .from(placesDescriptions)
      .where(and(eq(placesDescriptions.placeId, placeId), eq(placesDescriptions.source, GOWAY_NAME_SOURCE)));
    return Object.fromEntries(
      rows.map((row) => [descriptionField(row.language), { description: row.description, source: GOWAY_NAME_SOURCE }]),
    );
  };
  const before = await read();
  const now = new Date();
  for (const [language, description] of byLanguage) {
    const key = and(
      eq(placesDescriptions.placeId, placeId),
      eq(placesDescriptions.language, language),
      eq(placesDescriptions.source, GOWAY_NAME_SOURCE),
    );
    if (description === null) {
      await tx.delete(placesDescriptions).where(key);
      continue;
    }
    await tx
      .insert(placesDescriptions)
      .values({ placeId, language, description, source: GOWAY_NAME_SOURCE, observedAt: now })
      .onConflictDoUpdate({
        target: [placesDescriptions.placeId, placesDescriptions.language, placesDescriptions.source],
        set: { description, observedAt: now, updatedAt: now },
      });
  }
  return changesBetween(before, await read());
}

/**
 * The gallery item a write names as the place's logo or cover, by its Oxy file.
 *
 * It must be a VISIBLE item of THIS place, of the matching kind — a pointer at
 * anything else would publish an image the gallery does not, or one from
 * another place. Anything else is `validation_failed` naming the field.
 */
async function galleryItemFor(
  tx: DatabaseOrTransaction,
  placeId: string,
  fileId: string,
  kind: Extract<PlaceMediaKind, 'logo' | 'cover'>,
  field: string,
): Promise<string> {
  const [item] = await tx
    .select({ id: placeMedia.id })
    .from(placeMedia)
    .where(
      and(
        eq(placeMedia.placeId, placeId),
        eq(placeMedia.oxyFileId, fileId),
        eq(placeMedia.kind, kind),
        eq(placeMedia.state, 'visible'),
      ),
    )
    .limit(1);
  if (!item) {
    throw new ApiError('validation_failed', `The ${field} must be a visible ${kind} in this place's gallery.`, {
      field,
      issue: 'not_in_gallery',
    });
  }
  return item.id;
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
): Promise<PlaceRevisionChange[]> {
  if (capabilities.length === 0) return [];

  const sourceRows = await tx
    .select({ id: placesSources.id, source: placesSources.source, sourceId: placesSources.sourceId })
    .from(placesSources)
    .where(eq(placesSources.placeId, placeId));
  const sourceIdByRef = new Map(sourceRows.map((row) => [`${row.source}\u0000${row.sourceId}`, row.id]));

  const now = new Date();
  const changes: PlaceRevisionChange[] = [];
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
    const atTier = and(
      eq(placesCapabilities.placeId, placeId),
      eq(placesCapabilities.namespace, capability.namespace),
      eq(placesCapabilities.capability, capability.capability),
      eq(placesCapabilities.verification, verification),
    );
    const [before] = await tx.select(CAPABILITY_COLUMNS).from(placesCapabilities).where(atTier).limit(1);

    const [after] = await tx
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
      })
      .returning(CAPABILITY_COLUMNS);

    const change = changeOf(
      capabilityField(`${capability.namespace}.${capability.capability}`),
      before ? capabilitySnapshot(before) : undefined,
      after ? capabilitySnapshot(after) : undefined,
    );
    if (change) changes.push(change);
  }
  return changes;
}

/** The `places` column values a write sets, address and contact flattened. */
function placeColumnValues(input: PlaceWriteInput): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (input.name !== undefined) values.name = input.name;
  if (input.location !== undefined) {
    values.latitude = input.location.latitude;
    values.longitude = input.location.longitude;
    // Derived here and never accepted from the body — see `places/timezone`.
    values.timezone = timezoneAt(input.location.latitude, input.location.longitude);
  }
  if (input.geometry !== undefined) values.geometry = input.geometry;
  if (input.categories !== undefined) values.categories = input.categories;
  if (input.status !== undefined) values.status = input.status;
  if (input.openingHours !== undefined) values.openingHours = input.openingHours;
  if (input.description !== undefined) values.description = input.description;
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
 *
 * Its `place_created` revision records every field the place was created
 * with, in the same transaction.
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
        timezone: timezoneAt(input.location.latitude, input.location.longitude),
        createdByOxyUserId: actor.author.oxyAccountId,
      })
      .returning(PLACE_COLUMNS);
    if (!row) throw new ApiError('internal_error', 'The place could not be created.');

    const changes = [
      ...changesBetween({}, placeFieldValues(row)),
      ...(await linkSources(tx, row.id, refs)),
      ...(await applyGowayNames(tx, row.id, input.names ?? [])),
      ...(await applyGowayDescriptions(tx, row.id, input.descriptions ?? [])),
      ...(await applyCapabilities(tx, row.id, input.capabilities ?? [], actor)),
    ];
    await recordRevision(tx, { placeId: row.id, action: 'place_created', author: actor.author, changes });
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
 *
 * The row is locked `FOR UPDATE` before it is read, so the `place_updated`
 * revision's BEFORE side is the value this write replaced: two concurrent
 * edits are serialized, and neither's history claims to have changed a value
 * the other had already overwritten.
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
    const [before] = await tx.select(PLACE_COLUMNS).from(places).where(eq(places.id, id)).for('update');
    if (!before) return null;

    // A logo or cover names a gallery item by its Oxy file; the column holds
    // the item, resolved under the same lock as the rest of the write.
    const pointers: { logoMediaId?: string | null; coverMediaId?: string | null } = {};
    if (input.logoFileId !== undefined) {
      pointers.logoMediaId =
        input.logoFileId === null ? null : await galleryItemFor(tx, id, input.logoFileId, 'logo', 'logoFileId');
    }
    if (input.coverFileId !== undefined) {
      pointers.coverMediaId =
        input.coverFileId === null ? null : await galleryItemFor(tx, id, input.coverFileId, 'cover', 'coverFileId');
    }

    // `updated_at` moves for ANY change the request makes, including one that
    // only touches children — a client caching on `updatedAt` must not miss a
    // new capability because the `places` row itself was untouched.
    const [after] = await tx
      .update(places)
      .set({ ...placeColumnValues(input), ...pointers, updatedAt: new Date() })
      .where(eq(places.id, id))
      .returning(PLACE_COLUMNS);
    if (!after) return null;

    const changes = [
      ...changesBetween(placeFieldValues(before), placeFieldValues(after)),
      ...(await linkSources(tx, id, refs)),
      ...(await applyGowayNames(tx, id, input.names ?? [])),
      ...(await applyGowayDescriptions(tx, id, input.descriptions ?? [])),
      ...(await applyCapabilities(tx, id, input.capabilities ?? [], actor)),
    ];
    await recordRevision(tx, { placeId: id, action: 'place_updated', author: actor.author, changes });
    return after.id;
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

    const changes = [
      ...(assertion.source ? await linkSources(tx, placeId, [assertion.source]) : []),
      ...(await applyCapabilities(tx, placeId, [assertion], actor)),
    ];
    await recordRevision(tx, { placeId, action: 'capability_asserted', author: actor.author, changes });
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
  author: RevisionAuthor,
): Promise<boolean> {
  return db.transaction(async (tx) => deleteCapabilityAtTier(tx, placeId, key, verification, author));
}

/**
 * Delete one capability assertion at one tier and record its
 * `capability_withdrawn` revision, in the caller's transaction.
 *
 * Shared by the business's withdrawal above and moderation's withdrawal of the
 * `oxy_verified` tier, so the two cannot disagree about what a withdrawal
 * records. The tier is always a parameter its caller was entitled to name.
 */
export async function deleteCapabilityAtTier(
  tx: DatabaseOrTransaction,
  placeId: string,
  key: CapabilityKeyParts,
  verification: CapabilityVerification,
  author: RevisionAuthor,
): Promise<boolean> {
  const [deleted] = await tx
    .delete(placesCapabilities)
    .where(
      and(
        eq(placesCapabilities.placeId, placeId),
        eq(placesCapabilities.namespace, key.namespace),
        eq(placesCapabilities.capability, key.capability),
        eq(placesCapabilities.verification, verification),
      ),
    )
    .returning(CAPABILITY_COLUMNS);
  if (!deleted) return false;

  await tx.update(places).set({ updatedAt: new Date() }).where(eq(places.id, placeId));
  await recordRevision(tx, {
    placeId,
    action: 'capability_withdrawn',
    author,
    changes: [{ field: capabilityField(`${key.namespace}.${key.capability}`), before: capabilitySnapshot(deleted) }],
  });
  return true;
}

// ── Hours exceptions ────────────────────────────────────────────────────────

/** The source key every exception written through the API carries — as for names. */
export const GOWAY_HOURS_SOURCE = 'goway';

/** An exception as a writer supplies it, already parsed by the contract. */
export interface HoursExceptionInput {
  startsOn: string;
  endsOn?: string | undefined;
  closed: boolean;
  intervals?: { opens: string; closes: string }[] | undefined;
  note?: string | undefined;
}

/** The columns an input writes — `ends_on` defaulted, intervals empty when closed. */
function hoursExceptionValues(input: HoursExceptionInput) {
  return {
    startsOn: input.startsOn,
    endsOn: input.endsOn ?? input.startsOn,
    closed: input.closed,
    intervals: input.closed ? [] : (input.intervals ?? []),
    note: input.note ?? null,
  };
}

/** The `conflict` for a range this tier already holds an exception for. */
function rangeTaken(existing: { id: string } | undefined): ApiError {
  return new ApiError(
    'conflict',
    'An exception for exactly those dates already exists at your tier; rewrite that one instead.',
    existing ? { exceptionId: existing.id } : undefined,
  );
}

/** The existing exception for a range at a tier, if any. */
async function findExceptionForRange(
  db: DatabaseOrTransaction,
  placeId: string,
  range: { startsOn: string; endsOn: string },
  verification: CapabilityVerification,
): Promise<{ id: string } | undefined> {
  const [row] = await db
    .select({ id: placeHoursExceptions.id })
    .from(placeHoursExceptions)
    .where(
      and(
        eq(placeHoursExceptions.placeId, placeId),
        eq(placeHoursExceptions.startsOn, range.startsOn),
        eq(placeHoursExceptions.endsOn, range.endsOn),
        eq(placeHoursExceptions.verification, verification),
      ),
    )
    .limit(1);
  return row;
}

/**
 * Record a dated exception at the tier the caller's standing earns.
 *
 * The tier comes from {@link PlaceActor}, exactly as for a capability: the
 * body cannot name one, and `assertWritableVerification` refuses a moderation
 * tier that reached here by a cast. A second exception for the SAME dates at
 * the same tier is a `conflict` naming the existing one — rewrite it — while
 * the same dates at another tier land beside it, so a passer-by's report never
 * replaces the business's own notice.
 *
 * `places.updated_at` moves with it: a client caching a place must not miss
 * that it is closed tomorrow. The `hours_exception_created` revision is
 * recorded in the same transaction.
 */
export async function createHoursException(
  db: Database,
  placeId: string,
  input: HoursExceptionInput,
  actor: PlaceActor,
): Promise<PlaceHoursException | null> {
  const verification = assertWritableVerification(actor.assertedVerification);
  const values = hoursExceptionValues(input);
  return db.transaction(async (tx) => {
    const [place] = await tx
      .update(places)
      .set({ updatedAt: new Date() })
      .where(eq(places.id, placeId))
      .returning({ id: places.id });
    if (!place) return null;

    const [row] = await tx
      .insert(placeHoursExceptions)
      .values({ placeId, ...values, source: GOWAY_HOURS_SOURCE, verification, observedAt: new Date() })
      .onConflictDoNothing({
        target: [
          placeHoursExceptions.placeId,
          placeHoursExceptions.startsOn,
          placeHoursExceptions.endsOn,
          placeHoursExceptions.verification,
        ],
      })
      .returning(HOURS_EXCEPTION_COLUMNS);
    if (!row) throw rangeTaken(await findExceptionForRange(tx, placeId, values, verification));

    await recordRevision(tx, {
      placeId,
      action: 'hours_exception_created',
      author: actor.author,
      changes: [{ field: hoursExceptionField(row.id), after: hoursExceptionSnapshot(row) }],
    });
    return toHoursException(row);
  });
}

/** One exception of one place, or `undefined`. */
export async function findHoursException(
  db: DatabaseOrTransaction,
  placeId: string,
  exceptionId: string,
): Promise<PlaceHoursException | undefined> {
  const [row] = await db
    .select(HOURS_EXCEPTION_COLUMNS)
    .from(placeHoursExceptions)
    .where(and(eq(placeHoursExceptions.placeId, placeId), eq(placeHoursExceptions.id, exceptionId)))
    .limit(1);
  return row ? toHoursException(row) : undefined;
}

/**
 * Rewrite one exception, keeping its tier.
 *
 * The route has already checked that the caller's tier IS the row's tier; the
 * UPDATE re-states it as a predicate, so a row whose tier is not the caller's
 * cannot be rewritten even by a route that forgot. Returns `undefined` when no
 * row of that id and tier exists. The row is locked before it is read, so the
 * `hours_exception_replaced` revision's BEFORE side is the value this write
 * replaced.
 */
export async function replaceHoursException(
  db: Database,
  placeId: string,
  exceptionId: string,
  input: HoursExceptionInput,
  verification: AssertableVerification,
  author: RevisionAuthor,
): Promise<PlaceHoursException | undefined> {
  const values = hoursExceptionValues(input);
  return db.transaction(async (tx) => {
    const atTier = and(
      eq(placeHoursExceptions.placeId, placeId),
      eq(placeHoursExceptions.id, exceptionId),
      eq(placeHoursExceptions.verification, verification),
    );
    const [before] = await tx.select(HOURS_EXCEPTION_COLUMNS).from(placeHoursExceptions).where(atTier).for('update');
    if (!before) return undefined;

    const clash = await findExceptionForRange(tx, placeId, values, verification);
    if (clash && clash.id !== exceptionId) throw rangeTaken(clash);

    const now = new Date();
    const [row] = await tx
      .update(placeHoursExceptions)
      .set({ ...values, observedAt: now, updatedAt: now })
      .where(atTier)
      .returning(HOURS_EXCEPTION_COLUMNS);
    if (!row) return undefined;
    await tx.update(places).set({ updatedAt: now }).where(eq(places.id, placeId));

    const field = hoursExceptionField(row.id);
    const change = changeOf(field, hoursExceptionSnapshot(before), hoursExceptionSnapshot(row));
    await recordRevision(tx, {
      placeId,
      action: 'hours_exception_replaced',
      author,
      changes: change ? [change] : [],
    });
    return toHoursException(row);
  });
}

/**
 * Withdraw one exception at ONE tier — the capability rule: the tier is a
 * parameter whose type cannot hold `oxy_verified` or `external_source`, so no
 * API path can delete an exception it was not entitled to write. The
 * `hours_exception_withdrawn` revision records what was withdrawn.
 */
export async function withdrawHoursException(
  db: Database,
  placeId: string,
  exceptionId: string,
  verification: AssertableVerification,
  author: RevisionAuthor,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(placeHoursExceptions)
      .where(
        and(
          eq(placeHoursExceptions.placeId, placeId),
          eq(placeHoursExceptions.id, exceptionId),
          eq(placeHoursExceptions.verification, verification),
        ),
      )
      .returning(HOURS_EXCEPTION_COLUMNS);
    if (!deleted) return false;
    await tx.update(places).set({ updatedAt: new Date() }).where(eq(places.id, placeId));
    await recordRevision(tx, {
      placeId,
      action: 'hours_exception_withdrawn',
      author,
      changes: [{ field: hoursExceptionField(deleted.id), before: hoursExceptionSnapshot(deleted) }],
    });
    return true;
  });
}

/** Where a page of exceptions resumes: the last one served, by start date and id. */
export type HoursExceptionKeyset = readonly [startsOn: string, exceptionId: string];

/** One window of a place's exceptions, past ones included, earliest first. */
export async function listHoursExceptions(
  db: DatabaseOrTransaction,
  placeId: string,
  window: { limit: number; after?: HoursExceptionKeyset | undefined },
): Promise<PlaceHoursException[]> {
  const rows = await db
    .select(HOURS_EXCEPTION_COLUMNS)
    .from(placeHoursExceptions)
    .where(
      and(
        eq(placeHoursExceptions.placeId, placeId),
        window.after
          ? sql`(${placeHoursExceptions.startsOn}, ${placeHoursExceptions.id}) > (${window.after[0]}::date, ${window.after[1]})`
          : undefined,
      ),
    )
    .orderBy(placeHoursExceptions.startsOn, placeHoursExceptions.id)
    .limit(window.limit);
  return rows.map(toHoursException);
}

// ── Claims ──────────────────────────────────────────────────────────────────

/**
 * Seed a claim in any state, with no revision.
 *
 * A FIXTURE writer for tests and data repair, and nothing an HTTP path calls:
 * the API files claims through {@link requestClaim}, which can only create a
 * `pending` one and records its revision, and moderation decides them through
 * `moderationRepository`, which records theirs. Nothing here can create an
 * approved claim by accident — the state has to be passed explicitly.
 */
export async function createClaim(
  db: DatabaseOrTransaction,
  claim: {
    placeId: string;
    oxyAccountId: string;
    role: PlaceClaimRole;
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
      state,
      // The CHECK constraint ties these together: a decided claim has a
      // decision time and a pending one does not.
      decidedAt: state === 'pending' ? null : new Date(),
    })
    .returning({ id: placesClaims.id });
  if (!row) throw new ApiError('internal_error', 'The claim could not be recorded.');
  return row.id;
}

/** The field a claim's revisions are recorded under. Claims are moderation-visible only. */
export function claimField(claimId: string): string {
  return `claims.${claimId}`;
}

/**
 * Request a claim over a place, as an API caller.
 *
 * The PUBLIC way a claim comes to exist: it cannot be passed a state, so the
 * only claim an HTTP caller can create is `pending`. That is not a validation
 * rule the route enforces — the parameter does not exist — which matters
 * because an approved claim is what grants `business_asserted`, so a caller who
 * could set their own state could talk their own capability assertions up a
 * tier by asking nicely.
 *
 * `oxyAccountId` is the account the claim is FOR, which the route has already
 * checked the caller may file for; `author` is who filed it, and the
 * `claim_requested` revision records both in the same transaction.
 *
 * A second claim in the SAME role by the same account is a `conflict` rather
 * than a silent no-op or a second row: the caller needs to know their earlier
 * request is still pending instead of assuming this one is new.
 */
export async function requestClaim(
  db: Database,
  request: { placeId: string; oxyAccountId: string; role: PlaceClaimRole },
  author: RevisionAuthor,
): Promise<PlaceClaim> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(placesClaims)
      .values({
        placeId: request.placeId,
        oxyAccountId: request.oxyAccountId,
        role: request.role,
        // Explicitly, rather than by relying on the column default: "a claim is
        // a request to be recognised, not recognition" is the rule this function
        // exists to hold, and a default is something a later migration can change.
        state: 'pending',
        decidedAt: null,
      })
      .onConflictDoNothing({
        target: [placesClaims.placeId, placesClaims.oxyAccountId, placesClaims.role],
      })
      .returning(CLAIM_COLUMNS);

    if (!row) {
      const [existing] = await tx
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
        'That account already holds a claim on this place in that role.',
        existing ? { claimId: existing.id, state: existing.state } : undefined,
      );
    }

    await recordRevision(tx, {
      placeId: request.placeId,
      action: 'claim_requested',
      author,
      changes: [
        { field: claimField(row.id), after: { oxyAccountId: row.oxyAccountId, role: row.role, state: row.state } },
      ],
    });
    return toClaim(row);
  });
}

/** A `(claimedAt, id)` keyset over claims, oldest first. See `timeKeysetSchema` for why the timestamp is text. */
function claimWindow(window: TimeWindow): SQL | undefined {
  return window.after
    ? sql`(${placesClaims.claimedAt}, ${placesClaims.id}) > (${window.after[0]}::timestamptz, ${window.after[1]})`
    : undefined;
}

const CLAIM_PAGE_COLUMNS = { ...CLAIM_COLUMNS, position: sql<string>`${placesClaims.claimedAt}::text` } as const;

function pagedClaim(row: ClaimRow & { position: string }): Paged<PlaceClaim> {
  return { item: toClaim(row), position: [row.position, row.id] };
}

/**
 * One window of the claims on a place, and the facts the route decides who may
 * see them from.
 *
 * `claimantAccountIds` is every account holding a claim on the place in ANY
 * state, asked of the whole table rather than the window so the answer does
 * not depend on which page the caller's own claim falls on. The route lets a
 * caller see the claims when they act for one of those accounts — its own
 * claim and the ones it is competing with — which is the rule `findPlaceById`
 * applies to the embedded `claims` field, widened to Oxy membership. A pending
 * claimant counts: they have to be able to see that their request is pending.
 */
export async function listPlaceClaims(
  db: DatabaseOrTransaction,
  placeId: string,
  window: TimeWindow,
): Promise<{ lifecycle: PlaceLifecycle | null; claimantAccountIds: string[]; claims: Paged<PlaceClaim>[] }> {
  const [lifecycle, accounts, rows] = await Promise.all([
    findPlaceLifecycle(db, placeId),
    db
      .selectDistinct({ oxyAccountId: placesClaims.oxyAccountId })
      .from(placesClaims)
      .where(eq(placesClaims.placeId, placeId)),
    db
      .select(CLAIM_PAGE_COLUMNS)
      .from(placesClaims)
      .where(and(eq(placesClaims.placeId, placeId), claimWindow(window)))
      .orderBy(placesClaims.claimedAt, placesClaims.id)
      .limit(window.limit),
  ]);
  return {
    lifecycle,
    claimantAccountIds: accounts.map((account) => account.oxyAccountId),
    claims: rows.map(pagedClaim),
  };
}

/** One window of the claims in one state, oldest first — moderation's review queue. */
export async function findClaimsInState(
  db: DatabaseOrTransaction,
  state: PlaceClaimState,
  window: TimeWindow,
): Promise<Paged<PlaceClaim>[]> {
  const rows = await db
    .select(CLAIM_PAGE_COLUMNS)
    .from(placesClaims)
    .where(and(eq(placesClaims.state, state), claimWindow(window)))
    .orderBy(placesClaims.claimedAt, placesClaims.id)
    .limit(window.limit);
  return rows.map(pagedClaim);
}

/**
 * One window of every claim one Oxy account holds, in every state, oldest
 * first.
 *
 * The route decides whose: the session's own account, or one the caller acts
 * for. Nothing here can enumerate who has claimed what for an account nobody
 * asked Oxy about.
 */
export async function findAccountClaims(
  db: DatabaseOrTransaction,
  oxyAccountId: string,
  window: TimeWindow,
): Promise<Paged<PlaceClaim>[]> {
  const rows = await db
    .select(CLAIM_PAGE_COLUMNS)
    .from(placesClaims)
    .where(and(eq(placesClaims.oxyAccountId, oxyAccountId), claimWindow(window)))
    .orderBy(placesClaims.claimedAt, placesClaims.id)
    .limit(window.limit);
  return rows.map(pagedClaim);
}

/** Every place one Oxy account holds an approved claim on — a chain's locations, when the account is its brand. */
export async function findClaimedPlaceIds(db: DatabaseOrTransaction, oxyAccountId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ placeId: placesClaims.placeId })
    .from(placesClaims)
    .where(and(eq(placesClaims.state, 'approved'), eq(placesClaims.oxyAccountId, oxyAccountId)));
  return rows.map((row) => row.placeId);
}

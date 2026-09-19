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
import type {
  CapabilityVerification,
  GeoGeometry,
  OpeningHours,
  Place,
  PlaceClaimRole,
  PlaceContact,
  PlaceStatus,
  PlaceWithDistance,
  StructuredAddress,
} from '@goway/shared-types';
import { ApiError } from '../../http/apiError';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { places, placesCapabilities, placesClaims, placesDuplicateCandidates, placesSources } from '../schema';
import { distanceTo, withinBoundingBox, withinRadius } from './placeGeo';
import {
  CAPABILITY_COLUMNS,
  CLAIM_COLUMNS,
  PLACE_COLUMNS,
  SOURCE_COLUMNS,
  toPlace,
  toPlaceWithDistance,
  type CapabilityRow,
  type ClaimRow,
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

export interface PlaceWriteInput {
  name?: string;
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
 */
export interface PlaceActor {
  oxyUserId: string;
  assertedVerification: Extract<CapabilityVerification, 'business_asserted' | 'community_reported'>;
}

export interface PlaceListFilters {
  capabilities?: readonly string[];
  categories?: readonly string[];
  limit: number;
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
async function hydrate(db: DatabaseOrTransaction, rows: readonly PlaceRow[]): Promise<Map<string, { sources: SourceRow[]; capabilities: CapabilityRow[] }>> {
  const ids = rows.map((row) => row.id);
  const [sources, capabilities] = await Promise.all([loadSources(db, ids), loadCapabilities(db, ids)]);
  const sourcesByPlace = groupByPlace(sources);
  const capabilitiesByPlace = groupByPlace(capabilities);
  return new Map(
    ids.map((id) => [
      id,
      { sources: sourcesByPlace.get(id) ?? [], capabilities: capabilitiesByPlace.get(id) ?? [] },
    ]),
  );
}

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
): Promise<Place | null> {
  const [row] = await db.select(PLACE_COLUMNS).from(places).where(eq(places.id, id)).limit(1);
  if (!row) return null;

  const [sources, capabilities, claims] = await Promise.all([
    loadSources(db, [id]),
    loadCapabilities(db, [id]),
    viewerOxyAccountId ? loadClaims(db, id) : Promise.resolve(null),
  ]);

  const visibleClaims =
    claims !== null && claims.some((claim) => claim.oxyAccountId === viewerOxyAccountId)
      ? claims
      : undefined;

  return toPlace(row, { sources, capabilities, claims: visibleClaims });
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

  const children = await hydrate(db, rows);
  return rows.map(({ distanceMeters, ...row }) =>
    toPlaceWithDistance(row, children.get(row.id) ?? { sources: [], capabilities: [] }, distanceMeters),
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

  const children = await hydrate(db, rows);
  return rows.map((row) => toPlace(row, children.get(row.id) ?? { sources: [], capabilities: [] }));
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
  reason: 'shared_source_id' | 'proximity_and_name' | 'manual_report',
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
    const verification: CapabilityVerification = capability.source
      ? 'external_source'
      : actor.assertedVerification;

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
    await applyCapabilities(tx, row.id, input.capabilities ?? [], actor);
    return row.id;
  });

  // Duplicate detection runs AFTER the place is committed and outside its
  // transaction, and a failure to detect is not a failure to create: a missed
  // candidate is a review that does not happen, while a rolled-back create is a
  // contribution the user has to make again.
  const candidates = await findProximityNameCandidates(
    db,
    id,
    input.name,
    input.location.longitude,
    input.location.latitude,
  );
  for (const candidate of candidates) {
    await recordDuplicateCandidate(db, id, candidate, 'proximity_and_name');
  }

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
    await applyCapabilities(tx, id, input.capabilities ?? [], actor);
    return row.id;
  });

  if (updated === null) return null;
  return findPlaceById(db, id);
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

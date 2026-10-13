/**
 * Road rules: the reads the API serves and the writes a sync makes.
 *
 * Reads return the CONTRACT's shapes, parsed from what is stored — a row that
 * no longer satisfies its schema is a defect to surface, not data to serve.
 * Spatial reads narrow by the stored bounding box and then test the exact
 * geometry with the contract's own `geoGeometryContains`, the function the SDK
 * uses, so "inside the zone" has one definition.
 *
 * Writes are `upsertRuleSet` / `upsertZone`, each ONE transaction that locks the
 * row, compares it with what is stored, and — only when the RULE changed —
 * writes it with a `road_rule_events` row carrying the value it replaced. A
 * sync that re-reads an unchanged source refreshes `source.retrievedAt` and
 * nothing else, so the history records changes and not polls.
 */

import { and, asc, eq, gt, gte, lte, or, sql, type SQL } from 'drizzle-orm';
import {
  geoGeometryContains,
  roadRuleSetSchema,
  roadZoneSchema,
  type GeoBoundingBox,
  type GeoGeometry,
  type RoadRuleSource,
  type RoadRuleSet,
  type RoadZone,
  type RoadZoneKind,
} from '@goway/contracts';
import type { Database, DatabaseOrTransaction } from '../postgres';
import { roadCountries, roadRuleEvents, roadRuleSets, roadZones } from '../schema';
import type { RoadRuleEventAction, RoadRuleSubject } from '../schema/valueSets';

type ZoneRow = typeof roadZones.$inferSelect;
type RuleSetRow = typeof roadRuleSets.$inferSelect;

function ruleSetOf(row: RuleSetRow): RoadRuleSet {
  return roadRuleSetSchema.parse({
    countryCode: row.countryCode,
    drivingSide: row.drivingSide,
    speedLimitsKmh: row.speedLimitsKmh,
    source: row.source,
  });
}

function zoneOf(row: ZoneRow): RoadZone {
  return roadZoneSchema.parse({
    id: row.id,
    name: row.name,
    kind: row.kind,
    countryCode: row.countryCode,
    geometry: row.geometry,
    boundingBox: { west: row.west, south: row.south, east: row.east, north: row.north },
    timezone: row.timezone,
    ...(row.schedule ? { schedule: row.schedule } : {}),
    ...(row.effectiveFrom ? { effectiveFrom: row.effectiveFrom } : {}),
    ...(row.effectiveUntil ? { effectiveUntil: row.effectiveUntil } : {}),
    policy: row.policy,
    ...(row.rulesUrl ? { rulesUrl: row.rulesUrl } : {}),
    source: row.source,
  });
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** Rule sets ordered by country code; `after` is the last country served. */
export async function listRuleSets(
  db: DatabaseOrTransaction,
  window: { limit: number; after?: string | undefined },
): Promise<{ countryCode: string; ruleSet: RoadRuleSet }[]> {
  const rows = await db
    .select()
    .from(roadRuleSets)
    .where(
      and(
        eq(roadRuleSets.status, 'active'),
        window.after === undefined ? undefined : gt(roadRuleSets.countryCode, window.after),
      ),
    )
    .orderBy(asc(roadRuleSets.countryCode))
    .limit(window.limit + 1);
  return rows.map((row) => ({ countryCode: row.countryCode, ruleSet: ruleSetOf(row) }));
}

export async function ruleSetFor(
  db: DatabaseOrTransaction,
  countryCode: string,
): Promise<RoadRuleSet | null> {
  const [row] = await db
    .select()
    .from(roadRuleSets)
    .where(and(eq(roadRuleSets.countryCode, countryCode), eq(roadRuleSets.status, 'active')))
    .limit(1);
  return row ? ruleSetOf(row) : null;
}

/** Zones whose bounding box meets `box`; a box that crosses the antimeridian has `west > east`. */
function intersects(box: GeoBoundingBox): SQL {
  const lon =
    box.west <= box.east
      ? and(lte(roadZones.west, box.east), gte(roadZones.east, box.west))
      : or(lte(roadZones.west, box.east), gte(roadZones.east, box.west));
  return and(lon, lte(roadZones.south, box.north), gte(roadZones.north, box.south)) as SQL;
}

/** The active zones covering a position: bounding box in SQL, exact geometry in the contract's function. */
export async function zonesAt(
  db: DatabaseOrTransaction,
  position: { latitude: number; longitude: number },
): Promise<RoadZone[]> {
  const rows = await db
    .select()
    .from(roadZones)
    .where(
      and(
        eq(roadZones.status, 'active'),
        lte(roadZones.west, position.longitude),
        gte(roadZones.east, position.longitude),
        lte(roadZones.south, position.latitude),
        gte(roadZones.north, position.latitude),
      ),
    )
    .orderBy(asc(roadZones.id));
  return rows.map(zoneOf).filter((zone) => geoGeometryContains(zone.geometry, position));
}

/** The most zones one routing request loads: a box this size holds a handful. */
export const MAX_ZONES_PER_AREA = 500;

/** Every active zone meeting `box`, unpaged and capped: what a route is checked against. */
export async function zonesIn(db: DatabaseOrTransaction, box: GeoBoundingBox): Promise<RoadZone[]> {
  const rows = await db
    .select()
    .from(roadZones)
    .where(and(eq(roadZones.status, 'active'), intersects(box)))
    .orderBy(asc(roadZones.id))
    .limit(MAX_ZONES_PER_AREA);
  return rows.map(zoneOf);
}

export interface ZoneFilter {
  box?: GeoBoundingBox | undefined;
  country?: string | undefined;
  kind?: RoadZoneKind | undefined;
}

/** Active zones matching `filter`, ordered by id; `after` is the last id served. */
export async function listZones(
  db: DatabaseOrTransaction,
  filter: ZoneFilter,
  window: { limit: number; after?: string | undefined },
): Promise<{ id: string; zone: RoadZone }[]> {
  const rows = await db
    .select()
    .from(roadZones)
    .where(
      and(
        eq(roadZones.status, 'active'),
        filter.box ? intersects(filter.box) : undefined,
        filter.country ? eq(roadZones.countryCode, filter.country) : undefined,
        filter.kind ? eq(roadZones.kind, filter.kind) : undefined,
        window.after === undefined ? undefined : gt(roadZones.id, window.after),
      ),
    )
    .orderBy(asc(roadZones.id))
    .limit(window.limit + 1);
  return rows.map((row) => ({ id: row.id, zone: zoneOf(row) }));
}

// ── Writes (syncs) ──────────────────────────────────────────────────────────

export type UpsertOutcome = 'created' | 'updated' | 'restored' | 'unchanged';

/** The rule without its provenance's clock: what "the rule changed" compares. */
function ruleContent<T extends { source: { retrievedAt: string } }>(value: T): unknown {
  const { source, ...rest } = value;
  return { ...rest, source: { ...source, retrievedAt: undefined } };
}

/** Structural equality of JSON-shaped values, key order ignored. */
function sameJson(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as object).sort(([x], [y]) => (x < y ? -1 : 1)))
      : v,
  );
}

async function recordEvent(
  tx: DatabaseOrTransaction,
  subject: RoadRuleSubject,
  subjectId: string,
  action: RoadRuleEventAction,
  syncId: string,
  previous: unknown,
): Promise<void> {
  await tx.insert(roadRuleEvents).values({
    subject,
    subjectId,
    action,
    syncId,
    previous: previous === null ? null : (previous as object),
  });
}

/**
 * How one kind of rule is stored. The rules of upserting — lock, compare,
 * write only a real change, record it with what it replaced, restore a
 * withdrawn rule — are written once in {@link upsertRule}; a kind supplies only
 * its table.
 */
interface RuleStore<V extends { source: { retrievedAt: string } }> {
  subject: RoadRuleSubject;
  idOf(value: V): string;
  /** The stored rule, locked for update, with its status. */
  find(tx: DatabaseOrTransaction, id: string): Promise<{ status: string; value: V } | undefined>;
  insert(tx: DatabaseOrTransaction, value: V): Promise<void>;
  /** Overwrite every field and mark it active. */
  replace(tx: DatabaseOrTransaction, value: V): Promise<void>;
  /** Refresh only the provenance's clock. */
  touch(tx: DatabaseOrTransaction, value: V): Promise<void>;
}

async function upsertRule<V extends { source: { retrievedAt: string } }>(
  db: Database,
  store: RuleStore<V>,
  syncId: string,
  value: V,
): Promise<UpsertOutcome> {
  const id = store.idOf(value);
  return db.transaction(async (tx) => {
    const existing = await store.find(tx, id);
    if (!existing) {
      await store.insert(tx, value);
      await recordEvent(tx, store.subject, id, 'created', syncId, null);
      return 'created';
    }
    const restored = existing.status === 'withdrawn';
    if (!restored && sameJson(ruleContent(existing.value), ruleContent(value))) {
      await store.touch(tx, value);
      return 'unchanged';
    }
    await store.replace(tx, value);
    const action = restored ? 'restored' : 'updated';
    await recordEvent(tx, store.subject, id, action, syncId, existing.value);
    return action;
  });
}

const ruleSetStore: RuleStore<RoadRuleSet> = {
  subject: 'rule_set',
  idOf: (value) => value.countryCode,
  async find(tx, id) {
    const [row] = await tx
      .select()
      .from(roadRuleSets)
      .where(eq(roadRuleSets.countryCode, id))
      .for('update');
    return row ? { status: row.status, value: ruleSetOf(row) } : undefined;
  },
  async insert(tx, value) {
    await tx.insert(roadRuleSets).values(ruleSetColumns(value));
  },
  async replace(tx, value) {
    await tx
      .update(roadRuleSets)
      .set({ ...ruleSetColumns(value), updatedAt: sql`now()` })
      .where(eq(roadRuleSets.countryCode, value.countryCode));
  },
  async touch(tx, value) {
    await tx
      .update(roadRuleSets)
      .set({ source: value.source, updatedAt: sql`now()` })
      .where(eq(roadRuleSets.countryCode, value.countryCode));
  },
};

function ruleSetColumns(value: RoadRuleSet) {
  return {
    countryCode: value.countryCode,
    drivingSide: value.drivingSide,
    speedLimitsKmh: value.speedLimitsKmh,
    source: value.source,
    status: 'active',
  };
}

const zoneStore: RuleStore<RoadZone> = {
  subject: 'zone',
  idOf: (value) => value.id,
  async find(tx, id) {
    const [row] = await tx.select().from(roadZones).where(eq(roadZones.id, id)).for('update');
    return row ? { status: row.status, value: zoneOf(row) } : undefined;
  },
  async insert(tx, value) {
    await tx.insert(roadZones).values(zoneColumns(value));
  },
  async replace(tx, value) {
    await tx
      .update(roadZones)
      .set({ ...zoneColumns(value), updatedAt: sql`now()` })
      .where(eq(roadZones.id, value.id));
  },
  async touch(tx, value) {
    await tx
      .update(roadZones)
      .set({ source: value.source, updatedAt: sql`now()` })
      .where(eq(roadZones.id, value.id));
  },
};

function zoneColumns(value: RoadZone) {
  const box = value.boundingBox;
  return {
    id: value.id,
    name: value.name,
    kind: value.kind,
    countryCode: value.countryCode,
    geometry: value.geometry,
    west: box.west,
    south: box.south,
    east: box.east,
    north: box.north,
    timezone: value.timezone,
    schedule: value.schedule ?? null,
    effectiveFrom: value.effectiveFrom ?? null,
    effectiveUntil: value.effectiveUntil ?? null,
    policy: value.policy,
    rulesUrl: value.rulesUrl ?? null,
    source: value.source,
    status: 'active',
  };
}

/** A country's border as a sync supplies it. */
export interface CountryBorder {
  countryCode: string;
  name: string;
  geometry: Extract<GeoGeometry, { type: 'Polygon' | 'MultiPolygon' }>;
  source: RoadRuleSource;
}

const countryStore: RuleStore<CountryBorder> = {
  subject: 'country',
  idOf: (value) => value.countryCode,
  async find(tx, id) {
    const [row] = await tx
      .select()
      .from(roadCountries)
      .where(eq(roadCountries.countryCode, id))
      .for('update');
    return row ? { status: row.status, value: countryOf(row) } : undefined;
  },
  async insert(tx, value) {
    await tx.insert(roadCountries).values(countryColumns(value));
  },
  async replace(tx, value) {
    await tx
      .update(roadCountries)
      .set({ ...countryColumns(value), updatedAt: sql`now()` })
      .where(eq(roadCountries.countryCode, value.countryCode));
  },
  async touch(tx, value) {
    await tx
      .update(roadCountries)
      .set({ source: value.source, updatedAt: sql`now()` })
      .where(eq(roadCountries.countryCode, value.countryCode));
  },
};

function countryColumns(value: CountryBorder) {
  const box = boundsOf(value.geometry);
  return {
    countryCode: value.countryCode,
    name: value.name,
    geometry: value.geometry,
    west: box.west,
    south: box.south,
    east: box.east,
    north: box.north,
    source: value.source,
    status: 'active',
  };
}

function countryOf(row: typeof roadCountries.$inferSelect): CountryBorder {
  return {
    countryCode: row.countryCode,
    name: row.name,
    geometry: row.geometry as CountryBorder['geometry'],
    source: row.source,
  };
}

/** Every active country border: what a position is put in a country with. */
export async function loadCountryBorders(db: DatabaseOrTransaction): Promise<CountryBorder[]> {
  const rows = await db.select().from(roadCountries).where(eq(roadCountries.status, 'active'));
  return rows.map(countryOf);
}

/** The box a geometry spans. Zones and countries are stored by longitude range, so none may cross the antimeridian whole. */
export function boundsOf(geometry: GeoGeometry): GeoBoundingBox {
  const positions: [number, number][] =
    geometry.type === 'Polygon'
      ? geometry.coordinates.flat().map((p) => [p[0], p[1]])
      : geometry.type === 'MultiPolygon'
        ? geometry.coordinates.flat(2).map((p) => [p[0], p[1]])
        : [];
  if (positions.length === 0) throw new Error('an area needs a polygon');
  const lons = positions.map((p) => p[0]);
  const lats = positions.map((p) => p[1]);
  return {
    west: Math.min(...lons),
    east: Math.max(...lons),
    south: Math.min(...lats),
    north: Math.max(...lats),
  };
}

export const upsertRuleSet = (db: Database, syncId: string, ruleSet: RoadRuleSet) =>
  upsertRule(db, ruleSetStore, syncId, roadRuleSetSchema.parse(ruleSet));

export const upsertCountry = (db: Database, syncId: string, border: CountryBorder) =>
  upsertRule(db, countryStore, syncId, border);

export function upsertZone(
  db: Database,
  syncId: string,
  zone: Omit<RoadZone, 'boundingBox'>,
): Promise<UpsertOutcome> {
  return upsertRule(
    db,
    zoneStore,
    syncId,
    roadZoneSchema.parse({ ...zone, boundingBox: boundsOf(zone.geometry) }),
  );
}

/**
 * Withdraw the active zones of `countryCode` that a sync of the WHOLE country
 * no longer lists. Only a sync that read its source completely may call this:
 * a partial or failed read must never withdraw anything.
 */
export async function withdrawZonesNotIn(
  db: Database,
  syncId: string,
  countryCode: string,
  listedIds: readonly string[],
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(roadZones)
      .where(and(eq(roadZones.countryCode, countryCode), eq(roadZones.status, 'active')))
      .for('update');
    const keep = new Set(listedIds);
    const gone = rows.filter((row) => !keep.has(row.id));
    for (const row of gone) {
      await tx
        .update(roadZones)
        .set({ status: 'withdrawn', updatedAt: sql`now()` })
        .where(eq(roadZones.id, row.id));
      await recordEvent(tx, 'zone', row.id, 'withdrawn', syncId, zoneOf(row));
    }
    return gone.map((row) => row.id);
  });
}

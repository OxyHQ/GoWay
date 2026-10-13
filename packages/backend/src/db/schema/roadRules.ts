/**
 * Road rules by place, as data a sync keeps current (`docs/ROAD_RULES.md` §2).
 *
 *  - `road_rule_sets`   — one row per country: the side traffic keeps to and
 *                         what an implicit `maxspeed` (`ES:urban`) means.
 *  - `road_zones`       — low emission, congestion charge and restricted
 *                         access zones: geometry, schedule and policy.
 *  - `road_rule_events` — the append-only history of every change a sync made,
 *                         with the value it replaced. A rule is never
 *                         overwritten without a trace.
 *
 * ## Why the geometry is JSON and not a PostGIS column
 *
 * A zone's GeoJSON IS its contract shape: the API publishes it as stored and
 * the SDK tests a point against it with the same function the server uses
 * (`geoGeometryContains`), so "inside the zone" cannot mean two things. What
 * the database adds is a bounding box, written with the geometry and indexed,
 * to narrow a viewport or a position to a handful of zones before that exact
 * test. There are hundreds of zones on Earth, not millions, so a spatial index
 * would only add a second definition of "inside".
 *
 * ## Provenance
 *
 * `source` is the contract's `RoadRuleSource` — whose data it is, under what
 * licence, when it was read — on every row, so no rule is served without its
 * credit. The sync that wrote a rule is `road_rule_events.sourceId`.
 */

import { sql } from 'drizzle-orm';
import { check, doublePrecision, index, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, generatedId, updatedAt } from '@oxy.so/db';
import {
  DRIVING_SIDES,
  ROAD_ZONE_KINDS,
  type GeoGeometry,
  type RoadRuleSource,
  type RoadZonePolicy,
  type RoadRuleSet,
} from '@goway/contracts';
import { closedSet } from './columns';
import { ROAD_RULE_EVENT_ACTIONS, ROAD_RULE_STATUSES, ROAD_RULE_SUBJECTS } from './valueSets';

/**
 * A country's border, so a position can be put in a country at all: GoWay has
 * no other source for it, and a rule set is only useful once the country is
 * known. Natural Earth (public domain), simplified to ~110 m at sync time — a
 * border this approximate is wrong within a street of the line, which is the
 * resolution a whole country's rules can be trusted to anyway.
 */
export const roadCountries = pgTable(
  'road_countries',
  {
    /** ISO 3166-1 alpha-2, or the user-assigned code Natural Earth uses (`XK`). */
    countryCode: text().primaryKey(),
    name: text().notNull(),
    geometry: jsonb().notNull().$type<GeoGeometry>(),
    west: doublePrecision().notNull(),
    south: doublePrecision().notNull(),
    east: doublePrecision().notNull(),
    north: doublePrecision().notNull(),
    source: jsonb().notNull().$type<RoadRuleSource>(),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('road_countries_country_check', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check('road_countries_name_check', sql`btrim(${table.name}) <> ''`),
    closedSet('road_countries_status_check', table.status, ROAD_RULE_STATUSES),
    check(
      'road_countries_geometry_check',
      sql`${table.geometry} ->> 'type' in ('Polygon', 'MultiPolygon')`,
    ),
  ],
);

export const roadRuleSets = pgTable(
  'road_rule_sets',
  {
    /** ISO 3166-1 alpha-2, upper-case. */
    countryCode: text().primaryKey(),
    drivingSide: text().notNull(),
    /** `{ urban?, rural?, trunk?, motorway?, living_street? }` in km/h. */
    speedLimitsKmh: jsonb().notNull().$type<RoadRuleSet['speedLimitsKmh']>(),
    source: jsonb().notNull().$type<RoadRuleSource>(),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('road_rule_sets_country_check', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    closedSet('road_rule_sets_driving_side_check', table.drivingSide, DRIVING_SIDES),
    closedSet('road_rule_sets_status_check', table.status, ROAD_RULE_STATUSES),
    check(
      'road_rule_sets_speed_limits_check',
      sql`jsonb_typeof(${table.speedLimitsKmh}) = 'object'`,
    ),
  ],
);

export const roadZones = pgTable(
  'road_zones',
  {
    /** Stable and lower-case: `es-barcelona-zbe`. Never reused for another zone. */
    id: text().primaryKey(),
    name: text().notNull(),
    kind: text().notNull(),
    countryCode: text().notNull(),
    /** A GeoJSON Polygon or MultiPolygon, WGS 84. */
    geometry: jsonb().notNull().$type<GeoGeometry>(),
    /** The geometry's bounding box, written with it; the prefilter for every spatial read. */
    west: doublePrecision().notNull(),
    south: doublePrecision().notNull(),
    east: doublePrecision().notNull(),
    north: doublePrecision().notNull(),
    timezone: text().notNull(),
    /** Weekly local schedule (the contract's `OpeningHours`); null: always. */
    schedule: jsonb(),
    /** Local `YYYY-MM-DD`; null: unbounded. */
    effectiveFrom: text(),
    effectiveUntil: text(),
    policy: jsonb().notNull().$type<RoadZonePolicy>(),
    rulesUrl: text(),
    source: jsonb().notNull().$type<RoadRuleSource>(),
    status: text().notNull().default('active'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('road_zones_id_check', sql`${table.id} ~ '^[a-z0-9][a-z0-9-]{1,63}$'`),
    check('road_zones_country_check', sql`${table.countryCode} ~ '^[A-Z]{2}$'`),
    check('road_zones_name_check', sql`btrim(${table.name}) <> ''`),
    closedSet('road_zones_kind_check', table.kind, ROAD_ZONE_KINDS),
    closedSet('road_zones_status_check', table.status, ROAD_RULE_STATUSES),
    check(
      'road_zones_geometry_check',
      sql`${table.geometry} ->> 'type' in ('Polygon', 'MultiPolygon')`,
    ),
    check(
      'road_zones_bounds_check',
      sql`${table.south} between -90 and 90 and ${table.north} between -90 and 90 and ${table.south} <= ${table.north} and ${table.west} between -180 and 180 and ${table.east} between -180 and 180`,
    ),
    check(
      'road_zones_dates_check',
      sql`(${table.effectiveFrom} is null or ${table.effectiveFrom} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') and (${table.effectiveUntil} is null or ${table.effectiveUntil} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')`,
    ),
    index('road_zones_country_idx').on(table.countryCode, table.id),
    index('road_zones_bounds_idx').on(table.south, table.north),
  ],
);

/**
 * One change a sync made to one rule. Append-only and keyed by nothing: the
 * history of a zone outlives the zone's row being withdrawn, and a rule set's
 * outlives its replacement. `previous` is the full value the change replaced
 * (null on `created`).
 */
export const roadRuleEvents = pgTable(
  'road_rule_events',
  {
    id: generatedId(),
    subject: text().notNull(),
    subjectId: text().notNull(),
    action: text().notNull(),
    /** The sync adapter that made the change (`es-dgt-zbe`), or `operator`. */
    syncId: text().notNull(),
    previous: jsonb(),
    createdAt: createdAt(),
  },
  (table) => [
    closedSet('road_rule_events_subject_check', table.subject, ROAD_RULE_SUBJECTS),
    closedSet('road_rule_events_action_check', table.action, ROAD_RULE_EVENT_ACTIONS),
    index('road_rule_events_subject_idx').on(table.subject, table.subjectId, table.createdAt),
  ],
);

/**
 * The column shapes GoWay's schema repeats, defined once.
 *
 * `@oxy.so/db` owns the ecosystem-wide ones (`generatedId`, `createdAt`,
 * `updatedAt`, `timestamptz`, `geography`, `inList`). What lives here is the
 * handful that are geographic or closed-set, because each encodes a decision a
 * hand-written column could silently get wrong — and in this schema every one
 * of those decisions fails SILENTLY rather than loudly.
 */

import { sql, type SQL } from 'drizzle-orm';
import { check, doublePrecision, text, type PgColumn } from 'drizzle-orm/pg-core';
import { geography, inList } from '@oxy.so/db';

/**
 * The two ordinates the application actually reads and writes.
 *
 * `doublePrecision` rather than `numeric`: a coordinate is a measurement, every
 * consumer already treats it as a float, and `numeric` would arrive from the
 * driver as a string that invites a parse at each call site.
 *
 * The PostGIS point beside them is GENERATED from this pair (see
 * {@link generatedGeographyPoint}) rather than written, so a position has
 * exactly one source of truth and the point cannot disagree with its ordinates.
 */
export const latitude = () => doublePrecision();
export const longitude = () => doublePrecision();

/**
 * The PostGIS point, GENERATED from a longitude/latitude column pair.
 *
 * Ordinate order is the one place GeoJSON and PostGIS agree and the easiest
 * thing in this file to get backwards: GeoJSON stores `[lng, lat]` and
 * `ST_MakePoint` takes `(lng, lat)`, which is the opposite of every `lat, lng`
 * the HTTP layer receives. Getting it wrong does not fail — it puts every place
 * in the wrong hemisphere while every query still returns rows — which is why
 * `places-geo.realdb.test.ts` asserts it against a real, independently
 * checkable distance (Barcelona→Madrid ≈ 505 km) rather than trusting this
 * comment.
 *
 * The column names are spelled out as SQL identifiers because a generated
 * expression has no drizzle `Column` object to interpolate. This is the ONE
 * sanctioned exception to "never spell the casing out", and it is why the
 * helper takes the SQL names explicitly instead of guessing them.
 *
 * `ST_SetSRID` is explicit even though `::geography` implies 4326: the cast's
 * default is a property of PostGIS rather than of this schema, and the SRID is
 * what every `ST_DWithin` and `ST_Intersects` below is measured in.
 *
 * `ST_MakePoint` is STRICT, so a row with a NULL ordinate generates a NULL
 * point — a genuinely absent position rather than a point at (0, 0) in the Gulf
 * of Guinea. `places` declares both ordinates NOT NULL, so its point is always
 * present; the strictness matters for any future nullable position.
 */
export const generatedGeographyPoint = (longitudeColumn: string, latitudeColumn: string) =>
  geography().generatedAlwaysAs(
    (): SQL =>
      sql.raw(`ST_SetSRID(ST_MakePoint(${longitudeColumn}, ${latitudeColumn}), 4326)::geography`),
  );

/**
 * A CHECK restricting a `text` column to a closed set — this schema's only way
 * of expressing an enum.
 *
 * A PostgreSQL `enum` type is deliberately not used: adding a value to one is
 * DDL that cannot run in the same transaction as the code using it, and
 * removing a value is not supported at all. A CHECK is an ordinary migration.
 *
 * Both arguments come from the SAME `as const` tuple that types the column —
 * and for every set in this schema that tuple lives in `@goway/shared-types`,
 * so the public contract, the TypeScript union and the database constraint are
 * one definition rather than three.
 *
 * `sql.raw(inList(...))` and never a bare interpolation: an interpolated value
 * renders as a bound `$1`, and a migration file carries no parameters, so the
 * constraint would fail at APPLY time rather than at generate time. `bun run
 * check:migrations` is the gate for exactly that mistake.
 */
export const closedSet = (name: string, column: PgColumn, values: readonly string[]) =>
  check(name, sql`${column} in (${sql.raw(inList(values))})`);

/**
 * An id belonging to a FOREIGN service — an Oxy account id, an Oxy user id, an
 * external provider's own reference.
 *
 * A distinct helper rather than a bare `text()` so "this carries no foreign key
 * on purpose" is visible AT the column rather than inferred from the absence of
 * a `.references()`. Oxy owns identity; there is no `users` table here and
 * never will be.
 */
export const foreignServiceId = () => text();

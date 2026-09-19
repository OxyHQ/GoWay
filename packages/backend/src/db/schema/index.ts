/**
 * Drizzle schema barrel.
 *
 * This file is BOTH the single entry point `drizzle.config.ts` generates
 * migrations from AND the object `db/postgres.ts` hands to drizzle for the typed
 * query API. A table that is not re-exported here is invisible to both, so it
 * gets neither a migration nor a typed query — which is the failure mode to
 * remember when a new table "does not exist" against a database you just
 * migrated.
 *
 * ## What is here
 *
 * GoWay's schema is Places (issue #4) and it produced `0000`. `places.ts` holds
 * all five tables in one module because they are one aggregate: every child
 * table has a foreign key to `places`, and `places_capabilities` also references
 * `places_sources`, so splitting them across modules would only introduce an
 * export order to get wrong.
 *
 * ## When adding a table
 *
 * Add one line per table module, in DEPENDENCY order once tables reference each
 * other: a module must be exported after the module holding the tables its
 * foreign keys point at. Two conventions are not optional:
 *
 *   1. `oxyUserId` carries NO foreign key and never will. Oxy owns identity, so
 *      every user id here is a foreign service's primary key reached over HTTP
 *      and there is nothing in this database to point at. The same holds for any
 *      other service's id (an Oxy `fileId`, a payment reference) — say so in a
 *      comment on each such column.
 *   2. Columns are declared camelCase and named by the casing authority.
 *      `DATABASE_CASING` from `@oxy.so/db` is passed both to the runtime handle
 *      and to drizzle-kit, so `oxyUserId` becomes `oxy_user_id` in SQL. Never
 *      spell the SQL name by hand, and note that `column.name` on a drizzle
 *      column is the TypeScript property name, not the SQL one —
 *      `sqlColumnName()` is how hand-written SQL gets the SQL name.
 */

export * from './places';
export * from './valueSets';

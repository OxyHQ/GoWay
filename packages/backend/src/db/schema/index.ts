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
 * ## Deliberately EMPTY
 *
 * The scaffolder's `notes` demo table was deleted, along with the `0000`
 * migration that created it, so `drizzle/` holds no journal at all. GoWay's real
 * schema is Places (issue #4) and it will produce `0000` itself. A demo table
 * left here would have shipped into the first migration of every GoWay database
 * that ever exists, and dropping it later would be a `post`-phase migration
 * written to undo something that should never have been created.
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
 *
 * `export {}` keeps this a module while it exports nothing: without it the file
 * is a global script and `import * as schema from './schema'` stops compiling.
 */

export {};

/**
 * The Postgres extensions GoWay's schema depends on.
 *
 * ## Why this is a registry and not a migration
 *
 * An extension has to exist BEFORE the first statement that names a type it
 * provides. GoWay's Places schema is geographic from its very first table, so
 * migration `0000` is exactly where a fresh database fails without PostGIS —
 * and it fails ONLY on a fresh one, which is the shape that passes on a warm
 * developer machine and then fails in CI or on a newly provisioned managed
 * database.
 *
 * Putting `CREATE EXTENSION postgis` inside a numbered migration would answer
 * that only for as long as nobody renumbers, squashes or regenerates the
 * sequence — and anything that must be true before the FIRST migration cannot
 * live inside the numbered sequence at all. So it is a precondition of the
 * MIGRATOR: `runMigrations` calls `ensureExtensions` with this list on every
 * run, in every environment, before applying anything.
 *
 * ## `CREATE EXTENSION` is PRIVILEGED, and `IF NOT EXISTS` hides that
 *
 * `ensureExtensions` spells it `CREATE EXTENSION IF NOT EXISTS`. The duplicate
 * check short-circuits BEFORE the privilege check, so on a database where the
 * extension is already installed this is a NOTICE and a no-op even for an
 * unprivileged application role. That is the whole of what it buys.
 *
 * It is NOT a fallback that installs a missing extension. On a NEW database
 * nobody has prepared, the same statement raises `permission denied to create
 * extension "postgis"` — owning the database is not enough. Provisioning a new
 * GoWay database is therefore a two-party job: somebody holding `rds_superuser`
 * (or the local `postgres` superuser) runs `CREATE EXTENSION postgis;` against
 * it once, and only then can the migration role migrate. See the backend README
 * and oxy-infra `docs/runbooks/30-postgres-database-provisioning.md`.
 *
 * ## The image alone is not enough either
 *
 * `postgis/postgis:17-3.5` seeds PostGIS into `POSTGRES_DB` and a
 * `template_postgis` template — never into `template1`. Any database created
 * afterwards without a `TEMPLATE` clause is cloned from `template1` and lands
 * WITHOUT the extension. Running the right image is necessary; this registry is
 * what makes each database usable.
 */

import type { RequiredExtension } from '@oxy.so/db/migrate';

export const REQUIRED_EXTENSIONS: readonly RequiredExtension[] = [
  {
    name: 'postgis',
    reason:
      'GoWay Places store coordinates and geometry as `geography` columns with GiST ' +
      'indexes; every spatial query (nearby, within-bounds, distance ordering) is an ' +
      'ST_* call. Without PostGIS the first Places migration cannot even create its ' +
      'tables.',
  },
];

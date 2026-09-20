# `drizzle/` — generated migrations

Every file beside this one is GENERATED. Never hand-write a migration: edit
`src/db/schema/`, run `bun run db:generate`, then add exactly one deploy-phase
marker line to the new `.sql`:

```
-- oxy:deploy-phase=pre      additive; safe while the previous image serves
-- oxy:deploy-phase=post     drops/renames/narrows; only once the new image is live
```

`bun run db:migrate --target-database=<name>` refuses to apply an unmarked
migration, before any DDL runs, and `bun run check:migrations` fails the build on
one.

## `0000_goway_places`

GoWay's first migration is the Places schema (issue #4): five tables, their
constraints and their indexes. It is `pre` — purely additive, correct against
the image still serving and the one arriving, and it MUST be applied before the
rollout, because the new image's Places routes cannot answer a request without
these tables.

## `0001_goway_capture`

Street 3D capture (issues #9 and #10): five tables — sessions, media objects,
assets, location evidence and storage budgets — their constraints and their
indexes. Also `pre`, and purely additive.

Two constraints in it are the point of the whole migration rather than ordinary
validation, so read them before changing anything there:

- `capture_objects_expiry_ceiling_check`, together with `expires_at`,
  `retention_class` and `retention_reason` being NOT NULL, is what makes a
  permanent raw upload impossible to INSERT rather than merely unlikely.
- `capture_objects_live_content_hash_key` is a PARTIAL unique index, on
  `deleted_at is null`. Exact deduplication that still lets identical bytes be
  contributed again after the first object has expired and been deleted; a total
  unique constraint would refuse that forever on the strength of a tombstone.

`meta/_journal.json` is never deleted, even when it holds nothing: `readJournal`
treats a MISSING file as a read failure and throws (correctly — an image shipped
without its migrations must never read as "nothing to do"), and both `GET /ready`
and the migration gates parse it on every run.

## PostGIS is a precondition, not a migration

`0000` names the `geography` type in its very first statement, and `0001` both
names it and calls `ST_GeoHash`, so on a database without the extension they
fail with `type "geography" does not exist`.
`src/db/extensions.ts` declares it and `bun run db:migrate` ensures it before
any DDL runs. `CREATE EXTENSION` is privileged and `IF NOT EXISTS`
short-circuits before the privilege check, so a NEWLY provisioned database needs
a superuser to run it once by hand first — see that module for the full
explanation.

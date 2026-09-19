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

## Why the journal is empty

The scaffolder's `notes` demo table and its `0000_initial_schema` migration were
deleted in issue #1. A demo table would otherwise have shipped into the first
migration of every GoWay database that ever exists, and removing it afterwards
would be a `post`-phase migration written to undo something that should never
have been created.

`meta/_journal.json` is kept — with an empty `entries` array — rather than
deleted. It is a real, valid, zero-migration journal: `readJournal` treats a
MISSING file as a read failure and throws (correctly: an image shipped without
its migrations must never read as "nothing to do"), and both `GET /ready` and the
migration gates parse it on every run. GoWay's real `0000` arrives with the
Places schema in issue #4.

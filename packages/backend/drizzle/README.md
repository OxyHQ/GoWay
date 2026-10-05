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

## `0002_goway_place_names`

Place names in every language a source records one in (issue #61): one table,
`places_names`, plus a widened `places_duplicates_reason_check`. `pre` — nothing
is dropped, renamed or narrowed, and a widened CHECK is correct against the
image still serving.

It lands BEFORE the OpenStreetMap POI import that fills it, deliberately. That
import writes millions of rows, and a single-language `places.name` would have
fixed the map's vocabulary for places to one language — OSM's bare `name`, which
is the LOCAL language, not English — for as long as re-importing the planet is
too expensive to contemplate.

Two constraints are the point of the migration:

- `places_names_language_source_key` is on `(place_id, language, source)`. The
  third column is what makes a GoWay-owned correction survive the next import:
  the importer upserts against the `openstreetmap` row and has no way to address
  the `goway` row, so *"never destructively overwrite a source fact"* holds
  because of the key rather than because of the importer.
- `places_names_language_tag_check` is the canonical BCP 47 subset published by
  `@goway/contracts`, and its primary subtag is two or three letters on
  purpose. Under the wider BCP 47 rule, `left`, `right`, `signed` and `prefix`
  are all well-formed — and all four are real OpenStreetMap `name:*` keys that
  are not languages.

`places.name` deliberately stays, as the default (local-language) name, so
`name_normalized`, `places_name_normalized_idx` and every existing
reconciliation rule are untouched by this migration.

## `0006_goway_street3d`

Street 3D reconstruction (issues #11–#16): `capture_derivatives`,
`street3d_jobs`, `street3d_job_events`, `street3d_scenes`,
`street3d_scene_versions`, `street3d_scene_inputs`, `street3d_capture_edges`,
`street3d_scene_reports`, `street3d_capture_blocks`,
`street3d_coverage_areas`, plus a nullable, CHECKed
`capture_sessions.attribution`. `pre` — new tables and one nullable column;
nothing is dropped, renamed or narrowed, and the previous image never reads
them.

The constraints that carry the design:

- `capture_derivatives` repeats the raw-media guarantees — NOT NULL expiry
  under `capture_derivatives_expiry_ceiling_check`, protection bounded by
  expiry, at most three extensions — and its class CHECK admits only
  `privacy_safe_proxy`, so a raw upload is unrepresentable there.
- `street3d_jobs_open_scene_key` / `street3d_jobs_open_asset_key` are partial
  unique indexes: ONE open job per scene and per capture, whatever two
  concurrent scheduler ticks decide.
- `street3d_versions_published_key` allows one served version per scene, so
  publication is a swap inside one transaction, never two versions at once.
- `street3d_job_events` is keyed by the worker's `eventId`; SQS redelivery is
  absorbed there.

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

## `0007_goway_business_moderation`

Business ownership and moderation (`docs/BUSINESS_OWNERSHIP.md`):
`place_revisions` (the append-only history every place write records in its
own transaction), `place_reports` (one open report per reporter per place),
`places.merged_into_place_id` with `places_status_check` widened to admit
`merged`, and the indexes the moderation queues read. `pre` — new tables, a
nullable column and a widened CHECK are all correct against the image still
serving.

## `0008_goway_place_hours`

Place data, the additive half (`docs/PLACE_DATA.md`): `place_hours_exceptions`
(dated closures and special hours, each at a verification tier, unique on
`(place, starts_on, ends_on, verification)`), a nullable `places.timezone`
with a zone-name CHECK, `places_capabilities_value_type_check` widened to
admit `array` (an enum-set value), and `place_revisions_action_check` widened
to the three hours-exception actions every exception write records. `pre` —
a new table, a nullable column and widened CHECKs are all correct against the
image still serving.

## `0009_goway_place_media_reviews`

Place media, reviews and descriptions (`docs/PLACE_MEDIA_REVIEWS.md`):
`place_media` (a gallery item is a reference to an Oxy file, one live row per
file per place), `place_reviews` (one PUBLISHED review per person per place, a
partial unique index), the derived `place_review_aggregates`,
`places_descriptions` at the `places_names` grain, `places.description`,
`places.logo_media_id`/`cover_media_id`, the report subject columns
`place_reports.media_id`/`review_id`, and widened CHECKs on the report reasons
and revision actions. The open-report unique index is replaced by one keyed on
the subject as well — WIDER, so the previous image's one-per-place rows still
fit it. `pre`.

## `0010_goway_claim_retier`

`place_revisions_action_check` widened to `capability_retiered` and
`hours_exception_retiered`: the revisions a claim approval records for each
statement the claimant made at the community tier while the claim was pending
and that becomes the business's own (`docs/BUSINESS_OWNERSHIP.md`). `pre` — a
widened CHECK is correct against the image still serving.

## Every `pre` before every `post`

`0007`–`0010` are `pre`; `0011`–`0013` are `post`. The order is the point:
a `pre` run applies the pending PREFIX up to the first `post` and BLOCKS on a
`pre` queued behind an unapplied `post` (`planMigrationRun` in
`@oxy.so/db/migrate`), so business moderation, place data, media and reviews
and the claim re-tier ship in one release only because every additive half
comes first. `0009` and `0010` were each generated before the three `post`
migrations were regenerated on top of them, with their SQL unchanged.

## The `post` phase is one transaction, so its order is its lock time

The migrator applies every pending migration of a phase inside ONE
transaction, and a lock any statement takes is held until that transaction
commits. So the three `post` migrations run slow-and-unlocking first,
fast-and-locking last: `0011` converts data (row locks on the rows it changes,
nothing else), then `0012` and `0013` take ACCESS EXCLUSIVE locks for
milliseconds each. The order was regenerated with drizzle-kit for exactly this
(custom migration first, then the two schema diffs), and every `when` stays
newer than `0010`'s.

## `0011_goway_place_data_conversion`

The one CUSTOM migration (`drizzle-kit generate --custom`): data the previous
image wrote, converted in place. `post`, because each step narrows what that
image wrote, and it must run before `0013` adds the CHECK it makes true.

- `places.categories` and the importer's recorded `categories` are rewritten
  as taxonomy keys by ONE function over ONE mapping table, so a column that
  equalled what OpenStreetMap last said still equals it and the next import
  refreshes it. Both live in `pg_temp` and die with the session.
- A version-1 `places_sources.source_data` becomes `{v: 2, tags: {}, normalized}`.
- A well-formed `opening_hours.timezone` seeds `places.timezone` and leaves the
  schedule.

Production holds ~13M places and ~13M source rows, so this migration is NOT
where they are converted: `bun run places:convert-legacy` runs these same
statements in id-ordered batches before the release is merged
(`docs/PLACE_DATA_CONVERSION.md`), and here every UPDATE then matches only the
stragglers written since. The command reads this file rather than restating it,
which is why the file carries rules of its own (idempotent UPDATEs, one
line-initial `WHERE` each). `src/places/__tests__/legacyConversion.realdb.test.ts`
proves the converter followed by this migration equals this migration alone,
row for row, and that this migration then rewrites no row. It is a data
migration, not an API write, so it records no `place_revisions` rows.

## `0012_goway_drop_claim_brand`

Drops `places_claims.brand_id` and its index: a chain is an Oxy organization
claiming each location in the `brand` role, so nothing else groups them.
`post` — the previous image still reads and writes the column. After `0011`,
so its ACCESS EXCLUSIVE lock on `places_claims` is not held through the
conversion's scans.

## `0013_goway_category_taxonomy`

`places_categories_taxonomy_check`: every `places.categories` member is a key of
the contract's taxonomy. `post`, after `0011`, because it narrows the column.
Adding a category to the contract regenerates this CHECK in a new migration.

The generated statement carries one hand-added clause, `NOT VALID`, as the
phase marker is hand-added. ADD CONSTRAINT takes ACCESS EXCLUSIVE on `places`
either way; with `NOT VALID` it skips the scan of every existing row, so the
lock lasts milliseconds instead of a full read of a 13M-row table during which
no request can read a place. New and updated rows are checked at once. The
existing rows are validated afterwards by
`bun run places:convert-legacy -- --target-database=<name> --validate-constraint`,
which runs `VALIDATE CONSTRAINT` under SHARE UPDATE EXCLUSIVE (reads and writes
continue). `NOT VALID` followed by `VALIDATE` inside this migration would buy
nothing: the phase's one transaction would hold the ACCESS EXCLUSIVE lock
through the validating scan anyway. drizzle-kit does not model validity, so a
later `db:generate` neither notices nor reverts the clause.

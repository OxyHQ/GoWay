# Converting legacy place data before the places-platform release

The places-platform release changes what three things hold:

- `places.categories` becomes taxonomy keys;
- `places_sources.source_data` becomes `{v: 2, tags, normalized}`;
- the timezone moves out of `places.opening_hours` into its own column.

The post-deploy migration `0011_goway_place_data_conversion` does all three.
Against production's data it cannot run as written. The drizzle migrator applies
a whole phase in ONE transaction, and production holds:

| table | rows | size |
| --- | --- | --- |
| `places` | ~12.9M | 5.8 GB (3.4 GB heap) |
| `places_sources` | ~12.9M | 10.2 GB (7.2 GB heap) |

The instance is a `db.t4g.medium` (2 burstable vCPU) on gp3. Run unchanged, the
post phase would rewrite ~26M rows in one transaction while the new image
serves, holding a row lock on every place until it commits. It would also
outlast the deploy's 20-minute migration task. On a 1.5M-row copy the
unchanged phase took 5 min 42 s on a fast desktop, which extrapolates to
hours in production.

The release therefore ships `bun run places:convert-legacy`. It runs the
migration's own statements in id-ordered batches of 5,000 rows, and each batch
is its own transaction. The command reads `0011`'s SQL file and does not keep
a copy of it. The operator runs it **before merging**. The post phase then
converts only the rows written since, which turns it into a few full scans
instead of a rewrite.

## What the previous image does with converted rows

The previous image is the one serving while the converter runs. It is not
broken by converted rows: nothing errors and nothing is lost. Its category UI
degrades until the new image is live, though, so keep that window short.

- **`source_data` v2: invisible to users.** Only the OpenStreetMap importer
  reads `source_data`, and the API never does. Do not dispatch *Import
  OpenStreetMap POIs* between the start of the conversion and the end of the
  deploy. If it does run, the old importer reads a v2 row as "no previous
  statement". It then only fills empty columns and writes a v1 row back.
  Nothing is destroyed, the refresh of the converted rows is skipped for that
  run, and the post phase converts the v1 rows it wrote.
- **Taxonomy keys in `places.categories`: visible degradation, no errors.** The
  old backend treats categories as opaque strings (`z.string()`, `&&`
  overlap), and the SDK 0.2 parser accepts any string. The old app looks up
  icons by exact legacy key (`resolveCategory`), so for converted places:
  - every place draws as the generic pin;
  - the generic pin appears from zoom 14, so parks, museums, hospitals and
    stations disappear at zoom 12–13, and cafés and shops appear one level
    earlier;
  - the category shortcut chips ("Eat & drink", "Shops"…) filter on legacy
    keys, so they stop matching converted places;
  - free-text search still matches: `restaurant` is a substring of
    `food.restaurant`.
- **Timezone: unsafe while the old image serves.** The old image reads the
  zone out of `opening_hours` to evaluate the hours. That step also needs the
  `places.timezone` column, which only the pre phase adds. The converter
  refuses to run it before then. The post phase moves the timezones, of which
  there are few: only API writes ever set opening hours.
- **Old-image writes after the conversion** (an API edit with legacy keys, a v1
  statement) are stragglers. `0011` converts them in the post phase, with the
  same SQL.

**Safe order:**

1. Convert `sources` first. It is the larger table and is invisible to users.
2. Convert `categories` last.
3. Merge right away. The CI deploys the backend and the frontend together.

The category degradation then lasts only for the categories run plus the
deploy.

## Expected durations

Measured on a synthetic copy shaped like the OSM import: 1.5M places with old
importer category lists, and 1.5M v1 sources at ~600 B per row against
production's ~560 B. The machine was an i9-14900K with the data in RAM.

| step | 1.5M rows, measured | 12.9M rows, local equivalent | production estimate (t4g.medium, gp3) |
| --- | --- | --- | --- |
| `--dry-run --step=sources` (read-only smoke test) | 6 s | ~1 min | 2–5 min (I/O bound: 7.2 GB heap) |
| `--step=sources` | 211 s | ~30 min | 1.5–2.5 h |
| `--step=categories` | 201 s | ~29 min | 1.5–2.5 h |
| `--dry-run` after conversion (verification) | 22 s | ~3 min | 5–15 min |
| post phase (`0011` stragglers, `0012`, `0013`), after conversion | 4.1 s | ~35 s | 2–5 min, against the deploy's 20 min limit |
| post phase **without** the converter (for comparison) | 342 s | ~50 min | several hours: exceeds the deploy task |
| `--validate-constraint` | 1.3 s | ~11 s | 1–3 min, no outage |

How the production column is derived:

- One Graviton2 vCPU is about 2.5–3.5× slower per core than the benchmark
  machine.
- The 4 GB instance cannot cache these tables, so every scan reads from gp3,
  whose baseline is 125 MiB/s and 3,000 IOPS.
- Each converted row writes a new tuple, an entry in every index of its table,
  and WAL.

Treat the estimates as a range. Read the real rate from the first progress
lines, which log `rowsPerSecond`, `percent` and `etaSeconds` every 10 s. The
converter uses one connection, so one vCPU, and leaves the other to the API.

The RDS T4g instances run in *unlimited* CPU credit mode by default. If this
one is in *standard* mode, a run longer than its credit balance throttles to
baseline and can take several times longer. Watch `CPUCreditBalance`. Pass
`--pause-ms=100` to slow the run if API latency rises.

Storage: on the copy, `places` grew 12% and `places_sources` 11% after a
vacuum, which is about +2 GB in production, plus transient WAL. About 52 GB is
free, and autoscaling allows 200 GB.

## Runbook

The operator's shell has `GOWAY_PROD_DATABASE_URL`, which goes through the
tunnel (`postgresql://…@127.0.0.1:15432/goway?sslmode=require`). Run everything
from a checkout of the release branch with dependencies installed:

```sh
git switch feat/places-platform-release && bun install
```

Every command asserts it is connected to the database named by
`--target-database` before it reads a row.

### 1. Smoke test (read-only)

```sh
DATABASE_URL="$GOWAY_PROD_DATABASE_URL" bun run places:convert-legacy -- --target-database=goway --dry-run --step=sources
```

Expect `matched` ≈ `examined` ≈ 12.9M. The `seconds` value is your read rate.

### 2. Convert the source statements (invisible to users)

From here until the deploy finishes, do not dispatch *Import OpenStreetMap
POIs*.

```sh
DATABASE_URL="$GOWAY_PROD_DATABASE_URL" bun run places:convert-legacy -- --target-database=goway --step=sources
```

### 3. Convert the categories, then merge promptly

```sh
DATABASE_URL="$GOWAY_PROD_DATABASE_URL" bun run places:convert-legacy -- --target-database=goway --step=categories
```

**Stopping and resuming.** You can stop at any time with Ctrl-C, a dropped
tunnel or a failed batch: every batch is idempotent. To continue, resume after
the last logged id:

```sh
DATABASE_URL="$GOWAY_PROD_DATABASE_URL" bun run places:convert-legacy -- --target-database=goway --step=categories --from=<lastId>
```

Every progress line and every error prints its own `--step=… --from=…`. You
can also simply re-run the command: converted batches cost a read and no
write.

A batch that waits more than 5 s on a row lock, or runs longer than 5 min, is
retried with backoff up to 5 times before the command stops.

Optionally, run `VACUUM (ANALYZE) places; VACUUM (ANALYZE) places_sources;` once
both runs finish. Autovacuum would do it too. Neither statement blocks reads or
writes.

### 4. Verify completion

The exact check uses the migrations' own predicates. It writes nothing:

```sh
DATABASE_URL="$GOWAY_PROD_DATABASE_URL" bun run places:convert-legacy -- --target-database=goway --dry-run
```

Every `matched` must be **0**: `categories` (rows `0011` would still change),
`taxonomy-check` (rows `0013`'s CHECK would refuse) and `sources`.

As an independent cross-check in SQL, run the following from the repository
root. The first command uses `0013`'s CHECK expression, extracted from the
migration file:

```sh
psql "$GOWAY_PROD_DATABASE_URL" -Atc "SELECT count(*) FROM places WHERE NOT ($(sed -n 's/.*CHECK (\(.*\)) NOT VALID;$/\1/p' packages/backend/drizzle/0013_goway_category_taxonomy.sql))"
psql "$GOWAY_PROD_DATABASE_URL" -Atc "SELECT count(*) FROM places_sources WHERE source_data IS NOT NULL AND source_data -> 'v' IS NULL"
psql "$GOWAY_PROD_DATABASE_URL" -Atc "SELECT count(*) FROM places WHERE opening_hours -> 'timezone' IS NOT NULL"
```

The expected results:

- The first two counts must be **0**. A small number written after the
  conversion is also acceptable: the post phase converts it.
- The third count is the timezones the post phase will move. It is expected to
  be small and non-zero.

### 5. Merge

Merging runs CI, then the deploy:

1. pre phase, `0007`–`0010`;
2. rollout of the new image;
3. post phase, `0011`–`0013`.

The post phase scans and converts only the stragglers. `0012` and `0013`
then hold ACCESS EXCLUSIVE locks for milliseconds, because `0013` adds the
CHECK `NOT VALID`.

If the post phase fails, the new revision keeps serving. It never needed the
post phase. Re-run the deploy (`workflow_dispatch`) to retry that phase.

### 6. After the deploy: validate the CHECK

```sh
DATABASE_URL="$GOWAY_PROD_DATABASE_URL" bun run places:convert-legacy -- --target-database=goway --validate-constraint
```

This runs `VALIDATE CONSTRAINT` under SHARE UPDATE EXCLUSIVE, so reads and
writes continue while it scans. After it finishes, this query must return `t`:

```sql
SELECT convalidated FROM pg_constraint WHERE conname = 'places_categories_taxonomy_check';
```

Then re-run step 4. Every count is 0, including the timezones.

## Why the CHECK is `NOT VALID`

`ALTER TABLE … ADD CONSTRAINT … CHECK` takes ACCESS EXCLUSIVE on `places` and
scans every row. Inside the migrator's single transaction, that lock is held
from the statement until the phase commits. During that time no request can
read a place.

Adding `NOT VALID` and then `VALIDATE` in the same migration would not help.
`VALIDATE` takes a weaker lock, but the transaction would already hold the
ACCESS EXCLUSIVE lock from the `ADD` and keep it through the scan.

What actually shortens the lock is three things together:

- add the constraint `NOT VALID`, which takes milliseconds and still checks
  every new or updated row;
- order it last in the phase;
- validate it in a separate session afterwards (step 6).

For the same reason, the conversion now runs first in the post phase. The
brand-column drop's ACCESS EXCLUSIVE lock on `places_claims` is taken after the
scans, not before them.

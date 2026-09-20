# `@goway/backend`

The GoWay API: Places persistence, provider adapters and the realtime surface.
Express 5 on Bun in development, compiled to CommonJS and run on Bun in the
container. PostgreSQL + PostGIS is the only store — there is no MongoDB, no
cache-as-database and no in-memory fallback, so a process that cannot reach
Postgres does not start.

## Layout

```text
server.ts                process bootstrap ONLY: connect → listen → drain → exit
src/app.ts               createApp(): helmet, CORS, json, routers, notFound, errorHandler
src/realtime.ts          Socket.IO, attached to the same HTTP server
src/config/index.ts      zod-parsed environment, ONE parse at module load
src/db/postgres.ts       connectPostgres/getDb/closePostgres + Database|Transaction handles
src/db/extensions.ts     REQUIRED_EXTENSIONS — a precondition of the migrator
src/db/migrate.ts        the one way a migration is ever applied
src/db/schema/           drizzle tables; index.ts is the barrel and the source of truth
src/db/places/           the ONLY code that touches the Places tables
  placeGeo.ts            ST_DWithin / ST_Intersects / ST_Distance, each in its one legal place
  placeMapper.ts         row → the published `Place`; nothing else may build one
  placesRepository.ts    reads, writes, source linking and duplicate detection
src/db/capture/          the ONLY code that touches the Street 3D capture tables
  captureMapper.ts       row → the published contract; keeps object keys and Oxy ids OUT
  captureRepository.ts   registration, deduplication, finalize and storage reporting
src/capture/             the capture decisions that are not database access
  anchor.ts              which position claim wins, and what its provenance was
  exif.ts                EXIF/QuickTime GPS → a GoWay coordinate, refs and all
  retention.ts           what is stored, why, and until when
src/storage/objectStore.ts  the GoWay interface; S3 is an adapter behind it
src/storage/s3ObjectStore.ts  SigV4 presigning over node:crypto — no AWS SDK
src/import/osm/          the OpenStreetMap POI import (#63) — a one-shot task, not a route
  protobuf.ts            the six protobuf wire constructs osmformat.proto uses
  pbf.ts                 blob framing, PrimitiveBlock, and per-blob offsets
  poiTags.ts             which OSM tags are a POI, and what GoWay calls them
  placeRecord.ts         one element → the facts GoWay stores. Pure.
  extract.ts             the three passes a sorted extract forces
  merge.ts               what a RE-import may change. Pure.
  writePlaces.ts         batched upserts; the only writer outside db/places/
  duplicates.ts          feeds places_duplicate_candidates; merges nothing
  download.ts            a resumable fetch, because the image has no curl
  verifyProvenance.ts    dereferences a sample against OpenStreetMap (see #58)
  run.ts                 the entry point the ECS one-shot invokes
src/db/__tests__/        the real-database suites + their harness (never built into dist/)
src/http/apiError.ts     ApiError + the public error-code vocabulary
src/http/errorHandler.ts the single place a failure becomes a response
src/http/validation.ts   zod → bad_request | validation_failed, details without values
src/middleware/auth.ts   Oxy auth, from @oxy.so/core/server and nowhere else
src/middleware/cors.ts   the public-read lane and the strict one, and which route gets which
src/routes/health.ts     GET /health (liveness + database reachability), GET /ready
src/routes/places.ts     the Places surface, mounted at /api/v1
src/routes/placeSchemas.ts  the request schemas, at least as strict as the CHECKs behind them
src/routes/capture.ts    the Street 3D contribution surface (#9/#10)
src/routes/captureSchemas.ts  its request schemas, with EXIF normalized at the boundary
src/config/capture.ts    retention windows, media limits and the object-store settings
src/utils/logger.ts      pino, with the redaction list
drizzle/                 GENERATED migrations — never hand-written
```

`connect BEFORE listen` is the rule `server.ts` exists to hold: a task that binds
the port first is reachable before it can answer, so the load balancer routes to
it and every request fails against a pool that is not open yet.

## Getting started

```bash
docker compose -f ../../docker-compose.postgres.yml up -d --wait postgres
cp .env.example .env
bun run db:migrate --target-database=goway_dev
bun run dev
```

## Places

`/api/v1` — the base path `@goway.to/sdk` ships as `GOWAY_API_BASE_PATH`. The
SDK is published contract, so these paths and payload shapes are not ours to
change unilaterally.

| route | auth | answers |
| --- | --- | --- |
| `GET /places/:id` | public | one `Place`, in any status |
| `GET /places/nearby?latitude&longitude&radiusMeters` | public | `PlaceWithDistance[]`, nearest first |
| `GET /places/bounds?west&south&east&north` | public | `Place[]` in the viewport |
| `GET /places?bbox=w,s,e,n` | public | the same, under the spelling issue #4 documents |
| `POST /places` | Oxy session | 201 + the created `Place` |
| `PATCH /places/:id` | Oxy session | the updated `Place` |

Reads are public because the map opens without an account. `?capabilities=` is a
conjunction and `?categories=` a disjunction, both answered without a client
knowing the capability table exists. A success body IS the contract value —
there is no envelope; only failures carry `{ error: { code, message, details? } }`.

Three rules the code is written to and the tests measure:

- `ST_DWithin` in a WHERE clause is index-backed; `ST_Distance(...) < r` is not
  and scans the planet, so `ST_Distance` appears only in a SELECT list or an
  ORDER BY. `placesGeo.realdb.test.ts` asserts both plans.
- The `places.geo` point is `GENERATED ALWAYS … STORED` from `longitude` and
  `latitude` and is never written. A transposed pair is a valid point in the
  wrong hemisphere, so the ordinate order is asserted against a real distance
  (Barcelona→Madrid ≈ 507 km; transposed it reads 659 km).
- Reconciliation links on `(source, sourceId)` and MERGES NOTHING. Look-alikes
  become rows in `places_duplicate_candidates` for review.

## Importing OpenStreetMap POIs

`src/import/osm/` fills `places` from an OpenStreetMap extract, so the shops,
bars and museums on the map are GoWay records with GoWay ids rather than
labels baked into somebody else's tile. It is a one-shot task, never a route
and never a background job on the API.

### What it imports, measured

A `--dry-run` over `europe/spain` on a GitHub runner, against the 1.48 GB
(1,483,405,280 byte) Geofabrik extract — measured, not estimated:

| | |
| --- | --- |
| places | **771,515** — 553,974 nodes, 209,346 ways, 8,195 relations, 0 unpositioned |
| translated names | **31,331** on 25,825 places, across 20+ languages |
| top languages | `es` 13,448 · `en` 5,294 · `ca` 4,612 · `eu` 1,772 · `fr` 1,361 · `gl` 960 |
| extract passes | 73 s + 29 s + 41 s = **143 s**, 51,308 blobs inflated |
| download | 1.48 GB in 113 s |
| peak resident memory | **541 MB** (670 MB for the whole runtime) |
| mean record size | **779 bytes** of normalized facts per place |
| provenance sample | **25 of 25** elements dereferenced to the right element |

The largest categories are `bus_stop` (70k), `restaurant` (58k),
`place_of_worship` (35k), `cafe` (20k), `bar` (20k) and `park` (20k) — which is
what a country looks like, and a useful shape to compare a future run against.

Reproduce it anywhere, including on a laptop, without a database:

```bash
bun run import:osm -- --dry-run --region=europe/spain
```

What is NOT measured here is the write itself: it needs `oxy-postgres`, which
is unreachable from anywhere a measurement can run. 772 batches of a thousand
places, five statements each, is the shape it was designed for; the first real
run is the number.

### What counts as a POI

`poiTags.ts` has the full reasoning. In short: the imported set must be a
SUPERSET of what the basemap's `poi-*` layers draw, or switching those layers
off loses places a user can see today. So inclusion is by tag KEY rather than by
a whitelist of values — `amenity=*`, `shop=*`, `tourism=*`, `leisure=*`,
`historic=*`, `office=*`, `craft=*`, `sport=*`, plus narrow value lists for the
keys whose other values are not places — and every POI must have a `name`,
which is what every one of those layer filters already requires. The classes the
style draws NOWHERE (`POI_CLUTTER_CLASSES`: bollards, gates, waste baskets,
station entrances) are the one deliberate exclusion.

`poiTags.test.ts` reads `packages/frontend/lib/map/style/layers.ts` and
`schema.ts` and checks the copy against them, so "copied from the map style" is
a verified claim rather than a comment.

### Running it in production

`oxy-postgres` is not publicly accessible, so the import runs inside the VPC as
a one-shot ECS task against the SHIPPED image — exactly as a migration does:

```bash
# The network identity comes off the live service; never hardcode a subnet.
NETWORK=$(aws ecs describe-services --cluster oxy-cluster --services goway \
  --query 'services[0].networkConfiguration.awsvpcConfiguration' --output json \
  | jq -r '"awsvpcConfiguration={subnets=[" + (.subnets|join(",")) + "],securityGroups=[" + (.securityGroups|join(",")) + "],assignPublicIp=" + .assignPublicIp + "}"')

aws ecs run-task --cluster oxy-cluster --task-definition oxy-goway \
  --launch-type FARGATE --count 1 --network-configuration "$NETWORK" \
  --overrides '{
    "cpu": "2048", "memory": "4096",
    "containerOverrides": [{ "name": "goway", "command": [
      "bun","packages/backend/dist/src/import/osm/run.js",
      "--target-database=goway","--region=europe/spain"]}]}'
```

Output goes to CloudWatch `/oxy/ecs`, stream `goway/goway/<task-id>`.

**Cost.** Fargate ARM in `us-west-2` is $0.03238 per vCPU-hour and $0.00356 per
GB-hour, so 2 vCPU / 4 GB is **$0.079 an hour** — about **four cents** for a
half-hour run and under a dime if the write path takes twice as long as the
extract suggests. Ingress from Geofabrik is not charged. This is small enough
that running it nightly costs less than a coffee a month; it is not a reason to
run it nightly, but it is a reason not to hesitate over a re-run.

**2 vCPU / 4 GB, and 20 GiB of ephemeral storage, are measured rather than
chosen**: the pass peaks at 596 MB and the extract is 1.48 GB. The serving task
is 512/1024, which is right for an API and too small for this; overriding at
`run-task` borrows the family for one run instead of registering a new revision
of it, which the next deploy would roll the service onto.

`.github/workflows/import-osm-pois.yml` is the same invocation as a
`workflow_dispatch`. **It cannot run until oxy-infra grants
`oxy-goway-github-deploy` `ecs:RunTask`, `iam:PassRole`, `ecs:DescribeTasks` and
`logs:GetLogEvents`** — `iam-goway-deploy.tf` deliberately has none of them, and
its own header says what to add. Until then the command above, run by a human
with those permissions, is the only path.

A first run does not have to be a whole country: `--bbox=2.15,41.37,2.19,41.40`
is central Barcelona, a few thousand places, and proves the write path before it
is asked for three quarters of a million.

### Checking it worked

`/places/bounds` is a viewport read and publishes ONE name per place, so the
check is two requests. The first asks for the same places in Spanish; the
second opens one of them, which publishes the full `names` set
unconditionally:

```bash
BOX='west=2.15&south=41.37&east=2.19&north=41.40'
curl -s "https://api.goway.to/api/v1/places/bounds?$BOX&locale=es&limit=5" \
  | jq '.places[] | {id, name, localizedName, categories}'

curl -s "https://api.goway.to/api/v1/places/<id>" | jq '{name, names, sources}'
```

Before this import, the first answers `{"places":[]}`. After it, every place
has non-empty `categories`, a `localizedName` that differs from `name` wherever
OpenStreetMap records one, and a `sources` entry whose `sourceId` is a
`<type>/<id>` that `https://www.openstreetmap.org/<type>/<id>` opens on the
right building.

### Running a second time

Designed to be run repeatedly, and cheap when nothing has changed:

- **Places are matched on `(openstreetmap, <type>/<id>)`**, which is unique
  across `places_sources`, so a re-import updates rather than duplicating.
- **A GoWay correction survives.** `merge.ts` compares three values for every
  column — what it holds, what the source said LAST time (kept in
  `places_sources.source_data`) and what it says now — and only moves a column
  that still equals the source's own previous value. Names get the same
  guarantee from the schema instead: the upsert targets
  `(place, language, 'openstreetmap')` and has no way to address a `goway` row.
- **Nothing is ever deleted.** A POI absent from today's extract is not a
  statement that the place closed.
- **An unchanged place produces no write at all**, so a re-run does not churn
  `updated_at` for a country and re-invalidate every client's cache.

### What it does NOT import

- **Opening hours.** `OpeningHours.intervals` is a structured weekly schedule
  and OSM's `opening_hours` is a small language. An empty `intervals` reads as
  "never open", which is worse than no data, and a real parser is its own issue.
- **Footprints.** `places.geometry` stays null; a way POI is positioned at the
  mean of its vertices, which is where a pin goes, not where a polygon is.
- **Relations with no way members**, and ways whose nodes the extract does not
  contain. Both are counted as `unpositioned` in the summary (0 for Spain).

### Locally

```bash
bun run import:osm -- --target-database=goway_dev \
  --region=europe/monaco --verify-sample=5
```

Monaco is 700 kB and finishes in seconds. A `--dry-run` writes nothing and opens
no connection, but still needs a syntactically valid `DATABASE_URL`: this
package parses its whole configuration at module load, on purpose.

## Street 3D capture

The contribution surface for #9/#10. Everything here needs an Oxy session
except the policy read — submitting has to be attributable so consent, deletion
and abuse handling are possible at all, while a visitor deciding whether to
contribute is entitled to know the retention policy first.

| route | auth | answers |
| --- | --- | --- |
| `GET /captures/policy` | public | `CaptureUploadPolicy` — accepted media, limits, retention |
| `POST /captures/sessions` | Oxy session | 201 + `CaptureSession`, recording the consent version |
| `GET /captures/sessions/:id` | Oxy session | the caller's own session |
| `GET /captures/sessions/:id/assets` | Oxy session | its `CaptureAsset[]`, with state, gate and expiry |
| `POST /captures/sessions/:id/assets` | Oxy session | 201 + `CaptureUploadTicket` |
| `GET /captures/assets/:id` | Oxy session | one `CaptureAsset` |
| `POST /captures/assets/:id/finalize` | Oxy session | the `CaptureAsset`, idempotently |

```text
app  →  POST …/assets            registers the contribution, returns an upload target
app  →  PUT  <object store>      the bytes, DIRECTLY — never through this process
app  →  POST …/:id/finalize      GoWay asks the store whether they arrived
```

Four rules the schema enforces rather than the code remembering:

- **No raw media is permanent by accident.** `capture_media_objects` declares
  `retention_class`, `retention_reason` and `expires_at` NOT NULL and CHECKs the
  expiry against a 400-day backstop no configuration can raise, so a permanent
  raw upload cannot be inserted — by this application or by a backfill.
- **Exact duplicates are one object.** A PARTIAL unique index on
  `(content_hash) WHERE deleted_at IS NULL`: the same photo twice is one stored
  object and two contributions, and the same bytes can be contributed again once
  the first object has expired. Near-duplicates are deliberately NOT handled —
  see the note in `src/db/schema/capture.ts`.
- **Privacy fails closed.** `capture_assets.reconstruction_eligible` is
  `GENERATED ALWAYS`, so nothing can write it, and a CHECK additionally refuses
  to let an asset enter a reconstruction state while the gate is shut.
- **A position is evidence.** Every claim is a row in
  `capture_location_evidence` with its origin AND its witness; the resolved
  anchor on the asset records which one won. A client can never claim GoWay
  measured a position itself.

There is no user location history here and there must not be one: every
coordinate hangs off a submitted asset, and `capture_sessions` holds no position
at all.

## Tests

`bun run test` needs a real PostgreSQL + PostGIS server. The `*.realdb.test.ts`
suites REFUSE to run without one rather than skipping — a skipped spatial suite
and a passing one are the same colour, and PostGIS is where every expensive
Places bug hides. Each file creates, migrates and drops its own throwaway
database on the server `TEST_DATABASE_URL` (or `DATABASE_URL`) names; the
database in that URL is never touched.

```bash
docker compose -f ../../docker-compose.postgres.yml up -d --wait postgres
export TEST_DATABASE_URL=postgres://goway:goway@127.0.0.1:5440/goway_dev
bun run test
```

## Commands

| command | what it does |
| --- | --- |
| `bun run dev` | watch-mode server on `PORT` (3000) |
| `bun run build` | `tsc` → `dist/` (CommonJS; the image runs this output) |
| `bun run start` | run the compiled server |
| `bun run typecheck` | the emitting program AND `tsconfig.tools.json` (see below) |
| `bun run lint` | eslint over every source file, `dist/` excluded |
| `bun run test` | `bun test` |
| `bun run db:generate` | diff `src/db/schema/` and WRITE a migration |
| `bun run db:migrate --target-database=<name>` | APPLY migrations |
| `bun run import:osm -- --target-database=<name>` | import OpenStreetMap POIs |

`typecheck` runs two programs on purpose. `tsconfig.json` is the emitting build
and excludes `drizzle.config.ts` (it imports the `drizzle-kit` devDependency the
runtime image strips) and `src/__tests__/` (dead weight in `dist/`).
`tsconfig.tools.json` is a non-emitting program over exactly those files —
because a file outside every `include` is removed from the program and can never
report an error.

## The error envelope

Every failure is `{ error: { code, message, details? } }`. The CODES are the
public contract — `packages/shared-types` re-exports the `API_ERROR_CODES` tuple
and `@goway.to/sdk` builds its typed errors from that re-export, so the SDK's
union cannot drift from the API's. Routes THROW an `ApiError`; nothing formats an
error itself. Anything thrown that is not an `ApiError` is a defect, answered
`500 internal_error`, leaking no message, stack or driver detail.

## Migrations

Never hand-write one. Edit `src/db/schema/`, run `bun run db:generate`, then add
exactly one marker line to the generated `.sql`:

```
-- oxy:deploy-phase=pre      additive; safe while the previous image serves
-- oxy:deploy-phase=post     drops/renames/narrows; only once the new image is live
```

There is no default, and an unmarked migration is a hard failure in
`bun run check:migrations` and again in the migrator before any DDL runs.

`bun run db:migrate --target-database=<name>` is the only way to apply one, dry
runs included — never `drizzle-kit migrate`. The flag is required on every
invocation because its absence does not fail loudly: pointed at the wrong
database a migrator finds an empty ledger, applies the entire journal, logs
`Applied N` and exits 0, leaving the real database untouched while the operator
reads a success line.

Two things interpolation gets wrong, both caught by `bun run check:migrations`:

- a JavaScript value interpolated into `check()` becomes the literal `$1` in the
  generated SQL and fails at APPLY time (`there is no parameter $1`) — use
  `sql.raw(String(value))` for the constant side;
- `column.name` on a drizzle column is the TypeScript property name, not the SQL
  one — `sqlColumnName()` from `@oxy.so/db` is how hand-written SQL gets the SQL
  name.

## PostGIS: `CREATE EXTENSION` is PRIVILEGED

GoWay's Places schema names `geography` in its very first table, so PostGIS has
to exist before migration `0000` runs. It is therefore in `REQUIRED_EXTENSIONS`
(`src/db/extensions.ts`) — a precondition the migrator ensures on **every** run,
in every environment — and NOT in a numbered migration, because anything that
must be true before the first migration cannot live inside the numbered sequence
at all.

**Provisioning a NEW production database is a two-party job.** The migrator
spells it `CREATE EXTENSION IF NOT EXISTS postgis`, and the duplicate check
short-circuits **before** the privilege check. That gives two opposite outcomes
from the same statement:

- on a database somebody has already prepared, it is a NOTICE and a silent no-op,
  even for an unprivileged application role — which is exactly what we want, and
  exactly why it reads as if no privilege were needed;
- on a fresh, unprepared database, the same statement raises
  `permission denied to create extension "postgis"`. Owning the database is not
  enough.

So before GoWay's migration role can migrate a new database, somebody holding
`rds_superuser` (RDS) or the local `postgres` superuser must run, once:

```sql
CREATE EXTENSION IF NOT EXISTS postgis;
```

See oxy-infra `docs/runbooks/30-postgres-database-provisioning.md`.

**The image alone is not enough either.** `postgis/postgis:17-3.5` seeds PostGIS
into `POSTGRES_DB` and a `template_postgis` template — never into `template1`.
Any database created afterwards without a `TEMPLATE` clause (a throwaway test
database, a second dev database) is cloned from `template1` and lands WITHOUT the
extension. Running the right image is necessary; the registry is what makes each
database usable.

Both versions in the image tag are pinned, in `docker-compose.postgres.yml` and
in `.github/workflows/ci.yml`, and CI asserts the two strings match. A floating
PostGIS minor is a floating set of function VOLATILITIES, and a generated
`geography` column needs `ST_MakePoint` and the `geography` cast to stay
IMMUTABLE.

## Authentication

`@oxy.so/core/server` only — `createOxyAuthMiddleware`, `createOptionalOxyAuth`,
`createOxyCors`, `createOxyRateLimit`, `authSocket`. No app-local bearer parsing,
no JWT verification, no second allowlist. Oxy owns identity, so `oxyUserId`
carries no foreign key and there is no `users` table.

The credential is a `Bearer` token in an `Authorization` header and nothing
else. There is no cookie-borne session anywhere on this API, and that fact is
what the public CORS lane below rests on.

The map opens without an account: browsing, search and routing sit behind
`optionalAuth` and must work signed out. Only identity-bound features (saves,
edits, lists, contributions) use `requireAuth`.

## CORS: two lanes

`src/middleware/cors.ts` picks one per request, ahead of the body parser. It
carries the full argument; this is the summary.

| lane | who gets it | headers |
| --- | --- | --- |
| **public** | the routes in `PUBLIC_READ_ROUTES` | `Access-Control-Allow-Origin: *`, no credentials header, no `Vary` |
| **strict** | everything else, including anything unrecognised | `createOxyCors`, unchanged: exact echoed origin or nothing, `Access-Control-Allow-Credentials: true`, `Vary: Origin` |

The public lane is exactly:

```text
GET  /api/v1/places            GET  /api/v1/search
GET  /api/v1/places/nearby     GET  /api/v1/geocode
GET  /api/v1/places/bounds     GET  /api/v1/geocode/reverse
GET  /api/v1/places/:id        GET  /api/v1/geocode/structured
POST /api/v1/routes
```

`POST /routes` is a read in every sense but the verb — a directions request is a
list of coordinates that does not fit in a query string — so its preflight is
answered on the public lane too, with `Access-Control-Allow-Headers:
Content-Type`. `Authorization` is deliberately not admitted there: a third-party
site that needs an AUTHENTICATED read gets its origin added to
`CORS_APP_ORIGINS` and the strict lane with it, or calls from its own server.

Two properties license the wildcard, and both are load-bearing: the data is
public and unauthenticated, and GoWay's credential is a non-ambient Bearer
header rather than a cookie, so a wildcard read carries no caller identity and
opens no CSRF surface. A spec-compliant `*` cannot be paired with
`Access-Control-Allow-Credentials: true`, and this lane never emits it.

It fails closed. The table is an explicit inventory, not a prefix rule — a
prefix rule would have made `GET /places/:id/claims` public — and a route added
to a router is on the strict lane until somebody writes it into the table.
`src/middleware/__tests__/cors.test.ts` walks the real routers and fails if
anything the table admits is mounted behind `requireAuth`, and if the set of
admitted routes is anything other than the list above.

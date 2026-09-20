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

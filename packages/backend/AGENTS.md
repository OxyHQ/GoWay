# Backend

Rules on top of the root `AGENTS.md`. Places rules: `src/places/AGENTS.md`.

## Database (drizzle)

- `src/db/schema/index.ts` is the single source of truth; a table missing there gets no migration and no typed query.
- Never hand-write a migration: edit the schema, `bun run db:generate`, then add `-- oxy:deploy-phase=pre|post` to the `.sql`.
- `bun run db:migrate --target-database=<name>` is the only way to apply one, dry runs included; never `drizzle-kit migrate`.
- Declare columns camelCase; `DATABASE_CASING` names them in SQL. Never spell snake_case by hand or use `column.name`: use `sqlColumnName()` from `@oxy.so/db`.
- `oxyUserId` carries no foreign key and there is no `users` table; Oxy owns identity.
- Extensions go in `REQUIRED_EXTENSIONS` in `src/db/migrate.ts`, not in a migration — **PostGIS included**.
- A phase is ONE transaction: never rewrite a big table in a migration (batch it first with an operator command that reads the migration's own SQL, like `places:convert-legacy`), put lock-taking DDL last, and add a CHECK to a big table `NOT VALID`.

## Live and Street 3D

- GoWay Live re-serves only feeds whose licence allows public, commercial redistribution (`live/catalogue.ts`), credits each while drawn, never persists a position and never stores or logs a viewport. Note: `docs/MAP_LIVE.md`.
- A capture's `motion` is gravity only (no position, heading or acceleration), sampled only while recording, kept no longer than its raw media and never published. Design note: `docs/STREET3D_MOTION_PRIORS.md`.
- A licensed Street 3D import publishes only with a privacy attestation (served as `privacyBasis`) and claims no privacy pipeline version; it is never clustered, rebuilt or retracted. Note: `docs/STREET3D_PIPELINE.md`.
- A capture's declared projection is a claim: the privacy worker verifies 360° media against its own metadata and 2:1 pixels and fails closed; panoramas are processed only as views, nadir masked. Design note: `docs/STREET3D_PIPELINE.md`.

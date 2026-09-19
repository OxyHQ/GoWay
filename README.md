# GoWay

GoWay is Oxy's open map and geographic platform, built for web, iOS and Android with Expo.

It provides both the consumer map experience at **https://goway.to** and the reusable **`@goway.to/sdk`** used by FairCoin, Moovo, Mercaria, Homiio, Mention, Clarity and other Oxy or third-party apps.

## Getting started

Bun only — never npm, yarn or pnpm, and `bun.lock` is committed with the
`package.json` change that moved it.

```bash
bun install

# PostgreSQL 17 + PostGIS 3.5 on 127.0.0.1:5440, loopback only.
# Both versions are pinned: a floating PostGIS minor is a floating set of
# function volatilities, and a generated `geography` column needs ST_MakePoint
# to stay IMMUTABLE.
docker compose -f docker-compose.postgres.yml up -d --wait postgres

cp packages/backend/.env.example packages/backend/.env
bun run db:migrate --target-database=goway_dev

bun run dev            # backend + Expo together
bun run dev:backend    # backend alone, on :3000
bun run dev:frontend   # Expo alone
```

Port **5440** rather than 5432: an Oxy developer machine routinely has several
backends' local databases up at once, and 5432–5439 and 5441 are already spoken
for (5432 oxy-api, 5433 Mention, 5434 Homiio/Syra, 5435 Mercaria,
5436 CrowdSource, 5437 Moovo, 5438 Noted, 5439 Peable, 5441 Schedio). A port
collision does not fail loudly once a container is running — it connects you to
somebody else's database and migrates it.

`CREATE EXTENSION postgis` is privileged. On a brand-new database a role with
`rds_superuser` has to run it once before GoWay's migration role can migrate;
`packages/backend/README.md` explains why `IF NOT EXISTS` hides that.

### Checks

```bash
bun run typecheck        # tsc -b across every package, plus the non-emitting tools program
bun run lint
bun run test             # bun test
bun run check:migrations # deploy-phase markers + no $1 placeholders in generated SQL
bun run check:lockfile   # bun.lock matches the manifests it describes
bun run test:gates       # proves the migration gates can fail
```

CI runs all of these, and the AWS deploy is a JOB of the CI workflow with
`needs:` those jobs — not a workflow with its own `push` trigger, which would
race CI and always win.

## Monorepo

GoWay follows the Oxy `packages/*` convention:

```text
packages/
  frontend/                 Expo Router app for web, iOS and Android
  backend/                  GoWay API, Places persistence and provider adapters
  sdk/                      public @goway.to/sdk package
  shared-types/             provider-neutral shared contracts and Places types
  reconstruction-worker/    Python/CUDA Street 3D worker
```

The frontend uses the same Oxy application foundation as the rest of the ecosystem: Expo Router, React Native/react-native-web, `@oxy.so/app-preset`, Bloom, Oxy Services/contracts/core and Oxy authentication. Street 3D contribution UI stays inside this same Expo app rather than becoming a separate product.

## Core platform

- **Maps** — MapLibre rendering, initially using OpenFreeMap/OpenStreetMap-derived vector data.
- **Places** — a first-class GoWay Places schema backed by PostgreSQL + PostGIS, with stable place IDs, source provenance, business relationships and extensible capabilities such as FairCoin acceptance.
- **Search** — provider-neutral place/address search, geocoding and reverse geocoding.
- **Routing** — provider-neutral directions and route geometry.
- **SDK** — `@goway.to/sdk` exposes maps, Places, search and routing without making consumer apps depend directly on MapLibre or an external geographic provider.

### Places schema ownership

The Places schema is part of GoWay v1, not deferred. Its public/domain contracts live in `packages/shared-types`; its canonical database schema, spatial indexes and migrations live in `packages/backend` using PostgreSQL + PostGIS. We intentionally do **not** create a separate public database-schema package because SDK consumers should depend on stable GoWay contracts, not on GoWay's internal tables or migrations.

GoWay does not need to host the full world map dataset initially. The map infrastructure is replaceable independently from GoWay-owned Places and ecosystem data.

## Street 3D

Street 3D is GoWay's community-built future street-level layer. Instead of depending on proprietary panorama coverage, users can contribute ordinary geotagged photos or videos. GoWay temporarily stores useful source media, matches overlapping views, solves camera geometry and progressively builds versioned 3D Gaussian scenes.

The design is intentionally cost-conscious:

- raw photos/videos are temporary reconstruction inputs, not a permanent archive;
- default source retention is measured in weeks/months, with aggressive deduplication and early raw-video deletion after useful keyframes are extracted;
- incomplete areas can become **at risk** when useful temporary captures are nearing expiry, allowing the community to contribute missing viewpoints before the opportunity is lost;
- published 3D scenes remain durable even after their raw source images are deleted;
- compact derived metadata, manifests and published splat/LOD assets are kept instead of indefinite raw media;
- AWS provides the control plane, S3/object storage and queueing during the bootstrap stage;
- expensive reconstruction can run on owned hardware through `packages/reconstruction-worker`, initially a local RTX 5090 consuming durable AWS SQS jobs;
- the worker can be offline without breaking GoWay and can later scale to multiple owned/cloud GPUs using the same contract;
- privacy preprocessing is required before captures become reconstruction inputs, including face/license-plate and dynamic-object handling;
- Street 3D is streamed by versioned scene/LOD manifests and integrated back into GoWay Places rather than embedding business metadata into 3D assets.

Street 3D is **not required for the first 2D GoWay release**, but it is an explicit GoWay roadmap track rather than an undefined future Street View add-on.

## Roadmap issues

### Mapping platform

- #1 repository/packages/Oxy foundation
- #2 MapLibre + OpenFreeMap rendering
- #3 `@goway.to/sdk`
- #4 GoWay Places + PostgreSQL/PostGIS
- #5 search/geocoding
- #6 routing
- #7 GoWay Bloom map experience
- #8 FairCoin merchant-discovery reference integration

### Street 3D

- #16 Street 3D epic / implementation order / cost-quality gates
- #9 geotagged photo/video contribution pipeline
- #10 temporary storage, retention, deduplication and cost budgets
- #11 geospatial capture graph + automated 3D Gaussian reconstruction
- #12 distributed GPU reconstruction worker + local RTX 5090/AWS SQS
- #13 privacy-safe capture/reconstruction pipeline
- #14 streamed Street 3D viewer + map integration
- #15 coverage health, expiry risk and community rescue UX

## License

The Breathe License 1.0 (`LicenseRef-Breathe-1.0`) — the same licence as the
rest of the Oxy ecosystem. The full text is in `LICENSE`, with `NOTICE` for
attribution. Commercial terms:
<https://github.com/OxyHQ/.github/blob/main/LICENSE-COMMERCIAL.md>.

Attribution under Section 3.1 is required of everyone, including paying
commercial licensees, and cannot be waived.

`@goway.to/sdk` ships its own copies of `LICENSE` and `NOTICE` in the
published tarball, because a consumer who installs the package never sees this
repository. Its release smoke test asserts both are present.

Geographic data served through GoWay carries its own upstream licences and is
not relicensed by this file — OpenStreetMap-derived data is ODbL.

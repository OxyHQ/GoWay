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
race CI and always win. The Cloudflare frontend deploy is a second such job
(`deploy-frontend`), for the same reason and on the same gates.

## Deploying the web app

`https://goway.to` is served by a **Cloudflare Worker serving static assets**,
published by `.github/workflows/deploy-frontend.yml` on every push to `main`
that passes CI. The build is an `expo export --platform web` of
`packages/frontend`; the Worker is configured entirely by
`packages/frontend/wrangler.toml`.

**It needs no backend.** `packages/frontend/lib/goway/client.ts` injects a
fixture `fetch` into the real `@goway.to/sdk` client while
`EXPO_PUBLIC_GOWAY_FIXTURES` is not `0`, so the deployed bundle is a complete,
browsable map — search, place details, routing, every degraded state — that
makes no call to `api.goway.to` at all. When the API is live, flipping that one
env value in the deploy workflow is the cutover.

### A Worker, not Pages — and why `workers_dev = false` is the point

A Cloudflare **Pages** project ALWAYS serves `<project>.pages.dev` and offers
no way to turn it off (`wrangler pages project` has only `list`, `create`,
`delete`). Every Oxy app that was on Pages therefore had a second, indexable
copy of itself on a hostname in no CORS allowlist and no Oxy application's
`redirectUris` — it rendered the shell and failed every call it made. GoWay is
born on Workers so it never has that hostname, and `workers_dev = false` in
`wrangler.toml` is the line that keeps it that way. Do not "simplify" this to
`wrangler pages deploy`.

The trade that comes with it: **Pages adds `x-content-type-options: nosniff`
and `referrer-policy: strict-origin-when-cross-origin` to every response;
Workers Static Assets does not.** Nothing in this repository asks for them, so
the difference is invisible to every build, test and deploy. They are declared
explicitly in `packages/frontend/public/_headers`, which `expo export` copies
into `dist/` verbatim, and the deploy workflow asserts both are on the live
response afterwards.

### One-time human setup

Everything below is done ONCE, by a human with access to Oxy's Cloudflare
account and the GitHub org. The deploy is fully automatic afterwards.

**1. Actions secrets — and the shadowing trap.**

The workflow reads exactly two values from `secrets`:

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | The Oxy **org-level** token — the same one every sibling frontend (Clarity, Inbox, Mention, Allo, Noted) deploys its Worker with. It must be Workers-capable: **Workers Scripts: Edit** on the account, and **Zone: Read** plus **Workers Routes: Edit** on the `goway.to` zone, which is what lets `wrangler` attach the custom domain and have Cloudflare write the record. |
| `CLOUDFLARE_ACCOUNT_ID` | The Oxy Cloudflare account id. |

If the first deploy fails with `Authentication error [code: 10000]`, the token
is Pages-scoped rather than Workers-capable — which is the failure the
shadowing note below describes.

> **Do NOT add these as repository secrets if the org already provides them.**
> **A repo-level Actions secret silently SHADOWS the org-level one of the same
> name**, and nothing reports it. `OxyHQ/Noted` carried its own
> `CLOUDFLARE_API_TOKEN` from 2026-07-15, scoped to Pages only; when the org
> token was rotated to a Workers-capable one on 2026-09-05 the repo copy kept
> winning and Noted's deploy failed `Authentication error [code: 10000]` while
> every sibling repo deployed fine. Check the org secrets first. If a repo-level
> copy already exists, **delete it** rather than updating its value.

Optionally set the repository **variable** `EXPO_PUBLIC_OXY_CLIENT_ID` to
GoWay's production Oxy client id. A variable, not a secret: the id ships inside
the bundle, so it is public by construction. Unset, the map still works — only
sign-in is disabled, and silently.

**2. DNS, in this order: DNS → deploy.** This order is not a preference.

**A Worker custom domain REFUSES a hostname that already has externally
managed DNS records (`code: 100117`).** Cloudflare writes and manages the
record for a custom domain itself, so the apex must be empty of address records
when `wrangler deploy` first runs.

1. In the `goway.to` zone, delete any existing **A / AAAA / CNAME** record at
   the apex. **Type-scoped** — a `TXT`/SPF/DMARC record at the same name must
   survive; deleting those breaks mail, not the website.
2. If `goway.to` is attached to a Cloudflare Pages project, detach it there too.
3. Run the workflow (merge to `main`, or `workflow_dispatch` on `main`).
   `wrangler` creates the Worker, attaches `goway.to` as a custom domain and
   writes the DNS record.

The downtime is that window — roughly 30 seconds when the build is ready first.
`api.goway.to` is a separate record in front of the AWS ALB and is **not**
touched by any of this.

### What the deploy proves before it reports success

`wrangler deploy` exiting 0 means an upload was accepted, not that `goway.to`
serves this build — and the SPA fallback makes the naive check actively
misleading, because with `not_found_handling = "single-page-application"` every
path that misses an asset answers **200 with `index.html`**. A bare status
check would pass against a deployment containing nothing but a stale shell.

So the final step asserts a size floor plus positive markers: the shell is at
least 1 KB and carries the React root, the title and three or more hashed
bundle references; both `_headers` security headers are on the live response;
**the entry bundle this run just built, addressed by the content hash read out
of the local `dist/`, comes back as JavaScript rather than `text/html`** (the
one assertion that cannot pass against the previous deployment or against the
fallback); and a route that exists only inside the bundle answers with the
shell, proving deep links work.

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

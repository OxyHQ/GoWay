# GoWay Architecture

GoWay is split into four layers:

1. **GoWay App** — Expo Router app for web, iOS and Android using Bloom and Oxy services.
2. **GoWay SDK** — reusable `@goway.to/sdk` package exposing provider-agnostic maps, Places, search and routing APIs to GoWay, FairCoin Wallet, Moovo, Mercaria, Homiio, Mention, Clarity and third-party apps.
3. **GoWay Places** — GoWay-owned geographic/place identity and enrichment layer backed by PostgreSQL + PostGIS. The Places schema is part of the initial platform, not a later optional feature.
4. **Map infrastructure** — MapLibre as renderer, initially backed by OpenFreeMap/OpenStreetMap-derived vector data, with routing/geocoding providers abstracted behind GoWay interfaces.

## Package boundaries

```text
packages/
  frontend/                 consumer app
  backend/                  API, Places schema/migrations, provider adapters
  sdk/                      public @goway.to/sdk
  contracts/                the API contract: zod schemas, route registry, openapi.json
  reconstruction-worker/    Street 3D reconstruction worker (Python/CUDA)
```

`contracts` is the single source of truth for the API (`~/Oxy/docs/api-conventions.md`):
every request, response, error code and closed value set is a zod 4 schema
there, and every type is `z.infer`/`z.input` of one. The backend validates
requests with those schemas, `@goway.to/sdk` parses responses with them, and the
OpenAPI 3.1 document (`packages/contracts/openapi.json`, served at
`/api/v1/openapi.json`) and the JSON Schemas are generated from them and gated
fresh in CI. There is no second copy of a shape anywhere to drift.

`contracts` is private and is *bundled* into `@goway.to/sdk` at build time: a
published package naming a `workspace:*` dependency is unresolvable for every
consumer. The SDK's one runtime dependency is `zod`. `reconstruction-worker` is deliberately not a Bun workspace member —
it owns its own Python environment through `uv` and is driven by the root
`worker:setup` / `worker:doctor` / `worker:run` scripts.

## Principles

- One Expo codebase for web and native, with platform adapters only where the underlying renderer requires them.
- GoWay owns the stable API/SDK contracts; consumer apps should not couple directly to MapLibre, OpenFreeMap or an individual geocoder/router.
- Do not copy the whole OpenStreetMap dataset into the product database unless operationally justified.
- Give every GoWay-enriched physical place a stable GoWay Place ID independent of external provider IDs.
- Keep GoWay-owned data separate from third-party/open geographic source data and preserve provenance.
- The Places schema must support extensible capabilities such as FairCoin acceptance without adding product-specific tables for every consumer.
- Privacy by default: precise user location should not be retained unless a feature explicitly requires it and the user has consented.
- Street-level imagery is intentionally out of scope for the initial release.

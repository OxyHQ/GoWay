# GoWay

GoWay is Oxy's open map and geographic platform, built for web, iOS and Android with Expo.

It provides both the consumer map experience at **https://goway.to** and the reusable **`@goway.to/sdk`** used by FairCoin, Moovo, Mercaria, Homiio, Mention, Clarity and other Oxy or third-party apps.

## Monorepo

GoWay follows the Oxy `packages/*` convention:

```text
packages/
  frontend/       Expo Router app for web, iOS and Android
  backend/        GoWay API, Places persistence and provider adapters
  sdk/            public @goway.to/sdk package
  shared-types/   provider-neutral shared contracts and Places types
```

## Core platform

- **Maps** — MapLibre rendering, initially using OpenFreeMap/OpenStreetMap-derived vector data.
- **Places** — a first-class GoWay Places schema backed by PostgreSQL + PostGIS, with stable place IDs, source provenance, business relationships and extensible capabilities such as FairCoin acceptance.
- **Search** — provider-neutral place/address search, geocoding and reverse geocoding.
- **Routing** — provider-neutral directions and route geometry.
- **SDK** — `@goway.to/sdk` exposes maps, Places, search and routing without making consumer apps depend directly on MapLibre or an external geographic provider.

### Places schema ownership

The Places schema is part of GoWay v1, not deferred. Its public/domain contracts live in `packages/shared-types`; its canonical database schema, spatial indexes and migrations live in `packages/backend` using PostgreSQL + PostGIS. We intentionally do **not** create a separate public database-schema package because SDK consumers should depend on stable GoWay contracts, not on GoWay's internal tables or migrations.

GoWay does not need to host the full world map dataset initially. The map infrastructure is replaceable independently from GoWay-owned Places and ecosystem data.

Street-level imagery is intentionally outside the initial release scope.
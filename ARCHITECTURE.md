# GoWay Architecture

GoWay is split into four layers:

1. **GoWay App** — Expo Router app for web, iOS and Android using Bloom and Oxy services.
2. **Oxy Maps SDK** — reusable `@oxy.so/maps` package exposing a provider-agnostic map API to GoWay, FairCoin Wallet, Moovo, Mercaria, Homiio, Mention, Clarity and third-party apps.
3. **Oxy Places** — Oxy-owned geographic/place identity layer backed by PostgreSQL + PostGIS, used to enrich external map/OSM data with Oxy-native metadata.
4. **Map infrastructure** — MapLibre as renderer, initially backed by OpenFreeMap/OpenStreetMap-derived vector data, with routing/geocoding providers abstracted behind Oxy interfaces.

## Principles

- One Expo codebase for web and native, with platform adapters only where the underlying renderer requires them.
- Do not couple product code to MapLibre, OpenFreeMap or any individual geocoder/router.
- Do not copy the whole OpenStreetMap dataset into the product database unless operationally justified.
- Give every Oxy-enriched physical place a stable Oxy Place ID.
- Keep first-party Oxy data separate from third-party/open geographic source data and preserve provenance.
- Privacy by default: precise user location should not be retained unless a feature explicitly requires it and the user has consented.
- Street-level imagery is intentionally out of scope for the initial release.

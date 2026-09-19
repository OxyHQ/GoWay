# Changelog

All notable changes to `@goway.to/sdk`. The package follows semantic versioning
with the 0.x rule: while the major version is 0, a MINOR release may break the
API or the contract, and a PATCH release never does.

## 0.1.0 — unreleased

First release — the headless integration boundary GoWay's own frontend and
every consuming Oxy app use from now on (OxyHQ/GoWay#3), and the surface the
FairCoin merchant-discovery reference integration is built on
(OxyHQ/GoWay#8).

### Added

- `createGoWayClient` for Node 18+, Bun, browsers and React Native, with no
  runtime dependencies. ESM and CommonJS builds with bundled type declarations.
- Anonymous reads by default — the map, search and routing all work signed out.
  Identity-bound calls take an Oxy access token through `getAccessToken`, which
  is called before every request and never cached, stored or logged.
- Places: `places.get`, `places.nearby`, `places.inBounds`, `places.create`,
  `places.update`, with the generic typed capability filter
  (`capabilities: ['payments.faircoin.accepted']`).
- Search and geocoding: `search.query`, `geocode.forward`, `geocode.reverse`,
  `geocode.structured`.
- Routing: `routes.directions`, with `no_route` and `unsupported_mode` surfaced
  as branchable domain answers rather than defects.
- Canonical links: `links.place` (`https://goway.to/place/<placeId>`) and
  `links.map`.
- A typed error hierarchy driven off the shared `API_ERROR_CODES` vocabulary,
  carrying a `Symbol.for` lineage brand so `instanceof` survives a process
  holding both the ESM and the CommonJS copy.
- Every domain type re-exported from GoWay's shared contracts, bundled so no
  consumer resolves a private workspace package.

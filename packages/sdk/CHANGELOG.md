# Changelog

All notable changes to `@goway.to/sdk`. The package follows semantic versioning
with the 0.x rule: while the major version is 0, a MINOR release may break the
API or the contract, and a PATCH release never does.

## 0.1.1 — unreleased

A PATCH, and the version number is the claim: nothing in 0.1.0 changed meaning,
nothing was removed, and a consumer on 0.1.0 keeps working against a server that
has this change (OxyHQ/GoWay#61).

In particular `Place.name` is exactly what it was — the place's DEFAULT,
local-language name — and it does not move with the new `locale` parameter. A
field whose meaning depended on a query parameter would make one cached `Place`
mean different things to different holders of it, so the resolved answer is a
second field instead.

### Added

- `Place.names` — every language GoWay holds a name for the place in, each with
  its own provenance. Carried by `places.get` and by search results; ABSENT from
  `places.nearby` and `places.inBounds`, where every language of every pin is a
  payload nothing renders. Absent is not empty, as with `Place.claims`.
- `Place.localizedName` — the name for the locale the call asked for, present
  only when one exists. GoWay resolves it: requested tag → bare language →
  another variety of that language, and a GoWay correction outranks a source's
  spelling at every step.
- `placeDisplayName(place)` — `localizedName` if there is one, `name` otherwise.
  The one expression every consumer should render, published so nobody has to
  restate the fallback and quietly get it wrong.
- `locale` on `places.nearby` and `places.inBounds`, and a `locale` option on
  `places.get`. The client's own `locale` now applies to all three; before this
  release it reached search, geocoding and routing only.
- `normalizeLanguageTag`, `baseLanguageTag` and `LANGUAGE_TAG_PATTERN` — the
  canonical BCP 47 subset GoWay stores names under, so a consumer can key a
  cache the same way the server does.
- `PlaceName`, `PlaceReadOptions` and `GoWayPlaceReadOptions` types.

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

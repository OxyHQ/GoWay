# Changelog

All notable changes to `@goway.to/sdk`. The package follows semantic versioning
with the 0.x rule: while the major version is 0, a MINOR release may break the
API or the contract, and a PATCH release never does.

## 0.3.0 — 2026-10-04

The SDK now validates every request and parses every response with the
contract's own zod schemas — the ones the GoWay API validates with — instead of
hand-written copies, and follows the Oxy API conventions for lists, errors and
parameters (`~/Oxy/docs/api-conventions.md`). A MINOR under the 0.x rule, and
almost every part of it is breaking.

### Breaking

- **`zod` is a runtime dependency** (`^4.6.5`), imported rather than bundled, so
  a consumer that already uses zod 4 shares one copy. The package is no longer
  dependency-free. zod's own declarations name the global `URL` type, which
  Node's types, the DOM lib, React Native and Bun all provide.
- **The hand-written response parsers are gone.** Responses are parsed by the
  contract schemas; unknown keys are still stripped. An optional field that
  arrives as `null` is now a `GoWayResponseError` (it used to be read as
  absent): the contract says optional, not nullable. A malformed response's
  message is now `response.<path>: <expectation>`, and still never quotes a
  value.
- **Lists are pages, `{ items, nextCursor }`**, with opaque cursors:
  - `places.nearby` → `PlaceWithDistancePage` (was `PlaceWithDistance[]`);
  - `places.inBounds` → `PlacePage` (was `Place[]`);
  - `search.query` and every `geocode.*` → `SearchResults`, whose `results` is
    renamed **`items`** and which gains `nextCursor`;
  - `captures.sessions(query?)` → `CaptureSessionPage` (was the 50 most recent
    sessions as an array);
  - `captures.assets(sessionId, query?)` → `CaptureAssetPage` (was an array).

  Every list query takes `cursor` and `limit`. Pass a cursor back with the same
  filters; walk a whole list with `iterateGoWayPages`. The capture lists take
  their query FIRST, so their request options (`signal`) move to the last
  argument: `captures.sessions(query?, options?)`,
  `captures.assets(sessionId, query?, options?)`.
- **Inputs are validated client-side with the contract request schemas**, and
  the PARSED value is what is sent. A refusal is `GoWayValidationError` with
  `status: null`, a message of the form `query.<path>: <expectation>`, and no
  request sent. Concretely:
  - query parameters are strict: an unknown key is refused, not dropped;
  - a body drops keys the contract does not name (`id`, `verification`, a
    claim's `state` never leave the client) — except a scene report, whose
    contract is strict, so an unknown key there is refused;
  - `limit` is held to the contract maxima (`MAX_PLACE_LIST_LIMIT` 200,
    `SEARCH_MAX_LIMIT` 50, `MAX_CLAIM_LIST_LIMIT` 200,
    `MAX_CAPTURE_LIST_LIMIT` 100) instead of being left to the server, and the
    contract default limit is now sent explicitly on place, claim and capture
    lists;
  - `radiusMeters` is at most `MAX_RADIUS_METERS` (50 km), a bounds box or a
    search viewport spans at most `MAX_BOUNDS_SPAN_DEGREES` (90°), a search
    `query` is at most 256 characters, and `waypoints` at most `MAX_WAYPOINTS`
    (8);
  - **capability keys must be lower-case `<namespace>.<capability>`**, in a
    filter and in a path: `Payments.FairCoin.Accepted` is refused rather than
    matching nothing;
  - values are normalized: locale and name-language tags to their canonical
    spelling (`ES` → `es`, `zh_hant` → `zh-Hant`), country codes upper-cased,
    names and notes trimmed. A tag outside GoWay's BCP 47 subset is refused;
  - path parameters are checked by the contract's path schemas (a place id or
    capture id of at most 128 characters, a scene id of at most 64);
  - the client's `locale` option is normalized once and applied to every call
    that accepts one and names none, directions included.
- **`removed` is no longer a place status a caller can write or a published
  place can carry.** `PlaceCreateInput.status` / `PlaceUpdateInput.status` are
  `WritablePlaceStatus` (`active`, `closed`, `proposed`), `Place.status` is one
  of `PUBLISHED_PLACE_STATUSES`, and `places.get` of a removed place rejects with
  the new `GoWayGoneError` (410). `PlaceStatus` still names `removed`, as a
  stored state.
- **The capability filter requires a HOLDING value** (server-side): a place
  matches `capabilities: [key]` only when its strongest assertion of `key` is
  not `false`, `0` or `''`. A place whose business asserts `false` no longer
  matches because somebody once reported `true`. `placeHasCapability` applies
  the same rule client-side.
- **`captures.remove(assetId)` resolves with nothing** (the API answers `204`);
  it used to resolve with the withdrawn `CaptureAsset`.
- **`PlaceClaim` gains a required `placeId`** and an optional `decidedAt`.
- **Two new error classes**, both non-retryable: `GoWayGoneError` (`gone`, 410)
  and `GoWayUnknownRouteError` (`unknown_route`, 404 — this SDK and the API
  disagree about what routes exist; deliberately not a `GoWayNotFoundError`).
  A `rate_limited` 429 now arrives as a JSON error body, and
  `retryAfterSeconds` is read from its `details` first.
- **Renamed and removed exports.** `PlaceReadOptions` is now `PlaceReadQuery`.
  `PlaceCapabilityInput`, `PlaceCreateInput` and `PlaceUpdateInput` are no
  longer SDK-local: they are the contract's input types, so `PlaceCreateInput`
  gains `names`, its `status` narrows as above, and a written `source` is a
  `PlaceSourceRefInput` (`source` and `sourceId`; `observedAt` is the server's
  clock). `GoWayHttpMethod` adds `PUT`.

### Added

- `places.capabilities.put(placeId, key, assertion)` → `Place`, and
  `places.capabilities.delete(placeId, key)` → nothing (`204`).
- `places.claims.create(placeId, input)` → `PlaceClaim`,
  `places.claims.list(placeId, query?)` → `PlaceClaimPage`, and the new
  `claims` namespace with `claims.mine(query?)` → `PlaceClaimPage`.
- `iterateGoWayPages(fetchPage)` — an async iterator over every item of a list,
  which throws `GoWayResponseError` if the server ever repeats a cursor.
- `places.create` / `places.update` accept every field of the contract input,
  `names` included.
- Exports: the value sets `WRITABLE_PLACE_STATUSES`, `PUBLISHED_PLACE_STATUSES`,
  `RETENTION_CLASSES`, `CAPTURE_LOCATION_ORIGIN_RANK`,
  `CAPTURE_CONTENT_HASH_ALGORITHM`, `STRUCTURED_GEOCODE_FIELDS` (beside the ones
  already exported); the limits `MAX_PLACE_LIST_LIMIT`,
  `DEFAULT_PLACE_LIST_LIMIT`, `MAX_RADIUS_METERS`, `MAX_BOUNDS_SPAN_DEGREES`,
  `MAX_CLAIM_LIST_LIMIT`, `DEFAULT_CLAIM_LIST_LIMIT`, `MAX_CAPTURE_LIST_LIMIT`,
  `DEFAULT_CAPTURE_LIST_LIMIT`, `SEARCH_MAX_LIMIT`, `SEARCH_MAX_DEPTH`,
  `MAX_SEARCH_QUERY_LENGTH`, `MAX_WAYPOINTS`, `MAX_CURSOR_LENGTH`,
  `MAX_LANGUAGE_TAG_LENGTH`; the helpers `placeHasCapability`,
  `strongestCapability`, `capabilityValueHolds`, `splitCapabilityKey` and
  `boundingBoxWidth`; and the types `Page`, `PlacePage`,
  `PlaceWithDistancePage`, `PlaceClaimPage`, `CaptureSessionPage`,
  `CaptureAssetPage`, `PlaceCapabilityAssertion`, `PlaceClaimInput`,
  `PlaceNameInput`, `PlaceSourceRefInput`, `WritablePlaceStatus`,
  `CapabilityValue`, `ClaimListQuery`, `CaptureListQuery`, `ApiErrorDetails`,
  the remaining capture types and the `GoWayPlaceCapabilitiesApi`,
  `GoWayPlaceClaimsApi`, `GoWayClaimsApi` and `GoWayPageLike` interfaces.
- The whole route registry is covered: a unit test holds every operation the
  API publishes to an SDK method.

## 0.2.0 — unreleased

- Add the typed `captures` namespace for policy, sessions, registration, upload
  finalization, contribution history and withdrawal.
- Registration accepts an idempotency key so clients can retry the same intent.
- Upload tickets describe direct, checksum-bound object storage requests. The
  SDK never forwards account credentials or media bytes to object storage.

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

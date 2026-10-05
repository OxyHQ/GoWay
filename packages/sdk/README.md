# `@goway.to/sdk`

The canonical, headless TypeScript client for GoWay — Oxy's open map and
geographic platform.

One client gives you GoWay Places, ecosystem capability filters, claims, search,
geocoding, routing, Street 3D and the canonical `goway.to` links, on Node 18+,
Bun, browsers and React Native. Its one runtime dependency is
[zod](https://zod.dev) 4: the contract *is* zod schemas, and the SDK validates
every request and parses every response with them.

```bash
bun add @goway.to/sdk    # npm i @goway.to/sdk
```

## What you are *not* installing

Nothing about a map provider. GoWay currently renders with MapLibre over
OpenFreeMap tiles, geocodes with Photon and Nominatim and routes with Valhalla —
and **none of that is in this package or in its contract**. Those are
replaceable adapters behind the GoWay API; when GoWay swaps one, your code does
not change, because it never named the provider in the first place. Installing
this SDK pulls in no renderer and no provider client — only zod.

A result does tell you which provider answered (`SearchResult.source`,
`SearchResults.providers`) — provenance is never discarded — but that is
information to display or log, not an interface to program against.

This release is headless: it is the data client. Map *rendering* primitives live
in GoWay's frontend (`packages/frontend/components/map`) and are not part of this
package yet.

## Quick start

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();

const place = await goway.places.get('gw_place_01H8');
console.log(place.name, goway.links.place(place));
```

The map opens without an account: browsing, search and routing all work signed
out, and a client created with no options reads anonymously from
`https://api.goway.to`.

### Options

```ts
const goway = createGoWayClient({
  apiBaseUrl: 'https://api.goway.to',   // absolute http(s), no query or fragment
  webBaseUrl: 'https://goway.to',       // what links.* are built on
  fetch: myFetch,                       // defaults to the runtime's global fetch
  getAccessToken: () => session.token,  // called before EVERY request
  locale: 'ca',                         // BCP 47; per-call override available
  timeoutMs: 15_000,
  headers: { 'X-Trace-Id': traceId },   // extra NON-auth headers
});
```

Every option is validated when the client is constructed, so a typo throws a
`TypeError` at start-up rather than a confusing failure on the first request.
`Authorization` and `Accept` are owned by the SDK and rejected in `headers`.

### Authentication

Identity-bound features — creating or editing a place, asserting a capability,
claiming a place, contributing imagery, anything tied to an Oxy account — need
an Oxy access token. Supply it with
`getAccessToken`:

```ts
// `@oxy.so/services` owns the Oxy session and its refresh; the SDK only asks
// it for the current token, every time.
const goway = createGoWayClient({ getAccessToken: () => oxy.getAccessToken() });
```

`getAccessToken` is called **before every request** and the result is never
cached, stored or logged by this SDK. Your Oxy auth package owns the session and
its refresh; a copy kept here would go stale exactly when it mattered, and would
outlive the sign-out that was supposed to end it. Return `null` for an anonymous
request. There is no second identity system here: no cookies, no session state,
no login flow.

## Namespaces

### `places`

```ts
// One place, by its stable GoWay Place ID.
const place = await goway.places.get('gw_place_01H8');

// Up to 50 places you store ids of, in one request: each exactly as `get`
// answers it, or in `gone` (with `mergedInto` for a merge) or `missing`.
const { items, gone, missing } = await goway.places.getMany(storedIds);

// Everything in the current viewport — the map read. One page at a time.
const { items: visible, nextCursor } = await goway.places.inBounds({
  west: 2.10, south: 41.36, east: 2.20, north: 41.41,
  categories: ['food'],          // a parent matches every category below it
  limit: 200,
});

// Create and update are identity-bound.
const created = await goway.places.create({
  name: 'Cafè de la Plaça',
  location: { latitude: 41.3874, longitude: 2.1686 },
  categories: ['food.cafe'],
  capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
  names: [{ language: 'es', name: 'Café de la Plaza' }],
});
await goway.places.update(created.id, { contact: { website: 'https://example.org' } });
// A merge patch: `null` clears, a part left out is untouched.
await goway.places.update(created.id, { contact: { phone: null }, address: { houseNumber: null } });
```

Categories are keys of one taxonomy that lives in GoWay's database, edited by
GoWay's moderators without an SDK release: `food.cafe`, `shop.books`,
`transport.rail_station`. The SDK bundles no copy of it. Fetch it with
`goway.categories.list({ locale })` — one page, every category with its parent,
glyph key, `status`, its `label` resolved for the locale and its `labels` in
every language GoWay holds (English always) — and index the page with
`categoryTaxonomy(page.items)` to look a key up (`of`), label it (`label`,
English as the fallback) or expand a parent (`descendants`). A key is checked
for its shape client-side and for membership by the server: a key that is not a
category is `GoWayValidationError` from the API, and so is a `deprecated` one on
a write that would add it, while places already carrying it keep reading it. A
place stores its most specific keys; filtering by a parent matches its
descendants.

```ts
const { items } = await goway.categories.list({ locale: 'es' });
const taxonomy = categoryTaxonomy(items);
taxonomy.label('food.cafe', 'es'); // 'Cafetería'
```

Opening hours are a weekly schedule read in `place.timezone` — which GoWay
derives from the position — plus `place.hoursExceptions`, the dated closures and
special hours that have not ended (on every place read, lists included). Never evaluate them
yourself: `openingStatusAt(place)` answers `open`/`closed`/`unknown` and when that
next changes, exactly as GoWay's own app does. Exceptions are written through
`places.hoursExceptions.create|replace|delete`, under the capability rules below.

A place write is parsed by the contract's input schema and the PARSED body is
what is sent: `id`, `verification` and a capability's `verification`/`observedAt`
are **server-derived and never sent**, even if you pass them, which is what stops
a community report from arriving labelled as verified. A caller sets `status` to
`active`, `closed` or `proposed` (`WRITABLE_PLACE_STATUSES`); withdrawing a place
from the map is a moderation act, and a withdrawn place answers `places.get`
with `GoWayGoneError`.

An update is a merge patch. It touches only the fields you pass — inside
`address` and `contact`, only the parts you pass — because GoWay layers
enrichment *over* source data and never destructively overwrites a source fact.
`null` clears a field that may be empty (`description`, `logoFileId`,
`coverFileId`, `geometry`, `openingHours`, any `address` or `contact` part, or
the whole `address`/`contact`); a field a place cannot be without refuses it.
A value you cleared that OpenStreetMap supplied stays cleared on the next
import, until OpenStreetMap's own value changes.

### Photos and reviews

A place's gallery is a list of **Oxy file ids**. Upload the image with the Oxy
SDK the app already uses, then hand GoWay the id; render an item from Oxy's CDN.
GoWay checks the file with Oxy on your session — yours, public, an image — and
never serves image bytes itself:

```ts
const { file } = await oxy.assets.upload(picked, { visibility: 'public' });
await goway.places.media.add(placeId, { fileId: file.id, kind: 'photo' });

const { items } = await goway.places.media.list(placeId);
const src = oxy.assets.publicUrl(items[0].fileId, 'thumb');
```

Reviews are one per person: `goway.places.reviews.put(placeId, { rating: 4 })`
writes yours or rewrites it, `delete` withdraws it. A business cannot review its
own place — anybody with a role in an organization that holds an approved claim
is refused — and answers with `reviews.reply` instead. `place.rating` is
`{ average, count }` over the published reviews, absent until there is one.

### Names, in every language GoWay has one

`place.name` is the place's **default** name — what is written on the shopfront,
which is the local language and *not* the English one. It never changes with the
locale you ask for, so one cached `Place` means the same thing to everybody
holding it.

```ts
import { placeDisplayName } from '@goway.to/sdk';

const place = await goway.places.get('gw_place_01H8', { locale: 'es-MX' });

place.name;                    // 'Museu Picasso'   — the default, always
place.localizedName;           // { language: 'es', name: 'Museo Picasso', source: 'openstreetmap' }
placeDisplayName(place);       // 'Museo Picasso'   — resolved, or the default
place.names;                   // every language GoWay holds, each with its provenance
```

Render `placeDisplayName(place)`. It is `localizedName ?? name` and it is
published precisely so nobody restates that and quietly drops the locale they
asked for.

GoWay resolves the locale server-side, once: the exact tag, then the bare
language, then another variety of that language, and then nothing — an arbitrary
*other* language is not a better answer than the name on the shopfront. A
GoWay-owned correction outranks a source's spelling at every step.

`names` is carried by `places.get`, `places.getMany` and by search results. `places.nearby` and
`places.inBounds` carry `localizedName` alone: 200 pins × every language is a
payload nothing on screen renders. An absent `names` means "not published here",
never "this place has one name".

Set `locale` once on the client and every place, search, geocoding and routing
call uses it; pass it per call to override. Tags are normalized (`ES` → `es`,
`zh_hant` → `zh-Hant`), so equivalent spellings are one request.

### Pages, and walking all of them

Every list answers one page, `{ items, nextCursor }`. Pass `nextCursor` back as
`cursor` — with the **same** filters — for the next page; it is `null` on the
last one. Cursors are opaque: never build or parse one, and never reuse one with
other filters (GoWay refuses it as `bad_request`). There are no totals.

`iterateGoWayPages` walks every page for you, and throws `GoWayResponseError`
if the server ever repeats a cursor rather than looping forever:

```ts
import { iterateGoWayPages } from '@goway.to/sdk';

const query = { latitude, longitude, radiusMeters: 2000, capabilities: ['payments.faircoin.accepted'] };
for await (const merchant of iterateGoWayPages((cursor) => goway.places.nearby({ ...query, cursor }))) {
  addMarker(merchant);
}
```

It works with any list: `places.inBounds`, `search.query`, the `geocode.*`
calls, `places.claims.list`, `claims.list`, `places.revisions`,
`captures.sessions` and `captures.assets`. Each list's `limit` has a documented default and maximum
(`DEFAULT_PLACE_LIST_LIMIT`/`MAX_PLACE_LIST_LIMIT`, `SEARCH_MAX_LIMIT`,
`MAX_CLAIM_LIST_LIMIT`, `MAX_CAPTURE_LIST_LIMIT`); a value outside it is refused,
never silently clamped. A search lists at most `SEARCH_MAX_DEPTH` results across
all its pages.

### Capability filters — `places.nearby({ capabilities })`

Capability filtering is generic and typed, and it is the same call whichever Oxy
product you are: pass the keys a place must assert. A FairCoin wallet asks for
nearby merchants that advertise FairCoin acceptance like this:

```ts
const { items: merchants } = await goway.places.nearby({
  latitude,
  longitude,
  radiusMeters: 5000,
  capabilities: ['payments.faircoin.accepted'],
});
```

```ts
// The identical call, one product over.
const { items: pickupPoints } = await goway.places.nearby({
  latitude,
  longitude,
  radiusMeters: 1000,
  capabilities: ['mobility.moovo.pickup'],
});
```

A key is one of `CAPABILITY_KEYS` — the registry that types every value — and a
list is a **conjunction**: a place matches only when it HAS every key listed —
its strongest assertion of each one holds (is not `false`, `0`, `''` or `[]`,
nor a value the key names as an absence, like `accessibility.wheelchair: 'no'`).
An enum, enum-set, price or text key can also be filtered by value:
`'food.cuisine:italian'`, `'accessibility.wheelchair:limited'`, `'price.level:2'`,
`'commerce.mercaria.store:<locationId>'` (a text value matches exactly, and may
not contain a comma). A business
that asserts `false` outranks a community report of `true`, so a merchant that
stopped accepting FairCoin drops out of the filter. A bare key such as
`'faircoin'`, or a mixed-case one, is refused client-side rather than silently
matching nothing. Ask the same question of a `Place` you already hold with
`placeHasCapability(place, key)`. The same `capabilities`
option is accepted by `places.inBounds` — the viewport read — and by
`search.query`.

Nothing about the capability table's layout appears in that call, and nothing
about FairCoin appears in GoWay's renderer. The same mechanism serves
accessibility, payment methods, amenities, cuisine, price, social links and the
ecosystem keys (`commerce.mercaria.store`, `mobility.moovo.pickup`,
`housing.homiio.listings`). The key space is CLOSED: each key declares the kind
of value it holds, `capabilities.put` checks the value before sending, and a key
GoWay has not registered is refused — a new key is a GoWay release. Label one
with `capabilityLabel(key, locale)` and `capabilityValueLabel(key, value, locale)`,
and group them with `capabilityGroupOf(key)`. Every capability label is written
in all twelve `LABEL_LANGUAGES` (`en`, `ar`, `bn`, `ca`, `de`, `es`, `fr`, `hi`,
`ja`, `pt-BR`, `ru`, `zh-Hans`). Pass the reader's whole locale — `zh-Hans-CN`,
`pt-PT`, `es-MX` — not its language: `matchLanguageTag` picks the best language
by BCP 47 rules (exact tag; same language and script, own region first; then
the same language in another script; English otherwise), so `zh-TW` reads
Simplified Chinese until a `zh-Hant` label exists.

Each result carries its distance and the **evidence** behind every claim:

```ts
import { strongestCapability } from '@goway.to/sdk';

for (const merchant of merchants) {
  const claim = strongestCapability(merchant, 'payments.faircoin.accepted');
  // 'oxy_verified' | 'business_asserted' | 'external_source' | 'community_reported'
  console.log(merchant.name, Math.round(merchant.distanceMeters), claim?.verification, claim?.observedAt);
}
```

Render that honestly. `community_reported` is not `oxy_verified`, and a
two-year-old `observedAt` is not a current fact — the SDK gives you both so your
UI can say which it is. A place can carry **several claims for the same key** at
different verification tiers (nothing is overwritten, so an Oxy verification and
an older community report coexist); they arrive strongest first, then freshest,
and `strongestCapability` picks the one that decides. Passing
an explicit viewport or a coordinate the user approved is also what keeps
merchant discovery from building a precise location history.

Then send the user onward with the canonical link:

```ts
goway.links.place(merchant); // https://goway.to/place/gw_place_01H8
```

### Asserting capabilities, and claiming a place

A business or a contributor writes ONE capability at a time; the verification
tier is never yours to name — GoWay derives it from who is asking (an approved
claim earns `business_asserted`) and whether a `source` is cited:

```ts
await goway.places.capabilities.put(place.id, 'payments.faircoin.accepted', { value: true });
await goway.places.capabilities.put(place.id, 'payments.faircoin.accepted', { value: false }); // retract
await goway.places.capabilities.delete(place.id, 'payments.faircoin.accepted');                 // withdraw yours
```

`value` is required: a reporter retracts with `false`, which is better evidence
than a deletion. To be recognised as running a place, claim it — a claim is
always created `pending`, and its `state` is not yours to set:

```ts
const claim = await goway.places.claims.create(place.id, { role: 'owner' });
const onThisPlace = await goway.places.claims.list(place.id);   // PlaceClaimPage
const mine = await goway.claims.list();                         // every claim you hold, in every state
```

A business is an **Oxy organization**, so claim for it: pass its account id, and
GoWay checks with Oxy that you own or administer it. From then on anybody Oxy
says may act for the organization — a session switched into it, or a member
who is its `owner`, `admin` or `editor` — edits the place, asserts at the
business tier and reads its claims, from GoWay or from any other Oxy app:

```ts
await goway.places.claims.create(place.id, { role: 'owner', oxyAccountId: organizationId });
const locations = await goway.claims.list({ oxyAccountId: organizationId });
```

A chain is one organization claiming each location in the `brand` role. When
Oxy cannot be asked, these calls reject with `GoWayUnavailableError` — retry
later; GoWay never guesses who belongs to a business.

### History and reports

```ts
const history = await goway.places.revisions(place.id);   // PlaceRevisionPage, newest first
// [{ action: 'place_updated', source: 'api', changes: [{ field: 'name', before: 'Old', after: 'New' }], … }]

await goway.places.report(place.id, { reason: 'permanently_closed', note: 'Shuttered since May' });
```

The history needs no account and says what changed and when — never who, and
never a claim, a report or a duplicate review. A report needs a session; the
note is read by GoWay's moderators only. (`goway.moderation` is the operator
surface behind GoWay's allow-list; it is not for integrations. It includes the
category taxonomy: `categories`, `createCategory`, `updateCategory` — glyph,
position, OpenStreetMap mapping, or `status: 'deprecated'`, since a key never
changes — `setCategoryLabel` and `removeCategoryLabel`, English excepted.)

The end-to-end version of this — install, map, capability query, markers,
evidence, deep link, and how a merchant comes to be marked in the first place —
is the [merchant discovery integration
guide](https://github.com/OxyHQ/GoWay/blob/main/docs/integration/merchant-discovery.md).

### `search`

```ts
const results = await goway.search.query({
  query: 'cafè',
  near: { latitude: 41.3874, longitude: 2.1686 },  // biases; never filters
  capabilities: ['payments.faircoin.accepted'],
  limit: 10,
});

for (const result of results.items) render(result);
if (results.degradedProviders?.length) {
  // A short list because a source was down — not the same as "no matches".
}
```

`search.query` blends GoWay Places with the active geocoders. A result that
reconciles to a GoWay place carries `placeId`, which is what lets it show
ecosystem capabilities and Oxy verification.

### `geocode`

```ts
await goway.geocode.forward({ query: 'Carrer de Sants 100, Barcelona' });
await goway.geocode.reverse({ latitude: 41.3874, longitude: 2.1686, radiusMeters: 50 });
await goway.geocode.structured({ street: 'Carrer de Sants', city: 'Barcelona', countryCode: 'ES' });
```

Use `geocode.forward` when you specifically want an address resolved, and
`search.query` for a search box.

### `routes`

```ts
const { routes } = await goway.routes.directions({
  origin: { coordinate: { latitude: 41.3874, longitude: 2.1686 } },
  destination: { placeId: merchant.id },
  mode: 'walk',
  locale: 'ca',
});

if (routes.length === 0) {
  // "No route found" — a normal answer, not an error.
} else {
  const [best] = routes;
  best.geometry;                  // GeoJSON LineString, longitude-first
  best.legs[0].maneuvers[0].instruction;
}
```

Passing `placeId` rather than a coordinate lets GoWay resolve the *routable*
point: a building centroid is not necessarily reachable, and which entrance a
router should aim at is GoWay's knowledge, not yours.

### `links`

```ts
goway.links.place('gw_place_01H8');                                    // https://goway.to/place/gw_place_01H8
goway.links.map({ latitude: 41.3874, longitude: 2.1686, zoom: 15 });   // https://goway.to/?lat=…&lng=…&zoom=…
```

Links are built from **GoWay Place IDs**, never provider ids: an OSM node can be
renumbered or deleted without GoWay losing the place's identity, and a
GoWay-created place has an ID before it matches anything external. Persist the
place ID; rebuild the link.

## Errors

Every failure is one class from one hierarchy, and every class carries `code`,
`status`, `retryable`, `details` and `toJSON()`. Branch on the class or the
`code` — never on `message`.

| Class | `code` | HTTP | Retryable | What it means |
| --- | --- | --- | --- | --- |
| `GoWayValidationError` | `bad_request`, `validation_failed` | 400, 422 | no | The request was refused — by GoWay, or by the SDK before it was sent (`status: null`). |
| `GoWayUnauthorizedError` | `unauthorized` | 401 | no | No token, or one that did not verify. Refresh and retry once. |
| `GoWayForbiddenError` | `forbidden` | 403 | no | Authenticated, but not permitted (an unapproved place claim, say). |
| `GoWayNotFoundError` | `not_found` | 404 | no | GoWay has no such place, or it is not visible to this caller. |
| `GoWayGoneError` | `gone` | 410 | no | The place existed and is retired. `mergedInto` is the id to use instead when it was merged; otherwise drop the persisted id. |
| `GoWayUnknownRouteError` | `unknown_route` | 404 | no | The API has no such route: this SDK is newer than the deployment, or pointed at the wrong origin. Never evidence about a resource. |
| `GoWayConflictError` | `conflict` | 409 | no | A duplicate claim, or a stale update. |
| `GoWayRateLimitError` | `rate_limited` | 429 | **yes** | Back off; `retryAfterSeconds` (from `details.retryAfterSeconds`, or `Retry-After`). |
| `GoWayNoRouteError` | `no_route` | 422 | no | **A normal answer**: no route exists between those points. |
| `GoWayUnsupportedModeError` | `unsupported_mode` | 422 | no | **A normal answer**: the active router does not cover that mode here. |
| `GoWayUnavailableError` | `provider_unavailable` | 503 | **yes** | An upstream geographic provider failed or timed out. |
| `GoWayUnavailableError` | `internal_error` | 500 | no | A GoWay defect. Never carries internal detail. |
| `GoWayNetworkError` | `network_error` | — | **yes** | The request never completed: DNS, TLS, offline. |
| `GoWayTimeoutError` | `timeout` | — | **yes** | Exceeded `timeoutMs`. Extends `GoWayNetworkError`. |
| `GoWayAbortError` | `aborted` | — | no | You cancelled it through your own `AbortSignal`. |
| `GoWayResponseError` | `malformed_response` | any | no | The body was not the contract. Report it; it means GoWay drifted. |
| `GoWayApiError` | `http_error` | any | varies | A non-2xx GoWay did not write — a proxy, a gateway. |

`no_route` and `unsupported_mode` are **domain answers, not defects**. Two points
separated by an ocean have no driving route and never will. Branch on them
cleanly and say so in the UI:

```ts
import { GoWayNoRouteError, GoWayUnsupportedModeError, isGoWayError } from '@goway.to/sdk';

try {
  const { routes } = await goway.routes.directions(request);
  if (routes.length === 0) return show('No route found');
  return render(routes[0]);
} catch (error) {
  if (error instanceof GoWayNoRouteError) return show('No route found');
  if (error instanceof GoWayUnsupportedModeError) return show('Try another travel mode');
  if (isGoWayError(error) && error.retryable) return retryWithBackoff();
  throw error;
}
```

### Validation before anything is sent

Every input is checked against the contract's own request schema before a
request is made, and the parsed, normalized value is what is sent. A refusal is
a `GoWayValidationError` with `status: null` and a message naming the field and
what was expected — `query.latitude: Too big: expected number to be <=90` —
never the value, which may be a user's location. Query parameters are strict: a
key the contract does not name is refused rather than silently dropped.

Responses are parsed the same way. A key the contract does not name is
stripped, so nothing GoWay leaks by mistake reaches your objects, and a body
that is not the contract is a `GoWayResponseError` naming the path.

`instanceof` works even when a process holds both the ESM and the CommonJS copy
of this package: every error is branded with a `Symbol.for` lineage that each
class checks alongside its prototype chain.

The SDK never retries by itself — `retryable` tells you whether it is worth
doing, and the backoff policy stays yours.

### Cancellation

```ts
const controller = new AbortController();
const results = goway.search.query({ query: text }, { signal: controller.signal });
controller.abort();   // rejects with GoWayAbortError
```

Every call also races the client's `timeoutMs`, so a `fetch` implementation that
ignores `signal` still cannot outlive it.

## Types

Every domain type is re-exported here — `Place`, `PlaceWithDistance`,
`PlacePage`, `PlaceCapability`, `CapabilityKey`, `PlaceClaim`, `SearchResult`,
`SearchResults`, `Route`, `RouteRequest`, `GeoCoordinate`, `GeoBoundingBox`,
`MapViewport`, `TravelMode`, `ApiErrorCode`, every request input and the rest —
from GoWay's single definition of them, bundled into this package's
declarations, together with the closed value sets (`WRITABLE_PLACE_STATUSES`,
`CAPABILITY_VERIFICATIONS`, `TRAVEL_MODES`, …) and the limits the API enforces.
Types are `z.infer` of the contract schemas, so the declarations import zod's
types; the schemas themselves are not exported. You never import a private
GoWay package, and you never keep your own copy of `Place`.

These are contracts, not rows: GoWay's Drizzle/PostGIS schema is deliberately
not published, so a database migration cannot break your build.

Coordinates come in two spellings and mixing them up is the most expensive bug in
geographic code, because a transposed pair is a *plausible* point in the wrong
hemisphere rather than an error. `GeoCoordinate` is the named, ergonomic form
(`{ latitude, longitude }`) that every argument and every result uses;
`GeoPosition` is GeoJSON's `[longitude, latitude]`, **longitude first**, and
appears only inside real GeoJSON geometry. Convert with the exported
`toGeoPosition` / `toGeoCoordinate` rather than writing an array literal.

## Runtimes

One build, four runtimes: Node 18+ (ESM and CommonJS), Bun, browsers and React
Native, with zod as its one dependency. `fetch` is taken from `globalThis` at call time — so a polyfill installed
after the client was created is still picked up — or injected through the `fetch`
option. The source compiles with no DOM lib and no Node types, so the published
declarations never force `lib: ["DOM"]` on a server consumer (zod's own
declarations name the global `URL` type, which every one of these runtimes'
types provides), and there is no Node built-in anywhere in the bundle. The release smoke test asserts all of that
against the packed tarball, not the working tree.

## License

The Breathe License 1.0 (`LicenseRef-Breathe-1.0`), the same licence as the
rest of the Oxy ecosystem. See `LICENSE` and `NOTICE`; commercial terms are at
<https://github.com/OxyHQ/.github/blob/main/LICENSE-COMMERCIAL.md>.

Attribution under Section 3.1 is required of everyone, including paying
commercial licensees, and cannot be waived.
Map data served through the GoWay API carries its own upstream licences
(OpenStreetMap data is ODbL).

### Contributions

`client.captures.policy()` is public. The other capture methods require an Oxy
session through the client's existing authenticated transport. Create a session
with the current consent version, then register metadata and a SHA-256 content
hash using a stable `idempotencyKey`. Upload directly with the returned ticket's
method and headers, then call `captures.finalize(asset.id)`. Do not attach your
API authorization header to the storage request. A repeated immutable PUT may
return 412; finalization verifies the already-stored object's checksum and size.

`captures.sessions(query?)` pages your sessions, newest first, and
`captures.assets(sessionId, query?)` pages a session's contributions, oldest
first. `captures.remove(id)` withdraws the contribution and resolves with
nothing; shared bytes are queued for deletion after their upload intents expire
when no valid contribution still references them.

# `@goway.to/sdk`

The canonical, headless TypeScript client for GoWay — Oxy's open map and
geographic platform.

One client gives you GoWay Places, ecosystem capability filters, search,
geocoding, routing and the canonical `goway.to` links, with **no runtime
dependencies**, on Node 18+, Bun, browsers and React Native.

```bash
bun add @goway.to/sdk    # npm i @goway.to/sdk
```

## What you are *not* installing

Nothing about a map provider. GoWay currently renders with MapLibre over
OpenFreeMap tiles, geocodes with Photon and Nominatim and routes with Valhalla —
and **none of that is in this package or in its contract**. Those are
replaceable adapters behind the GoWay API; when GoWay swaps one, your code does
not change, because it never named the provider in the first place. Installing
this SDK pulls in no renderer, no provider client, and no dependency at all.

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
anything tied to an Oxy account — need an Oxy access token. Supply it with
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

// Everything in the current viewport — the map read.
const visible = await goway.places.inBounds({
  west: 2.10, south: 41.36, east: 2.20, north: 41.41,
  categories: ['food.cafe'],
  limit: 200,
});

// Create and update are identity-bound.
const created = await goway.places.create({
  name: 'Cafè de la Plaça',
  location: { latitude: 41.3874, longitude: 2.1686 },
  categories: ['food.cafe'],
  capabilities: [{ namespace: 'payments.faircoin', capability: 'accepted', value: true }],
});
await goway.places.update(created.id, { contact: { website: 'https://example.org' } });
```

A place write carries only the fields this SDK knows a client may set; `id`,
`verification` and a capability's `verification`/`observedAt` are **server-derived
and never sent**, which is what stops a community report from arriving labelled
as verified.

An update touches only the fields you pass: GoWay layers enrichment *over* source
data and never destructively overwrites a source fact.

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

`names` is carried by `places.get` and by search results. `places.nearby` and
`places.inBounds` carry `localizedName` alone: 200 pins × every language is a
payload nothing on screen renders. An absent `names` means "not published here",
never "this place has one name".

Set `locale` once on the client and every place, search, geocoding and routing
call uses it; pass it per call to override.

### Capability filters — `places.nearby({ capabilities })`

Capability filtering is generic and typed, and it is the same call whichever Oxy
product you are: pass the keys a place must assert. A FairCoin wallet asks for
nearby merchants that advertise FairCoin acceptance like this:

```ts
const merchants = await goway.places.nearby({
  latitude,
  longitude,
  radiusMeters: 5000,
  capabilities: ['payments.faircoin.accepted'],
});
```

```ts
// The identical call, one product over.
const pickupPoints = await goway.places.nearby({
  latitude,
  longitude,
  radiusMeters: 1000,
  capabilities: ['mobility.moovo.pickup'],
});
```

A key is `<domain>.<product>.<capability>`, a list is a **conjunction** (a place
must assert every key listed), and a bare key such as `'faircoin'` is refused
client-side rather than silently matching nothing. The same `capabilities`
option is accepted by `places.inBounds` — the viewport read — and by
`search.query`.

Nothing about the capability table's layout appears in that call, and nothing
about FairCoin appears in GoWay's renderer. The same mechanism serves
`commerce.mercaria.*`, `mobility.moovo.*`, `housing.homiio.*` and any key a
third party defines — `WELL_KNOWN_CAPABILITIES` autocompletes, but the namespace
is open, so a new consumer does not need a GoWay release.

Each result carries its distance and the **evidence** behind every claim:

```ts
for (const merchant of merchants) {
  const claim = merchant.capabilities.find((c) => c.key === 'payments.faircoin.accepted');
  // 'oxy_verified' | 'business_asserted' | 'external_source' | 'community_reported'
  console.log(merchant.name, Math.round(merchant.distanceMeters), claim?.verification, claim?.observedAt);
}
```

Render that honestly. `community_reported` is not `oxy_verified`, and a
two-year-old `observedAt` is not a current fact — the SDK gives you both so your
UI can say which it is. A place can carry **several claims for the same key** at
different verification tiers (nothing is overwritten, so an Oxy verification and
an older community report coexist); they arrive strongest first, then freshest,
so take the first row for a key rather than assuming there is only one. Passing
an explicit viewport or a coordinate the user approved is also what keeps
merchant discovery from building a precise location history.

Then send the user onward with the canonical link:

```ts
goway.links.place(merchant); // https://goway.to/place/gw_place_01H8
```

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
| `GoWayConflictError` | `conflict` | 409 | no | A duplicate claim, or a stale update. |
| `GoWayRateLimitError` | `rate_limited` | 429 | **yes** | Back off; `retryAfterSeconds` when GoWay said. |
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
`PlaceCapability`, `CapabilityKey`, `SearchResult`, `SearchResults`, `Route`,
`RouteRequest`, `GeoCoordinate`, `GeoBoundingBox`, `MapViewport`, `TravelMode`,
`ApiErrorCode` and the rest — from GoWay's single definition of them, bundled
into this package's declarations. You never import a private GoWay package, and
you never keep your own copy of `Place`.

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
Native. `fetch` is taken from `globalThis` at call time — so a polyfill installed
after the client was created is still picked up — or injected through the `fetch`
option. The source compiles with no DOM lib and no Node types, so the published
declarations never force `lib: ["DOM"]` on a server consumer, and there is no
Node built-in anywhere in the bundle. The release smoke test asserts all of that
against the packed tarball, not the working tree.

## License

The Breathe License 1.0 (`LicenseRef-Breathe-1.0`), the same licence as the
rest of the Oxy ecosystem. See `LICENSE` and `NOTICE`; commercial terms are at
<https://github.com/OxyHQ/.github/blob/main/LICENSE-COMMERCIAL.md>.

Attribution under Section 3.1 is required of everyone, including paying
commercial licensees, and cannot be waived.
Map data served through the GoWay API carries its own upstream licences
(OpenStreetMap data is ODbL).

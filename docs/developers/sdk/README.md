# GoWay SDK

`@goway.to/sdk` is the TypeScript client for GoWay's public geographic API. It reads and writes GoWay places, filters them by capability, searches, geocodes and routes, streams live vehicles, answers road rules, and builds canonical GoWay links and map style URLs. Every request is validated before it is sent and every response is parsed against the same contract the API uses, and every failure is a typed error. It runs in Node 18+, Bun, browsers and React Native, ships ESM and CommonJS builds with types, and depends only on `zod`.

## What it is, and what it is not

The SDK is:

- an HTTP client (`createGoWayClient`) with one namespace per product area;
- the contract types and value sets (`Place`, `CAPABILITY_KEYS`, `TRAVEL_MODES`, ...) and pure helpers over them (`placeDisplayName`, `openingStatusAt`, `decideAccess`, ...);
- four small entry points that load without the HTTP client: `/live`, `/geo`, `/road-access` and `/map`.

The SDK is not:

- a map renderer. To draw a map, use `@goway.to/maps` (see the [maps documentation](../maps/README.md)); it uses this SDK to resolve GoWay styles;
- a socket client. The live protocol is described in `@goway.to/sdk/live`; bring your own `socket.io-client`;
- an authentication library. It asks your app for an Oxy access token when it needs one and never stores it;
- a cache or a retry layer. It tells you whether an error is retryable; when to retry is yours to decide.

## Install

```bash
npm install @goway.to/sdk
```

```bash
bun add @goway.to/sdk
```

## Quick start

Search, browsing and routing work without an account, so a client needs no options to start:

```ts
import { createGoWayClient, placeDisplayName } from '@goway.to/sdk';

const goway = createGoWayClient();

const nearby = await goway.places.nearby({
  latitude: 41.3874,
  longitude: 2.1686,
  radiusMeters: 1000,
  capabilities: ['payments.faircoin.accepted'],
});

for (const place of nearby.items) {
  console.log(placeDisplayName(place), Math.round(place.distanceMeters), 'm', goway.links.place(place));
}
```

## Entry points

| Import | Use it for | Reference |
| --- | --- | --- |
| `@goway.to/sdk` | The HTTP client, errors, pagination, contract types and helpers. | [index](./api-reference/index.md) |
| `@goway.to/sdk/live` | The GoWay Live Socket.IO protocol: events, room tiles, message parsers. | [live](./api-reference/live.md) |
| `@goway.to/sdk/geo` | Web Mercator, boxes across the antimeridian, distances, pixel projection. | [geo](./api-reference/geo.md) |
| `@goway.to/sdk/road-access` | Who may use a road, from OpenStreetMap access tags. | [road-access](./api-reference/road-access.md) |
| `@goway.to/sdk/map` | Style names and documents, the style catalogue, the tile schema, localized labels. No `zod`. | [map](./api-reference/map.md) |

## Client options

`createGoWayClient(options?: GoWayClientOptions)` takes:

| Option | Default | Description |
| --- | --- | --- |
| `apiBaseUrl` | `'https://api.goway.to'` (`DEFAULT_GOWAY_API_BASE_URL`) | The API origin. Requests go to `<apiBaseUrl>/api/v1/...`. |
| `webBaseUrl` | `'https://goway.to'` (`DEFAULT_GOWAY_WEB_BASE_URL`) | The origin `client.links` builds URLs on. |
| `getAccessToken` | none | A function returning the current Oxy access token, or `null`/`undefined` for anonymous requests. See [Authentication](#authentication). |
| `locale` | none | Default BCP 47 language tag (`'es'`, `'pt-BR'`) for localized names and route instructions, used by every call that accepts a `locale` and names none. |
| `timeoutMs` | `15000` (`DEFAULT_GOWAY_TIMEOUT_MS`) | Per-request timeout in milliseconds, token lookup and body included. |
| `fetch` | the global `fetch` | A `fetch` implementation, for a runtime without one or for tests. Looked up per request when omitted. |
| `headers` | none | Extra non-auth headers sent with every request, such as a tracing id. `Authorization` and `Accept` are refused. |

An invalid option throws `TypeError` from `createGoWayClient`. The client is immutable; create another one to change options.

```ts
const goway = createGoWayClient({
  apiBaseUrl: 'https://api.goway.to',
  locale: 'es',
  timeoutMs: 10_000,
  headers: { 'X-Request-Source': 'my-app' },
});
```

## Authentication

Most of the API needs no account: places, search, geocoding, routing, road rules, live sources, categories, reviews and Street 3D scenes all answer anonymous requests. Identity-bound calls (creating or editing a place, asserting a capability, claiming a place, writing a review, adding media, contributing captures, editing organization lists, moderation) need an Oxy access token, and reject with `GoWayUnauthorizedError` without one.

Supply the token through `getAccessToken`:

```ts
const goway = createGoWayClient({
  getAccessToken: () => oxyServices.session.accessToken,
});
```

- The SDK calls it before every request and sends a non-empty result as `Authorization: Bearer <token>`. It never caches, stores or logs the token, so your Oxy session stays the only owner of it and of its refresh.
- It may return a string, `null` or `undefined`, or a promise of one. `null`, `undefined` or `''` sends the request anonymously.
- An error it throws is passed through unchanged. Its time counts against `timeoutMs`.
- There is no API key option, and `headers` may not set `Authorization`.

The snippet above is how GoWay's own app wires its `@oxy.so/services` session; any function that returns the signed-in user's Oxy access token works. Some calls that work anonymously show more to a signed-in caller, such as claim details on a place you claimed.

## Guides

| Guide | Covers |
| --- | --- |
| [Places](./guides/places.md) | `client.places`: get, batch, nearby, viewport, capabilities, hours, gallery, reviews, claims, edits. |
| [Search](./guides/search.md) | `client.search`: free text, bias, results, cancellation. |
| [Geocoding](./guides/geocoding.md) | `client.geocode`: forward, structured and reverse. |
| [Routing](./guides/routing.md) | `client.routes`: directions, maneuvers, vehicle profiles, "no route". |
| [Links](./guides/links.md) | `client.links`: place pages, map and embed URLs, style documents, `styleUrl`. |
| [Live](./guides/live.md) | `client.live` and `@goway.to/sdk/live`. |
| [Road rules](./guides/roads.md) | `client.roads`: rule sets, zones, "may this vehicle enter". |
| [Road access](./guides/road-access.md) | `@goway.to/sdk/road-access`. |
| [Geographic arithmetic](./guides/geo.md) | `@goway.to/sdk/geo`. |
| [Map styles](./guides/map-styles.md) | `@goway.to/sdk/map` from a renderer's point of view. |
| [Categories](./guides/categories.md) | `client.categories` and the taxonomy helpers. |
| [Organization lists](./guides/organization-lists.md) | `client.organizationLists`. |
| [Street 3D and captures](./guides/street3d.md) | `client.street3d` and `client.captures`. |
| [Moderation](./guides/moderation.md) | `client.moderation`, for GoWay operators. |
| [Errors](./guides/errors.md) | Error classes, retryability, validation before sending, cancellation, timeouts. |
| [Pagination](./guides/pagination.md) | Cursors, `iterateGoWayPages`, page sizes. |

## Examples

See the [examples index](./examples/README.md):

- [Nearby places with a capability filter](./examples/nearby-with-capability-filter.md)
- [Search as you type](./examples/search-as-you-type.md)
- [Reverse geocode a tap](./examples/reverse-geocode-tap.md)
- [Route between two points and draw it](./examples/route-and-draw.md)
- [Walk all pages](./examples/walk-all-pages.md)
- [Handle errors](./examples/handle-errors.md)
- [Live vehicles](./examples/live-vehicles.md)
- [Refresh stored place ids](./examples/refresh-stored-places.md)

## API reference

- [`@goway.to/sdk`](./api-reference/index.md)
- [`@goway.to/sdk/live`](./api-reference/live.md)
- [`@goway.to/sdk/geo`](./api-reference/geo.md)
- [`@goway.to/sdk/road-access`](./api-reference/road-access.md)
- [`@goway.to/sdk/map`](./api-reference/map.md)

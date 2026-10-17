# GoWay HTTP API

The GoWay HTTP API gives you GoWay's places, categories, search and geocoding, directions, road rules, Street 3D scenes and live-transit sources as JSON over HTTPS. This page covers what every operation has in common: the base URL, authentication, request and response conventions, errors, pagination, languages, rate limits and the OpenAPI document. The operations themselves are listed in the [operation reference](operations.md).

## Base URL

```text
https://api.goway.to/api/v1
```

The version is part of the path. Every path in the [operation reference](operations.md) is relative to this base, so `GET /places/nearby` is `GET https://api.goway.to/api/v1/places/nearby`. A request to a path that does not exist answers `404` with the code `unknown_route` (not `not_found`): it means the client is built for a different API version than it is talking to.

## Authentication

Most of the API needs no account: browsing places, search, geocoding, directions and road rules all work without credentials. Operations that act for a person (writing a review, editing a place, claiming a business, contributing captures, managing lists) need an Oxy session.

Send an Oxy access token as a bearer token:

```http
GET /api/v1/places/{placeId}/reviews/mine HTTP/1.1
Host: api.goway.to
Authorization: Bearer <oxy-access-token>
```

The token is an Oxy access token for the Oxy API (`aud=oxy-api`), as Oxy's client libraries (`@oxy.so/services`) issue it. GoWay accepts no API keys, cookies or other credentials.

Each operation states one of three authentication levels:

| Level | Meaning |
| --- | --- |
| None | No session is read. Send no `Authorization` header. |
| Optional | Answers without a session. With a valid session, some responses include more: for example, claim details on a place you have claimed. |
| Required | A valid Oxy session, or `401 unauthorized` with `WWW-Authenticate: Bearer realm="goway"`. |

A valid session is necessary but not always sufficient. Business operations (replying to reviews, ordering a gallery, asserting capabilities) check with Oxy that you may act for the organization that holds the claim, and answer `403 forbidden` when you may not, or `503 service_unavailable` when Oxy cannot answer. Every `/moderation/*` operation is limited to GoWay's moderators and answers `403 forbidden` to anyone else.

### Calling from a web page

The public read operations (place, category, search, geocoding, directions, road-rule, Street 3D, live-source and organization-list reads, and the OpenAPI document) answer any origin with `Access-Control-Allow-Origin: *`, so a page on any site can call them directly, without credentials.

A request that carries an `Authorization` header is handled differently: it is only allowed from origins GoWay has registered, such as GoWay's own apps. A page on another origin cannot send an Oxy token to the API from the browser. Call authenticated operations from your server or from a native app, where CORS does not apply.

## Requests

- **Query parameters** are sent once each. A list is one comma-separated value (`categories=food.cafe,food.bakery`), never a repeated parameter: `?limit=1&limit=2` is `400 bad_request`, and so is a parameter the operation does not declare. Empty values are ignored, list members are trimmed and duplicates removed. Booleans are `true` or `false`.
- **Coordinates** are decimal degrees (WGS 84). In a query they are separate parameters, `latitude` and `longitude`; a bounding box is `west`, `south`, `east` and `north`. In a JSON body a coordinate is an object, `{ "latitude": 41.3851, "longitude": 2.1734 }`.
- **Bodies** are JSON with `Content-Type: application/json`, at most 1 MB. A larger body is `413 payload_too_large`; a body that is not valid JSON is `400 bad_request`.
- **Partial updates.** `PATCH` bodies are merge patches: a field you leave out is left alone, and `null` clears a field that may be empty. A field that cannot be empty refuses `null`. The [operation reference](operations.md) lists which fields each body takes.
- **Path parameters** that are malformed (not a valid place id, for example) are `400 bad_request`, not `404`.

## Responses

- A successful response body is the resource itself, with no envelope: `GET /places/{placeId}` answers a place object, not `{ "data": ... }`.
- Creating something answers `201` with the new resource. Some operations answer `204` with no body. Reporting something you have already reported, while your report is still open, answers `200` with the existing report.
- Times are ISO 8601 date-time strings.
- Fields documented as optional may be absent. Absent is not the same as empty: for example, a place in a nearby or viewport list has no `names` field (names are not published there), while `names: []` on a single-place read means GoWay holds no other names.
- Some read operations set `Cache-Control` so shared caches can keep them: the OpenAPI document and `GET /categories` (5 minutes), the road rule-set, rules and zone reads (5 minutes), Street 3D coverage and scene manifests (1 minute), `GET /live/sources` (5 seconds) and live route shapes (1 hour). Search, directions, `POST /roads/access` and every organization-list operation answer `Cache-Control: no-store`.

## Errors

Every error, from any operation, has the same body:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request query is not acceptable: latitude.",
    "details": { "field": "latitude", "issue": "too_big", "issueCount": 1 }
  }
}
```

| Field | Meaning |
| --- | --- |
| `error.code` | One of the codes below. This is what your code should branch on. |
| `error.message` | A human-readable explanation, safe to log. Its wording may change; do not parse it. |
| `error.details` | Optional. Flat, machine-readable context: strings, numbers, booleans or `null`. A validation error names the `field`, the `issue` and the `issueCount`, never the value you sent. |

| Code | Status | Retry? | Meaning |
| --- | --- | --- | --- |
| `bad_request` | 400 | no | Malformed request: invalid JSON, a field of the wrong type, a missing required field, an unknown or repeated query parameter, or a cursor from a different list or filters. |
| `unauthorized` | 401 | no | No credentials, or credentials that did not verify. |
| `forbidden` | 403 | no | Authenticated, but not permitted to do this. |
| `not_found` | 404 | no | The resource does not exist, or is not visible to you. |
| `unknown_route` | 404 | no | No route has this path. Check the API version your client targets. |
| `method_not_allowed` | 405 | no | The route exists, but not for this HTTP method. |
| `conflict` | 409 | no | The request conflicts with the current state, such as a duplicate claim. |
| `gone` | 410 | no | The resource existed and was withdrawn, such as a place GoWay removed. Stop using the id. |
| `payload_too_large` | 413 | no | The request body is over the size limit. |
| `validation_failed` | 422 | no | Well-formed, but a value is refused: a latitude of 120, a box with `south` greater than `north`, a `limit` out of range. |
| `no_route` | 422 | no | A directions request is valid, but no route exists between the points. |
| `unsupported_mode` | 422 | no | The travel mode is not supported. |
| `rate_limited` | 429 | yes | You exceeded a rate limit. Wait as long as `Retry-After` (and `details.retryAfterSeconds`) says. |
| `internal_error` | 500 | no | An unexpected server defect. The response carries no internal detail. |
| `provider_unavailable` | 503 | yes | An upstream map data provider failed or timed out. |
| `service_unavailable` | 503 | yes | GoWay itself is degraded or not ready, or a service it depends on could not answer. |

`bad_request` and `validation_failed` are deliberately different: the first means your request was built wrong (a serialisation bug), the second means it was built right but asked for something GoWay refuses. In a query string, where every value arrives as text, a value that does not parse (`latitude=abc`) is `validation_failed`.

Retry only the three retryable codes, with backoff. Every other error is a property of the request and will fail again the same way. Each operation in the [operation reference](operations.md) lists the codes it can answer; `rate_limited` and `internal_error` can come from any operation.

## Pagination

Every list answers the same shape:

```json
{
  "items": [],
  "nextCursor": "eyJ2IjoxLCJvIjo1MH0"
}
```

- `nextCursor` is `null` on the last page. To get the next page, repeat the request with `cursor=<nextCursor>` and **the same filters**. A cursor used with a different list or different filters is `400 bad_request`, not a page of something else.
- A cursor is opaque. Do not build, parse or store it for later use; it is at most 512 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`.
- `limit` sets the page size, between 1 and a per-operation maximum, with a per-operation default. A value outside that range is `422 validation_failed`, never silently clamped.
- There is no total count.

```bash
curl 'https://api.goway.to/api/v1/places/nearby?latitude=41.3851&longitude=2.1734&radiusMeters=500&limit=20'
# then, with the same filters:
curl 'https://api.goway.to/api/v1/places/nearby?latitude=41.3851&longitude=2.1734&radiusMeters=500&limit=20&cursor=<nextCursor>'
```

## Languages

Operations that return human-readable names take a `locale` query parameter: a BCP 47 language tag such as `es`, `ca` or `pt-BR`. It is normalised, so `ES` and `es` are the same request. A tag that is not valid BCP 47 is `422 validation_failed`.

`locale` is a preference, never a filter:

- A place's `name` is always its default name in the local language, whatever `locale` you send. With a `locale`, GoWay adds `localizedName` (and, on single-place and batch reads, `localizedDescription`) when it has a name in that language. A place with no name in that language is still returned.
- `GET /categories` resolves each category's `label` for the `locale`, and also returns every label it holds.
- Search, geocoding and directions pass the `locale` on to the providers that answer them.

The API does not read `Accept-Language`. The language is part of the URL so that caches keep one copy per language.

## Rate limits

Every operation under `/api/v1` is rate limited per caller: by Oxy session when a valid one is sent, otherwise by client IP address. Some operations have a further limit on top, per 15-minute window:

| Operations | Limit per 15 minutes |
| --- | --- |
| Writing reviews and replies, and adding or removing gallery items | 60 |
| Reporting a place, a gallery item, a review or a Street 3D scene | 30 |
| Creating, editing, reordering and deleting organization lists and their entries | 120 |
| `GET /live/sources/{sourceId}/shapes/{shapeId}` (instead of the general limit) | 3000 |

Over a limit, the API answers `429` with the `rate_limited` error body, a `Retry-After` header and `details.retryAfterSeconds`. Wait at least that long before retrying.

## OpenAPI document

The API describes itself as an OpenAPI 3.1 document:

```bash
curl https://api.goway.to/api/v1/openapi.json
```

It is public, cacheable for five minutes and callable from any origin. The same document is committed in the GoWay repository as `packages/contracts/openapi.json`. Both are generated from the schemas the API validates requests with, so they describe exactly the operations the server runs. Use it to generate a client in another language or to load the API into a tool such as Postman.

In the document, the `oxySession` security scheme is the bearer token described under [Authentication](#authentication). An operation whose `security` includes an empty requirement (`{}`) can also be called without a session.

## Operations

The [operation reference](operations.md) lists every operation, grouped by area (places, categories, hours, media, reviews, claims, moderation, search, directions, captures, Street 3D, live sources and road rules), with its parameters, request body, success response and error codes. It is generated from the OpenAPI document.

New to the API? [Make your first request](guides/first-request.md) walks through a few calls with curl.

Real-time vehicle positions for GoWay Live are delivered over Socket.IO, not over this HTTP API, and are not covered here. The map tiles, styles and fonts are served from `https://goway.to/map/`; see [Map styles](../styles/README.md).

## The TypeScript SDK

[`@goway.to/sdk`](../sdk/README.md) wraps these operations in a typed client for Node, Bun, browsers and React Native, with the same request and response types and typed errors for every code above. Use it when you work in TypeScript; use the HTTP API directly from any other language.

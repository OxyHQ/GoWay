# Make your first request

This guide calls the GoWay HTTP API with `curl`: finding places near a point, reading one place, searching, getting directions and reading an error. None of these calls needs an account. It ends with an authenticated call, for when you have an Oxy session. The examples pipe responses through `jq` to keep the output readable; it is optional.

All paths are relative to the base URL `https://api.goway.to/api/v1`. See the [API overview](../README.md) for the conventions used below.

## Find places near a point

`GET /places/nearby` returns places within a radius, nearest first. Coordinates are query parameters in decimal degrees.

```bash
curl -s 'https://api.goway.to/api/v1/places/nearby?latitude=41.3851&longitude=2.1734&radiusMeters=300&limit=5&locale=es' \
  | jq '.items[] | { id, name, localizedName, categories, distanceMeters }'
```

The response is a page, `{ "items": [...], "nextCursor": ... }`. Each item is a place with its `distanceMeters` from the point you asked about. `name` is the place's own name in the local language; because the request names `locale=es`, a place that has a Spanish name also carries it in `localizedName`.

To narrow the results, add `categories` (any of these category keys) or `capabilities` (all of these capabilities), each as one comma-separated value:

```bash
curl -s 'https://api.goway.to/api/v1/places/nearby?latitude=41.3851&longitude=2.1734&radiusMeters=300&categories=food.cafe'
```

`GET /categories` lists every category key with its labels.

## Read one place

Take an `id` from the previous response and read the full place:

```bash
curl -s "https://api.goway.to/api/v1/places/$PLACE_ID?locale=es" | jq '{ name, names, address, openingHours, timezone }'
```

A single-place read includes fields that lists leave out, such as `names` (every name GoWay holds, by language) and `description`. A place that GoWay has withdrawn answers `410` with the code `gone`; stop using that id.

## Search

`GET /search` is a search box: it blends GoWay's places with geocoder results. Pass the user's text as `q`, and a point or a box to bias the results towards where the user is looking.

```bash
curl -s 'https://api.goway.to/api/v1/search?q=sagrada%20familia&latitude=41.3851&longitude=2.1734&limit=5' \
  | jq '.items[] | { kind, displayName, coordinate, placeId }'
```

A result that is a GoWay place carries its `placeId`. The response also lists the `providers` that answered and, if any failed, `degradedProviders`.

For an explicit address lookup use `GET /geocode`, and to find what is at a coordinate use `GET /geocode/reverse?latitude=...&longitude=...`.

## Get directions

`POST /routes` takes a JSON body. Each end is a `coordinate` object, a `placeId`, or both (the place wins). `mode` is `drive`, `walk` or `bike`.

```bash
curl -s https://api.goway.to/api/v1/routes \
  -H 'Content-Type: application/json' \
  -d '{
    "origin": { "coordinate": { "latitude": 41.3851, "longitude": 2.1734 } },
    "destination": { "coordinate": { "latitude": 41.4036, "longitude": 2.1744 } },
    "mode": "walk"
  }' \
  | jq '.routes[] | { mode, distanceMeters, durationSeconds }'
```

Each route has a GeoJSON `LineString` geometry (`[longitude, latitude]` pairs, as GeoJSON requires) and its `legs` with turn-by-turn `maneuvers`. An empty `routes` array is a normal answer. When no route exists the API answers `422 no_route`, and a mode the routing engine does not support is `422 unsupported_mode`.

## Read an error

Send a latitude out of range:

```bash
curl -s -w '\nHTTP %{http_code}\n' 'https://api.goway.to/api/v1/places/nearby?latitude=120&longitude=2.1734&radiusMeters=300'
```

The status is `422` and the body is the error envelope every operation uses:

```json
{
  "error": {
    "code": "validation_failed",
    "message": "The request query is not acceptable: latitude.",
    "details": { "field": "latitude", "issue": "too_big", "issueCount": 1 }
  }
}
```

Branch on `error.code`, never on the message. The [error table](../README.md#errors) says which codes are worth retrying.

## Call an operation that needs a session

Operations marked **Required** in the [operation reference](../operations.md) need an Oxy access token as a bearer token. For example, to read your own review of a place:

```bash
curl -s "https://api.goway.to/api/v1/places/$PLACE_ID/reviews/mine" \
  -H "Authorization: Bearer $OXY_ACCESS_TOKEN"
```

Without a valid token the answer is `401 unauthorized`. Send tokens from your server or a native app: the API does not accept an `Authorization` header from web pages on other origins (see [Calling from a web page](../README.md#calling-from-a-web-page)).

## Next

- The [operation reference](../operations.md) lists every operation with its parameters and responses.
- In TypeScript, [`@goway.to/sdk`](../../sdk/README.md) makes the same calls with typed requests, responses and errors.

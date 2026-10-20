# Search

`client.search.query` is the search box: free text in, a blended and normalized list of GoWay places, addresses, streets and localities out. Use it for "type to find"; use [geocoding](./geocoding.md) when you specifically want an address resolved to a coordinate.

## Search for text

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();

const results = await goway.search.query({
  query: 'cafe del mar',
  near: { latitude: 41.3874, longitude: 2.1686 },
  limit: 10,
  locale: 'es',
});

for (const result of results.items) {
  console.log(result.kind, result.displayName, result.coordinate);
}
```

### Query fields (`SearchQuery`)

| Field | Type | Description |
| --- | --- | --- |
| `query` | `string` | Required. Trimmed; 1 to `MAX_SEARCH_QUERY_LENGTH` (256) characters. |
| `near` | `GeoCoordinate` | Bias results toward this point. |
| `viewport` | `GeoBoundingBox` | Bias results toward the visible map area. At most `MAX_BOUNDS_SPAN_DEGREES` on either axis. |
| `capabilities` | `string[]` | Only results whose reconciled GoWay place has every listed capability (`key` or `key:value`). |
| `categories` | `string[]` | Taxonomy keys; a parent matches its descendants. |
| `limit` | `number` | 1 to `SEARCH_MAX_LIMIT` (50). Absent, the server's default. |
| `locale` | `string` | BCP 47 tag for localized names. Defaults to the client's `locale`. |
| `cursor` | `string` | The previous page's `nextCursor`. |

`near` and `viewport` only re-rank; neither filters. When both are given, `near` wins.

An empty or whitespace-only `query` is refused with `GoWayValidationError` before anything is sent, so check the input before calling.

## Read the results (`SearchResults`)

| Field | Description |
| --- | --- |
| `items` | `SearchResult[]`, best first. |
| `nextCursor` | The next page's cursor, or `null`. A search lists at most `SEARCH_MAX_DEPTH` (50) results across all its pages. |
| `providers` | The sources that contributed to this answer. |
| `degradedProviders` | Sources that were asked but failed or timed out. A degraded source gives a shorter list rather than an error. |

Each `SearchResult` has:

- `id`: deterministic for a given source record, so you can diff and de-duplicate lists across requests;
- `displayName`: a label ready to render;
- `kind`: one of `SEARCH_RESULT_KINDS` (`place`, `address`, `street`, `locality`, `region`, `country`, `poi`);
- `coordinate`, and `boundingBox` when the source has an extent (use it to frame the camera);
- `address` (`StructuredAddress`) and `context` (`city`, `region`, `country`, `countryCode`) when known;
- `source` and `sourceId`: which provider produced it;
- `placeId` and `place` when the result reconciles to a GoWay place. Only these carry capabilities and verification;
- `relevance`: 0 to 1, not comparable across providers.

To link a result, pass it straight to `client.links.place(result)`: its `placeId` is used.

## Show a "some sources unavailable" notice

```ts
if (results.degradedProviders && results.degradedProviders.length > 0) {
  showNotice('Some results may be missing.');
}
```

Only when no source answered does the call reject, with `GoWayUnavailableError` or `GoWayRateLimitError` (see [Errors](./errors.md)).

## Cancel stale requests

For search as you type, cancel the previous request when the text changes. Pass an `AbortSignal`; an aborted call rejects with `GoWayAbortError`, which you can ignore:

```ts
import { GoWayAbortError } from '@goway.to/sdk';

let inFlight: AbortController | undefined;

async function onTextChange(text: string) {
  inFlight?.abort();
  if (text.trim() === '') return;
  const controller = new AbortController();
  inFlight = controller;
  try {
    const results = await goway.search.query({ query: text, limit: 8 }, { signal: controller.signal });
    render(results.items);
  } catch (error) {
    if (error instanceof GoWayAbortError) return;
    throw error;
  }
}
```

A complete version is in the [search-as-you-type example](../examples/search-as-you-type.md).

## See also

- [Geocoding](./geocoding.md)
- [Places](./places.md) for capability filters
- [API reference: `client.search`](../api-reference/index.md#clientsearch-gowaysearchapi)

# Pagination

Every GoWay list answers one page at a time as `{ items, nextCursor }` (`Page<T>`). `nextCursor` is an opaque string to pass back for the next page, or `null` on the last one. There is no total count. `iterateGoWayPages` walks a whole list for you as an async iterator.

## One page at a time

```ts
const first = await goway.places.nearby({ latitude: 41.3874, longitude: 2.1686, radiusMeters: 1000, limit: 50 });
render(first.items);

if (first.nextCursor !== null) {
  const second = await goway.places.nearby({
    latitude: 41.3874,
    longitude: 2.1686,
    radiusMeters: 1000,
    limit: 50,
    cursor: first.nextCursor,
  });
  render(second.items);
}
```

Pass the same filters with every cursor. A cursor is bound to the list and the filters that issued it; replaying it with different ones is refused with `GoWayValidationError` (`bad_request`) rather than returning a page of something else.

## Walk every page

```ts
import { iterateGoWayPages } from '@goway.to/sdk';

const query = { latitude: 41.3874, longitude: 2.1686, radiusMeters: 1000, capabilities: ['amenities.wifi'] };

for await (const place of iterateGoWayPages((cursor) => goway.places.nearby({ ...query, cursor }))) {
  render(place);
}
```

- `fetchPage` is called with `undefined` for the first page, then with each `nextCursor`, until one is `null`.
- Break out of the loop to stop early; nothing more is requested.
- If the server returns a cursor it has already issued during this walk, or a `nextCursor` that is neither a non-empty string nor `null`, the iterator throws `GoWayResponseError` after yielding that page's items, so a loop always ends.
- Errors from `fetchPage` (a network error, a rate limit) propagate out of the `for await`.

`iterateGoWayPages` works with any function that returns a `GoWayPageLike<T>` (`{ items, nextCursor }`), so you can wrap a call to add retries or a signal:

```ts
const controller = new AbortController();
const reviews = iterateGoWayPages((cursor) =>
  goway.places.reviews.list(placeId, { sort: 'newest', cursor }, { signal: controller.signal }),
);
```

`client.organizationLists` also has built-in `iterate()` and `iterateEntries(listId)` that do this for you.

## Page sizes

`limit` is validated before sending: below 1 or above the list's maximum is a `GoWayValidationError`, never a silent clamp.

| List | Maximum | Default |
| --- | --- | --- |
| `places.nearby`, `places.inBounds` | `MAX_PLACE_LIST_LIMIT` (200) | `DEFAULT_PLACE_LIST_LIMIT` (50) |
| `search.query`, `geocode.*` | `SEARCH_MAX_LIMIT` (50) | server default |
| `places.reviews.list` | `MAX_REVIEW_LIST_LIMIT` (50) | `DEFAULT_REVIEW_LIST_LIMIT` (20) |
| `places.media.list` | `MAX_MEDIA_LIST_LIMIT` (100) | `DEFAULT_MEDIA_LIST_LIMIT` (30) |
| `places.hoursExceptions.list` | `MAX_HOURS_EXCEPTION_LIST_LIMIT` (100) | `DEFAULT_HOURS_EXCEPTION_LIST_LIMIT` (50) |
| `places.revisions` | `MAX_REVISION_LIST_LIMIT` (100) | `DEFAULT_REVISION_LIST_LIMIT` (25) |
| `places.claims.list`, `claims.list` | `MAX_CLAIM_LIST_LIMIT` (200) | `DEFAULT_CLAIM_LIST_LIMIT` (50) |
| `roads.ruleSets`, `roads.zones` | `MAX_ROAD_LIST_LIMIT` (200) | `DEFAULT_ROAD_LIST_LIMIT` (50) |
| `captures.sessions`, `captures.assets` | `MAX_CAPTURE_LIST_LIMIT` (100) | `DEFAULT_CAPTURE_LIST_LIMIT` (50) |
| `moderation.claims`, `moderation.duplicates`, `moderation.reports` | `MAX_MODERATION_LIST_LIMIT` (100) | `DEFAULT_MODERATION_LIST_LIMIT` (25) |
| `organizationLists.list`, `organizationLists.entries` | 50 | 20 |

A search lists at most `SEARCH_MAX_DEPTH` (50) results across all of its pages. `categories.list` and `places.getMany` are not paged in practice: the categories come in one page, and a batch has no cursor at all.

## See also

- [Walk all pages example](../examples/walk-all-pages.md)
- [API reference: Pagination](../api-reference/index.md#pagination)

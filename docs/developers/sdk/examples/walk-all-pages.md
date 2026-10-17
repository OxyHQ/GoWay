# Walk all pages

Collect every café in a map viewport, page after page, with `iterateGoWayPages`, stopping early once you have enough. The iterator requests the next page only when the loop needs it, and stops if the server ever repeats a cursor.

```ts
import { createGoWayClient, iterateGoWayPages, placeDisplayName, type Place } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });

async function allCafes(max: number): Promise<Place[]> {
  const query = {
    west: 2.15,
    south: 41.38,
    east: 2.19,
    north: 41.40,
    categories: ['food.cafe'],
    limit: 100,
  };

  const found: Place[] = [];
  for await (const place of iterateGoWayPages((cursor) => goway.places.inBounds({ ...query, cursor }))) {
    found.push(place);
    if (found.length >= max) break; // nothing further is requested
  }
  return found;
}

async function main() {
  const cafes = await allCafes(500);
  console.log(`${cafes.length} cafés`);
  for (const cafe of cafes.slice(0, 10)) console.log(placeDisplayName(cafe));
}

main().catch((error) => console.error(error));
```

Notes:

- The same `query` object is spread into every call. A cursor is bound to the filters that issued it; changing them mid-walk is refused with `GoWayValidationError`.
- `cursor` is `undefined` on the first call, which the query schema treats as absent.
- `limit` is the page size (up to `MAX_PLACE_LIST_LIMIT`), not a total. The total is yours to cap, as `max` does here.
- An error on any page (network, rate limit) is thrown out of the `for await`; wrap the fetch function to add retries.

See the [Pagination guide](../guides/pagination.md).

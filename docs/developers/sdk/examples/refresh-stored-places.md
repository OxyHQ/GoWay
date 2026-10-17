# Refresh stored place ids

An app that saves GoWay places (favourites, a store locator, a delivery zone) should store the GoWay Place ID and refresh its copy now and then. This program refreshes any number of stored ids with `places.getMany`, 50 per request, follows merges to the surviving place, and drops ids GoWay retired or never had.

```ts
import { createGoWayClient, MAX_PLACE_BATCH_SIZE, type Place, type PlaceId } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });

interface RefreshResult {
  places: Map<PlaceId, Place>;
  /** Old id to new id, for places merged into another. */
  replaced: Map<PlaceId, PlaceId>;
  /** Ids to forget: removed, or never existed. */
  dropped: PlaceId[];
}

async function refresh(storedIds: readonly PlaceId[]): Promise<RefreshResult> {
  const result: RefreshResult = { places: new Map(), replaced: new Map(), dropped: [] };
  const ids = [...new Set(storedIds)];

  for (let start = 0; start < ids.length; start += MAX_PLACE_BATCH_SIZE) {
    const batch = await goway.places.getMany(ids.slice(start, start + MAX_PLACE_BATCH_SIZE));

    for (const place of batch.items) result.places.set(place.id, place);
    for (const gone of batch.gone) {
      if (gone.mergedInto) result.replaced.set(gone.id, gone.mergedInto);
      else result.dropped.push(gone.id);
    }
    result.dropped.push(...batch.missing);
  }

  // Fetch the survivors of merges that were not already in the list.
  const survivors = [...new Set(result.replaced.values())].filter((id) => !result.places.has(id));
  for (let start = 0; start < survivors.length; start += MAX_PLACE_BATCH_SIZE) {
    const batch = await goway.places.getMany(survivors.slice(start, start + MAX_PLACE_BATCH_SIZE));
    for (const place of batch.items) result.places.set(place.id, place);
  }

  return result;
}

async function main() {
  const stored = ['gw_place_01H8', 'gw_place_02K4', 'gw_place_03M9'];
  const { places, replaced, dropped } = await refresh(stored);

  console.log(`${places.size} places refreshed`);
  for (const [oldId, newId] of replaced) console.log(`replace ${oldId} with ${newId}`);
  for (const id of dropped) console.log(`forget ${id}`);
}

main().catch((error) => console.error(error));
```

Notes:

- Every id lands in exactly one of `items`, `gone` and `missing`, in the order you asked.
- A merged place points one hop to its survivor, so a second batch for the survivors is enough.
- `items` carry the full single-place shape: `names`, `descriptions`, and `hoursExceptions`.
- More than `MAX_PLACE_BATCH_SIZE` ids in one call, or none, is a `GoWayValidationError` before anything is sent, which is why the list is split.

See the [Places guide](../guides/places.md).

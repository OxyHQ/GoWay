# Organization lists

An organization list is an ordered list of GoWay places that an Oxy organization publishes, where each entry names a place, an activity and a time window (an event programme, a route of stops, a set of opening days). `client.organizationLists` reads lists without an account and edits them for whoever may act for the owning organization.

```ts
import { createGoWayClient } from '@goway.to/sdk';

const apiBaseUrl = 'https://api.goway.to';
const linked = oxyServices.createLinkedClient({ baseURL: apiBaseUrl });
const goway = createGoWayClient({ apiBaseUrl, fetch: linked.fetchOptional });
// Dispose linked when this component or provider closes.
```

## Read lists

```ts
const page = await goway.organizationLists.list({ oxyAccountId: 'oxy_org_id' });

for await (const list of goway.organizationLists.iterate({ oxyAccountId: 'oxy_org_id' })) {
  console.log(list.title, list.revision);
}

const list = await goway.organizationLists.get('list_id');
```

`list` and `get` are public. `iterate(query)` walks every page for you (see [Pagination](./pagination.md)). Pages hold up to 50 items, 20 by default.

## Read entries

```ts
for await (const entry of goway.organizationLists.iterateEntries('list_id', { state: 'all' })) {
  console.log(entry.position, entry.activity, entry.placeId, entry.startsAt, entry.endsAt, entry.status);
}
```

- `entries(listId, query)` returns one page; `iterateEntries(listId, query)` walks them all.
- `state` is `'active'` (the default) or `'all'`.
- Each `OrganizationListEntry` has `id`, `listId`, `placeId`, `activity`, `information`, `startsAt` and `endsAt` (ISO 8601 UTC instants), `position`, `completedAt`, a derived `status` (`upcoming`, `active`, `expired` or `completed`) and the place's `timezone` for display.

Resolve the places with `places.getMany(entries.map((entry) => entry.placeId))`.

## Create and edit

Writes need an access token for someone who may act for the list's organization; anyone else gets `GoWayForbiddenError`.

```ts
const list = await goway.organizationLists.create({
  oxyAccountId: 'oxy_org_id',
  title: 'Summer market days',
  description: 'Where to find us this summer.',
});

const entry = await goway.organizationLists.addEntry(list.id, {
  placeId: 'gw_place_01H8',
  activity: 'Market stall',
  startsAt: '2026-07-04T08:00:00Z',
  endsAt: '2026-07-04T14:00:00Z',
});

await goway.organizationLists.completeEntry(list.id, entry.id);
```

- `title` is 1 to 160 characters, `description` and `information` at most 4000. `endsAt` must be after `startsAt`; both are checked before sending.
- `update(listId, { title, description })` replaces the title and description. `updateEntry(listId, entryId, input)` replaces an entry. `delete` and `deleteEntry` remove them.

## Reorder entries

`order` puts the entries in a new order. It takes the list's current `revision`, so two editors cannot silently overwrite each other:

```ts
const current = await goway.organizationLists.get(list.id);
await goway.organizationLists.order(list.id, {
  revision: current.revision,
  entryIds: ['entry_c', 'entry_a', 'entry_b'],
});
```

## See also

- [Places](./places.md)
- [API reference: `client.organizationLists`](../api-reference/index.md#clientorganizationlists-gowayorganizationlistsapi)

# Places

A GoWay place is a real-world location with a stable GoWay Place ID, a default name, a position, taxonomy categories, opening hours and capabilities (what it offers, such as wheelchair access or FairCoin payments). This guide covers reading places by id, by distance and by viewport, reading and writing capabilities and hours, and the gallery, reviews and business claims attached to a place.

All examples assume a client:

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'es' });
```

## Place IDs

`Place.id` (type `PlaceId`) is GoWay's own identifier. It does not change when the underlying OpenStreetMap element is renumbered, and a place created in GoWay has one before it matches anything external. Store the id, not a provider id, and not a link: rebuild links with [`client.links.place`](./links.md).

## Get one place

```ts
import { GoWayGoneError, GoWayNotFoundError, placeDisplayName } from '@goway.to/sdk';

try {
  const place = await goway.places.get('gw_place_01H8', { locale: 'pt-BR' });
  console.log(placeDisplayName(place), place.location);
} catch (error) {
  if (error instanceof GoWayGoneError) {
    // The place was removed, or merged into another one.
    if (error.mergedInto) console.log('Now stored as', error.mergedInto);
  } else if (error instanceof GoWayNotFoundError) {
    console.log('GoWay has no such place');
  } else {
    throw error;
  }
}
```

- The second argument (`GoWayPlaceReadOptions`) takes `locale` and `signal`. `locale` overrides the client's default for this call.
- `place.name` is always the default, local-language name. `place.localizedName` is the name in the requested locale when GoWay has one. Render with `placeDisplayName(place)`, which picks the right one.
- A single-place read also carries `names` (every language GoWay holds), `description`, `descriptions` and `localizedDescription`. List reads do not.
- `GoWayGoneError` means the id was real and is retired: drop it, or replace it with `error.mergedInto`. `GoWayNotFoundError` is only raised from a genuine GoWay error body.

## Refresh many stored ids

`getMany` reads up to `MAX_PLACE_BATCH_SIZE` (50) places in one request. Every id lands in exactly one list, in the order you gave (repeats collapse):

```ts
const batch = await goway.places.getMany(['gw_a', 'gw_b', 'gw_c']);

for (const place of batch.items) save(place);
for (const gone of batch.gone) gone.mergedInto ? replace(gone.id, gone.mergedInto) : forget(gone.id);
for (const id of batch.missing) forget(id);
```

More than 50 distinct ids, or none, is a `GoWayValidationError` before anything is sent. Split the list.

## Places near a point

```ts
const page = await goway.places.nearby({
  latitude: 41.3874,
  longitude: 2.1686,
  radiusMeters: 800,
  capabilities: ['payments.faircoin.accepted'],
  categories: ['food'],
  limit: 20,
});

for (const place of page.items) {
  console.log(place.name, Math.round(place.distanceMeters), 'm');
}
```

- Results are nearest first. Each item is a `PlaceWithDistance`.
- `radiusMeters` must be positive and at most `MAX_RADIUS_METERS` (50,000).
- `limit` is 1 to `MAX_PLACE_LIST_LIMIT` (200), default `DEFAULT_PLACE_LIST_LIMIT` (50).
- `capabilities` is a conjunction: a place must have every listed capability. Each entry is a registered key (`amenities.wifi`) or, for an enum, enum set, price level (`1` to `4`) or text capability, `key:value` (`accessibility.wheelchair:yes`, `price.level:2`). A text value may not contain a comma.
- `categories` is a disjunction: a place carrying any listed category, or any category below it, matches.
- The page has `nextCursor`; see [Pagination](./pagination.md).

## Places in a viewport

```ts
const page = await goway.places.inBounds({
  west: 2.15,
  south: 41.38,
  east: 2.19,
  north: 41.40,
  categories: ['food.cafe'],
});
```

The box takes the same filters as `nearby`. `south` must not be north of `north`, and the box may span at most `MAX_BOUNDS_SPAN_DEGREES` (90) on either axis. A box with `west > east` crosses the antimeridian.

## Capabilities

A capability is a registered key (`CAPABILITY_KEYS`) with a value of the kind the key declares, asserted at a verification tier (`CAPABILITY_VERIFICATIONS`, weakest to strongest: `community_reported`, `external_source`, `business_asserted`, `oxy_verified`). A place can carry several assertions of one key; the strongest, then freshest, is the answer.

Read them with the helpers rather than scanning `place.capabilities` yourself:

```ts
import {
  capabilityLabel,
  capabilityValueLabel,
  placeHasCapability,
  strongestCapability,
} from '@goway.to/sdk';

if (placeHasCapability(place, 'payments.faircoin.accepted')) {
  console.log(capabilityLabel('payments.faircoin.accepted', 'es')); // "Acepta FairCoin"
}

const wheelchair = strongestCapability(place, 'accessibility.wheelchair');
if (wheelchair && typeof wheelchair.value === 'string') {
  console.log(capabilityValueLabel('accessibility.wheelchair', wheelchair.value, 'en'));
  console.log('verified as', wheelchair.verification);
}
```

`placeHasCapability` applies the same rule as the server's `capabilities` filter, and `placeMatchesCapabilityFilter(place, 'key:value')` does the same for a `key:value` entry.

Assert or withdraw a capability (needs an access token):

```ts
await goway.places.capabilities.put('gw_place_01H8', 'payments.faircoin.accepted', { value: true });
await goway.places.capabilities.delete('gw_place_01H8', 'payments.faircoin.accepted');
```

The key and the value kind are checked before sending. You never name the tier: the server derives it from who is asking (an approved business claim earns `business_asserted`). To say a place does not offer something, assert `false` rather than deleting.

## Opening hours

`place.openingHours` is the weekly schedule, read in `place.timezone`. `place.hoursExceptions` holds dated closures and special hours that have not ended. Evaluate both with `openingStatusAt`:

```ts
import { openingStatusAt } from '@goway.to/sdk';

const status = openingStatusAt(place); // or openingStatusAt(place, new Date(...))
if (status.state === 'unknown') {
  console.log('Hours unknown');
} else {
  console.log(status.state, status.nextChange ? `until ${status.nextChange.localTime}` : '');
}
```

Every read that returns places (by id, batch, nearby, viewport) carries `hoursExceptions`, so you can answer "open now" for a list without a second request.

Report a closure or special hours (needs an access token). Dates are `YYYY-MM-DD` and times `HH:mm` in the place's local time:

```ts
await goway.places.hoursExceptions.create('gw_place_01H8', {
  startsOn: '2026-12-24',
  endsOn: '2026-12-26',
  closed: true,
  note: 'Holidays',
});

await goway.places.hoursExceptions.create('gw_place_01H8', {
  startsOn: '2026-12-31',
  closed: false,
  intervals: [{ opens: '09:00', closes: '14:00' }],
});
```

`hoursExceptions.list`, `replace` and `delete` complete the set. A caller rewrites only an exception at their own tier, and only an approved claimant may withdraw one.

## Gallery

Every gallery item is an Oxy file. Upload the image with the Oxy SDK as a public file first, then add its id:

```ts
const media = await goway.places.media.list('gw_place_01H8', { kinds: ['photo', 'interior'] });

await goway.places.media.add('gw_place_01H8', { fileId: 'oxy_file_id', kind: 'photo', caption: 'Terrace' });
```

`add` rejects with `GoWayForbiddenError` for a file that is not yours (or a `logo` or `cover` on a place whose business is not you), `GoWayValidationError` for a file that is not a public, active image (`PLACE_MEDIA_MIME_TYPES`), and `GoWayConflictError` when the gallery already holds it. `remove`, `reorder` (business only) and `report` complete the set. `place.logoFileId` and `place.coverFileId` name the business's own imagery.

## Reviews

One review per person. `put` writes yours or rewrites it whole:

```ts
const reviews = await goway.places.reviews.list('gw_place_01H8', { sort: 'highest' });

const mine = await goway.places.reviews.put('gw_place_01H8', {
  rating: 5,
  title: 'Great coffee',
  body: 'Quiet in the morning.',
});
console.log(mine.status);
```

- `rating` is an integer from `MIN_REVIEW_RATING` (1) to `MAX_REVIEW_RATING` (5).
- `mine` returns your review with its status, and rejects with `GoWayNotFoundError` when you have none. `delete` withdraws it.
- A business may not review its own place; it answers with `reply` and `deleteReply`.
- `place.rating` (`{ average, count }`) is derived from the published reviews.

## Business claims

A claim asks to be recognised as running a place. It is always created `pending` and decided by GoWay. Claim for an Oxy organization you own or administer by passing its account id:

```ts
const claim = await goway.places.claims.create('gw_place_01H8', {
  role: 'owner',
  oxyAccountId: 'oxy_org_id',
});

// Every claim an organization holds, across places.
const claims = await goway.claims.list({ oxyAccountId: 'oxy_org_id' });
```

`role` is one of `PLACE_CLAIM_ROLES`. `places.claims.list(placeId)` lists the claims on one place for whoever may act for an account that holds one. Once a claim is approved, that account's capability and hours writes are asserted at `business_asserted`.

## Create, edit and report

These need an access token.

```ts
const created = await goway.places.create({
  name: 'Café del Mar',
  location: { latitude: 41.3809, longitude: 2.1897 },
  categories: ['food.cafe'],
  contact: { website: 'https://example.com' },
});

// A merge patch: absent fields are untouched, null clears one that may be empty.
await goway.places.update(created.id, { contact: { phone: null }, status: 'closed' });

await goway.places.report(created.id, { reason: 'duplicate' });
```

`places.revisions(placeId)` lists a place's public history, newest first: what changed and when, never who. It needs no account.

## See also

- [Search](./search.md) and [Geocoding](./geocoding.md) for finding places by text.
- [Categories](./categories.md) for labelling `place.categories`.
- [Errors](./errors.md) and [Pagination](./pagination.md).
- [API reference: `client.places`](../api-reference/index.md#clientplaces-gowayplacesapi).

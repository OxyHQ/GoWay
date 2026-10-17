# Nearby places with a capability filter

Find places within walking distance that accept FairCoin and have wheelchair access, then print each with its distance, whether it is open now, and a link to its GoWay page. The capability filter runs on the server, so only matching places come back. It needs no account, and runs in Node 18+, Bun, a browser or React Native.

```ts
import {
  capabilityLabel,
  createGoWayClient,
  openingStatusAt,
  placeDisplayName,
  strongestCapability,
} from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });

async function main() {
  const page = await goway.places.nearby({
    latitude: 41.3874,
    longitude: 2.1686,
    radiusMeters: 1500,
    capabilities: ['payments.faircoin.accepted', 'accessibility.wheelchair:yes'],
    limit: 20,
  });

  if (page.items.length === 0) {
    console.log('No matching places nearby.');
    return;
  }

  for (const place of page.items) {
    const status = openingStatusAt(place);
    const open = status.state === 'unknown' ? 'hours unknown' : status.state;
    const faircoin = strongestCapability(place, 'payments.faircoin.accepted');

    console.log(
      `${placeDisplayName(place)}: ${Math.round(place.distanceMeters)} m, ${open}`,
      `\n  ${capabilityLabel('payments.faircoin.accepted', 'en')} (${faircoin?.verification ?? 'unverified'})`,
      `\n  ${goway.links.place(place)}`,
    );
  }

  if (page.nextCursor !== null) console.log('More results are available.');
}

main().catch((error) => console.error(error));
```

Notes:

- `capabilities` is a conjunction: every entry must hold for a place to match. `accessibility.wheelchair:yes` matches the enum value `yes`; `accessibility.wheelchair` alone would match any value that holds (`yes` or `limited`).
- `verification` tells you how much to trust the answer, from `community_reported` up to `oxy_verified`.
- To get the next page, call `nearby` again with the same query and `cursor: page.nextCursor`, or use [`iterateGoWayPages`](./walk-all-pages.md).

See the [Places guide](../guides/places.md).

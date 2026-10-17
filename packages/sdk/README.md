# @goway.to/sdk

The TypeScript client for GoWay's public geographic API: GoWay places and capability filters, search, geocoding, routing, live vehicles, road rules, and canonical GoWay links and map style URLs. Every request is validated before it is sent, every response is parsed against the API's own contract, and every failure is a typed error. It runs in Node 18+, Bun, browsers and React Native, and depends only on `zod`.

## Install

```bash
npm install @goway.to/sdk
```

## Quick start

```ts
import { createGoWayClient, placeDisplayName } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });

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

Search, browsing and routing need no account. For identity-bound calls, pass `getAccessToken: () => <the user's Oxy access token>`.

## Entry points

| Import | Contents |
| --- | --- |
| `@goway.to/sdk` | The HTTP client (`createGoWayClient`), typed errors, pagination, contract types and helpers. |
| `@goway.to/sdk/live` | The GoWay Live Socket.IO protocol: events, room tiles, message parsers. Bring your own `socket.io-client`. |
| `@goway.to/sdk/geo` | Web Mercator, boxes across the antimeridian, distances, pixel projection. |
| `@goway.to/sdk/road-access` | Who may use a road, from OpenStreetMap access tags. |
| `@goway.to/sdk/map` | Map style names and documents, the style catalogue, the tile schema, localized labels. No `zod`. |

## Documentation

- [Overview, client options and authentication](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/README.md)
- Guides: [Places](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/places.md), [Search](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/search.md), [Geocoding](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/geocoding.md), [Routing](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/routing.md), [Links](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/links.md), [Live](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/live.md), [Errors](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/errors.md), [Pagination](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/guides/pagination.md)
- [Examples](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/examples/README.md)
- API reference: [`@goway.to/sdk`](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/api-reference/index.md), [`/live`](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/api-reference/live.md), [`/geo`](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/api-reference/geo.md), [`/road-access`](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/api-reference/road-access.md), [`/map`](https://github.com/OxyHQ/GoWay/blob/main/docs/developers/sdk/api-reference/map.md)

## License

`SEE LICENSE IN LICENSE`: the terms are in the [LICENSE](https://github.com/OxyHQ/GoWay/blob/main/packages/sdk/LICENSE) file shipped with this package.

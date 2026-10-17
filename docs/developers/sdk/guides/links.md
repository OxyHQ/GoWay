# Links

`client.links` builds canonical GoWay web URLs: a place page, the map framed on a viewport, an embeddable map, and the style documents a map renderer loads. The methods are synchronous, fetch nothing and need no account. They build on the client's `webBaseUrl` (default `https://goway.to`).

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient();
```

## Place pages

```ts
goway.links.place('gw_place_01H8'); // 'https://goway.to/place/gw_place_01H8'
goway.links.place(place);           // a Place: its id
goway.links.place(searchResult);    // a SearchResult: its placeId
```

`place()` accepts any `PlaceLinkTarget`: a `PlaceId`, an object with `id`, or an object with `placeId` (which wins over `id`). The id is URL-encoded. An empty id throws `GoWayValidationError`.

A link is presentation. Store the place id and rebuild the link when you need it.

## The map at a viewport

```ts
goway.links.map({ latitude: 41.38, longitude: 2.16, zoom: 14 });
// 'https://goway.to/?lat=41.38&lng=2.16&zoom=14'
```

The argument is a `MapViewport`: `latitude`, `longitude`, `zoom`, and optional `bearing` and `pitch`. A coordinate out of range, or a `zoom`, `bearing` or `pitch` that is not a finite number, throws `GoWayValidationError`. Query parameters are sorted, so the same viewport always gives the same URL.

## Embed a map

`embed` returns the URL of GoWay's embeddable map, for an `<iframe src>`:

```ts
const src = goway.links.embed({ latitude: 41.39, longitude: 2.17, zoom: 14 }, { style: 'outdoors' });
// 'https://goway.to/frame?lat=41.39&light=day&lng=2.17&style=outdoors&zoom=14'
```

```tsx
export function EmbeddedMap({ src }: { src: string }) {
  return <iframe src={src} title="Map" width="600" height="400" style={{ border: 0 }} />;
}
```

`options.style` is a `MapStyleId` and `options.light` a `MapLightPreset`. With neither, the URL carries no style and the embed uses its default. With only `light`, the style is `DEFAULT_MAP_STYLE`. A style or light GoWay does not publish throws `GoWayValidationError`.

## Style documents

A GoWay style is a complete MapLibre style document: tiles, glyphs, sprite and credit included.

```ts
goway.links.mapStyle('standard', 'night'); // 'https://goway.to/map/styles/standard/night.json'
goway.links.mapStyle('dark', 'day');       // 'https://goway.to/map/styles/dark/night.json'
goway.links.mapStyleIndex();               // 'https://goway.to/map/styles/index.json'
```

- `mapStyle(style, light?)` defaults to the style's own light. A light the style is not published in resolves to the nearest one it is; a fixed-light style keeps its one.
- `mapStyleIndex()` is the catalogue of every published style. Fetch it yourself and check it with `parseMapStyleIndex`, which keeps styles this SDK version does not know.

### `styleUrl`: resolve a style name

GoWay names styles with `goway://styles/<id>` URLs (optionally `?light=<preset>`). `styleUrl` turns such a name into its document, and passes any other URL through:

```ts
goway.links.styleUrl('goway://styles/standard');                   // '.../standard/day.json'
goway.links.styleUrl('goway://styles/standard', 'night');          // '.../standard/night.json'
goway.links.styleUrl('goway://styles/standard?light=dawn', 'night'); // '.../standard/dawn.json': the name's light wins
goway.links.styleUrl('https://example.org/style.json');            // unchanged
```

A `goway://` name that is not a published style throws `GoWayValidationError`. The same rule without a client and without throwing is `styleDocumentUrl` (returns `null` instead), exported from both `@goway.to/sdk` and `@goway.to/sdk/map`. See [Map styles](./map-styles.md).

## Point at another deployment

```ts
const staging = createGoWayClient({ webBaseUrl: 'https://staging.goway.to' });
staging.links.place('p'); // 'https://staging.goway.to/place/p'
```

## See also

- [Map styles](./map-styles.md)
- [API reference: `client.links`](../api-reference/index.md#clientlinks-gowaylinks)

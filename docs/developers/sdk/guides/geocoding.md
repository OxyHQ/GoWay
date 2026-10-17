# Geocoding

`client.geocode` turns addresses into coordinates and coordinates into addresses. It has three methods: `forward` for free-text address lookup, `structured` for an address whose parts are already separated, and `reverse` for "what is at this point". All three answer with the same `SearchResults` shape as [search](./search.md), and all work signed out.

```ts
import { createGoWayClient } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });
```

## Forward geocoding

Text in, coordinates out. Takes the same `SearchQuery` as `client.search.query`:

```ts
const results = await goway.geocode.forward({
  query: 'Passeig de Gràcia 43, Barcelona',
  limit: 5,
});

const best = results.items[0];
if (best) console.log(best.displayName, best.coordinate);
```

Bias toward the user's area with `near` (a `GeoCoordinate`) or `viewport` (a `GeoBoundingBox`); both only re-rank.

## Structured geocoding

When your form already separates the parts, send them as a `StructuredGeocodeQuery`:

```ts
const results = await goway.geocode.structured({
  street: 'Passeig de Gràcia',
  houseNumber: '43',
  city: 'Barcelona',
  countryCode: 'es',
});
```

- At least one of `STRUCTURED_GEOCODE_FIELDS` (`street`, `houseNumber`, `city`, `region`, `postalCode`, `countryCode`) is required, or the call is refused with `GoWayValidationError` before sending.
- Each part is trimmed and at most 256 characters.
- `countryCode` must be an ISO 3166-1 alpha-2 code and is upper-cased for you.
- `limit`, `locale` and `cursor` work as in search.
- A deployment whose geocoders have no structured endpoint answers `GoWayUnavailableError`.

## Reverse geocoding

What is at this coordinate:

```ts
const results = await goway.geocode.reverse({
  latitude: 41.3917,
  longitude: 2.1649,
  radiusMeters: 50,
  limit: 1,
});

const here = results.items[0];
console.log(here?.displayName ?? 'Nothing here');
```

`ReverseGeocodeQuery` takes `latitude`, `longitude`, an optional `radiusMeters` (positive, at most `MAX_RADIUS_METERS`), and `limit`, `locale`, `cursor`. A latitude outside ±90 or a longitude outside ±180 is a `GoWayValidationError` before sending.

See the [reverse-geocode-a-tap example](../examples/reverse-geocode-tap.md) for doing this from a map press.

## Results

Every result has a `kind` (`address`, `street`, `locality`, `region`, `country`, `place`, `poi`), a `displayName`, a `coordinate` and, when the source supplies them, a `boundingBox`, a structured `address` and an administrative `context`. A result that reconciles to a GoWay place also carries `placeId` and `place`. `degradedProviders` lists geocoders that failed during this request.

## Privacy

Coordinates you send for a reverse lookup or a `near` bias are request data. Ask for the device location only when the user invokes something that needs it.

## See also

- [Search](./search.md)
- [Errors](./errors.md)
- [API reference: `client.geocode`](../api-reference/index.md#clientgeocode-gowaygeocodeapi)

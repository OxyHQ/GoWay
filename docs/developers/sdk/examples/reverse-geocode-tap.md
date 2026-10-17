# Reverse geocode a tap

When the user presses the map, look up what is at that point and show its name. The press handler cancels the previous lookup if the user taps again before it answers. The map is `@goway.to/maps`'s `MapView` (React and React Native); set it up as described in the [maps documentation](../../maps/README.md).

```tsx
import { useState } from 'react';
import { Text, View } from 'react-native';
import { MapView, type MapPressEvent } from '@goway.to/maps';
import { createGoWayClient, GoWayAbortError, type SearchResult } from '@goway.to/sdk';

const goway = createGoWayClient({ locale: 'en' });

let lookup: AbortController | undefined;

export function WhatIsHere() {
  const [result, setResult] = useState<SearchResult | null>(null);
  const [message, setMessage] = useState('Tap the map');

  async function onPress(event: MapPressEvent) {
    lookup?.abort();
    const controller = new AbortController();
    lookup = controller;
    setMessage('Looking up…');
    try {
      const page = await goway.geocode.reverse(
        { ...event.coordinate, radiusMeters: 100, limit: 1 },
        { signal: controller.signal },
      );
      const first = page.items[0] ?? null;
      setResult(first);
      setMessage(first ? first.displayName : 'Nothing found here');
    } catch (error) {
      if (error instanceof GoWayAbortError) return;
      setResult(null);
      setMessage('Lookup failed, try again');
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        mapStyle="goway://styles/standard"
        initialViewState={{ latitude: 41.3874, longitude: 2.1686, zoom: 15 }}
        onPress={onPress}
      />
      <View style={{ padding: 16 }}>
        <Text>{message}</Text>
        {result?.placeId ? <Text>{goway.links.place(result)}</Text> : null}
      </View>
    </View>
  );
}
```

Notes:

- `MapPressEvent.coordinate` is already a GoWay `{ latitude, longitude }`, so it spreads straight into `ReverseGeocodeQuery`.
- `radiusMeters` limits how far from the press a result may be (at most `MAX_RADIUS_METERS`).
- A result with `placeId` reconciles to a GoWay place; `goway.links.place(result)` links it.
- The press coordinate is the user's choice of point, not their location: no location permission is involved.

See the [Geocoding guide](../guides/geocoding.md).

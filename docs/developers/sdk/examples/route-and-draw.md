# Route between two points and draw it

Ask GoWay for a walking route between two points, draw the line on a `@goway.to/maps` map with a `GeoJSONSource` and a `Layer`, and frame the camera on it. It handles "no route" as a normal answer. Set up `@goway.to/maps` as described in the [maps documentation](../../maps/README.md).

```tsx
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import { GeoJSONSource, Layer, MapView } from '@goway.to/maps';
import {
  createGoWayClient,
  GoWayNoRouteError,
  GoWayUnsupportedModeError,
  toGeoCoordinate,
  type GeoCoordinate,
  type Route,
} from '@goway.to/sdk';
import { boundsOf } from '@goway.to/sdk/geo';

const goway = createGoWayClient({ locale: 'en' });

const FROM: GeoCoordinate = { latitude: 41.3874, longitude: 2.1686 }; // Plaça de Catalunya
const TO: GeoCoordinate = { latitude: 41.4036, longitude: 2.1744 }; // Sagrada Família

async function walkingRoute(from: GeoCoordinate, to: GeoCoordinate): Promise<Route | null> {
  try {
    const response = await goway.routes.directions({
      origin: { coordinate: from },
      destination: { coordinate: to },
      mode: 'walk',
    });
    return response.routes[0] ?? null; // an empty list also means "no route"
  } catch (error) {
    if (error instanceof GoWayNoRouteError || error instanceof GoWayUnsupportedModeError) return null;
    throw error;
  }
}

export function WalkingDirections() {
  const [route, setRoute] = useState<Route | null>(null);
  const [message, setMessage] = useState('');

  async function onDirections() {
    setMessage('Finding a route…');
    try {
      const found = await walkingRoute(FROM, TO);
      setRoute(found);
      setMessage(
        found
          ? `${(found.distanceMeters / 1000).toFixed(1)} km, ${Math.round(found.durationSeconds / 60)} min`
          : 'No route found',
      );
    } catch {
      setMessage('Directions are unavailable right now');
    }
  }

  const bounds = route ? boundsOf(route.geometry.coordinates.map(toGeoCoordinate)) : null;

  return (
    <View style={{ flex: 1 }}>
      <MapView
        style={{ flex: 1 }}
        initialViewState={{ latitude: 41.395, longitude: 2.171, zoom: 13 }}
        camera={bounds ? { bounds, padding: 48 } : undefined}
      >
        {route ? (
          <GeoJSONSource id="route" data={{ type: 'Feature', geometry: route.geometry, properties: {} }}>
            <Layer
              id="route-line"
              type="line"
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
              paint={{ 'line-color': '#1a73e8', 'line-width': 5 }}
            />
          </GeoJSONSource>
        ) : null}
      </MapView>
      <View style={{ padding: 16, gap: 8 }}>
        <Pressable onPress={onDirections}>
          <Text>Walking directions</Text>
        </Pressable>
        <Text>{message}</Text>
        {route?.legs.flatMap((leg) => leg.maneuvers).map((step, index) => (
          <Text key={index}>{step.instruction}</Text>
        ))}
      </View>
    </View>
  );
}
```

Notes:

- `route.geometry` is a GeoJSON `LineString` with `[longitude, latitude]` positions, so it goes straight into a `GeoJSONSource`. `toGeoCoordinate` converts positions to `{ latitude, longitude }` for `boundsOf`.
- `MapView`'s `camera` is applied whenever its value changes, so the map frames each new route once and leaves the user's pans alone.
- "No route" arrives either as `GoWayNoRouteError` or as an empty `routes` array; both are handled as a normal result.
- Maneuver `instruction` text is in the client's `locale`.

See the [Routing guide](../guides/routing.md).

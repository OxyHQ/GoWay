# Draw a route

Ask GoWay for directions with `@goway.to/sdk` and draw the route as a line under the map's labels. The route's geometry is GeoJSON, so it goes straight into a `GeoJSONSource`.

```tsx
import { useState } from 'react';
import { View } from 'react-native';
import { GeoJSONSource, Layer, MapView, Markers, type GeoCoordinate } from '@goway.to/maps';
import { createGoWayClient, type Route } from '@goway.to/sdk';
import { boundsOf } from '@goway.to/sdk/geo';
import { Button } from '@oxy.so/bloom/button';

const client = createGoWayClient();

export function RouteMap({ from, to }: { from: GeoCoordinate; to: GeoCoordinate }) {
  const [route, setRoute] = useState<Route | null>(null);

  const findRoute = async () => {
    const { routes } = await client.routes.directions({
      origin: { coordinate: from },
      destination: { coordinate: to },
      mode: 'walk',
    });
    setRoute(routes[0] ?? null);
  };

  const ends = [
    { id: 'from', coordinate: from, label: 'A' },
    { id: 'to', coordinate: to, label: 'B' },
  ];

  return (
    <View style={{ flex: 1 }}>
      <MapView camera={{ bounds: boundsOf([from, to]), padding: 64 }}>
        {route ? (
          <GeoJSONSource id="app-route" data={route.geometry}>
            <Layer
              id="app-route-line"
              type="line"
              beforeId="goway:anchor:labels"
              paint={{ 'line-color': '#1a73e8', 'line-width': 6 }}
              layout={{ 'line-cap': 'round', 'line-join': 'round' }}
            />
          </GeoJSONSource>
        ) : null}
        <Markers data={ends} />
      </MapView>
      <View style={{ position: 'absolute', top: 16, alignSelf: 'center' }}>
        <Button onPress={findRoute}>Walk there</Button>
      </View>
    </View>
  );
}
```

- `route.distanceMeters` and `route.durationSeconds` give the summary; `route.legs` carries the step-by-step maneuvers.
- `beforeId="goway:anchor:labels"` draws the line under the basemap's labels, so street names stay readable on top of it.

Related: [Sources and layers](../guides/sources-and-layers.md), [Routing with the GoWay SDK](../../sdk/guides/routing.md).

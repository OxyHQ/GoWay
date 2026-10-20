# Markers and clusters

Homes as Bloom price pills, clustered when they crowd. Pressing a pin selects it and shows a card; the selected pin is never folded into a cluster. Pressing a cluster zooms in to where it splits.

```tsx
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { MapView, Markers, type GeoBoundingBox, type MapMarkerData } from '@goway.to/maps';
import { Text } from '@oxy.so/bloom/typography';

interface Home {
  id: string;
  price: string;
  latitude: number;
  longitude: number;
}

export function HomesMap({ homes, area }: { homes: readonly Home[]; area: GeoBoundingBox }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const markers = useMemo<MapMarkerData[]>(
    () =>
      homes.map((home) => ({
        id: home.id,
        coordinate: { latitude: home.latitude, longitude: home.longitude },
        label: home.price,
        accessibilityLabel: `Home for ${home.price}`,
      })),
    [homes],
  );
  const selected = homes.find((home) => home.id === selectedId) ?? null;

  return (
    <View style={{ flex: 1 }}>
      <MapView camera={{ bounds: area }} onPress={() => setSelectedId(null)}>
        <Markers
          data={markers}
          cluster
          clusterRadius={50}
          selectedId={selectedId}
          onPress={(marker) => setSelectedId(marker.id)}
        />
      </MapView>
      {selected ? (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 48, padding: 16, borderRadius: 16, backgroundColor: 'white' }}>
          <Text>{selected.price}</Text>
        </View>
      ) : null}
    </View>
  );
}
```

Memoize the marker list: a new array on every render re-indexes the clusters.

Related: [Markers and clusters](../guides/markers.md).

# Pick a place on the map

A tap that lands on a basemap label (a shop, a station, a park) already knows its name. A tap anywhere else is reverse geocoded with `@goway.to/sdk`. The pick is drawn as a pin, and the camera follows it.

```tsx
import { useMemo, useState } from 'react';
import { View } from 'react-native';
import { MapView, Markers, type GeoCoordinate, type MapPressEvent } from '@goway.to/maps';
import { createGoWayClient } from '@goway.to/sdk';
import { Text } from '@oxy.so/bloom/typography';

const client = createGoWayClient();

interface Pick {
  coordinate: GeoCoordinate;
  name: string;
}

export function PlacePicker({ onPick }: { onPick: (pick: Pick) => void }) {
  const [pick, setPick] = useState<Pick | null>(null);

  const handlePress = async ({ coordinate, label }: MapPressEvent) => {
    if (label && label.kind !== 'road') {
      const named = { coordinate: label.coordinate, name: label.name };
      setPick(named);
      onPick(named);
      return;
    }
    setPick({ coordinate, name: '…' });
    const { items } = await client.geocode.reverse({ ...coordinate, limit: 1 });
    const named = { coordinate, name: items[0]?.displayName ?? 'Dropped pin' };
    setPick(named);
    onPick(named);
  };

  const pins = useMemo(() => (pick ? [{ id: 'pick', coordinate: pick.coordinate }] : []), [pick]);

  return (
    <View style={{ flex: 1 }}>
      <MapView
        initialViewState={{ latitude: 41.3874, longitude: 2.1686, zoom: 13 }}
        camera={pick ? { center: pick.coordinate, zoom: 16 } : undefined}
        onPress={handlePress}
      >
        <Markers data={pins} selectedId="pick" />
      </MapView>
      {pick ? (
        <View style={{ position: 'absolute', left: 16, right: 16, bottom: 48 }}>
          <Text>{pick.name}</Text>
        </View>
      ) : null}
    </View>
  );
}
```

- A label's `coordinate` is the feature's own point when `anchored` is `true`, and the tap otherwise.
- The camera target is compared by value, so re-rendering with the same pick does not move the map again.

Related: [Events](../guides/events.md#presses), [Geocoding with the GoWay SDK](../../sdk/guides/geocoding.md).

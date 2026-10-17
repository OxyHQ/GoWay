# Labels on screen

List the places the map is showing right now, as the reader pans. `onLabelsChange` reports the labels MapLibre actually placed, on every settled frame; `sameLabelSet` keeps an unchanged set from re-rendering the list.

```tsx
import { useState } from 'react';
import { FlatList, View } from 'react-native';
import { MapView, sameLabelSet, type MapLabelFeature } from '@goway.to/maps';
import { Text } from '@oxy.so/bloom/typography';

export function WhatsHere() {
  const [labels, setLabels] = useState<readonly MapLabelFeature[]>([]);
  const places = labels.filter((label) => label.kind === 'poi');

  return (
    <View style={{ flex: 1, flexDirection: 'row' }}>
      <View style={{ flex: 2 }}>
        <MapView
          initialViewState={{ latitude: 41.3874, longitude: 2.1686, zoom: 16 }}
          onLabelsChange={(next) => setLabels((previous) => (sameLabelSet(previous, next) ? previous : next))}
        />
      </View>
      <FlatList
        style={{ flex: 1 }}
        data={places}
        keyExtractor={(label) => label.id}
        renderItem={({ item }) => (
          <Text>
            {item.name}
            {item.category ? ` · ${item.category}` : ''}
          </Text>
        )}
      />
    </View>
  );
}
```

A label's `id` is stable while the loaded tiles are, which is enough for a list key. It is not a GoWay place id; to get a place, search for it with the [GoWay SDK](../../sdk/README.md).

Related: [Events](../guides/events.md#labels-on-screen).

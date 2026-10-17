# Custom markers

Draw your own marker body by `kind`, and keep Bloom's default for everything else. Calling the `onPress` you are given keeps the visited state and cluster expansion working.

```tsx
import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import { DefaultMapMarker, MapView, Markers, type MapMarkerData, type MapMarkerItem } from '@goway.to/maps';
import { Text } from '@oxy.so/bloom/typography';

const stops: MapMarkerData[] = [
  { id: 'cafe', kind: 'stop', coordinate: { latitude: 41.3851, longitude: 2.1734 }, label: '1' },
  { id: 'museum', kind: 'stop', coordinate: { latitude: 41.3917, longitude: 2.1801 }, label: '2' },
  { id: 'hotel', coordinate: { latitude: 41.3874, longitude: 2.1686 }, label: 'Hotel' },
];

export function TourMap() {
  const renderMarker = useCallback((item: MapMarkerItem, onPress: () => void) => {
    if (item.kind === 'point' && item.marker.kind === 'stop') {
      const active = item.state === 'active';
      return (
        <Pressable
          onPress={onPress}
          accessibilityRole="button"
          accessibilityLabel={`Stop ${item.marker.label}`}
          style={{
            width: 32,
            height: 32,
            borderRadius: 16,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: active ? '#1a73e8' : 'white',
          }}
        >
          <Text style={{ color: active ? 'white' : 'black' }}>{item.marker.label}</Text>
        </Pressable>
      );
    }
    return <DefaultMapMarker item={item} onPress={onPress} />;
  }, []);

  return (
    <View style={{ flex: 1 }}>
      <MapView initialViewState={{ latitude: 41.388, longitude: 2.174, zoom: 14 }}>
        <Markers data={stops} renderMarker={renderMarker} />
      </MapView>
    </View>
  );
}
```

A marker body is an ordinary React Native view on every platform. It is centred on its coordinate.

Related: [Markers and clusters](../guides/markers.md#custom-marker-bodies).

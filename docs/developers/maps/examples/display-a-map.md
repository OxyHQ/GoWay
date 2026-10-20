# Display a map

The smallest useful map: GoWay Standard, opened on a city, in the app's Bloom theme (day in a light theme, night in a dark one).

```tsx
import { View } from 'react-native';
import { MapView } from '@goway.to/maps';

export function CityMap() {
  return (
    <View style={{ flex: 1 }}>
      <MapView initialViewState={{ latitude: 41.3874, longitude: 2.1686, zoom: 12 }} />
    </View>
  );
}
```

`MapView` fills its parent. In a scroll view, give it a height instead: `style={{ height: 280 }}`.

Related: [Map view](../guides/map-view.md), [Camera](../guides/camera.md).

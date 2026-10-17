# Fit the map to data

Frame whatever the results are, as a value: when the results change, the map frames the new box; when they don't, a re-render leaves the reader's camera alone. A button re-frames on demand through the ref.

```tsx
import { useMemo, useRef } from 'react';
import { View } from 'react-native';
import { MapView, Markers, type MapMarkerData, type MapViewRef } from '@goway.to/maps';
import { boundsOf } from '@goway.to/sdk/geo';
import { Button } from '@oxy.so/bloom/button';

export function ResultsMap({ results }: { results: readonly MapMarkerData[] }) {
  const map = useRef<MapViewRef>(null);
  const box = useMemo(() => boundsOf(results.map((result) => result.coordinate)), [results]);

  return (
    <View style={{ flex: 1 }}>
      <MapView ref={map} camera={{ bounds: box, padding: 64, maxZoom: 16 }}>
        <Markers data={results} cluster />
      </MapView>
      <View style={{ position: 'absolute', top: 16, alignSelf: 'center' }}>
        <Button onPress={() => box && map.current?.fitBounds(box, { padding: 64, maxZoom: 16 })}>
          Show all results
        </Button>
      </View>
    </View>
  );
}
```

- `boundsOf` (from `@goway.to/sdk/geo`) returns `null` for no points; a `null` box is no target, so the camera stays put.
- One result is a box with no area. The map moves to it at street zoom instead of zooming all the way in.
- `maxZoom` keeps two results on the same street from framing at building level.

Related: [Camera](../guides/camera.md).

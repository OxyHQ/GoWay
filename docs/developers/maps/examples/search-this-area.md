# Search this area

Offer "Search this area" only after the reader has moved the map themselves, never because the app framed the results. `onCameraChanged` reports who moved the camera, so the rule is three lines.

```tsx
import { useState } from 'react';
import { View } from 'react-native';
import { MapView, Markers, type GeoBoundingBox, type MapMarkerData } from '@goway.to/maps';
import { Button } from '@oxy.so/bloom/button';

export function SearchMap({
  searchedArea,
  results,
  onSearchArea,
}: {
  searchedArea: GeoBoundingBox;
  results: readonly MapMarkerData[];
  onSearchArea: (area: GeoBoundingBox) => void;
}) {
  const [pending, setPending] = useState<GeoBoundingBox | null>(null);

  return (
    <View style={{ flex: 1 }}>
      <MapView
        camera={{ bounds: searchedArea }}
        onCameraChanged={({ bounds, source, isFinal }) => {
          if (!isFinal) return;
          // The app framing the results is not a request to search elsewhere.
          setPending(source === 'user' ? bounds : null);
        }}
      >
        <Markers data={results} cluster />
      </MapView>
      {pending ? (
        <View style={{ position: 'absolute', top: 16, alignSelf: 'center' }}>
          <Button
            onPress={() => {
              onSearchArea(pending);
              setPending(null);
            }}
          >
            Search this area
          </Button>
        </View>
      ) : null}
    </View>
  );
}
```

When `onSearchArea` commits the new box, it becomes the next `searchedArea`; the map frames it, that move is `programmatic`, and the button stays hidden.

Related: [Events](../guides/events.md#camera-changes), [Testing](../guides/testing.md) for unit-testing this logic.

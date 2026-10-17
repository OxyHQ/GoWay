# Locate me

A "locate me" button that asks for the location only when pressed, moves the map there, and explains a refusal in words that fit it. The puck appears as soon as the permission is granted.

```tsx
import { View } from 'react-native';
import { MapView, UserLocation, useMap, useUserLocation } from '@goway.to/maps';
import { Button } from '@oxy.so/bloom/button';
import { Text } from '@oxy.so/bloom/typography';

const MESSAGES = {
  denied: 'Location is off for this app.',
  unavailable: 'Your device could not find its position.',
  timeout: 'Finding your position took too long. Try again.',
  insecureContext: 'Location needs a secure (https) page.',
} as const;

function LocateMe() {
  const map = useMap();
  const location = useUserLocation();

  const locate = async () => {
    const coordinate = await location.locate();
    if (coordinate) map.moveTo({ ...coordinate, zoom: 15 });
  };

  return (
    <View style={{ position: 'absolute', top: 16, right: 16, alignItems: 'flex-end', gap: 8 }}>
      <Button onPress={locate} disabled={location.isLocating}>
        Locate me
      </Button>
      {location.error ? (
        <Text>
          {MESSAGES[location.error]}
          {location.error === 'denied' && !location.canAskAgain ? ' Turn it on in Settings.' : ''}
        </Text>
      ) : null}
    </View>
  );
}

export function MapWithLocation() {
  return (
    <View style={{ flex: 1 }}>
      <MapView initialViewState={{ latitude: 41.3874, longitude: 2.1686, zoom: 12 }}>
        <UserLocation />
        <LocateMe />
      </MapView>
    </View>
  );
}
```

`LocateMe` is rendered inside the `MapView` so it can use `useMap()`, and positioned absolutely so it floats over the canvas.

Related: [User location](../guides/user-location.md).

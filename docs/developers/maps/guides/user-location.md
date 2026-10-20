# User location

`UserLocation` draws Bloom's location puck at the reader's position. `useUserLocation()` asks for the permission and gets a fix, from a tap. Opening a map never shows a permission prompt.

```tsx
import { MapView, UserLocation } from '@goway.to/maps';

<MapView>
  <UserLocation />
</MapView>;
```

## The puck never prompts

`UserLocation` reads the location permission without asking (`getForegroundPermissionsAsync`). If it is already granted, the puck appears and follows the device (balanced accuracy, every 10 m) while the component is mounted. If it is not, nothing is drawn and no dialog appears. `visible={false}` hides it.

Asking is something the reader does on purpose, so it belongs to a control: a "locate me" button.

## Asking from a tap: `useUserLocation`

```tsx
import { useRef } from 'react';
import { MapView, UserLocation, useUserLocation, type MapViewRef } from '@goway.to/maps';
import { Button } from '@oxy.so/bloom/button';

export function MapWithLocateButton() {
  const map = useRef<MapViewRef>(null);
  const location = useUserLocation();

  const locate = async () => {
    const coordinate = await location.locate();
    if (coordinate) map.current?.moveTo({ ...coordinate, zoom: 15 });
  };

  return (
    <>
      <MapView ref={map} style={{ flex: 1 }}>
        <UserLocation />
      </MapView>
      <Button onPress={locate} disabled={location.isLocating}>
        Locate me
      </Button>
      {location.error ? <LocationErrorMessage error={location.error} canAskAgain={location.canAskAgain} /> : null}
    </>
  );
}
```

`locate()` reads the permission, asks if it may, and then gets one fix (with a 12-second limit). It resolves the coordinate, or `null`. Concurrent calls share one prompt and one fix. Once permission is granted this way, every mounted `UserLocation` starts drawing the puck.

The state `useUserLocation()` returns:

| Field | Meaning |
| --- | --- |
| `status` | `unknown` (not asked in this session), `granted` or `denied` |
| `coordinate` | the last fix, for this screen only; never stored anywhere |
| `isLocating` | a `locate()` is in flight |
| `error` | why the last `locate()` gave `null`, or `null` |
| `canAskAgain` | whether calling `locate()` again could still show a prompt |
| `locate()` | ask if needed, then get a fix |
| `forget()` | drop the fix from memory |

`error` separates the cases that need different words:

| `error` | What happened | What helps |
| --- | --- | --- |
| `denied` | the reader declined, or the browser blocks the site | if `canAskAgain` is `false`, only the system or browser setting |
| `unavailable` | permission is fine, but there was no position (services off) | turning location services on |
| `timeout` | no fix within the limit | trying again |
| `insecureContext` | web only: the page is not https, so the browser refuses without asking | serving the app over https |

When `canAskAgain` is `false`, a "try again" button would do nothing; point the reader at the setting instead.

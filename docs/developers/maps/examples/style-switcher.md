# Style switcher

Offer GoWay's styles, and let the reader pin a light or follow the app's theme. Switching styles keeps the camera where it is.

```tsx
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { MapView } from '@goway.to/maps';
import { MAP_LIGHT_PRESETS, MAP_STYLE_CATALOGUE, gowayStyleUrl, type MapLightPreset, type MapStyleId } from '@goway.to/sdk/map';

// Styles whose data is published (an `offer` marks one that is not yet).
const OFFERED = MAP_STYLE_CATALOGUE.filter((entry) => entry.offer === undefined);
import { Button } from '@oxy.so/bloom/button';

export function StyleSwitcher() {
  const [style, setStyle] = useState<MapStyleId>('standard');
  const [light, setLight] = useState<MapLightPreset | undefined>(undefined); // undefined: follow the theme

  return (
    <View style={{ flex: 1 }}>
      <MapView
        mapStyle={gowayStyleUrl(style)}
        lightPreset={light}
        initialViewState={{ latitude: 41.3874, longitude: 2.1686, zoom: 13 }}
      />
      <ScrollView horizontal style={{ position: 'absolute', top: 16, left: 16, right: 16 }}>
        {OFFERED.map((entry) => (
          <Button key={entry.id} onPress={() => setStyle(entry.id)}>
            {entry.id}
          </Button>
        ))}
      </ScrollView>
      <ScrollView horizontal style={{ position: 'absolute', top: 64, left: 16, right: 16 }}>
        <Button onPress={() => setLight(undefined)}>theme</Button>
        {MAP_LIGHT_PRESETS.map((preset) => (
          <Button key={preset} onPress={() => setLight(preset)}>
            {preset}
          </Button>
        ))}
      </ScrollView>
    </View>
  );
}
```

Not every style is published in every light. Asking for one it does not have draws the nearest it does: a fixed-light style (satellite, hybrid, light, dark) always draws its own. `MAP_STYLE_CATALOGUE` from `@goway.to/sdk/map` lists each style's lights. `satellite` and `hybrid` carry `offer: 'development'` (their imagery is not published yet), which is why the picker above leaves entries with an `offer` out.

Related: [Map view](../guides/map-view.md#style-and-theme), [Map styles and tiles](../../styles/README.md).

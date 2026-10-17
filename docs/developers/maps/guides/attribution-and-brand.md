# Attribution and brand

Every map carries two things in its corners: the GoWay mark (bottom-left) and the data credit (bottom-right). There is no prop to turn either off. This page explains how to add your own credits and how to lay your chrome out around both.

## The data credit

The credit always names the sources GoWay's tiles require, `© OpenMapTiles` and `© OpenStreetMap` (`MAP_DATA_CREDITS`), as links. It is spelled out when the map loads and folds into an ⓘ button after five seconds or at the reader's first interaction; pressing ⓘ opens it again. Its toggle is labelled in the Bloom locale.

### Your own credits

Data you draw over the basemap may require its own credit. Pass it in `credits`; it is shown after GoWay's:

```tsx
<MapView credits={[{ label: '© City Open Data', href: 'https://opendata.example.org/licence' }]} />
```

`creditDisclosure` adds a line while something it names is on the map, for example simulated content:

```tsx
<MapView
  creditDisclosure={
    showingSimulation
      ? { text: 'Traffic on this map is simulated.', detail: 'It is not live data.', short: 'Simulated' }
      : null
  }
/>
```

`text` shows while the credit is open, `detail` is read after it by a screen reader, and `short` shows beside the folded ⓘ.

## The GoWay mark

The mark sits at the bottom-left of every map. A surface whose own chrome already shows the GoWay logo (GoWay's own map screen) can declare so with `BrandedChromeProvider`, around the map, and the map's badge stands down. Use it only where the logo really is visible in your chrome.

```tsx
import { BrandedChromeProvider, GowayLogo } from '@goway.to/maps';

<BrandedChromeProvider>
  <Header logo={<GowayLogo width={96} />} />
  <MapView />
</BrandedChromeProvider>;
```

`GowayLogo` draws the mark in your UI: `width` in px (the height follows the artwork, see `gowayLogoHeight(width, variant)`), `variant` `wordmark` (default) or `mark`, and `label` for its accessible name (`GoWay` by default; `''` hides it from assistive technology when it sits beside the name already). `@goway.to/maps/brand` exports the artwork as geometry (see the [brand reference](../api-reference/brand.md)).

## Laying chrome around the corners

Chrome you float over the map's bottom corners has to clear the mark and the credit.

| Constant | Value | Use |
| --- | --- | --- |
| `MAP_BRAND_WIDTH`, `MAP_BRAND_HEIGHT` | the mark's size | layout that sits beside it |
| `MAP_BRAND_CLEARANCE` | `MAP_BRAND_WIDTH + 16` | horizontal room the mark takes from the left edge |
| `MAP_CREDIT_CLEARANCE` | `36` | vertical room the folded or one-line credit takes above the bottom edge |
| `CREDIT_GAP` | `4` | between the credit and the edge below it |

Spelled out on a narrow screen the credit wraps. To keep bottom-right chrome above it however tall it gets, provide a Reanimated shared value through `MapCreditHeightContext`; the credit writes its measured height there, and `creditRise(height)` (a worklet) is how far your chrome must rise:

```tsx
import { useSharedValue, useAnimatedStyle } from 'react-native-reanimated';
import Animated from 'react-native-reanimated';
import { MAP_CREDIT_CLEARANCE, MapCreditHeightContext, MapView, creditRise } from '@goway.to/maps';

function MapScreen() {
  const creditHeight = useSharedValue(0);
  const raised = useAnimatedStyle(() => ({
    transform: [{ translateY: -creditRise(creditHeight.value) }],
  }));
  return (
    <MapCreditHeightContext.Provider value={creditHeight}>
      <MapView style={{ flex: 1 }} />
      <Animated.View style={[{ position: 'absolute', right: 16, bottom: MAP_CREDIT_CLEARANCE }, raised]}>
        <LocateButton />
      </Animated.View>
    </MapCreditHeightContext.Provider>
  );
}
```

`useMapCreditHeight()` reads the same shared value inside the provider.

A screen with a bottom sheet over the map can keep the credit above the sheet's current edge by providing a `MapChromeLift` through `MapChromeLiftContext`: `lift` (px to translate up) and `opacity` as shared values, and `rightClearance` (px the screen keeps at the bottom-right for its own controls). `useMapChromeLift()` reads it.

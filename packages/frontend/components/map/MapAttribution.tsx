/**
 * Map data credit — GoWay-owned, identical on web and native.
 *
 * Both engines ship an attribution ornament of their own (maplibre-gl's
 * `AttributionControl`, MapLibre Native's "i" button), and both derive their
 * text from an `attribution` field on the style's sources. The OpenFreeMap
 * style documents do not set one, so both would render an EMPTY credit — the
 * failure mode where the obligation looks satisfied and is not.
 *
 * So the canvas renders this instead, from `lib/map/provider.ts`, and disables
 * the engines' own ornaments. Two other things fall out of that: the credit
 * sits inside GoWay's layout (so floating chrome can be positioned against it
 * rather than around an engine-owned box), and it looks the same on both
 * platforms.
 *
 * Rendered by `MapCanvas` itself, never by feature code — attribution must not
 * be something a screen can forget.
 *
 * It also POSITIONS itself, for the same reason. A credit pinned 4px off the
 * window edge disappears the moment anything parks at that edge — a persistent
 * half-sheet, a tab bar — and it disappears silently, which for a licence
 * obligation is the worst way to fail. Reading Bloom's bottom-edge registry
 * here means the credit rises above whatever is claimed without the claimant
 * and the credit knowing about each other, and without a screen being able to
 * get the geometry wrong.
 *
 * ## Why it is on the RIGHT now
 *
 * Because `MapBrand` took the left corner, and the layout is Google's for the
 * same reason Google's is: brand in one bottom corner, data credit in the
 * other. Two things follow that are worth stating, because the obvious
 * alternatives are both wrong:
 *
 *  - The credit was MOVED, not shrunk, folded into the logo or dropped. It is
 *    an OSM/OpenMapTiles licence obligation and it is still a full-size,
 *    tappable line of links at the same distance from the edge as before.
 *  - It is not free to sit wherever is left over. A wrapped credit on a narrow
 *    phone would run straight under the mark, so this reads
 *    {@link MAP_BRAND_CLEARANCE} and starts after it — the same pattern as the
 *    bottom-edge inset, one owner for each piece of geometry, no component
 *    holding a private copy of another's size.
 *
 * The positioning box spans that clearance to the right edge and the plate is
 * a child of it, so the card hugs the text instead of stretching across the
 * map.
 */
import { memo, useCallback } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';

import { resolveMapAttribution } from '@/lib/map/provider';
import { MAP_BRAND_CLEARANCE } from './MapBrand';

/** Breathing room between the credit and whatever is below it. */
const ATTRIBUTION_GAP = 4;

function MapAttributionComponent() {
  const attribution = resolveMapAttribution();
  const bottomEdge = useBottomEdgeInset();

  const open = useCallback((href: string) => {
    void Linking.openURL(href).catch(() => {
      // An unopenable credit link must never take the map down with it.
    });
  }, []);

  return (
    <View
      pointerEvents="box-none"
      className="absolute right-space-8 items-end"
      style={{
        // A claim already folds in the safe area of the surface holding the
        // edge, so the plain gap is added to it rather than the safe-area-aware
        // one.
        bottom: bottomEdge > 0 ? bottomEdge + ATTRIBUTION_GAP : ATTRIBUTION_GAP,
        // Never overlap the mark in the other corner, however the text wraps.
        left: MAP_BRAND_CLEARANCE,
      }}
    >
      <View className="flex-row flex-wrap items-center justify-end gap-space-4 rounded-radius-8 bg-card/80 px-space-8 py-space-2">
        {attribution.prefix ? (
          <Text className="text-caption text-muted-foreground">
            {attribution.prefix}
          </Text>
        ) : null}
        {attribution.links.map((link) => (
          <Pressable
            key={link.href}
            accessibilityRole="link"
            accessibilityLabel={link.label}
            onPress={() => open(link.href)}
            hitSlop={6}
          >
            <Text className="text-caption text-muted-foreground underline">
              {link.label}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

export const MapAttribution = memo(MapAttributionComponent);

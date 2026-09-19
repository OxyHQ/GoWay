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
 */
import { memo, useCallback } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { Text } from '@oxy.so/bloom/typography';

import { resolveMapAttribution } from '@/lib/map/provider';

function MapAttributionComponent() {
  const attribution = resolveMapAttribution();

  const open = useCallback((href: string) => {
    void Linking.openURL(href).catch(() => {
      // An unopenable credit link must never take the map down with it.
    });
  }, []);

  return (
    <View
      pointerEvents="box-none"
      className="flex-row flex-wrap items-center gap-space-4 rounded-radius-8 bg-card/80 px-space-8 py-space-2"
    >
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
  );
}

export const MapAttribution = memo(MapAttributionComponent);

/**
 * The map's style picker — Apple's "Choose Map" card and Google's layers
 * sheet, GoWay's way (`docs/MAP_STYLES.md` → The picker).
 *
 * A Bloom `Dialog`: a bottom sheet on a phone, a card on a wide window. In it,
 *
 *  1. **Style** — one tile per published style, each a THUMBNAIL rendered from
 *     that style's own document by the real renderer
 *     (`scripts/build-map-thumbs.ts`), never a drawing of one, in the light
 *     the map is drawn in now;
 *  2. **Light** — the app's theme, the real sun, or always day or night
 *     (a style with a fixed light says so instead);
 *  3. **Map details** — the registry's own switches for what a picker like
 *     this one carries (the 3D city, terrain, simulated traffic, live
 *     transit where offered), read and written through the map-feature store
 *     exactly as Settings writes them.
 *
 * Every choice applies at once, on the map behind the sheet, and is kept on
 * this device (`mapFeatureStore`). It ships in the settings modal's lazy chunk
 * (re-exported by `MapSettingsModal.tsx`): one chunk for the map's panels, so
 * the feature labels they share are never hoisted to first paint.
 */
import { Image, Pressable, useWindowDimensions, View } from 'react-native';
import { type Labels, localizedLabel } from '@goway.to/sdk';
import { Dialog } from '@oxy.so/bloom/dialog';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback } from 'react';

import { useTranslation } from '@/lib/i18n';
import { MAP_FEATURE_LABELS } from '@/lib/map/mapFeatureLabels';
import type { MapFeatureId } from '@/lib/map/mapFeatures';
import { MAP_LIGHT_MODE_LABELS, MAP_STYLE_COPY, MAP_STYLE_LABELS } from '@/lib/map/mapStyleLabels';
import { resolveMapStyleThumbnailUrl } from '@/lib/map/provider';
import {
  MAP_LIGHT_MODES,
  MAP_STYLES,
  isMapStyleOffered,
  type MapLightMode,
  type MapStyleDefinition,
  resolveMapStyle,
} from '@/lib/map/style/catalogue';
import { mapFeatureStore, useMapFeatures } from '@/lib/map/useMapFeatures';

/** The registry features a layers picker carries, in the order it lists them. */
export const PICKER_FEATURES: readonly MapFeatureId[] = ['city3d', 'terrain', 'cityLife', 'live'];

export interface MapStylePickerProps {
  open: boolean;
  onClose: () => void;
}

export function MapStylePicker({ open, onClose }: MapStylePickerProps) {
  const { locale } = useTranslation();
  const say = useCallback((labels: Labels) => localizedLabel(labels, locale), [locale]);
  const { features, labs, style, light } = useMapFeatures();
  const themeDark = useTheme().isDark;
  const { width } = useWindowDimensions();
  const columns = width < 640 ? 2 : 4;
  // A style whose data is not published yet (imagery) is offered in a
  // development build only (`MapStyleDefinition.offer`).
  const offered = MAP_STYLES.filter((entry) => isMapStyleOffered(entry.id, __DEV__));
  const current = offered.find((entry) => entry.id === style) ?? offered[0];
  // The tiles show the light the map is drawn in: night thumbnails on a dark
  // map, day ones otherwise. The sun's dawn and dusk show as day.
  const darkNow = light === 'night' || (light !== 'day' && themeDark);
  const details = PICKER_FEATURES.map((id) => features.get(id)).filter(
    (state) => state.available && (state.tier === 'stable' || labs),
  );

  return (
    <Dialog
      open={open}
      onClose={onClose}
      placement={{ base: 'bottom', md: 'center' }}
      maxWidth={600}
      title={say(MAP_STYLE_COPY.title)}
      label={say(MAP_STYLE_COPY.title)}
      testID="map-style-picker"
    >
      <View className="gap-space-20">
        <View className="gap-space-8">
          <Text className="text-caption text-muted-foreground">{say(MAP_STYLE_COPY.style)}</Text>
          <View accessibilityRole="radiogroup" className="flex-row flex-wrap gap-space-12">
            {offered.map((entry) => (
              <StyleTile
                key={entry.id}
                entry={entry}
                selected={entry.id === style}
                dark={darkNow}
                columns={columns}
                say={say}
              />
            ))}
          </View>
          <Text className="text-caption text-muted-foreground">
            {say(MAP_STYLE_LABELS[current.id].description)}
          </Text>
        </View>

        <View className="gap-space-8">
          <Text className="text-caption text-muted-foreground">{say(MAP_STYLE_COPY.light)}</Text>
          <SegmentedControl<MapLightMode>
            type="radio"
            size="sm"
            value={light}
            disabled={current.light === 'fixed'}
            onValueChange={(mode) => mapFeatureStore.setLight(mode)}
            label={say(MAP_STYLE_COPY.light)}
          >
            {MAP_LIGHT_MODES.map((mode) => (
              <SegmentedControlItem key={mode} value={mode} testID={`map-style-light-${mode}`}>
                <SegmentedControlItemText>
                  {say(MAP_LIGHT_MODE_LABELS[mode])}
                </SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
          <Text className="text-caption text-muted-foreground">
            {say(current.light === 'fixed' ? MAP_STYLE_COPY.fixedLight : MAP_STYLE_COPY.lightHint)}
          </Text>
        </View>

        {details.length > 0 ? (
          <View className="gap-space-4">
            <Text className="text-caption text-muted-foreground">
              {say(MAP_STYLE_COPY.details)}
            </Text>
            {details.map((state) => {
              const name = say(MAP_FEATURE_LABELS[state.id as MapFeatureId].name);
              return (
                <View
                  key={state.id}
                  className="min-h-11 flex-row items-center justify-between gap-space-12"
                  testID={`map-style-detail-${state.id}`}
                >
                  <Text className="flex-1 text-body text-foreground">{name}</Text>
                  <Switch
                    checked={state.on}
                    disabled={state.blockedBy.length > 0 || state.source === 'page'}
                    onCheckedChange={(on) => mapFeatureStore.setChoice(state.id, on)}
                    accessibilityLabel={name}
                  />
                </View>
              );
            })}
          </View>
        ) : null}
      </View>
    </Dialog>
  );
}

function StyleTile({
  entry,
  selected,
  dark,
  columns,
  say,
}: {
  entry: MapStyleDefinition;
  selected: boolean;
  dark: boolean;
  columns: number;
  say: (labels: Labels) => string;
}) {
  const preview = resolveMapStyle(entry.id, dark ? 'night' : 'day');
  const name = say(MAP_STYLE_LABELS[entry.id].name);
  // Two tiles a row on a phone, four on a wide window; 4% a tile is left for
  // the 12 px gaps, which a percentage cannot name.
  const basis = `${(100 - columns * 4) / columns}%` as const;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ checked: selected }}
      accessibilityLabel={name}
      onPress={() => mapFeatureStore.setStyle(entry.id)}
      className="gap-space-4"
      style={{ width: basis }}
      testID={`map-style-${entry.id}`}
    >
      <View
        className={`overflow-hidden rounded-radius-12 border-2 ${selected ? 'border-primary' : 'border-transparent'}`}
      >
        <Image
          source={{ uri: resolveMapStyleThumbnailUrl(preview) }}
          accessibilityIgnoresInvertColors
          style={{ width: '100%', aspectRatio: 3 / 2 }}
          resizeMode="cover"
        />
      </View>
      <Text
        className={`text-center text-caption ${selected ? 'text-primary' : 'text-foreground'}`}
        numberOfLines={1}
      >
        {name}
      </Text>
    </Pressable>
  );
}

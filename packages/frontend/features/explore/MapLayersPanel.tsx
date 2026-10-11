/**
 * The body of the layers panel (`MapLayersButton.tsx`), loaded on first open.
 *
 * Three parts, top to bottom:
 *
 *  - **Map view**, 2D or 3D: the camera, not a feature — 3D tilts it so the
 *    buildings and the terrain stand up, 2D levels it. It follows the map, so
 *    tilting with a gesture moves the control too.
 *  - **Layers**: the registry's `stable` features this build carries and this
 *    platform draws.
 *  - **Labs**, once revealed: the `labs` features, each with what it shows, and
 *    the warning that they may be slow.
 *
 * Every switch writes the person's choice through the map-feature store and
 * nothing else; the map reads the store and applies the change itself — live
 * where it can, by redrawing the map where it cannot (`docs/MAP_FEATURES.md`).
 * Nothing here leaves the device.
 */
import { useCallback } from 'react';
import { ScrollView, useWindowDimensions, View } from 'react-native';
import { useRouter } from 'expo-router';
import { type Labels, localizedLabel } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { PopoverHeader, PopoverSeparator, PopoverTitle } from '@oxy.so/bloom/popover';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { Switch } from '@oxy.so/bloom/switch';
import { Text } from '@oxy.so/bloom/typography';
import { RiFlaskLine } from '@oxy.so/bloom/icons/RiFlaskLine';
import { useTheme } from '@oxy.so/bloom/theme';

import { formatMessage, useTranslation } from '@/lib/i18n';
import { MAP_FEATURE_LABELS, MAP_LAYERS_COPY } from '@/lib/map/mapFeatureLabels';
import type { MapFeatureId, MapFeatureState } from '@/lib/map/mapFeatures';
import { mapFeatureStore, useMapFeatures } from '@/lib/map/useMapFeatures';

export interface MapLayersPanelProps {
  tilted: boolean;
  onTiltChange: (tilted: boolean) => void;
  /** Close the panel — before navigating away from the map. */
  onClose: () => void;
}

type ViewMode = '2d' | '3d';

/**
 * Room the panel leaves on screen around itself: the top bar and the button it
 * hangs from above it, a margin below. Past that the panel scrolls rather than
 * running off the window — Labs alone is taller than a phone.
 */
const PANEL_CHROME_PX = 180;
const PANEL_MIN_HEIGHT_PX = 240;

export function MapLayersPanel({ tilted, onTiltChange, onClose }: MapLayersPanelProps) {
  const { locale } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { features, labs } = useMapFeatures();
  const { height } = useWindowDimensions();
  const maxHeight = Math.max(PANEL_MIN_HEIGHT_PX, height - PANEL_CHROME_PX);
  const say = useCallback((labels: Labels) => localizedLabel(labels, locale), [locale]);

  const offered = features.list.filter((state) => state.available);
  const stable = offered.filter((state) => state.tier === 'stable');
  const experimental = offered.filter((state) => state.tier === 'labs');
  const studio = features.on('flyover');

  const openStudio = useCallback(() => {
    onClose();
    router.push('/studio');
  }, [onClose, router]);

  return (
    <ScrollView style={{ maxHeight }} contentContainerClassName="gap-space-12">
      <PopoverHeader>
        <PopoverTitle>{say(MAP_LAYERS_COPY.title)}</PopoverTitle>
      </PopoverHeader>

      <SegmentedControl<ViewMode>
        type="radio"
        label={say(MAP_LAYERS_COPY.view)}
        value={tilted ? '3d' : '2d'}
        onValueChange={(mode) => onTiltChange(mode === '3d')}
        testID="map-layers-view"
      >
        <SegmentedControlItem
          value="2d"
          accessibilityHint={say(MAP_LAYERS_COPY.flatHint)}
          testID="map-layers-view-2d"
        >
          <SegmentedControlItemText>{say(MAP_LAYERS_COPY.flat)}</SegmentedControlItemText>
        </SegmentedControlItem>
        <SegmentedControlItem
          value="3d"
          accessibilityHint={say(MAP_LAYERS_COPY.tiltedHint)}
          testID="map-layers-view-3d"
        >
          <SegmentedControlItemText>{say(MAP_LAYERS_COPY.tilted)}</SegmentedControlItemText>
        </SegmentedControlItem>
      </SegmentedControl>

      {stable.length > 0 ? (
        <View accessibilityRole="list" accessibilityLabel={say(MAP_LAYERS_COPY.layers)}>
          <PopoverTitle tone="secondary">{say(MAP_LAYERS_COPY.layers)}</PopoverTitle>
          {stable.map((state) => (
            <FeatureRow key={state.id} state={state} say={say} />
          ))}
        </View>
      ) : null}

      {labs && experimental.length > 0 ? (
        <>
          <PopoverSeparator />
          <View
            accessibilityRole="list"
            accessibilityLabel={say(MAP_LAYERS_COPY.labs)}
            testID="map-layers-labs"
          >
            <View className="flex-row items-center gap-space-8">
              <RiFlaskLine width={16} height={16} fill={theme.colors.textSecondary} />
              <PopoverTitle tone="secondary">{say(MAP_LAYERS_COPY.labs)}</PopoverTitle>
            </View>
            <Text className="text-caption text-muted-foreground">
              {say(MAP_LAYERS_COPY.labsHint)}
            </Text>
            {experimental.map((state) => (
              <FeatureRow key={state.id} state={state} say={say} />
            ))}
            <View className="flex-row flex-wrap items-center gap-space-8 pt-space-4">
              {studio ? (
                <Button size="sm" appearance="outline" onPress={openStudio}>
                  {say(MAP_LAYERS_COPY.studio)}
                </Button>
              ) : null}
              <Button
                size="sm"
                appearance="plain"
                tone="neutral"
                onPress={() => mapFeatureStore.setLabs(false)}
                testID="map-layers-hide-labs"
              >
                {say(MAP_LAYERS_COPY.hideLabs)}
              </Button>
            </View>
          </View>
        </>
      ) : null}
    </ScrollView>
  );
}

function FeatureRow({ state, say }: { state: MapFeatureState; say: (labels: Labels) => string }) {
  const labels = MAP_FEATURE_LABELS[state.id as MapFeatureId];
  const name = say(labels.name);
  const blocked = state.blockedBy.length > 0;
  const fromPage = state.source === 'page';
  const note = blocked
    ? formatMessage(say(MAP_LAYERS_COPY.requires), {
        feature: state.blockedBy
          .map((id) => say(MAP_FEATURE_LABELS[id as MapFeatureId].name))
          .join(', '),
      })
    : fromPage
      ? say(MAP_LAYERS_COPY.setByPage)
      : null;

  return (
    <View
      accessibilityRole="none"
      className="flex-row items-center gap-space-12 py-space-8"
      testID={`map-layers-feature-${state.id}`}
    >
      <View className="flex-1 gap-space-2">
        <Text className="text-body text-foreground">{name}</Text>
        <Text className="text-bodySmall text-muted-foreground">{say(labels.description)}</Text>
        {note ? <Text className="text-caption text-muted-foreground">{note}</Text> : null}
      </View>
      <Switch
        checked={state.on}
        disabled={blocked || fromPage}
        onCheckedChange={(on) => mapFeatureStore.setChoice(state.id, on)}
        accessibilityLabel={name}
        testID={`map-layers-switch-${state.id}`}
      />
    </View>
  );
}

/**
 * The map chip for a published Street 3D scene: its poster, and "3D".
 *
 * The poster is the same image the viewer opens on, so tapping the chip reads
 * as the picture growing into the scene rather than as a page change. A scene
 * with approximate placement says so in its label — the contract forbids
 * presenting it as exactly placed, and the chip is the first presentation.
 */
import { memo } from 'react';
import { Pressable, View } from 'react-native';
import { Image } from 'expo-image';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiBox3Line } from '@oxy.so/bloom/icons/RiBox3Line';
import type { StreetSceneSummary } from '@goway.to/sdk';

export interface SceneChipProps {
  summary: StreetSceneSummary | undefined;
  accessibilityLabel: string;
  onPress: () => void;
}

const THUMB = 36;

function SceneChipComponent({ summary, accessibilityLabel, onPress }: SceneChipProps) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className="flex-row items-center gap-space-4 rounded-radius-max bg-card py-space-2 pl-space-2 pr-space-8 shadow-m active:opacity-80"
    >
      <View className="items-center justify-center overflow-hidden rounded-radius-max bg-muted" style={{ width: THUMB, height: THUMB }}>
        {summary?.posterUrl ? (
          <Image source={{ uri: summary.posterUrl }} style={{ width: THUMB, height: THUMB }} contentFit="cover" />
        ) : (
          <RiBox3Line width={18} height={18} fill={theme.colors.textSecondary} />
        )}
      </View>
      <Text className="text-caption text-foreground">3D</Text>
    </Pressable>
  );
}

export const SceneChip = memo(SceneChipComponent);

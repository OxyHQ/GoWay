/**
 * A camera's pin on the map. An offline camera is drawn dimmer: the pin is a
 * promise of a picture, and one that is not coming should not look like one
 * that is.
 */
import { memo } from 'react';
import { Pressable } from 'react-native';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiCameraLine } from '@oxy.so/bloom/icons/RiCameraLine';
import type { CameraStatus } from '@goway.to/sdk';

export interface CameraMarkerProps {
  status: CameraStatus | undefined;
  accessibilityLabel: string;
  onPress: () => void;
}

const SIZE = 32;

function CameraMarkerComponent({ status, accessibilityLabel, onPress }: CameraMarkerProps) {
  const theme = useTheme();
  const dim = status === 'offline';
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      className="items-center justify-center rounded-radius-max bg-card shadow-m active:opacity-80"
      style={{ width: SIZE, height: SIZE, opacity: dim ? 0.55 : 1 }}
    >
      <RiCameraLine
        width={18}
        height={18}
        fill={status === 'live' ? theme.colors.primary : theme.colors.textSecondary}
      />
    </Pressable>
  );
}

export const CameraMarker = memo(CameraMarkerComponent);

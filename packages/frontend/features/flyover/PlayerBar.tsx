/**
 * Transport controls for a camera playback: skip back, play/pause, skip
 * forward, a seek bar, and a close. Shared by the route flyover and Camera
 * Studio's preview, on web and native — it is Bloom's media controls, because
 * a flyover IS media: a timeline with a play button.
 *
 * It CLAIMS the bottom edge with its measured height, so the map's credit and
 * mark (`MapAttribution`, `MapBrand`) rise above it instead of being covered —
 * the same mechanism `MapSheet` uses, and the reason the attribution is never
 * something a new overlay can hide.
 */
import { type ReactNode, useState } from 'react';
import { View } from 'react-native';
import { GlyphButton } from '@oxy.so/bloom/button';
import { useClaimBottomEdge, windowEdgeGap } from '@oxy.so/bloom/layout';
import { PlayButton, PlaybackProgress } from '@oxy.so/bloom/media-controls';
import { Text } from '@oxy.so/bloom/typography';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiSkipBackFill } from '@oxy.so/bloom/icons/RiSkipBackFill';
import { RiSkipForwardFill } from '@oxy.so/bloom/icons/RiSkipForwardFill';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import type { CameraPlayer } from './useCameraPlayer';

export interface PlayerBarProps {
  player: CameraPlayer;
  /** What is playing, for the play button's name ("Play the route flyover"). */
  subject: string;
  /** A line above the controls (distance flown, a reduced-motion note). */
  caption?: string;
  /** Extra controls on the right (Camera Studio's export). */
  trailing?: ReactNode;
  onClose: () => void;
  closeLabel: string;
  testID?: string;
}

export function PlayerBar({
  player,
  subject,
  caption,
  trailing,
  onClose,
  closeLabel,
  testID,
}: PlayerBarProps) {
  const insets = useSafeAreaInsets();
  const [height, setHeight] = useState(0);
  const bottom = windowEdgeGap(insets.bottom);
  useClaimBottomEdge(height > 0 ? height + bottom : 0);

  return (
    <View
      pointerEvents="box-none"
      className="absolute left-0 right-0 items-center px-space-12"
      style={{ bottom }}
      testID={testID}
    >
      <View
        onLayout={(event) => setHeight(Math.round(event.nativeEvent.layout.height))}
        className="w-full max-w-[640px] gap-space-4 rounded-radius-16 bg-card px-space-12 py-space-8 shadow-m"
      >
        {caption ? (
          <Text className="text-caption text-muted-foreground" numberOfLines={1}>
            {caption}
          </Text>
        ) : null}
        <View className="flex-row items-center gap-space-8">
          <GlyphButton
            icon={RiSkipBackFill}
            size={36}
            onPress={() => player.skip(-1)}
            accessibilityLabel="Previous turn"
          />
          <PlayButton
            playing={player.playing}
            onPress={player.toggle}
            size="sm"
            subject={subject}
            testID={testID ? `${testID}-play` : undefined}
          />
          <GlyphButton
            icon={RiSkipForwardFill}
            size={36}
            onPress={() => player.skip(1)}
            accessibilityLabel="Next turn"
          />
          <View className="flex-1">
            <PlaybackProgress
              value={player.timeMs / 1000}
              duration={player.durationMs / 1000}
              onSeek={(seconds) => player.seek(seconds * 1000)}
              onSeekPreview={(seconds) => player.seek(seconds * 1000)}
              showTimes
              accessibilityLabel={`Seek ${subject}`}
            />
          </View>
          {trailing}
          <GlyphButton
            icon={RiCloseLine}
            size={36}
            onPress={onClose}
            accessibilityLabel={closeLabel}
          />
        </View>
      </View>
    </View>
  );
}

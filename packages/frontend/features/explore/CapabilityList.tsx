/**
 * Ecosystem capabilities, rendered so provenance survives the trip to the eye.
 *
 * The rule from issue #7 → Accessibility — "do not make color the only
 * indicator of an ecosystem capability or status" — is enforced structurally
 * here rather than by discipline: every row draws a GLYPH, a LABEL and a
 * PROVENANCE SENTENCE, and the tint is the last thing added. Remove the colour
 * entirely and the row still says "Accepts FairCoin · Verified by Oxy ·
 * Checked 9 days ago".
 *
 * A stale claim is demoted by `presentCapability`, and the row shows its age in
 * words. A two-year-old community report and a verification from last week must
 * not be the same pill, which is the whole reason `PlaceCapability` carries
 * `verification` and `observedAt` in the first place.
 *
 * Rows are grouped as the capability registry groups them — accessibility,
 * payment, amenities, food, price, social, brand, the Oxy ecosystem — so a
 * place that knows twenty things reads as a few short sections rather than a
 * wall of pills. A group the place says nothing about renders nothing.
 */
import { useCallback } from 'react';
import { Pressable, View } from 'react-native';
import type { PlaceCapability } from '@goway.to/sdk';
import * as WebBrowser from 'expo-web-browser';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';

import {
  groupedCapabilities,
  type CapabilityPresentation,
  type CapabilityTone,
} from '@/lib/goway/capabilities';

export interface CapabilityListProps {
  capabilities: readonly PlaceCapability[];
  testID?: string;
}

/**
 * The tint pairs, taken from Bloom's status families.
 *
 * Each `*Subtle` ships with the `*SubtleForeground` that is legible on it —
 * the pair the colour policy generates together. Appending hex alpha to a fill
 * instead (`${colors.primary}18`) produces a malformed string that
 * react-native-web reads back as fully OPAQUE, painting the label on its own
 * colour at contrast 1.00.
 */
function toneColors(tone: CapabilityTone, colors: ReturnType<typeof useTheme>['colors']) {
  switch (tone) {
    case 'verified':
      return { background: colors.successSubtle, foreground: colors.successSubtleForeground };
    case 'info':
      return { background: colors.infoSubtle, foreground: colors.infoSubtleForeground };
    default:
      return { background: colors.backgroundSecondary, foreground: colors.textSecondary };
  }
}

function CapabilityRow({ presented }: { presented: CapabilityPresentation }) {
  const theme = useTheme();
  const paint = toneColors(presented.tone, theme.colors);
  const Icon = presented.icon;
  const provenance = presented.freshness
    ? `${presented.provenance} · ${presented.freshness}`
    : presented.provenance;
  const open = useCallback(() => {
    if (presented.href) void WebBrowser.openBrowserAsync(presented.href);
  }, [presented.href]);

  const body = (
    <View
      accessibilityLabel={`${presented.label}${presented.value ? `: ${presented.value}` : ''}. ${provenance}.${presented.stale ? ' This report may be out of date.' : ''}`}
      className="flex-row items-start gap-space-8 rounded-radius-12 px-space-12 py-space-8"
      style={{ backgroundColor: paint.background }}
    >
      <View className="pt-space-2">
        <Icon width={16} height={16} fill={paint.foreground} />
      </View>
      <View className="flex-1">
        <Text className="text-bodySmall" style={{ color: paint.foreground }}>
          {presented.value ? `${presented.label} · ${presented.value}` : presented.label}
        </Text>
        <Text className="text-caption text-muted-foreground">{provenance}</Text>
        {presented.stale ? (
          <Text className="text-caption text-muted-foreground">
            Old enough that it may no longer be true — worth checking.
          </Text>
        ) : null}
      </View>
    </View>
  );

  return presented.href ? (
    <Pressable accessibilityRole="link" onPress={open}>
      {body}
    </Pressable>
  ) : (
    <View accessibilityRole="text">{body}</View>
  );
}

export function CapabilityList({ capabilities, testID }: CapabilityListProps) {
  const groups = groupedCapabilities(capabilities);

  // Absent is absent. A place nobody has asked about renders no section at all
  // rather than an empty heading.
  if (groups.length === 0) return null;

  return (
    <View className="gap-space-12" testID={testID}>
      {groups.map((group) => (
        <View key={group.group} className="gap-space-8">
          <Text className="text-caption text-muted-foreground">{group.label}</Text>
          {group.items.map((presented) => (
            <CapabilityRow key={presented.key} presented={presented} />
          ))}
        </View>
      ))}
    </View>
  );
}

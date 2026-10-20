/**
 * The guided-navigation banner: what to do next, how far to it, and the
 * leaving control — Bloom's `NavigationBanner` over GoWay's route steps.
 *
 * The maneuver vocabulary is the same one the step list draws
 * (`ManeuverList` → `maneuverOf`), so the banner and the list cannot name a
 * turn two ways.
 */
import { View } from 'react-native';
import { Button } from '@oxy.so/bloom/button';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { NavigationBanner, type NavigationBannerState } from '@oxy.so/bloom/navigation-banner';

import { formatDistance } from '@/lib/goway/format';

import type { Guidance } from './guidance';
import { maneuverOf } from './ManeuverList';

export interface GuidanceBannerProps {
  guidance: Guidance;
  state: NavigationBannerState;
  onEnd: () => void;
  testID?: string;
}

export function GuidanceBanner({ guidance, state, onEnd, testID }: GuidanceBannerProps) {
  const { next, then, distanceToNext, arrived } = guidance;
  return (
    <View className="gap-space-8" testID={testID}>
      <NavigationBanner
        state={state}
        maneuver={maneuverOf(next.maneuver.type)}
        // The figure counts down to the turn; at the end there is nothing to count.
        distance={arrived ? undefined : formatDistance(distanceToNext)}
        instruction={next.maneuver.instruction}
        thenManeuver={then ? maneuverOf(then.maneuver.type) : undefined}
        then={then?.maneuver.streetName ?? then?.maneuver.instruction}
        testID="guidance-banner"
      />
      <View className="flex-row">
        <Button
          size="sm"
          leadingIcon={RiCloseLine}
          onPress={onEnd}
          accessibilityLabel="Stop guidance"
          tone="neutral"
          appearance="outline"
        >
          {arrived ? 'Done' : 'Stop'}
        </Button>
      </View>
    </View>
  );
}

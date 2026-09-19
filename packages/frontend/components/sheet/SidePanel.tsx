/**
 * The desktop counterpart to `MapSheet`: a fixed column beside the map.
 *
 * Issue #7 is explicit that a wide window should get "map + side panel/search
 * results layout where there is room, rather than stretching a mobile bottom
 * sheet across desktop", so this is a genuinely different STRUCTURE — not the
 * sheet with a media query. It shares everything that matters (the search
 * field, the result rows, the place details, the states) because those are
 * components; only the container differs.
 *
 * It deliberately has no gestures. A panel that could be dragged to three
 * detents with a mouse would be a phone affordance wearing a desktop costume;
 * a pointer user resizes a window instead.
 *
 * It READS the top edge rather than claiming it, so it sits under whatever
 * chrome the screen has parked there, and it claims nothing at the bottom
 * because it is not on that edge.
 */
import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ScreenScope, useTopEdgeInset, windowEdgeGap } from '@oxy.so/bloom/layout';

import { PANEL_WIDTH } from '@/lib/useLayoutMode';

export interface SidePanelProps {
  /** Sticky chrome at the top of the column (the search field). */
  header?: ReactNode;
  children: ReactNode;
  /** `false` when the content owns its own scrolling (a `VirtualList`). */
  scrollable?: boolean;
  accessibilityLabel?: string;
  testID?: string;
}

export function SidePanel({
  header,
  children,
  scrollable = true,
  accessibilityLabel = 'Results',
  testID,
}: SidePanelProps) {
  const insets = useSafeAreaInsets();
  const topEdge = useTopEdgeInset();

  const sideGap = windowEdgeGap(insets.left, 0);
  const bottomGap = windowEdgeGap(insets.bottom);
  // `useTopEdgeInset()` already folds in the safe area of whatever is parked up
  // there, so the plain gap is added to it rather than the safe-area-aware one.
  const top = topEdge > 0 ? topEdge + windowEdgeGap(0) : windowEdgeGap(insets.top);

  return (
    <View
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      className="absolute overflow-hidden rounded-radius-24 bg-card shadow-m"
      style={{ top, bottom: bottomGap, left: sideGap, width: PANEL_WIDTH }}
    >
      <ScreenScope>
        {header}
        {scrollable ? (
          <ScrollView
            style={{ flex: 1 }}
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ paddingBottom: 16 }}
          >
            {children}
          </ScrollView>
        ) : (
          <View className="flex-1">{children}</View>
        )}
      </ScreenScope>
    </View>
  );
}

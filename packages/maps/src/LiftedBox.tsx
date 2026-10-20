/**
 * The positioning box for the map's corner chrome: laid out against Bloom's
 * bottom edge, and — when the screen hands down a live lift — riding the
 * sheet's current top edge on the UI thread. Absent a lift it is the plain
 * box. The data credit (right) and the scale bar (left) both sit in one.
 */
import type { ReactNode } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';

import type { MapChromeLift } from './chromeLift';

export type LiftedBoxSide = 'left' | 'right';

export function LiftedBox({
  lift,
  side,
  style,
  children,
}: {
  lift: MapChromeLift | null;
  side: LiftedBoxSide;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const box = side === 'left' ? styles.left : styles.right;
  if (!lift) {
    return (
      <View pointerEvents="box-none" style={[box, style]}>
        {children}
      </View>
    );
  }
  return (
    <AnimatedLift lift={lift} box={box} style={style}>
      {children}
    </AnimatedLift>
  );
}

function AnimatedLift({
  lift,
  box,
  style,
  children,
}: {
  lift: MapChromeLift;
  box: ViewStyle;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const { lift: rise, opacity } = lift;
  const animated = useAnimatedStyle(
    () => ({ transform: [{ translateY: -rise.value }], opacity: opacity.value }),
    [rise, opacity],
  );
  return (
    <Animated.View pointerEvents="box-none" style={[box, style, animated]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  right: { position: 'absolute', right: 8, alignItems: 'flex-end' },
  left: { position: 'absolute', left: 8, alignItems: 'flex-start' },
});

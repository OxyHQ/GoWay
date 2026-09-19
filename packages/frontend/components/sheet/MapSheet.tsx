/**
 * A persistent, NON-MODAL bottom sheet — the half-sheet a map product needs and
 * Bloom's `BottomSheet` deliberately is not.
 *
 * ## Why this exists beside Bloom's sheet
 *
 * `@oxy.so/bloom/bottom-sheet` is MODAL by construction: on native it renders
 * inside a React Native `<Modal>` with a full-screen backdrop and no
 * `pointerEvents="box-none"`, so while it is open the map underneath cannot be
 * panned. That is exactly right for a modal flow — filters, route options,
 * share — and exactly wrong for the Apple/Google-Maps-style sheet that must sit
 * over a map the user is still dragging. GoWay uses Bloom's sheet for the
 * former; this one is a SIBLING of the canvas, not a layer over the screen.
 *
 * Nothing about its appearance is re-invented: the card is `bg-card`,
 * `rounded-t-radius-24` and `shadow-m`, and the grab handle is Bloom's own 36×5
 * pill. Only the *presentation model* differs.
 *
 * ## The gesture contract
 *
 * Two props are mirrored from Bloom's sheet on purpose, because they are the
 * two that decide whether a sheet fights the surfaces around it:
 *
 *  - **`manualActivation`** — the BODY pan uses RNGH's manual activation and
 *    only takes the gesture when the inner scroller is at its top AND the
 *    finger has moved more than {@link ACTIVATION_SLOP} dp in a direction the
 *    sheet can honour. Until then the pan stays idle and the list scrolls
 *    normally. The DRAG HANDLE gets its own unconditional pan, so it is always
 *    grabbable even mid-scroll. Without this the sheet either steals every
 *    vertical flick from the list or never responds to one.
 *  - **`animatedProgress`** — a `SharedValue` the drag writes on the UI thread,
 *    `0` at the smallest detent and `1` fully expanded. The map reads it to
 *    re-centre in lock-step with the finger. The same number via React state
 *    arrives one to three frames late, worst exactly while dragging (the JS
 *    thread is busiest then), and the eye reads that as two surfaces moving at
 *    different times — see the note on motion in Bloom's `bottom-edge`.
 *
 * The sheet never fights the MAP, either, and not by coincidence: the card is
 * only as tall as it is drawn, so the map above it receives touches directly.
 * There is no backdrop and no `<Modal>` to intercept them.
 *
 * Its geometry travels through Bloom's edge registry rather than through props:
 * it CLAIMS its resting footprint with `useClaimBottomEdge`, so the map's own
 * controls move up without either surface importing the other. The claim is the
 * RESTING height, never the live drag position — a claim is geometry, and
 * geometry that changes sixty times a second through React state is exactly
 * what that registry refuses to carry.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Pressable, View, useWindowDimensions, type AccessibilityActionEvent } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  clamp,
  runOnJS,
  useAnimatedReaction,
  useAnimatedScrollHandler,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { EDGE_GAP, ScreenScope, useClaimBottomEdge } from '@oxy.so/bloom/layout';
import { useTheme } from '@oxy.so/bloom/theme';

/** The three detents. `peek` shows the header only; `full` is nearly the screen. */
export type MapSheetSnap = 'peek' | 'half' | 'full';

/** Ordered smallest to largest — the order the accessibility stepper walks. */
export const MAP_SHEET_SNAPS: readonly MapSheetSnap[] = ['peek', 'half', 'full'];

export interface MapSheetProps {
  /** The current detent. The sheet is controlled — it never moves on its own. */
  snap: MapSheetSnap;
  onSnapChange: (snap: MapSheetSnap) => void;
  /**
   * UI-thread mirror of the sheet's expansion, `0` at `peek` and `1` at `full`.
   * Hand the same value to whatever must move WITH the drag.
   */
  animatedProgress?: SharedValue<number>;
  /**
   * Gate the body pan on the inner scroller's offset (default `true`). `false`
   * makes the whole body an unconditional drag surface — right only for a sheet
   * whose content never scrolls.
   */
  manualActivation?: boolean;
  /** Sticky chrome above the scrolling body. Its measured height sets `peek`. */
  header?: ReactNode;
  /**
   * The body. Rendered inside the sheet's own scroller by default; pass
   * `scrollable={false}` when the content owns its scrolling (a `VirtualList`),
   * since nesting one inside a ScrollView breaks windowing.
   */
  children: ReactNode;
  scrollable?: boolean;
  /** Fraction of the window height the `half` detent sits at. */
  halfRatio?: number;
  accessibilityLabel?: string;
  testID?: string;
}

/** How far a finger must travel before the body pan claims the gesture. */
const ACTIVATION_SLOP = 8;
/** Grab-handle pill, matching Bloom's own sheet. */
const HANDLE_WIDTH = 36;
const HANDLE_HEIGHT = 5;
/** Vertical space the handle row occupies (pill plus its padding). */
const HANDLE_ROW_HEIGHT = 22;
/** How far a flick is extrapolated when choosing the detent to land on. */
const VELOCITY_PROJECTION_S = 0.15;

const SPRING = { damping: 34, stiffness: 320, mass: 0.9, overshootClamping: true } as const;

const SNAP_LABELS: Record<MapSheetSnap, string> = {
  peek: 'Collapsed',
  half: 'Half open',
  full: 'Expanded',
};

const ACCESSIBILITY_ACTIONS = [
  { name: 'increment' as const, label: 'Expand' },
  { name: 'decrement' as const, label: 'Collapse' },
];

export function MapSheet({
  snap,
  onSnapChange,
  animatedProgress,
  manualActivation = true,
  header,
  children,
  scrollable = true,
  halfRatio = 0.45,
  accessibilityLabel = 'Results',
  testID,
}: MapSheetProps) {
  const insets = useSafeAreaInsets();
  const theme = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const reducedMotion = useReducedMotion();

  // The header is MEASURED rather than assumed: a constant disagrees with
  // reality the moment a translation wraps or the user enlarges their font, and
  // does so silently — the same reason the map's top bar measures its claim.
  const [headerHeight, setHeaderHeight] = useState(0);

  const geometry = useMemo(() => {
    const full = Math.max(240, windowHeight - insets.top - EDGE_GAP);
    const peek = Math.min(full, HANDLE_ROW_HEIGHT + headerHeight + insets.bottom);
    const half = Math.min(full, Math.max(peek, Math.round(windowHeight * halfRatio)));
    return {
      full,
      peek,
      half,
      /** Translation for each detent; `0` is fully expanded. */
      offsets: { full: 0, half: full - half, peek: full - peek } as Record<MapSheetSnap, number>,
      maxOffset: full - peek,
    };
  }, [windowHeight, insets.top, insets.bottom, headerHeight, halfRatio]);

  const translateY = useSharedValue(geometry.offsets[snap]);
  const dragStart = useSharedValue(0);
  const touchStartY = useSharedValue(0);
  const scrollOffset = useSharedValue(0);

  // What the sheet parks at the bottom edge, so map chrome clears it. The
  // RESTING height, never the drag: see the file header.
  useClaimBottomEdge(geometry.peek);

  const maxOffset = geometry.maxOffset;

  /**
   * Publish expansion on the UI thread.
   *
   * `maxOffset` is 0 for the first commit (before the header has measured), and
   * dividing by it would make every frame `NaN` — which propagates into the
   * consumer's `useAnimatedStyle` and silently stops the map re-centring.
   */
  useAnimatedReaction(
    () => translateY.value,
    (value) => {
      if (!animatedProgress) return;
      // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write, never during render; the React Compiler rule does not model SharedValue mutation.
      animatedProgress.value = maxOffset > 0 ? clamp(1 - value / maxOffset, 0, 1) : 0;
    },
    [maxOffset, animatedProgress],
  );

  // The last detent the SHEET settled on, so the controlled-prop effect below
  // does not re-animate to a position the gesture has just produced.
  const settled = useRef(snap);

  const commit = useCallback(
    (next: MapSheetSnap) => {
      settled.current = next;
      onSnapChange(next);
    },
    [onSnapChange],
  );

  const offsets = geometry.offsets;

  /**
   * The geometry the sheet is currently resting against.
   *
   * Needed because a gesture's own commit comes BACK through `snap`: the pan
   * starts a spring, calls `onSnapChange`, and this effect re-runs one render
   * later with `settled.current === snap`. Writing the resting offset there
   * unconditionally would set the shared value to the spring's own target and
   * cut the animation off mid-flight — a released drag would land with a hard
   * jump instead of settling. So the resting position is only re-asserted when
   * the GEOMETRY changed (rotation, font size, a taller header), never merely
   * because the detent came round again.
   */
  const restingOffsets = useRef(offsets);

  useEffect(() => {
    const geometryChanged = restingOffsets.current !== offsets;
    restingOffsets.current = offsets;

    if (settled.current === snap) {
      // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write, never during render; the React Compiler rule does not model SharedValue mutation.
      if (geometryChanged) translateY.value = offsets[snap];
      return;
    }
    settled.current = snap;
    translateY.value = reducedMotion
      ? withTiming(offsets[snap], { duration: 0 })
      : withSpring(offsets[snap], SPRING);
  }, [snap, offsets, reducedMotion, translateY]);

  /**
   * The native scroll gesture of the body's scroller, named so the body pan can
   * BLOCK it once it activates. Without that the two run together and the list
   * slides under the finger while the sheet is being dragged.
   */
  const scrollGesture = useMemo(() => Gesture.Native(), []);

  /**
   * Build a fresh pan with the sheet's drag-and-settle behaviour.
   *
   * A FACTORY rather than one shared gesture, because RNGH's builder methods
   * MUTATE and return the same object: `pan.manualActivation(true)` for the
   * body would have silently made the handle's pan manual too, and one gesture
   * instance cannot be mounted in two `GestureDetector`s at all. Both defects
   * are runtime-only.
   */
  const makePan = useCallback(
    () =>
      Gesture.Pan()
        .onStart(() => {
          dragStart.value = translateY.value;
        })
        .onUpdate((event) => {
          translateY.value = clamp(dragStart.value + event.translationY, 0, maxOffset);
        })
        .onEnd((event) => {
          // The detent nearest where the flick is HEADING, not where the finger
          // left: a fast short flick means "next detent", not "stay".
          const projected = clamp(
            translateY.value + event.velocityY * VELOCITY_PROJECTION_S,
            0,
            maxOffset,
          );
          let best: MapSheetSnap = 'peek';
          let bestDistance = Number.POSITIVE_INFINITY;
          for (const name of MAP_SHEET_SNAPS) {
            const distance = Math.abs(offsets[name] - projected);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = name;
            }
          }
          translateY.value = reducedMotion
            ? withTiming(offsets[best], { duration: 0 })
            : withSpring(offsets[best], SPRING);
          runOnJS(commit)(best);
        }),
    [commit, dragStart, maxOffset, offsets, reducedMotion, translateY],
  );

  /** The handle's pan is unconditional — it is the affordance of last resort. */
  // eslint-disable-next-line react-hooks/refs -- `makePan` only READS shared values inside worklets that run later; the rule cannot see that a SharedValue is not a ref.
  const handlePan = useMemo(() => makePan(), [makePan]);
  /** The header is a second grab surface, and needs its own instance. */
  // eslint-disable-next-line react-hooks/refs -- `makePan` only READS shared values inside worklets that run later; the rule cannot see that a SharedValue is not a ref.
  const headerPan = useMemo(() => makePan(), [makePan]);

  /**
   * The body's pan, gated so it never fights the inner scroller.
   *
   * With `manualActivation` the pan does nothing until `activate()` is called,
   * so a normal list scroll is untouched. It activates on a DOWNWARD drag only
   * when the scroller is already at its top (otherwise the user means "scroll
   * back up"), and on an UPWARD drag only while the sheet is not yet fully
   * expanded (otherwise the user means "read further down the list"). Anything
   * else fails the pan and hands the gesture straight back.
   */
  const bodyPan = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- `makePan` only READS shared values inside worklets that run later; the rule cannot see that a SharedValue is not a ref.
    const pan = makePan();
    if (!manualActivation) return pan;
    const gated = pan.manualActivation(true);
    // Only when the scroller is actually mounted: naming a gesture that is not
    // in the tree is a relation RNGH can never resolve.
    if (scrollable) gated.blocksExternalGesture(scrollGesture);
    return gated
      .onTouchesDown((event) => {
        const touch = event.allTouches[0];
        // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write, never during render; the React Compiler rule does not model SharedValue mutation.
        touchStartY.value = touch ? touch.absoluteY : 0;
      })
      .onTouchesMove((event, state) => {
        const touch = event.changedTouches[0] ?? event.allTouches[0];
        if (!touch) return;
        const delta = touch.absoluteY - touchStartY.value;
        if (delta > ACTIVATION_SLOP && scrollOffset.value <= 0) {
          state.activate();
          return;
        }
        if (delta < -ACTIVATION_SLOP && translateY.value > 0) {
          state.activate();
          return;
        }
        if (Math.abs(delta) > ACTIVATION_SLOP) state.fail();
      });
  }, [makePan, manualActivation, scrollable, scrollGesture, scrollOffset, touchStartY, translateY]);

  const onScroll = useAnimatedScrollHandler({
    onScroll: (event) => {
      // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write, never during render; the React Compiler rule does not model SharedValue mutation.
      scrollOffset.value = event.contentOffset.y;
    },
  });

  const cardStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

  const moveTo = useCallback(
    (next: MapSheetSnap) => {
      // eslint-disable-next-line react-hooks/immutability -- Reanimated SharedValue write, never during render; the React Compiler rule does not model SharedValue mutation.
      translateY.value = reducedMotion
        ? withTiming(offsets[next], { duration: 0 })
        : withSpring(offsets[next], SPRING);
      commit(next);
    },
    [commit, offsets, reducedMotion, translateY],
  );

  /** Tap: cycle up, wrapping back to `peek` from the top. */
  const cycle = useCallback(() => {
    const index = MAP_SHEET_SNAPS.indexOf(snap);
    moveTo(MAP_SHEET_SNAPS[(index + 1) % MAP_SHEET_SNAPS.length] ?? 'peek');
  }, [moveTo, snap]);

  /** Screen-reader / keyboard stepping, which does not wrap. */
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      const index = MAP_SHEET_SNAPS.indexOf(snap);
      const delta = event.nativeEvent.actionName === 'increment' ? 1 : -1;
      const next = MAP_SHEET_SNAPS[Math.max(0, Math.min(MAP_SHEET_SNAPS.length - 1, index + delta))];
      if (next && next !== snap) moveTo(next);
    },
    [moveTo, snap],
  );

  const body = scrollable ? (
    <GestureDetector gesture={scrollGesture}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        keyboardShouldPersistTaps="handled"
        style={{ flex: 1 }}
        contentContainerStyle={{ paddingBottom: insets.bottom + EDGE_GAP }}
      >
        {children}
      </Animated.ScrollView>
    </GestureDetector>
  ) : (
    <View className="flex-1" style={{ paddingBottom: insets.bottom }}>
      {children}
    </View>
  );

  return (
    <Animated.View
      testID={testID}
      style={[
        { position: 'absolute', left: 0, right: 0, bottom: 0, height: geometry.full },
        cardStyle,
      ]}
    >
      <View className="flex-1 overflow-hidden rounded-t-radius-24 bg-card shadow-m">
        {/* The sheet is its own screen: chrome inside it must claim and read
            ITS edges, not the map screen's underneath. */}
        <ScreenScope>
          <GestureDetector gesture={handlePan}>
            <View>
              <Pressable
                onPress={cycle}
                accessibilityRole="adjustable"
                accessibilityLabel={accessibilityLabel}
                accessibilityHint="Drag, or activate to change how much of the sheet is showing"
                accessibilityValue={{ text: SNAP_LABELS[snap] }}
                accessibilityActions={ACCESSIBILITY_ACTIONS}
                onAccessibilityAction={onAccessibilityAction}
                className="items-center justify-center"
                style={{ height: HANDLE_ROW_HEIGHT }}
                testID={testID ? `${testID}-handle` : undefined}
              >
                <View
                  style={{
                    width: HANDLE_WIDTH,
                    height: HANDLE_HEIGHT,
                    borderRadius: HANDLE_HEIGHT,
                    backgroundColor: theme.colors.textTertiary,
                  }}
                />
              </Pressable>
            </View>
          </GestureDetector>

          {header ? (
            <GestureDetector gesture={headerPan}>
              <View onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
                {header}
              </View>
            </GestureDetector>
          ) : null}

          <GestureDetector gesture={bodyPan}>
            <View className="flex-1">{body}</View>
          </GestureDetector>
        </ScreenScope>
      </View>
    </Animated.View>
  );
}

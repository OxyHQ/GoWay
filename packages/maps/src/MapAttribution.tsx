/**
 * Map data credit — rendered by `MapView` on every map, identical on web and
 * native, with no prop to turn it off.
 *
 * Both engines ship an attribution ornament of their own (maplibre-gl's
 * `AttributionControl`, MapLibre Native's "i" button); `MapView` disables both
 * and draws this instead, so the credit sits inside the app's layout (chrome
 * can be positioned against it) and looks the same on both platforms.
 *
 * It POSITIONS itself. A credit pinned 4 px off the window edge disappears the
 * moment anything parks at that edge — a half-sheet, a tab bar — and it
 * disappears silently, which for a licence obligation is the worst way to
 * fail. Reading Bloom's bottom-edge registry here means the credit rises above
 * whatever is claimed without either knowing about the other.
 *
 * ## On the right, after the mark
 *
 * The GoWay mark (`MapBrand`) takes the bottom-left corner and the credit the
 * bottom-right, starting after {@link MAP_BRAND_CLEARANCE} so a credit that
 * wraps on a narrow phone never runs under the mark.
 *
 * ## Compact, as the OSMF guidelines allow
 *
 * The OSMF Attribution Guidelines
 * (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) accept a
 * credit that is visible when the map loads and then collapses — after a few
 * seconds or once the reader interacts — into a control that shows it again.
 * That is this component's two states (`compactCredit.ts` holds the rule and
 * its test): spelled out, with an ⓘ at the end to fold it; or just the ⓘ, in
 * the same corner, which opens it. The links stay links.
 *
 * ## A disclosure rides here
 *
 * While an app draws something the reader must not mistake for data (GoWay's
 * simulated traffic), the credit says so: spelled out, its first line is the
 * whole sentence; folded, a word sits beside the ⓘ. Labelled in BOTH states,
 * for exactly as long as it is drawn.
 */
import { memo, type ReactNode, useCallback } from 'react';
import {
  type LayoutChangeEvent,
  Linking,
  Pressable,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { localizedLabel } from '@goway.to/sdk';
import { useBloomLocale } from '@oxy.so/bloom/locale';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { useBrandedChrome } from './brand/BrandedChrome';
import { type MapChromeLift, useMapChromeLift } from './chromeLift';
import { creditDisclosure } from './compactCredit';
import { useMapCreditHeight } from './creditHeight';
import { CREDIT_LABELS } from './creditLabels';
import { CREDIT_GAP, MAP_CREDIT_CLEARANCE } from './creditRise';
import { MAP_BRAND_CLEARANCE } from './MapBrand';
import type { MapCreditDisclosure, MapCreditLink } from './types';

/** Breathing room between the credit and whatever is below it. */
const ATTRIBUTION_GAP = CREDIT_GAP;
/** From the left edge when no mark is drawn there: the plate's own right inset. */
const CREDIT_SIDE_INSET = 8;

/**
 * How much of the bottom-right the credit occupies above the bottom edge when
 * it is one line (`creditRise.ts`). Bottom-right chrome a screen floats there
 * starts above it and rises by the credit's measured extra height
 * (`creditHeight.ts`), so the two never overlap.
 */
export { MAP_CREDIT_CLEARANCE };

/**
 * The credit GoWay's tiles oblige: OpenMapTiles' schema and OpenStreetMap's
 * data. Always shown, before anything an app adds.
 */
export const MAP_DATA_CREDITS: readonly MapCreditLink[] = [
  { label: '© OpenMapTiles', href: 'https://www.openmaptiles.org/' },
  { label: '© OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
];

const NO_EXTRA: readonly MapCreditLink[] = [];

/**
 * @param extra - credits owed while something the app draws is on screen,
 *   after the basemap's own.
 */
function MapAttributionComponent({
  extra = NO_EXTRA,
  disclosure = null,
  expanded,
  onToggle,
}: {
  extra?: readonly MapCreditLink[];
  /** A line the credit carries while something it names is drawn, `null` otherwise. */
  disclosure?: MapCreditDisclosure | null;
  /** Spelled out, or folded into the ⓘ (`compactCredit.ts`). */
  expanded: boolean;
  onToggle: () => void;
}) {
  const locale = useBloomLocale();
  const theme = useTheme();
  const toggleLabel = localizedLabel(
    expanded ? CREDIT_LABELS.hide : CREDIT_LABELS.show,
    locale ?? 'en',
  );
  const links = extra.length > 0 ? [...MAP_DATA_CREDITS, ...extra] : MAP_DATA_CREDITS;
  const shown = creditDisclosure(expanded, disclosure);
  const bottomEdge = useBottomEdgeInset();
  const chromeLift = useMapChromeLift();
  // The mark is not drawn while the app's own chrome carries it, so the
  // credit takes the corner's full width.
  const brandDrawn = !useBrandedChrome();
  const heightOut = useMapCreditHeight();
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      heightOut?.set(withTiming(event.nativeEvent.layout.height, { duration: 160 }));
    },
    [heightOut],
  );

  const open = useCallback((href: string) => {
    void Linking.openURL(href).catch(() => {
      // A link the platform will not open costs the tap, not the map.
    });
  }, []);

  const secondary = { color: theme.colors.textSecondary };
  const primary = { color: theme.colors.text };

  return (
    <CreditBox
      lift={chromeLift}
      style={{
        bottom: bottomEdge > 0 ? bottomEdge + ATTRIBUTION_GAP : ATTRIBUTION_GAP,
        left: brandDrawn ? MAP_BRAND_CLEARANCE : CREDIT_SIDE_INSET,
      }}
    >
      <View style={styles.plate} onLayout={heightOut ? measure : undefined} testID="map-credit">
        {/* The plate's fill is its own layer at an opacity, so the text on it
            stays fully opaque over a map Bloom cannot see. */}
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, styles.fill, { backgroundColor: theme.colors.card }]}
        />
        {shown.line && disclosure ? (
          <Text
            variant="caption-1-semibold"
            accessibilityLabel={`${shown.line}. ${disclosure.detail}`}
            style={[styles.disclosure, primary]}
            testID="map-credit-simulated"
          >
            {shown.line}
          </Text>
        ) : null}
        <View style={styles.row}>
          {expanded
            ? links.map((link) => (
                <Pressable
                  key={`${link.label}|${link.href}`}
                  accessibilityRole="link"
                  accessibilityLabel={link.label}
                  onPress={() => open(link.href)}
                  hitSlop={6}
                >
                  <Text variant="caption-1-regular" style={[styles.link, secondary]}>
                    {link.label}
                  </Text>
                </Pressable>
              ))
            : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              shown.tag && disclosure ? `${disclosure.text}. ${toggleLabel}` : toggleLabel
            }
            aria-expanded={expanded}
            onPress={onToggle}
            hitSlop={10}
            style={({ pressed }) => [styles.toggle, pressed ? styles.pressed : null]}
            testID="map-credit-toggle"
          >
            {shown.tag ? (
              <Text
                variant="caption-1-semibold"
                style={primary}
                testID="map-credit-simulated-short"
              >
                {shown.tag}
              </Text>
            ) : null}
            <RiInformationLine width={18} height={18} fill={theme.colors.textSecondary} />
          </Pressable>
        </View>
      </View>
    </CreditBox>
  );
}

function CreditBox({
  lift,
  style,
  children,
}: {
  lift: MapChromeLift | null;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  if (!lift) {
    return (
      <View pointerEvents="box-none" style={[styles.box, style]}>
        {children}
      </View>
    );
  }
  return (
    <LiftedCreditBox lift={lift} style={style}>
      {children}
    </LiftedCreditBox>
  );
}

function LiftedCreditBox({
  lift,
  style,
  children,
}: {
  lift: MapChromeLift;
  style: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const { lift: rise, opacity } = lift;
  const animated = useAnimatedStyle(
    () => ({ transform: [{ translateY: -rise.value }], opacity: opacity.value }),
    [rise, opacity],
  );
  return (
    <Animated.View pointerEvents="box-none" style={[styles.box, style, animated]}>
      {children}
    </Animated.View>
  );
}

export const MapAttribution = memo(MapAttributionComponent);

const styles = StyleSheet.create({
  box: { position: 'absolute', right: 8, alignItems: 'flex-end' },
  plate: {
    alignItems: 'flex-end',
    gap: 2,
    borderRadius: 8,
    overflow: 'hidden',
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  fill: { opacity: 0.8 },
  disclosure: { textAlign: 'right' },
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 4,
  },
  link: { textDecorationLine: 'underline' },
  toggle: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    borderRadius: 9999,
  },
  pressed: { opacity: 0.7 },
});

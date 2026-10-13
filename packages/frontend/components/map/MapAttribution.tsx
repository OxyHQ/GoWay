/**
 * Map data credit — GoWay-owned, identical on web and native.
 *
 * Both engines ship an attribution ornament of their own (maplibre-gl's
 * `AttributionControl`, MapLibre Native's "i" button), and both derive their
 * text from an `attribution` field on the style's sources. The OpenFreeMap
 * style documents do not set one, so both would render an EMPTY credit — the
 * failure mode where the obligation looks satisfied and is not.
 *
 * So the canvas renders this instead, from `lib/map/provider.ts`, and disables
 * the engines' own ornaments. Two other things fall out of that: the credit
 * sits inside GoWay's layout (so floating chrome can be positioned against it
 * rather than around an engine-owned box), and it looks the same on both
 * platforms.
 *
 * Rendered by `MapCanvas` itself, never by feature code — attribution must not
 * be something a screen can forget.
 *
 * It also POSITIONS itself, for the same reason. A credit pinned 4px off the
 * window edge disappears the moment anything parks at that edge — a persistent
 * half-sheet, a tab bar — and it disappears silently, which for a licence
 * obligation is the worst way to fail. Reading Bloom's bottom-edge registry
 * here means the credit rises above whatever is claimed without the claimant
 * and the credit knowing about each other, and without a screen being able to
 * get the geometry wrong.
 *
 * ## Why it is on the RIGHT now
 *
 * Because `MapBrand` took the left corner, and the layout is Google's for the
 * same reason Google's is: brand in one bottom corner, data credit in the
 * other. Two things follow that are worth stating, because the obvious
 * alternatives are both wrong:
 *
 *  - The credit was MOVED, not folded into the logo or dropped. It is an
 *    OSM/OpenMapTiles licence obligation and it is a full-size, tappable line
 *    of links whenever it is spelled out.
 *  - It is not free to sit wherever is left over. A wrapped credit on a narrow
 *    phone would run straight under the mark, so this reads
 *    {@link MAP_BRAND_CLEARANCE} and starts after it — the same pattern as the
 *    bottom-edge inset, one owner for each piece of geometry, no component
 *    holding a private copy of another's size.
 *
 * The positioning box spans that clearance to the right edge and the plate is
 * a child of it, so the card hugs the text instead of stretching across the
 * map.
 *
 * ## Compact, as the OSMF guidelines allow
 *
 * The OSMF Attribution Guidelines
 * (https://osmfoundation.org/wiki/Licence/Attribution_Guidelines) accept a
 * credit that is visible when the map loads and then collapses — after a few
 * seconds or once the reader interacts — into a control that shows it again.
 * That is this component's two states, driven by `MapCanvas` through
 * `useCompactCredit` (`lib/map/compactCredit.ts` holds the rule and its test):
 * spelled out, with an ⓘ at the end to fold it; or just the ⓘ, in the same
 * corner, which opens it. The links stay links. `MapCanvas` renders it on
 * every map with no prop to turn it off — the embed included.
 *
 * ## The simulation's label rides here
 *
 * While the city-life simulation draws anything, the credit says so
 * (`docs/MAP_CITY_LIFE.md` → Honesty): spelled out, its first line is the
 * whole label ("Simulated: cars and people · Live: buses"); folded, the ⓘ
 * carries the one word "Simulated" beside it, and pressing either opens the
 * whole label. So the simulation is labelled in BOTH states, for exactly as
 * long as it draws — the credit's corner is the one no screen, sheet or panel
 * may take, which is why the label moved here from the top-right stack.
 */
import { memo, useCallback } from 'react';
import {
  type LayoutChangeEvent,
  Linking,
  Pressable,
  type StyleProp,
  View,
  type ViewStyle,
} from 'react-native';
import Animated, { useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { localizedLabel } from '@goway.to/sdk';
import { Text } from '@oxy.so/bloom/typography';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { useTheme } from '@oxy.so/bloom/theme';

import { useBrandedChrome } from '@/components/brand';
import { useTranslation } from '@/lib/i18n';
import { creditDisclosure } from '@/lib/map/compactCredit';
import { CREDIT_LABELS } from '@/lib/map/creditLabels';
import { CREDIT_GAP, MAP_CREDIT_CLEARANCE } from '@/lib/map/creditRise';

import { type MapAttributionLink, resolveMapAttribution } from '@/lib/map/provider';
import { type MapChromeLift, useMapChromeLift } from './chromeLift';
import { useMapCreditHeight } from './creditHeight';
import { MAP_BRAND_CLEARANCE } from './MapBrand';
import { useMapRelief } from './reliefFlags';

/** Breathing room between the credit and whatever is below it. */
const ATTRIBUTION_GAP = CREDIT_GAP;
/** From the left edge when no mark is drawn there: the plate's own right inset. */
const CREDIT_SIDE_INSET = 8;

/**
 * How much of the bottom-right the credit occupies above the bottom edge when
 * it is one line (`lib/map/creditRise.ts`). Bottom-right chrome a screen
 * floats there ("My location") starts above it and rises by the credit's
 * measured extra height (`creditHeight.ts`), so the two never overlap —
 * exported for the same reason `MAP_BRAND_CLEARANCE` is.
 */
export { MAP_CREDIT_CLEARANCE };

const NO_EXTRA: readonly MapAttributionLink[] = [];

/**
 * What the credit must disclose about the map right now: the city-life
 * simulation's label (`cityLifeLabel.ts`), already in the reader's language.
 */
export interface MapCreditDisclosure {
  /** The whole label: "Simulated: cars and people · Live: buses". */
  text: string;
  /** That simulated is not live traffic — read with it by a screen reader. */
  detail: string;
  /** One word, beside the folded ⓘ: "Simulated". */
  short: string;
}

/**
 * @param extra - credits owed only while something is drawn — a CC BY
 *   landmark model's author (`docs/MAP_LANDMARKS.md`), a GoWay Live feed
 *   (`MapLiveLayer.credits`, `docs/MAP_LIVE.md`). Passed by `MapCanvas`
 *   alone, from what is drawn; never by feature code.
 */
function MapAttributionComponent({
  elevation = false,
  extra = NO_EXTRA,
  disclosure = null,
  expanded,
  onToggle,
}: {
  /** The style itself draws elevation data (Outdoors' hillshade and contours). */
  elevation?: boolean;
  extra?: readonly MapAttributionLink[];
  /**
   * The simulation's label while it draws, `null` otherwise. Passed by
   * `MapCanvas` alone, from what the city layer says it draws.
   */
  disclosure?: MapCreditDisclosure | null;
  /** Spelled out, or folded into the ⓘ (`useCompactCredit`). */
  expanded: boolean;
  onToggle: () => void;
}) {
  const { locale } = useTranslation();
  const theme = useTheme();
  const toggleLabel = localizedLabel(expanded ? CREDIT_LABELS.hide : CREDIT_LABELS.show, locale);
  // The elevation credit rides along whenever the relief prototype draws
  // terrain or a hillshade (`docs/MAP_TERRAIN_GLOBE.md`).
  const relief = useMapRelief();
  const attribution = resolveMapAttribution({ terrain: relief.terrain || elevation });
  const links = extra.length > 0 ? [...attribution.links, ...extra] : attribution.links;
  // The simulation's label: the whole line spelled out, one word folded.
  const shown = creditDisclosure(expanded, disclosure);
  const bottomEdge = useBottomEdgeInset();
  // Above a sheet's LIVE top edge where the screen provides one (phones).
  const chromeLift = useMapChromeLift();
  // The mark stands down where the screen's chrome carries the logo (`MapBrand`).
  const brandDrawn = !useBrandedChrome();
  // Its own height, for the chrome a screen floats above it.
  const heightOut = useMapCreditHeight();
  const measure = useCallback(
    (event: LayoutChangeEvent) => {
      heightOut?.set(withTiming(event.nativeEvent.layout.height, { duration: 160 }));
    },
    [heightOut],
  );

  const open = useCallback((href: string) => {
    void Linking.openURL(href).catch(() => {
      // An unopenable credit link must never take the map down with it.
    });
  }, []);

  return (
    <CreditBox
      lift={chromeLift}
      style={{
        // A claim already folds in the safe area of the surface holding the
        // edge, so the plain gap is added to it rather than the safe-area-aware
        // one.
        bottom: bottomEdge > 0 ? bottomEdge + ATTRIBUTION_GAP : ATTRIBUTION_GAP,
        // Never overlap the mark in the other corner, however the text wraps;
        // where the screen's chrome carries the logo instead (the explore
        // screen, `BrandedChromeProvider`), the corner is free and a phone
        // gets the width back — fewer lines for the chrome above to clear.
        left: brandDrawn ? MAP_BRAND_CLEARANCE : CREDIT_SIDE_INSET,
      }}
    >
      <View
        className="items-end gap-space-2 rounded-radius-8 bg-card/80 px-space-8 py-space-2"
        onLayout={heightOut ? measure : undefined}
        testID="map-credit"
      >
        {shown.line && disclosure ? (
          <Text
            accessibilityLabel={`${shown.line}. ${disclosure.detail}`}
            className="text-right text-caption font-semibold text-foreground"
            testID="map-credit-simulated"
          >
            {shown.line}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap items-center justify-end gap-space-4">
          {expanded ? (
            <>
              {attribution.prefix ? (
                <Text className="text-caption text-muted-foreground">{attribution.prefix}</Text>
              ) : null}
              {links.map((link) => (
                <Pressable
                  key={`${link.label}|${link.href}`}
                  accessibilityRole="link"
                  accessibilityLabel={link.label}
                  onPress={() => open(link.href)}
                  hitSlop={6}
                >
                  <Text className="text-caption text-muted-foreground underline">{link.label}</Text>
                </Pressable>
              ))}
            </>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              shown.tag && disclosure ? `${disclosure.text}. ${toggleLabel}` : toggleLabel
            }
            aria-expanded={expanded}
            onPress={onToggle}
            hitSlop={10}
            className="flex-row items-center justify-center gap-space-4 rounded-radius-max active:opacity-70"
            testID="map-credit-toggle"
          >
            {shown.tag ? (
              <Text
                className="text-caption font-semibold text-foreground"
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

/**
 * The positioning box: laid out against Bloom's bottom edge, and — when the
 * screen hands down a live lift — riding the sheet's current top edge on the
 * UI thread. Absent a lift it is the plain box it always was.
 */
function CreditBox({
  lift,
  style,
  children,
}: {
  lift: MapChromeLift | null;
  style: StyleProp<ViewStyle>;
  children: React.ReactNode;
}) {
  if (!lift) {
    return (
      <View pointerEvents="box-none" className="absolute right-space-8 items-end" style={style}>
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
  children: React.ReactNode;
}) {
  const { lift: rise, opacity } = lift;
  const animated = useAnimatedStyle(
    () => ({ transform: [{ translateY: -rise.value }], opacity: opacity.value }),
    [rise, opacity],
  );
  return (
    <Animated.View
      pointerEvents="box-none"
      className="absolute right-space-8 items-end"
      style={[style, animated]}
    >
      {children}
    </Animated.View>
  );
}

export const MapAttribution = memo(MapAttributionComponent);

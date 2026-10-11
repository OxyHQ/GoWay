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
 */
import { memo, useCallback } from 'react';
import { Linking, Pressable, View } from 'react-native';
import { localizedLabel } from '@goway.to/sdk';
import { Text } from '@oxy.so/bloom/typography';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';
import { RiInformationLine } from '@oxy.so/bloom/icons/RiInformationLine';
import { useTheme } from '@oxy.so/bloom/theme';

import { useTranslation } from '@/lib/i18n';
import { CREDIT_LABELS } from '@/lib/map/creditLabels';

import { type MapAttributionLink, resolveMapAttribution } from '@/lib/map/provider';
import { MAP_BRAND_CLEARANCE } from './MapBrand';
import { useMapRelief } from './reliefFlags';

/** Breathing room between the credit and whatever is below it. */
const ATTRIBUTION_GAP = 4;

const NO_EXTRA: readonly MapAttributionLink[] = [];

/**
 * @param extra - credits owed only while something is drawn — a CC BY
 *   landmark model's author (`docs/MAP_LANDMARKS.md`). Passed by `MapCanvas`
 *   alone, from what its engine reports drawn; never by feature code.
 */
function MapAttributionComponent({
  extra = NO_EXTRA,
  expanded,
  onToggle,
}: {
  extra?: readonly MapAttributionLink[];
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
  const attribution = resolveMapAttribution({ terrain: relief.terrain });
  const links = extra.length > 0 ? [...attribution.links, ...extra] : attribution.links;
  const bottomEdge = useBottomEdgeInset();

  const open = useCallback((href: string) => {
    void Linking.openURL(href).catch(() => {
      // An unopenable credit link must never take the map down with it.
    });
  }, []);

  return (
    <View
      pointerEvents="box-none"
      className="absolute right-space-8 items-end"
      style={{
        // A claim already folds in the safe area of the surface holding the
        // edge, so the plain gap is added to it rather than the safe-area-aware
        // one.
        bottom: bottomEdge > 0 ? bottomEdge + ATTRIBUTION_GAP : ATTRIBUTION_GAP,
        // Never overlap the mark in the other corner, however the text wraps.
        left: MAP_BRAND_CLEARANCE,
      }}
    >
      <View
        className="flex-row flex-wrap items-center justify-end gap-space-4 rounded-radius-8 bg-card/80 px-space-8 py-space-2"
        testID="map-credit"
      >
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
          accessibilityLabel={toggleLabel}
          aria-expanded={expanded}
          onPress={onToggle}
          hitSlop={10}
          className="items-center justify-center rounded-radius-max active:opacity-70"
          testID="map-credit-toggle"
        >
          <RiInformationLine width={18} height={18} fill={theme.colors.textSecondary} />
        </Pressable>
      </View>
    </View>
  );
}

export const MapAttribution = memo(MapAttributionComponent);

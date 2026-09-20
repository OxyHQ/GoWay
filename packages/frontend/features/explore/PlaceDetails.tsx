/**
 * A selected place, shown without inventing anything.
 *
 * Issue #7 → Place details: "Avoid showing fields that are absent merely to
 * imitate Google Maps density." So every section below is conditional on the
 * fact actually existing, and the place with almost no metadata gets a short,
 * honest sentence plus the one action that could fix it — not a skeleton of
 * grey bars that never fill in.
 *
 * The two identity-bound actions (saving, contributing) go through
 * `useAuthGate()`: pressing one while signed out opens the in-app Oxy dialog
 * OVER the map and leaves everything mounted. Everything else on this screen —
 * the place, its hours, its capabilities, directions — works signed out.
 */
import { useCallback } from 'react';
import { Linking, Platform, View } from 'react-native';
import type { Place } from '@goway.to/sdk';
import * as WebBrowser from 'expo-web-browser';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { RiVerifiedBadgeLine } from '@oxy.so/bloom/icons/RiVerifiedBadgeLine';

import { useAuthGate } from '@/lib/authGate';
import { resolveCategory } from '@/lib/goway/categories';
import { formatAddress, formatWebsite, websiteUrl } from '@/lib/goway/format';
import { evaluateOpeningHours } from '@/lib/goway/openingHours';

import { CapabilityList } from './CapabilityList';

/** How GoWay describes its own confidence in a record. Words, never a colour. */
const VERIFICATION_WORDS: Record<Place['verification']['state'], string | null> = {
  unverified: null,
  community_reviewed: 'Reviewed by the community',
  oxy_verified: 'Verified by Oxy',
  owner_verified: 'Verified by the owner',
};

export interface PlaceDetailsProps {
  place: Place;
  /**
   * Enter the directions planner with this place as the destination.
   *
   * The card deliberately shows no ETA and no travel-mode chips: a route has an
   * origin, an origin is a thing the user gets to CHOOSE, and choosing it is
   * the planner's whole job. Half a planner on a place card was the shape that
   * could only ever answer one question.
   */
  onDirections: () => void;
  testID?: string;
}

export function PlaceDetails({ place, onDirections, testID }: PlaceDetailsProps) {
  const theme = useTheme();
  const gate = useAuthGate();

  const category = resolveCategory(place.categories);
  const address = formatAddress(place.address);
  const opening = evaluateOpeningHours(place.openingHours);
  const website = formatWebsite(place.contact?.website);
  const phone = place.contact?.phone;
  const verification = VERIFICATION_WORDS[place.verification.state];

  // "Do we know anything at all?" — the test the incomplete-metadata state
  // hangs off, written once rather than as five nested ternaries below.
  const hasDetail = Boolean(address || phone || website || opening.state !== 'unknown' || place.capabilities.length > 0);

  const openWebsite = useCallback(() => {
    const url = websiteUrl(place.contact?.website);
    if (!url) return;
    void WebBrowser.openBrowserAsync(url);
  }, [place.contact?.website]);

  const callPhone = useCallback(() => {
    if (!phone) return;
    void Linking.openURL(`tel:${phone.replace(/\s+/g, '')}`);
  }, [phone]);

  /** Identity-bound: the gate opens the Oxy dialog when there is no session. */
  const save = useCallback(() => {
    gate.run(() => {
      // The saved-places store is issue #9's; the gate is what issue #7 owes.
    });
  }, [gate]);

  const suggestEdit = useCallback(() => {
    gate.run(() => {
      // Authored edits land with the contribution flow; identity is required
      // before the editor opens, not after it is filled in.
    });
  }, [gate]);

  return (
    <View className="gap-space-16 px-space-16 pb-space-16" testID={testID}>
      <View className="gap-space-4">
        <Text className="text-sectionTitle text-foreground">{place.name}</Text>
        <View className="flex-row flex-wrap items-center gap-space-8">
          <Text className="text-bodySmall text-muted-foreground">{category.label}</Text>
          {place.status === 'closed' ? (
            <Text className="text-bodySmall" style={{ color: theme.colors.errorSubtleForeground }}>
              Permanently closed
            </Text>
          ) : null}
          {verification ? (
            <View className="flex-row items-center gap-space-4">
              <RiVerifiedBadgeLine width={14} height={14} fill={theme.colors.primary} />
              <Text className="text-caption text-muted-foreground">{verification}</Text>
            </View>
          ) : null}
        </View>
      </View>

      <View className="flex-row flex-wrap items-center gap-space-8">
        <Button
          variant="primary"
          size="small"
          leadingIcon={RiRouteLine}
          onPress={onDirections}
          accessibilityLabel={`Directions to ${place.name}`}
        >
          Directions
        </Button>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiBookmarkLine}
          onPress={save}
          accessibilityLabel={gate.canUsePrivateApi ? 'Save this place' : 'Sign in to save this place'}
        >
          Save
        </Button>
      </View>

      {hasDetail ? <Divider /> : null}

      {address ? (
        <Item
          density="compact"
          leading={<RiMapPin2Line width={18} height={18} fill={theme.colors.textSecondary} />}
          title={address}
          accessibilityLabel={`Address: ${address}`}
        />
      ) : null}

      {opening.state !== 'unknown' ? (
        <Item
          density="compact"
          leading={<RiTimeLine width={18} height={18} fill={theme.colors.textSecondary} />}
          title={
            opening.state === 'open'
              ? `Open · closes ${opening.closesAt}`
              : opening.opensAt
                ? `Closed · opens ${opening.opensAt}`
                : 'Closed'
          }
          accessibilityLabel={opening.state === 'open' ? `Open now, closes at ${opening.closesAt}` : 'Closed now'}
        />
      ) : null}

      {phone ? (
        <Item
          density="compact"
          onPress={callPhone}
          leading={<RiPhoneLine width={18} height={18} fill={theme.colors.textSecondary} />}
          title={phone}
          accessibilityLabel={`Call ${place.name} on ${phone}`}
        />
      ) : null}

      {website ? (
        <Item
          density="compact"
          onPress={openWebsite}
          leading={<RiGlobalLine width={18} height={18} fill={theme.colors.textSecondary} />}
          title={website}
          accessibilityLabel={`Open the website for ${place.name}${Platform.OS === 'web' ? '' : ' in a browser'}`}
        />
      ) : null}

      <CapabilityList capabilities={place.capabilities} />

      {!hasDetail ? (
        <View className="gap-space-8">
          <Text className="text-bodySmall text-muted-foreground">
            GoWay doesn&apos;t have any more details for this place yet — no address, hours or contact from any
            source it reconciles.
          </Text>
          <View className="flex-row">
            <Button
              variant="secondary"
              size="small"
              leadingIcon={RiEditLine}
              onPress={suggestEdit}
              accessibilityLabel={
                gate.canUsePrivateApi ? 'Add details for this place' : 'Sign in to add details for this place'
              }
            >
              Add details
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

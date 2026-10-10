/**
 * A selected place, shown without inventing anything.
 *
 * Issue #7 → Place details: "Avoid showing fields that are absent merely to
 * imitate Google Maps density." So every section below is conditional on the
 * fact actually existing, and the place with almost no metadata gets a short,
 * honest sentence plus the one action that could fix it — not a skeleton of
 * grey bars that never fill in.
 *
 * The identity-bound actions (saving, contributing, adding a photo, writing a
 * review) go through `useAuthGate()`: pressing one while signed out opens the
 * in-app Oxy dialog OVER the map and leaves everything mounted. Everything else
 * on this screen — the place, its hours, its capabilities, its photos and
 * reviews, directions — works signed out.
 *
 * Below the facts come what people made of the place: its photos (Oxy files,
 * drawn from Oxy's CDN), its description, the products a Mercaria store
 * trading from it has in stock (read from Mercaria, stored nowhere here), and
 * its reviews with the business's replies — each a section that is absent when
 * there is nothing in it.
 */
import { useCallback, useState } from 'react';
import { Linking, Platform, View } from 'react-native';
import { placeDisplayName } from '@goway.to/sdk';
import type { Place } from '@goway.to/sdk';
import * as WebBrowser from 'expo-web-browser';
import { Avatar } from '@oxy.so/bloom/avatar';
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
import { openingSummary, upcomingExceptions, weeklySchedule } from '@/lib/goway/hours';
import { useCategoryTaxonomy } from '@/lib/goway/queries';

import { CapabilityList } from './CapabilityList';
import { PlaceGallery } from './PlaceGallery';
import { PlaceProducts } from './PlaceProducts';
import { PlaceReviews } from './PlaceReviews';

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

  const taxonomy = useCategoryTaxonomy();
  const category = resolveCategory(place.categories, taxonomy);
  const address = formatAddress(place.address);
  const opening = openingSummary(place);
  const schedule = weeklySchedule(place);
  const exceptions = upcomingExceptions(place);
  const [showWeek, setShowWeek] = useState(false);
  const website = formatWebsite(place.contact?.website);
  const phone = place.contact?.phone;
  const verification = VERIFICATION_WORDS[place.verification.state];
  // GoWay resolved the reader's language; the place's own wording otherwise.
  const description = place.localizedDescription?.description ?? place.description;

  // "Do we know anything at all?" — the test the incomplete-metadata state
  // hangs off, written once rather than as five nested ternaries below.
  const hasDetail = Boolean(
    address ||
      phone ||
      website ||
      opening ||
      schedule ||
      exceptions.length > 0 ||
      place.capabilities.length > 0 ||
      description,
  );

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

  const displayName = placeDisplayName(place);

  const suggestEdit = useCallback(() => {
    gate.run(() => {
      // Authored edits land with the contribution flow; identity is required
      // before the editor opens, not after it is filled in.
    });
  }, [gate]);

  return (
    <View className="gap-space-16 px-space-16 pb-space-16" testID={testID}>
      <View className="gap-space-4">
        {/* The resolved name for the reader's locale, falling back to the
            place's default. `placeDisplayName` is the SDK's own one-liner, so
            the sheet, the marker pill and the result row cannot disagree. */}
        <View className="flex-row items-center gap-space-8">
          {place.logoFileId ? (
            // An Oxy file id, resolved by Bloom's image resolver like every other.
            <Avatar source={place.logoFileId} variant="thumb" name={displayName} size="md" />
          ) : null}
          <Text className="flex-1 text-sectionTitle text-foreground">{displayName}</Text>
        </View>
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
          size="sm"
          leadingIcon={RiRouteLine}
          onPress={onDirections}
          accessibilityLabel={`Directions to ${displayName}`}
          tone="accent"
          appearance="solid"
        >
          Directions
        </Button>
        <Button
          size="sm"
          leadingIcon={RiBookmarkLine}
          onPress={save}
          accessibilityLabel={
            gate.canUsePrivateApi ? 'Save this place' : 'Sign in to save this place'
          }
          tone="neutral"
          appearance="outline"
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

      {opening || schedule ? (
        <View className="gap-space-4">
          <Item
            density="compact"
            leading={<RiTimeLine width={18} height={18} fill={theme.colors.textSecondary} />}
            // A schedule GoWay can read but not evaluate (no zone) still shows
            // its week; it just makes no claim about right now.
            title={opening?.text ?? 'Opening hours'}
            onPress={schedule ? () => setShowWeek((shown) => !shown) : undefined}
            accessibilityLabel={`${opening?.spoken ?? 'Opening hours'}.${schedule ? (showWeek ? ' Hide the week.' : ' Show the week.') : ''}`}
          />
          {showWeek && schedule ? (
            <View className="gap-space-2 pl-space-32">
              {schedule.map((row) => (
                <View key={row.day} className="flex-row gap-space-12">
                  <Text className="w-space-40 text-bodySmall text-muted-foreground">{row.day}</Text>
                  <Text className="flex-1 text-bodySmall text-foreground">{row.text}</Text>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}

      {exceptions.length > 0 ? (
        <View
          className="gap-space-4 pl-space-32"
          accessibilityLabel="Upcoming changes to the usual hours"
        >
          {exceptions.map((exception) => (
            <Text key={exception.id} className="text-bodySmall text-muted-foreground">
              {`${exception.dates} · ${exception.text}${exception.note ? ` · ${exception.note}` : ''}`}
            </Text>
          ))}
        </View>
      ) : null}

      {phone ? (
        <Item
          density="compact"
          onPress={callPhone}
          leading={<RiPhoneLine width={18} height={18} fill={theme.colors.textSecondary} />}
          title={phone}
          accessibilityLabel={`Call ${displayName} on ${phone}`}
        />
      ) : null}

      {website ? (
        <Item
          density="compact"
          onPress={openWebsite}
          leading={<RiGlobalLine width={18} height={18} fill={theme.colors.textSecondary} />}
          title={website}
          accessibilityLabel={`Open the website for ${displayName}${Platform.OS === 'web' ? '' : ' in a browser'}`}
        />
      ) : null}

      <CapabilityList capabilities={place.capabilities} />

      <PlaceGallery placeId={place.id} placeName={displayName} />

      {description ? <Text className="text-bodySmall text-foreground">{description}</Text> : null}

      <PlaceProducts place={place} />

      <PlaceReviews place={place} />

      {!hasDetail ? (
        <View className="gap-space-8">
          <Text className="text-bodySmall text-muted-foreground">
            GoWay doesn&apos;t have any more details for this place yet — no address, hours or
            contact from any source it reconciles.
          </Text>
          <View className="flex-row">
            <Button
              size="sm"
              leadingIcon={RiEditLine}
              onPress={suggestEdit}
              accessibilityLabel={
                gate.canUsePrivateApi
                  ? 'Add details for this place'
                  : 'Sign in to add details for this place'
              }
              tone="neutral"
              appearance="outline"
            >
              Add details
            </Button>
          </View>
        </View>
      ) : null}
    </View>
  );
}

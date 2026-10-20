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
import { type ReactNode, useCallback, useMemo } from 'react';
import { Linking, Platform, View } from 'react-native';
import { placeDisplayName } from '@goway.to/sdk';
import type { Place } from '@goway.to/sdk';
import * as WebBrowser from 'expo-web-browser';
import { PlaceCard, type PlaceAction } from '@oxy.so/bloom/place-card';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { PlaceHours, PlaceInfoList, type PlaceInfoItem } from '@oxy.so/bloom/place-details';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiBookmarkFill } from '@oxy.so/bloom/icons/RiBookmarkFill';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiVerifiedBadgeLine } from '@oxy.so/bloom/icons/RiVerifiedBadgeLine';

import { useAuthGate } from '@/lib/authGate';
import { resolveCategory } from '@/lib/goway/categories';
import { formatAddress, formatWebsite, websiteUrl } from '@/lib/goway/format';
import { openingSummary, upcomingExceptions, weeklyHours } from '@/lib/goway/hours';
import { useCategoryTaxonomy } from '@/lib/goway/queries';
import { useTranslation } from '@/lib/i18n';

import { useSaveControl } from '@/features/saved/useSaveControl';

import { CapabilityList } from './CapabilityList';
import { PlaceGallery } from './PlaceGallery';
import { PlaceProducts } from './PlaceProducts';
import { PlaceReviews } from './PlaceReviews';
import { PlaceTransitSection } from './PlaceTransitSection';

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
  /** More actions after Directions and Save (the landmark tour, when the flag is on). */
  actions?: ReactNode;
  testID?: string;
}

export function PlaceDetails({ place, onDirections, actions, testID }: PlaceDetailsProps) {
  const theme = useTheme();
  const gate = useAuthGate();
  const { t } = useTranslation();

  const taxonomy = useCategoryTaxonomy();
  const category = resolveCategory(place.categories, taxonomy);
  const address = formatAddress(place.address);
  const opening = openingSummary(place);
  const week = weeklyHours(place);
  const exceptions = upcomingExceptions(place);
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
      week ||
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

  const displayName = placeDisplayName(place);

  /** Save opens the list picker; signed out, the auth gate opens the Oxy dialog instead. */
  const saving = useSaveControl({ id: place.id, name: displayName });

  const onInfoPress = useCallback(
    (id: string) => {
      if (id === 'phone') callPhone();
      else if (id === 'website') openWebsite();
    },
    [callPhone, openWebsite],
  );
  const info = useMemo<PlaceInfoItem[]>(
    () => [
      ...(address
        ? [{ id: 'address', value: address, label: 'Address', icon: RiMapPin2Line }]
        : []),
      ...(phone
        ? [
            {
              id: 'phone',
              value: phone,
              label: 'Phone',
              icon: RiPhoneLine,
              action: 'call' as const,
              onPress: onInfoPress,
              accessibilityLabel: `Call ${displayName} on ${phone}`,
            },
          ]
        : []),
      ...(website
        ? [
            {
              id: 'website',
              value: website,
              label: 'Website',
              icon: RiGlobalLine,
              action: 'open' as const,
              onPress: onInfoPress,
              accessibilityLabel: `Open the website for ${displayName}${Platform.OS === 'web' ? '' : ' in a browser'}`,
            },
          ]
        : []),
    ],
    [address, phone, website, displayName, onInfoPress],
  );

  const badge = verification ? (
    <View className="flex-row items-center gap-space-4">
      <RiVerifiedBadgeLine width={14} height={14} fill={theme.colors.primary} />
      <Text className="text-caption text-muted-foreground">{verification}</Text>
    </View>
  ) : undefined;

  const cardActions = useMemo<PlaceAction[]>(
    () => [
      {
        id: 'directions',
        label: 'Directions',
        icon: RiRouteLine,
        onPress: onDirections,
        accessibilityLabel: `Directions to ${displayName}`,
      },
      {
        id: 'save',
        label: saving.saved ? t('saved.action.saved') : t('saved.action.save'),
        icon: saving.saved ? RiBookmarkFill : RiBookmarkLine,
        onPress: saving.openPicker,
        accessibilityLabel: !gate.canUsePrivateApi
          ? t('saved.action.signInLabel')
          : saving.saved
            ? t('saved.action.editLabel')
            : t('saved.action.saveLabel'),
      },
    ],
    [onDirections, saving.openPicker, saving.saved, displayName, gate.canUsePrivateApi, t],
  );

  const suggestEdit = useCallback(() => {
    gate.run(() => {
      // Authored edits land with the contribution flow; identity is required
      // before the editor opens, not after it is filled in.
    });
  }, [gate]);

  return (
    <View className="gap-space-16 px-space-16 pb-space-16" testID={testID}>
      <PlaceCard
        density="detail"
        name={displayName}
        category={category.label}
        photo={place.coverFileId}
        rating={place.rating?.average}
        reviewCount={place.rating?.count}
        badge={badge}
        openState={place.status === 'closed' ? 'closed' : opening?.state}
        openLabel={place.status === 'closed' ? 'Permanently closed' : undefined}
        hours={place.status === 'closed' ? undefined : opening?.text}
        address={address ?? undefined}
        actions={cardActions}
        testID="place-card"
      />
      {saving.dialog}

      {actions ? (
        <View className="flex-row flex-wrap items-center gap-space-8">{actions}</View>
      ) : null}

      {hasDetail ? <Divider /> : null}

      {opening || week ? (
        <PlaceHours
          // A schedule GoWay can read but not evaluate (no zone) still shows
          // its week; it just makes no claim about right now.
          days={week ?? []}
          state={opening?.state}
          summary={opening?.text ?? 'Opening hours'}
          testID="place-hours"
        />
      ) : null}

      {exceptions.length > 0 ? (
        <View className="gap-space-4" accessibilityLabel="Upcoming changes to the usual hours">
          {exceptions.map((exception) => (
            <Text key={exception.id} className="text-bodySmall text-muted-foreground">
              {`${exception.dates} · ${exception.text}${exception.note ? ` · ${exception.note}` : ''}`}
            </Text>
          ))}
        </View>
      ) : null}

      {info.length > 0 ? <PlaceInfoList items={info} testID="place-info" /> : null}

      <CapabilityList capabilities={place.capabilities} />

      <PlaceTransitSection place={place} />

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

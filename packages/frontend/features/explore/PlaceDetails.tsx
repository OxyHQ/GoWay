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
import type { Place, Route, TravelMode } from '@goway.to/sdk';
import * as WebBrowser from 'expo-web-browser';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { Item } from '@oxy.so/bloom/item';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';
import { RiBookmarkLine } from '@oxy.so/bloom/icons/RiBookmarkLine';
import { RiCarLine } from '@oxy.so/bloom/icons/RiCarLine';
import { RiEditLine } from '@oxy.so/bloom/icons/RiEditLine';
import { RiGlobalLine } from '@oxy.so/bloom/icons/RiGlobalLine';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiPhoneLine } from '@oxy.so/bloom/icons/RiPhoneLine';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiTimeLine } from '@oxy.so/bloom/icons/RiTimeLine';
import { RiVerifiedBadgeLine } from '@oxy.so/bloom/icons/RiVerifiedBadgeLine';
import { RiWalkLine } from '@oxy.so/bloom/icons/RiWalkLine';

import { useAuthGate } from '@/lib/authGate';
import { resolveCategory } from '@/lib/goway/categories';
import { formatAddress, formatDistance, formatDuration, formatWebsite, websiteUrl } from '@/lib/goway/format';
import { evaluateOpeningHours } from '@/lib/goway/openingHours';
import type { GoWayFailureKind } from '@/lib/goway/errors';
import type { LocationErrorReason } from '@/lib/map/useUserLocation';

import { CapabilityList } from './CapabilityList';
import { LocationFailureState } from './states';
import type { RouteOriginKind } from './useExplore';

/** How GoWay describes its own confidence in a record. Words, never a colour. */
const VERIFICATION_WORDS: Record<Place['verification']['state'], string | null> = {
  unverified: null,
  community_reviewed: 'Reviewed by the community',
  oxy_verified: 'Verified by Oxy',
  owner_verified: 'Verified by the owner',
};

const MODE_ICONS = { walk: RiWalkLine, bike: RiBikeLine, drive: RiCarLine } as const;
const MODE_LABELS: Record<TravelMode, string> = { walk: 'Walk', bike: 'Bike', drive: 'Drive' };

export interface PlaceDetailsProps {
  place: Place;
  /** The computed route, when the user has asked for directions. */
  route?: Route | null;
  routePending?: boolean;
  /** Set when directions failed, or when no route exists. */
  routeFailure?: GoWayFailureKind | 'noRoute' | null;
  /**
   * Where the route starts. `'map'` is NOT the user's position and is labelled
   * as such wherever a distance or an ETA is shown.
   */
  routeOriginKind?: RouteOriginKind | null;
  /** The permission prompt / fix is outstanding. */
  locationPending?: boolean;
  /**
   * Why Directions has no origin. Rendering this is the difference between the
   * button working and the button looking dead — see `useExplore`.
   */
  locationFailure?: LocationErrorReason | null;
  /** `false` when asking again provably cannot reach a prompt. */
  canAskLocationAgain?: boolean;
  /** Offered beside a location failure; absent when there is nothing sane to offer. */
  onRouteFromMap?: (() => void) | null;
  travelMode: TravelMode;
  onTravelModeChange: (mode: TravelMode) => void;
  onDirections: () => void;
  testID?: string;
}

export function PlaceDetails({
  place,
  route,
  routePending = false,
  routeFailure = null,
  routeOriginKind = null,
  locationPending = false,
  locationFailure = null,
  canAskLocationAgain = true,
  onRouteFromMap = null,
  travelMode,
  onTravelModeChange,
  onDirections,
  testID,
}: PlaceDetailsProps) {
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
          disabled={locationPending}
          accessibilityLabel={
            routeOriginKind === 'map' ? 'Directions from your location instead of the map' : 'Directions'
          }
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

      {/* Travel mode + the route's own summary. A mode the router cannot serve
          fails with its own message rather than an empty card. */}
      <View className="gap-space-8">
        <View className="flex-row items-center gap-space-8">
          {(['walk', 'bike', 'drive'] as const).map((mode) => {
            const Icon = MODE_ICONS[mode];
            const active = mode === travelMode;
            return (
              <Button
                key={mode}
                variant={active ? 'primary' : 'secondary'}
                size="xs"
                leadingIcon={Icon}
                onPress={() => onTravelModeChange(mode)}
                accessibilityLabel={`${MODE_LABELS[mode]} directions${active ? ', selected' : ''}`}
              >
                {MODE_LABELS[mode]}
              </Button>
            );
          })}
        </View>

        {/* Asking for the permission and waiting for a fix is its own wait, and
            a visibly different one from waiting for the router: this is the
            second or ten during which the user is deciding, and calling it
            "working out the route" would be describing the wrong thing. */}
        {locationPending ? (
          <View className="flex-row items-center gap-space-8">
            <Loading variant="spinner" size="small" />
            <Text className="text-bodySmall text-muted-foreground">Finding your location…</Text>
          </View>
        ) : null}

        {routePending ? (
          <View className="flex-row items-center gap-space-8">
            <Loading variant="spinner" size="small" />
            <Text className="text-bodySmall text-muted-foreground">Working out the route…</Text>
          </View>
        ) : null}

        {route ? (
          <View className="gap-space-4">
            <Text className="text-bodySmall text-foreground">
              {`${formatDuration(route.durationSeconds)} · ${formatDistance(route.distanceMeters)}`}
            </Text>
            {/* A route measured from a point on the map is never allowed to
                read as a route from the user. Saying so is the whole reason
                the origin carries its provenance this far. */}
            {routeOriginKind === 'map' ? (
              <Text className="text-caption text-muted-foreground">
                Measured from the area you were browsing, not from your location. Tap Directions to use your
                location instead.
              </Text>
            ) : null}
          </View>
        ) : null}

        {routeFailure === 'noRoute' ? (
          <Text className="text-bodySmall text-muted-foreground">
            {`No ${MODE_LABELS[travelMode].toLowerCase()} route to here. Try another travel mode.`}
          </Text>
        ) : null}
        {routeFailure && routeFailure !== 'noRoute' ? (
          <Text className="text-bodySmall text-muted-foreground">
            {routeFailure === 'offline'
              ? "Directions need a connection, and GoWay can't reach the network."
              : "Directions aren't available right now."}
          </Text>
        ) : null}

        {/* The state the bug report was missing. Four different reasons, four
            different sentences, and a way forward that is never a silent
            substitution of somewhere the user never said they were. */}
        {locationFailure && !locationPending ? (
          <LocationFailureState
            reason={locationFailure}
            canAskAgain={canAskLocationAgain}
            onRetry={onDirections}
            onUseMapOrigin={onRouteFromMap ?? undefined}
          />
        ) : null}
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

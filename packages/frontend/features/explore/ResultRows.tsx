/**
 * The rows the sheet and the panel both render.
 *
 * Two of them, because a search returns two genuinely different things: GoWay
 * PLACES (which carry categories, capabilities and verification) and geocoder
 * CANDIDATES (a street, a locality — a name and a point, and honestly nothing
 * else). Rendering the second as if it were the first is how a list ends up
 * with blank category lines and a verification badge on a postcode.
 *
 * Both are Bloom `Item`s with `role="option"`, so on web the list announces as
 * a listbox and the selected row announces as selected — which is also what
 * makes the list keyboard-navigable without a custom focus manager.
 */
import { View } from 'react-native';
import { placeDisplayName } from '@goway.to/sdk';
import type { Place, PlaceWithDistance, SearchResult } from '@goway.to/sdk';
import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';
import { RiVerifiedBadgeLine } from '@oxy.so/bloom/icons/RiVerifiedBadgeLine';

import { capabilitySummary, presentCapability, visibleCapabilities } from '@/lib/goway/capabilities';
import { resolveCategory } from '@/lib/goway/categories';
import { formatAddress, formatDistance, formatPlaceSubtitle } from '@/lib/goway/format';
import { evaluateOpeningHours } from '@/lib/goway/openingHours';

/** A tiny glyph+word pair. Never a bare coloured dot. */
function Tag({ children, color }: { children: string; color: string }) {
  return (
    <Text className="text-caption" style={{ color }}>
      {children}
    </Text>
  );
}

export interface PlaceRowProps {
  place: Place | PlaceWithDistance;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}

export function PlaceRow({ place, selected = false, onPress, testID }: PlaceRowProps) {
  const theme = useTheme();
  const category = resolveCategory(place.categories);
  const Icon = category.icon;
  const subtitle = formatPlaceSubtitle(place);
  const distance = 'distanceMeters' in place ? formatDistance(place.distanceMeters) : null;
  const opening = evaluateOpeningHours(place.openingHours);
  const capabilities = visibleCapabilities(place.capabilities);
  const oxyVerified = place.verification.state === 'oxy_verified' || place.verification.state === 'owner_verified';

  // The accessible name carries everything the visual tags carry, in words, so
  // colour and iconography are never the only channel.
  const displayName = placeDisplayName(place);
  const spoken = [
    displayName,
    subtitle,
    place.status === 'closed' ? 'permanently closed' : null,
    opening.state === 'open' ? `open until ${opening.closesAt}` : null,
    opening.state === 'closed' ? 'closed now' : null,
    oxyVerified ? 'verified by Oxy' : null,
    capabilitySummary(place.capabilities),
    distance ? `${distance} away` : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <Item
      role="option"
      selected={selected}
      onPress={onPress}
      accessibilityLabel={spoken}
      testID={testID}
      leading={
        <View className="h-9 w-9 items-center justify-center rounded-radius-max bg-muted">
          <Icon width={18} height={18} fill={theme.colors.textSecondary} />
        </View>
      }
      trailing={distance ? <Text className="text-caption text-muted-foreground">{distance}</Text> : undefined}
    >
      <View className="flex-1 gap-space-2">
        <View className="flex-row items-center gap-space-4">
          <Text className="text-body text-foreground" numberOfLines={1}>
            {displayName}
          </Text>
          {oxyVerified ? (
            <RiVerifiedBadgeLine width={14} height={14} fill={theme.colors.primary} />
          ) : null}
        </View>

        {subtitle ? (
          <Text className="text-bodySmall text-muted-foreground" numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}

        {/* Status words, not status colours. The tint is redundant emphasis. */}
        {(place.status === 'closed' || opening.state !== 'unknown' || capabilities.length > 0) ? (
          <View className="flex-row flex-wrap items-center gap-space-8">
            {place.status === 'closed' ? (
              <Tag color={theme.colors.errorSubtleForeground}>Permanently closed</Tag>
            ) : null}
            {place.status !== 'closed' && opening.state === 'open' ? (
              <Tag color={theme.colors.successSubtleForeground}>{`Open · until ${opening.closesAt}`}</Tag>
            ) : null}
            {place.status !== 'closed' && opening.state === 'closed' ? (
              <Tag color={theme.colors.textSecondary}>
                {opening.opensAt ? `Closed · opens ${opening.opensAt}` : 'Closed'}
              </Tag>
            ) : null}
            {capabilities.slice(0, 2).map((capability) => (
              <Tag key={capability.key} color={theme.colors.textSecondary}>
                {presentCapability(capability).label}
              </Tag>
            ))}
          </View>
        ) : null}
      </View>
    </Item>
  );
}

export interface SearchResultRowProps {
  result: SearchResult;
  selected?: boolean;
  onPress: () => void;
  testID?: string;
}

/**
 * A geocoder candidate.
 *
 * When the result reconciles to a GoWay place it carries the whole `place`, so
 * it renders as one — the richer row is not a different screen, just more
 * facts about the same point.
 */
export function SearchResultRow({ result, selected = false, onPress, testID }: SearchResultRowProps) {
  const theme = useTheme();

  if (result.place) {
    return <PlaceRow place={result.place} selected={selected} onPress={onPress} testID={testID} />;
  }

  const where = formatAddress(result.address) ?? contextLine(result);

  return (
    <Item
      role="option"
      selected={selected}
      onPress={onPress}
      title={result.displayName}
      subtitle={where ?? undefined}
      accessibilityLabel={[result.displayName, KIND_WORDS[result.kind], where].filter(Boolean).join(', ')}
      testID={testID}
      leading={
        <View className="h-9 w-9 items-center justify-center rounded-radius-max bg-muted">
          <RiMapPin2Line width={18} height={18} fill={theme.colors.textSecondary} />
        </View>
      }
    />
  );
}

const KIND_WORDS: Record<SearchResult['kind'], string> = {
  place: 'place',
  address: 'address',
  street: 'street',
  locality: 'area',
  region: 'region',
  country: 'country',
  poi: 'point of interest',
};

function contextLine(result: SearchResult): string | null {
  const parts = [result.context?.city, result.context?.region, result.context?.country].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

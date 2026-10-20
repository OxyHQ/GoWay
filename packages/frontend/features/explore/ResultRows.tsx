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
import type { CategoryTaxonomy, Place, PlaceWithDistance, SearchResult } from '@goway.to/sdk';
import { Item } from '@oxy.so/bloom/item';
import { PlaceCard, type PlaceCardProps } from '@oxy.so/bloom/place-card';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';

import { ecosystemCapabilities, presentCapability } from '@/lib/goway/capabilities';
import { formatAddress, formatDistance, formatPlaceSubtitle } from '@/lib/goway/format';
import { openingSummary } from '@/lib/goway/hours';
import { useCategoryTaxonomy } from '@/lib/goway/queries';

import { useSaveControl } from '../saved/useSaveControl';

export interface PlaceRowProps {
  place: Place | PlaceWithDistance;
  selected?: boolean;
  onPress: () => void;
  /**
   * Draw the save heart. On by default: a result is a place worth keeping.
   * A row that PICKS a place for something else (a route stop) turns it off.
   */
  saveable?: boolean;
  testID?: string;
}

/** The most capabilities a row names; the rest are on the place's own page. */
const ROW_CAPABILITIES = 2;

/**
 * A GoWay place as Bloom's `PlaceCard` row.
 *
 * Everything the card draws is something the place records: its cover photo
 * (an Oxy file id the app's image resolver turns into a URL), the published
 * rating summary (absent, not "New", when nobody has rated it), the category,
 * and whether it is open — evaluated by the SDK's `openingStatusAt`, which
 * answers nothing without the place's timezone. The ecosystem capabilities
 * ride in the facts row as words, so the card never relies on colour.
 */
/**
 * What a place is as a `PlaceCard` row: everything but the press, the save
 * heart and the test id, which belong to whoever draws it. A search result and
 * a place in a saved list are the same row (`PlaceList` draws it too), so it is
 * written once, here.
 */
export function placeRowCardProps(
  place: Place | PlaceWithDistance,
  taxonomy: CategoryTaxonomy | undefined,
): Omit<PlaceCardProps, 'density' | 'style' | 'testID'> {
  const subtitle = formatPlaceSubtitle(place, taxonomy);
  const distance = 'distanceMeters' in place ? formatDistance(place.distanceMeters) : null;
  const opening = openingSummary(place);
  const closed = place.status === 'closed';
  const capabilities = ecosystemCapabilities(place.capabilities).slice(0, ROW_CAPABILITIES);
  const oxyVerified =
    place.verification.state === 'oxy_verified' || place.verification.state === 'owner_verified';
  const address = formatAddress(place.address);

  const facts = [
    ...(distance
      ? [{ icon: RiMapPin2Line, label: distance, accessibilityLabel: `${distance} away` }]
      : []),
    ...capabilities.map((capability) => ({ label: presentCapability(capability).label })),
  ];

  return {
    name: placeDisplayName(place),
    category: subtitle || undefined,
    photo: place.coverFileId,
    photoVariant: 'thumb',
    rating: place.rating?.average,
    reviewCount: place.rating?.count,
    badge: oxyVerified ? 'Verified by Oxy' : undefined,
    openState: closed ? 'closed' : opening?.state,
    openLabel: closed ? 'Permanently closed' : undefined,
    hours: closed ? undefined : opening?.text,
    address: address ?? undefined,
    facts,
  };
}

export function PlaceRow({
  place,
  selected = false,
  onPress,
  saveable = true,
  testID,
}: PlaceRowProps) {
  const taxonomy = useCategoryTaxonomy();
  const saving = useSaveControl({ id: place.id, name: placeDisplayName(place) }, saveable);

  const card = (
    <PlaceCard
      {...placeRowCardProps(place, taxonomy)}
      {...(saveable
        ? {
            favorite: saving.saved,
            onFavoriteChange: saving.onFavoriteChange,
            saveLabel: saving.saveLabel,
            removeLabel: saving.removeLabel,
          }
        : {})}
      onPress={onPress}
      testID={testID}
    />
  );

  return (
    <>
      {selected ? (
        <View className="rounded-radius-12 bg-accent" accessibilityState={{ selected }}>
          {card}
        </View>
      ) : (
        card
      )}
      {saving.dialog}
    </>
  );
}

export interface SearchResultRowProps {
  result: SearchResult;
  selected?: boolean;
  onPress: () => void;
  /** As on {@link PlaceRowProps}: whether a place result draws the save heart. */
  saveable?: boolean;
  testID?: string;
}

/**
 * A geocoder candidate.
 *
 * When the result reconciles to a GoWay place it carries the whole `place`, so
 * it renders as one — the richer row is not a different screen, just more
 * facts about the same point.
 */
export function SearchResultRow({
  result,
  selected = false,
  onPress,
  saveable = true,
  testID,
}: SearchResultRowProps) {
  const theme = useTheme();

  if (result.place) {
    return (
      <PlaceRow
        place={result.place}
        selected={selected}
        onPress={onPress}
        saveable={saveable}
        testID={testID}
      />
    );
  }

  const where = formatAddress(result.address) ?? contextLine(result);

  return (
    <Item
      role="option"
      selected={selected}
      onPress={onPress}
      title={result.displayName}
      subtitle={where ?? undefined}
      accessibilityLabel={[result.displayName, KIND_WORDS[result.kind], where]
        .filter(Boolean)
        .join(', ')}
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
  const parts = [result.context?.city, result.context?.region, result.context?.country].filter(
    Boolean,
  );
  return parts.length > 0 ? parts.join(', ') : null;
}

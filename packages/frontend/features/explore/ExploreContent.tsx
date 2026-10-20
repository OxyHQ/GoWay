/**
 * What the sheet (mobile) and the side panel (desktop) both show.
 *
 * The two containers differ structurally — one is a gesture-driven half-sheet
 * over the map, the other a fixed column beside it — but what goes INSIDE them
 * is the same three states of the same map, so it is written once here. That is
 * the whole of "the responsive layout may vary structurally while remaining one
 * Expo app and shared design language".
 *
 * The rows are plain Bloom `Item`s inside the container's own scroller rather
 * than a `VirtualList`. That is deliberate: the sheet's body pan is gated on
 * ITS scroller's offset (`manualActivation`), and a nested virtualized list
 * would both break that gating and trip React Native's
 * VirtualizedList-inside-ScrollView warning. These lists are bounded by the
 * viewport read and the search limit — tens of rows, not thousands — so
 * virtualization would buy nothing and cost the gesture contract.
 */
import { type ReactNode, useMemo } from 'react';
import { View } from 'react-native';
import type { Place, PlaceWithDistance } from '@goway.to/sdk';
import { Admonition } from '@oxy.so/bloom/admonition';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import * as Skeleton from '@oxy.so/bloom/skeleton';
import { RiRouteLine } from '@oxy.so/bloom/icons/RiRouteLine';
import { RiHistoryLine } from '@oxy.so/bloom/icons/RiHistoryLine';
import { Item } from '@oxy.so/bloom/item';

import { DirectionsBody, DirectionsHeader } from '@/features/directions/DirectionsPanel';
import { distanceMeters } from '@goway.to/sdk/geo';
import { useTranslation } from '@/lib/i18n';

import { CategoryShortcuts } from './CategoryShortcuts';
import { PlaceDetails } from './PlaceDetails';
import { PlaceRow, SearchResultRow } from './ResultRows';
import { SearchField } from './SearchField';
import {
  FailureState,
  NoResultsState,
  NothingHereState,
  PanelState,
  ZoomForMoreState,
} from './states';
import type { ExploreController } from './useExplore';
import { RiMapPin2Line } from '@oxy.so/bloom/icons/RiMapPin2Line';

/** The sticky chrome: search, and the way back out of a selection. */
export function ExploreHeader({ explore }: { explore: ExploreController }) {
  const { t } = useTranslation();
  const inSelection = explore.selection != null;

  // In the planner the itinerary IS the chrome: it is what the user is editing,
  // and a turn list that pushes the From field off the top is a form you cannot
  // see. The search box would be a second, competing text field for the same
  // job, so it steps aside rather than stacking above.
  if (explore.directions.active) {
    return <DirectionsHeader directions={explore.directions} testID="directions-header" />;
  }

  return (
    <View>
      <SearchField
        value={explore.query}
        onChangeText={explore.setQuery}
        onClear={explore.clearQuery}
        onSubmit={explore.submitSearch}
        onNavigate={explore.moveActiveResult}
        busy={explore.searchBusy}
        onBack={inSelection ? explore.clearSelection : undefined}
        backLabel={explore.query ? t('search.back.results') : t('search.back.nearby')}
        testID="explore-search"
      />
      {explore.query.trim().length === 1 ? (
        <Text className="px-space-16 pb-space-8 text-caption text-muted-foreground">
          {t('search.keepTyping')}
        </Text>
      ) : null}
      {/* Also while searching: a category chosen here filters the search, and a
          filter the person cannot see is a search that "finds nothing" for no
          visible reason. */}
      {explore.mode === 'browse' || explore.mode === 'search' ? (
        <View className="pb-space-8">
          <CategoryShortcuts
            selected={explore.shortcutId}
            onSelect={explore.setShortcutId}
            testID="explore-shortcuts"
          />
        </View>
      ) : null}
    </View>
  );
}

/** Extra actions for a place's card, rendered beside Directions and Save (the landmark tour). */
export type RenderPlaceActions = (place: Place) => ReactNode;

export function ExploreBody({
  explore,
  renderPlaceActions,
  onStartGuidance,
}: {
  explore: ExploreController;
  renderPlaceActions?: RenderPlaceActions;
  onStartGuidance?: () => void;
}) {
  if (explore.directions.active) {
    return (
      <DirectionsBody
        directions={explore.directions}
        places={explore.places}
        center={explore.center}
        viewport={explore.bounds}
        // Only ever a position the user has already asked for in this session;
        // nothing here requests one.
        near={explore.location.coordinate}
        onStartGuidance={onStartGuidance}
        testID="directions-body"
      />
    );
  }
  if (explore.selection)
    return <SelectionBody explore={explore} renderPlaceActions={renderPlaceActions} />;
  if (explore.mode === 'search') return <SearchBody explore={explore} />;
  return <BrowseBody explore={explore} />;
}

// ── Browse ──────────────────────────────────────────────────────────────────

function BrowseBody({ explore }: { explore: ExploreController }) {
  const { t } = useTranslation();
  const { center, places } = explore;

  /**
   * Nearest first, from the centre of the box the results came from.
   *
   * Not from the USER — the map may be showing a city they are not in, and a
   * list ordered by "distance from you" there is a list ordered by nothing.
   */
  const ordered = useMemo<Array<Place | PlaceWithDistance>>(() => {
    if (!center) return [...places];
    return places
      .map((place) => ({ ...place, distanceMeters: distanceMeters(center, place.location) }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters);
  }, [center, places]);

  if (explore.placesFailure) {
    return (
      <FailureState kind={explore.placesFailure} subject="places" onRetry={explore.retryPlaces} />
    );
  }
  if (explore.placesBusy && places.length === 0) return <RowSkeletons />;
  // The action is offered only when it would DO something: re-committing the
  // same box produces the same query key and therefore no request at all.
  if (places.length === 0) {
    return (
      <NothingHereState onSearchArea={explore.areaMoved ? explore.searchThisArea : undefined} />
    );
  }

  return (
    <View accessibilityRole="list" accessibilityLabel={t('search.placesInArea')}>
      <RecentSearches explore={explore} />
      {ordered.map((place) => (
        <PlaceRow
          key={place.id}
          place={place}
          selected={false}
          onPress={() => explore.selectPlace(place)}
          testID={`place-row-${place.id}`}
        />
      ))}
      {explore.hiddenByZoom > 0 ? (
        <>
          <Divider />
          <ZoomForMoreState hidden={explore.hiddenByZoom} />
        </>
      ) : null}
    </View>
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

function SearchBody({ explore }: { explore: ExploreController }) {
  const { t } = useTranslation();
  if (explore.searchFailure) {
    return (
      <FailureState kind={explore.searchFailure} subject="search" onRetry={explore.retrySearch} />
    );
  }
  if (explore.results.length === 0) {
    // Typing is ahead of the request: the answer is not "nothing", it is "not yet".
    if (explore.searchBusy || explore.searchStale) return <RowSkeletons />;
    return <NoResultsState query={explore.query.trim()} onClear={explore.clearQuery} />;
  }

  const count = explore.results.length;
  return (
    <View>
      {/* A degraded provider is a SHORT LIST, not a failure — the SDK reports
          the two separately precisely so this can be said out loud. */}
      {explore.degradedProviders.length > 0 ? (
        <View className="px-space-16 pb-space-8">
          <Admonition type="warning">{t('search.degraded')}</Admonition>
        </View>
      ) : null}

      {/* The previous query's list stays, dimmed, until the new one lands: a
          panel that blanks per keystroke reads as a flicker, not as searching. */}
      <View
        accessibilityRole="list"
        accessibilityLiveRegion="polite"
        accessibilityLabel={`${t('search.resultsFor', { query: explore.query.trim() })}, ${t(
          count === 1 ? 'search.resultCount.one' : 'search.resultCount.other',
          { count },
        )}`}
        aria-busy={explore.searchStale}
        style={{ opacity: explore.searchStale ? 0.55 : 1 }}
        pointerEvents={explore.searchStale ? 'none' : 'auto'}
      >
        {explore.results.map((result, index) => (
          <SearchResultRow
            key={result.id}
            result={result}
            selected={index === explore.activeResultIndex}
            onPress={() => explore.selectResult(result)}
            testID={`result-row-${result.id}`}
          />
        ))}
      </View>
    </View>
  );
}

/** The searches this device ran lately: one tap runs one again. Only in browse, only if any. */
function RecentSearches({ explore }: { explore: ExploreController }) {
  const { t } = useTranslation();
  if (explore.recentSearches.length === 0 || explore.shortcutId != null) return null;
  return (
    <View testID="recent-searches">
      <View className="flex-row items-center justify-between px-space-16 pt-space-4">
        <Text className="text-caption text-muted-foreground">{t('search.recent.title')}</Text>
        <Button
          size="sm"
          appearance="plain"
          tone="neutral"
          onPress={explore.clearRecentSearches}
          accessibilityLabel={t('search.recent.clear')}
        >
          {t('search.clear')}
        </Button>
      </View>
      {explore.recentSearches.map((recent) => (
        <Item
          key={recent}
          title={recent}
          onPress={() => explore.runRecentSearch(recent)}
          accessibilityLabel={t('search.recent.again', { query: recent })}
          leading={<RiHistoryLine width={18} height={18} />}
          testID={`recent-search-${recent}`}
        />
      ))}
      <Divider />
    </View>
  );
}

// ── Selection ───────────────────────────────────────────────────────────────

function SelectionBody({
  explore,
  renderPlaceActions,
}: {
  explore: ExploreController;
  renderPlaceActions?: RenderPlaceActions;
}) {
  const { t } = useTranslation();
  const { selection } = explore;
  if (!selection) return null;

  if (selection.kind === 'result') {
    // A street or a locality: a name and a point, and honestly nothing else —
    // but it is still somewhere you can be routed to, so it gets the same one
    // tap into the planner that a place does.
    const { result } = selection;
    return (
      <View className="gap-space-8 px-space-16 pb-space-16">
        <Text className="text-sectionTitle text-foreground">{result.displayName}</Text>
        <Text className="text-bodySmall text-muted-foreground">
          {[result.context?.city, result.context?.region, result.context?.country]
            .filter(Boolean)
            .join(', ') || t('search.area')}
        </Text>
        <View className="flex-row">
          <Button
            size="sm"
            leadingIcon={RiRouteLine}
            onPress={() => explore.directions.openToResult(result)}
            accessibilityLabel={t('search.directionsTo', { name: result.displayName })}
            tone="accent"
            appearance="solid"
          >
            {t('search.directions')}
          </Button>
        </View>
        <Text className="text-caption text-muted-foreground">
          {t('search.locationFrom', { source: result.source })}
        </Text>
      </View>
    );
  }

  if (selection.kind === 'label') {
    return <BasemapLabelBody explore={explore} />;
  }

  if (explore.selectedPlaceFailure) {
    return <FailureState kind={explore.selectedPlaceFailure} subject="place" />;
  }
  if (!explore.selectedPlace) {
    return explore.selectedPlaceBusy ? (
      <DetailSkeleton />
    ) : (
      <PanelState
        icon={RiMapPin2Line}
        title={t('search.placeMissing')}
        testID="state-place-missing"
      />
    );
  }

  const place = explore.selectedPlace;
  return (
    <PlaceDetails
      place={place}
      // One tap, same as before: the planner opens with this place as the
      // destination and asks the device where you are for the starting point.
      onDirections={() => explore.directions.openTo(place)}
      actions={renderPlaceActions?.(place)}
      testID="place-details"
    />
  );
}

/**
 * A name the map itself is showing, tapped.
 *
 * Every shop, street, district and river on the map comes out of the vector
 * tiles, and until they became tappable that was unreachable. What this must
 * NOT do now is imitate a place card. The tiles carry a name, a point and a
 * category token; there is no address here, no hours, no phone number, and no
 * skeleton pretending one is loading, because none of those is coming.
 *
 * ## Why it does not apologise
 *
 * An earlier draft ended with "GoWay doesn't hold a place record for it yet",
 * which is true and reads like a database error to everybody who is not us.
 * Apple and Google, handed a name and nothing else, show the name, say what
 * kind of thing it is, and offer to take you there — the absence is simply the
 * absence, not an announcement. So does this. The one sentence that remains is
 * about where the name CAME from, which is a fact worth having when two sources
 * disagree, and it is the last line rather than the headline.
 *
 * While search is still deciding whether GoWay holds a record, even that line
 * is held back: the answer arrives within one request, and a card that says the
 * wrong thing for 400 ms is worse than a card that says less.
 */
function BasemapLabelBody({ explore }: { explore: ExploreController }) {
  const { t } = useTranslation();
  const label = explore.selectedLabel;
  if (!label) return null;

  return (
    <View className="gap-space-12 px-space-16 pb-space-16" testID="basemap-label-details">
      <View className="gap-space-4">
        <Text className="text-sectionTitle text-foreground">{label.name}</Text>
        {explore.labelCategory ? (
          <Text className="text-bodySmall text-muted-foreground">{explore.labelCategory}</Text>
        ) : null}
      </View>
      <View className="flex-row">
        <Button
          size="sm"
          leadingIcon={RiRouteLine}
          onPress={() => explore.directions.openToPoint(label.coordinate, label.name)}
          accessibilityLabel={t('search.directionsTo', { name: label.name })}
          tone="accent"
          appearance="solid"
        >
          {t('search.directions')}
        </Button>
      </View>
      {explore.selectedLabelBusy ? null : (
        <Text className="text-caption text-muted-foreground">{t('search.fromMapData')}</Text>
      )}
    </View>
  );
}

// ── Loading ─────────────────────────────────────────────────────────────────

/**
 * Skeletons rather than a spinner, because the shape of what is coming is
 * known: the list is rows, and a row-shaped placeholder does not make the
 * content jump when it arrives.
 */
function RowSkeletons() {
  const { t } = useTranslation();
  return (
    <View
      className="gap-space-12 px-space-16 py-space-12"
      accessibilityLabel={t('search.loadingPlaces')}
    >
      {[0, 1, 2, 3].map((index) => (
        <Skeleton.Row key={index} style={{ gap: 12, alignItems: 'center' }}>
          <Skeleton.Circle size={36} />
          <Skeleton.Col style={{ gap: 6, flex: 1 }}>
            <Skeleton.Box width="60%" height={12} />
            <Skeleton.Box width="40%" height={10} />
          </Skeleton.Col>
        </Skeleton.Row>
      ))}
    </View>
  );
}

function DetailSkeleton() {
  const { t } = useTranslation();
  return (
    <View
      className="gap-space-12 px-space-16 py-space-12"
      accessibilityLabel={t('search.loadingPlace')}
    >
      <Skeleton.Box width="70%" height={16} />
      <Skeleton.Box width="45%" height={12} />
      <Skeleton.Row style={{ gap: 8 }}>
        <Skeleton.Box width={110} height={32} borderRadius={16} />
        <Skeleton.Box width={86} height={32} borderRadius={16} />
      </Skeleton.Row>
      <View className="flex-row items-center gap-space-8">
        <Loading variant="spinner" size="sm" />
        <Text className="text-caption text-muted-foreground">{t('search.loadingDetails')}</Text>
      </View>
    </View>
  );
}

/**
 * Filling one slot of the itinerary.
 *
 * Every source the user can name a point from, in one list, ordered by how
 * often it is the answer:
 *
 *  1. **Your location** — one tap, and the only control here that can produce a
 *     permission prompt.
 *  2. **A point on the map** — hands the next map tap to this slot.
 *  3. **What you type** — the same `useSearch` the map's own search box uses,
 *     so GoWay places and geocoder candidates arrive reconciled and a result
 *     that IS a place brings its place ID with it.
 *  4. **What is around you** — before anything is typed, the places already
 *     loaded for the browsed area. They cost nothing (the query is the browse
 *     screen's own) and they are usually what a second stop is.
 *
 * The text itself lives in the FIELD, up in the header, not here: the field is
 * where a user looks while typing, and a second input inside the results would
 * be two places to look for one piece of state.
 */
import { useMemo } from 'react';
import { View } from 'react-native';
import type { GeoCoordinate, Place, SearchResult } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';
import { RiMap2Line } from '@oxy.so/bloom/icons/RiMap2Line';

import type { GeoBounds } from '@/components/map';
import { classifyGoWayError, type GoWayFailureKind } from '@/lib/goway/errors';
import { MIN_SEARCH_LENGTH, useSearch } from '@/lib/goway/queries';
import type { LocationErrorReason } from '@/lib/map/useUserLocation';
import { distanceMeters } from '@/lib/map/geo';
import { useDebouncedValue } from '@/lib/useDebouncedValue';

import { FailureState, LocationFailureState, NoResultsState } from '../explore/states';
import { PlaceRow, SearchResultRow } from '../explore/ResultRows';

/** Matches the map's own search box, so the two feel like one field. */
const SEARCH_DEBOUNCE_MS = 250;

/** How many nearby places to offer before anything is typed. */
const NEARBY_LIMIT = 8;

export interface StopPickerProps {
  /** "Starting point", "Destination", "Stop 2" — used in every label here. */
  slotName: string;
  draft: string;
  /** The user's own position, when it is already known. Biases the search. */
  near: GeoCoordinate | null;
  /** The box the user committed to browsing. Biases the search, and orders the list. */
  viewport: GeoBounds | null;
  center: GeoCoordinate | null;
  places: readonly Place[];
  onPickPlace: (place: Place) => void;
  onPickResult: (result: SearchResult) => void;
  onUseDevice: () => void;
  onChooseOnMap: () => void;
  /** Leave the picker without choosing. The field simply stays as it was. */
  onCancel: () => void;
  /** Offered beside a location failure; absent when there is nothing sane to offer. */
  onUseMapCentre?: (() => void) | null;
  locationBusy: boolean;
  locationFailure: LocationErrorReason | null;
  canAskLocationAgain: boolean;
  onRetryLocation: () => void;
  testID?: string;
}

export function StopPicker({
  slotName,
  draft,
  near,
  viewport,
  center,
  places,
  onPickPlace,
  onPickResult,
  onUseDevice,
  onChooseOnMap,
  onCancel,
  onUseMapCentre = null,
  locationBusy,
  locationFailure,
  canAskLocationAgain,
  onRetryLocation,
  testID,
}: StopPickerProps) {
  const debounced = useDebouncedValue(draft, SEARCH_DEBOUNCE_MS);
  const searching = debounced.trim().length >= MIN_SEARCH_LENGTH;

  const search = useSearch(debounced, { near, viewport, enabled: searching });
  const results = useMemo(() => search.data?.results ?? [], [search.data]);

  /** Nearest first from the browsed centre — the same ordering the browse list uses. */
  const nearby = useMemo(() => {
    if (!center) return places.slice(0, NEARBY_LIMIT);
    return places
      .map((place) => ({ ...place, distanceMeters: distanceMeters(center, place.location) }))
      .sort((a, b) => a.distanceMeters - b.distanceMeters)
      .slice(0, NEARBY_LIMIT);
  }, [center, places]);

  return (
    <View className="pb-space-16" testID={testID}>
      <View className="flex-row flex-wrap items-center gap-space-8 px-space-16 pb-space-8">
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiFocus3Line}
          onPress={onUseDevice}
          disabled={locationBusy}
          accessibilityLabel={`Use your location as the ${slotName.toLowerCase()}`}
        >
          Your location
        </Button>
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiMap2Line}
          onPress={onChooseOnMap}
          accessibilityLabel={`Choose the ${slotName.toLowerCase()} on the map`}
        >
          Choose on map
        </Button>
        {/* Opening a field must not be a one-way door: changing your mind
            leaves the field exactly as it was. */}
        <Button
          variant="text"
          size="small"
          onPress={onCancel}
          accessibilityLabel={`Stop editing the ${slotName.toLowerCase()}`}
        >
          Cancel
        </Button>
      </View>

      {locationBusy ? (
        <View className="flex-row items-center gap-space-8 px-space-16 pb-space-8">
          <Loading variant="spinner" size="small" />
          <Text className="text-bodySmall text-muted-foreground">Finding your location…</Text>
        </View>
      ) : null}

      {/* Four reasons a location can be missing, four sentences, and a way
          forward that is never a silent substitution of somewhere the user
          never said they were. */}
      {locationFailure && !locationBusy ? (
        <LocationFailureState
          reason={locationFailure}
          canAskAgain={canAskLocationAgain}
          onRetry={onRetryLocation}
          onUseMapOrigin={onUseMapCentre ?? undefined}
        />
      ) : null}

      <Divider />

      {searching ? (
        <SearchResults
          busy={search.isFetching}
          failure={failureOf(search.error)}
          query={debounced.trim()}
          results={results}
          slotName={slotName}
          onPickResult={onPickResult}
        />
      ) : (
        <View>
          <Text className="px-space-16 pt-space-12 pb-space-4 text-caption text-muted-foreground">
            {nearby.length > 0 ? 'Nearby' : 'Type to search for a place or an address.'}
          </Text>
          <View accessibilityRole="list" accessibilityLabel={`Nearby places to use as the ${slotName.toLowerCase()}`}>
            {nearby.map((place) => (
              <PlaceRow
                key={place.id}
                place={place}
                onPress={() => onPickPlace(place)}
                testID={`stop-nearby-${place.id}`}
              />
            ))}
          </View>
        </View>
      )}
    </View>
  );
}

/**
 * An error the picker should react to.
 *
 * `aborted` is filtered out: the app cancelled that request itself when the
 * next keystroke arrived, and "something went wrong" for a superseded search is
 * the classic debounce bug.
 */
function failureOf(error: unknown): GoWayFailureKind | null {
  if (!error) return null;
  const { kind } = classifyGoWayError(error);
  return kind === 'aborted' ? null : kind;
}

function SearchResults({
  busy,
  failure,
  query,
  results,
  slotName,
  onPickResult,
}: {
  busy: boolean;
  failure: GoWayFailureKind | null;
  query: string;
  results: readonly SearchResult[];
  slotName: string;
  onPickResult: (result: SearchResult) => void;
}) {
  if (failure) return <FailureState kind={failure} what="search" />;
  if (busy && results.length === 0) {
    return (
      <View className="flex-row items-center gap-space-8 px-space-16 py-space-16">
        <Loading variant="spinner" size="small" />
        <Text className="text-bodySmall text-muted-foreground">Searching…</Text>
      </View>
    );
  }
  if (results.length === 0) return <NoResultsState query={query} />;

  return (
    <View accessibilityRole="list" accessibilityLabel={`Results for ${query}, to use as the ${slotName.toLowerCase()}`}>
      {results.map((result) => (
        <SearchResultRow
          key={result.id}
          result={result}
          onPress={() => onPickResult(result)}
          testID={`stop-result-${result.id}`}
        />
      ))}
    </View>
  );
}

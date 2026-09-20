/**
 * The planner's chrome: the A→B fields, and what sits under them.
 *
 * Split the same way the explore screen is, into a sticky HEADER and a
 * scrolling BODY, because the sheet and the side panel both take those two
 * slots and the planner has no business inventing a third container.
 *
 * What goes where is a question about what must stay on screen while the rest
 * scrolls: the itinerary must — it is what the user is editing, and a turn list
 * that pushes the From field off the top is a form you cannot see. So the
 * header is the fields, the swap and "Add stop", and the body is whatever the
 * itinerary currently implies: a picker while a slot is being filled, a place
 * to tap while a point is being chosen on the map, and otherwise the route.
 */
import { useCallback } from 'react';
import { View } from 'react-native';
import type { TravelMode } from '@goway.to/sdk';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { Divider } from '@oxy.so/bloom/divider';
import { Loading } from '@oxy.so/bloom/loading';
import { Text } from '@oxy.so/bloom/typography';
import { TextField, TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { RiAddLine } from '@oxy.so/bloom/icons/RiAddLine';
import { RiArrowDownLine } from '@oxy.so/bloom/icons/RiArrowDownLine';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowUpDownLine } from '@oxy.so/bloom/icons/RiArrowUpDownLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiBikeLine } from '@oxy.so/bloom/icons/RiBikeLine';
import { RiCarLine } from '@oxy.so/bloom/icons/RiCarLine';
import { RiCloseLine } from '@oxy.so/bloom/icons/RiCloseLine';
import { RiDeleteBinLine } from '@oxy.so/bloom/icons/RiDeleteBinLine';
import { RiMap2Line } from '@oxy.so/bloom/icons/RiMap2Line';
import { RiWalkLine } from '@oxy.so/bloom/icons/RiWalkLine';

import type { GeoBounds } from '@/components/map';
import type { GeoCoordinate, Place } from '@goway.to/sdk';
import { formatDistance, formatDuration } from '@/lib/goway/format';

import { LocationFailureState } from '../explore/states';

import { ManeuverList } from './ManeuverList';
import { StopPicker } from './StopPicker';
import { slotLabel, slotName, type DirectionsStop } from './stops';
import type { DirectionsController } from './useDirections';

const MODE_ICONS = { walk: RiWalkLine, bike: RiBikeLine, drive: RiCarLine } as const;
const MODE_LABELS: Record<TravelMode, string> = { walk: 'Walk', bike: 'Bike', drive: 'Drive' };
const MODES = ['walk', 'bike', 'drive'] as const;

// ── Header ──────────────────────────────────────────────────────────────────

export interface DirectionsHeaderProps {
  directions: DirectionsController;
  testID?: string;
}

export function DirectionsHeader({ directions, testID }: DirectionsHeaderProps) {
  const { stops } = directions;
  const total = stops.length;

  return (
    <View className="gap-space-8 px-space-16 py-space-8" testID={testID}>
      <View className="flex-row items-start gap-space-8">
        <GlyphButton
          icon={RiArrowLeftLine}
          size={36}
          accessibilityLabel="Leave directions and go back to the map"
          onPress={directions.close}
        />

        <View className="flex-1 gap-space-4">
          {stops.map((stop, index) => (
            <StopField
              key={stop ? stop.id : `empty-${index}`}
              index={index}
              total={total}
              stop={stop}
              directions={directions}
            />
          ))}
        </View>

        {/* Swap reverses the WHOLE itinerary — see `useDirections`. Disabled
            rather than hidden while there is nothing to reverse, so the control
            does not appear and disappear under the user's thumb. */}
        <GlyphButton
          icon={RiArrowUpDownLine}
          size={36}
          disabled={stops.every((stop) => stop == null)}
          accessibilityLabel={
            total > 2
              ? 'Reverse the route, so it runs from the destination back to the start'
              : 'Swap the starting point and the destination'
          }
          onPress={directions.swap}
        />
      </View>

      {directions.canAddStop ? (
        <View className="flex-row">
          <Button
            variant="text"
            size="xs"
            leadingIcon={RiAddLine}
            onPress={directions.addStop}
            accessibilityLabel="Add a stop along the way"
          >
            Add stop
          </Button>
        </View>
      ) : null}
    </View>
  );
}

function StopField({
  index,
  total,
  stop,
  directions,
}: {
  index: number;
  total: number;
  stop: DirectionsStop | null;
  directions: DirectionsController;
}) {
  const theme = useTheme();
  const name = slotName(index, total);
  const editing = directions.editing === index;
  const intermediate = index > 0 && index < total - 1;

  const onFocus = useCallback(() => directions.beginEdit(index), [directions, index]);
  const onChangeText = useCallback((value: string) => directions.setDraft(value), [directions]);

  return (
    <View className="flex-row items-center gap-space-8">
      {/* The letter is drawn AND spoken (the field's own label names the slot),
          so the A/B pairing is never carried by position alone. */}
      <View
        className="h-6 w-6 items-center justify-center rounded-radius-max bg-muted"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <Text className="text-caption" style={{ color: theme.colors.textSecondary }}>
          {slotLabel(index, total)}
        </Text>
      </View>

      <View className="flex-1">
        <TextField size="small">
          <TextFieldInput
            label={name}
            // While a slot is being re-filled the field is empty and the OLD
            // value becomes the placeholder: the user can see what they are
            // replacing without having to delete it first.
            placeholder={stop ? stop.label : placeholderFor(index, total)}
            value={editing ? directions.draft : (stop?.label ?? '')}
            onFocus={onFocus}
            onChangeText={onChangeText}
            returnKeyType="search"
            autoCorrect={false}
            autoCapitalize="none"
            testID={`stop-field-${index}`}
          />
        </TextField>
      </View>

      {stop ? (
        <GlyphButton
          icon={RiCloseLine}
          size={28}
          glyphSize={14}
          accessibilityLabel={`Clear the ${name.toLowerCase()}`}
          onPress={() => directions.clearStop(index)}
        />
      ) : null}

      {/* Reordering is CLIENT-SIDE: it changes the order we send in
          `waypoints`, which the engine visits literally. Nothing here asks for
          an optimised sequence, and nothing claims one. */}
      {intermediate ? (
        <View className="flex-row items-center">
          <GlyphButton
            icon={RiArrowUpLine}
            size={28}
            glyphSize={14}
            disabled={index <= 1}
            accessibilityLabel={`Move ${name.toLowerCase()} earlier in the route`}
            onPress={() => directions.moveStop(index, -1)}
          />
          <GlyphButton
            icon={RiArrowDownLine}
            size={28}
            glyphSize={14}
            disabled={index >= total - 2}
            accessibilityLabel={`Move ${name.toLowerCase()} later in the route`}
            onPress={() => directions.moveStop(index, 1)}
          />
          <GlyphButton
            icon={RiDeleteBinLine}
            size={28}
            glyphSize={14}
            accessibilityLabel={`Remove ${name.toLowerCase()} from the route`}
            onPress={() => directions.removeStop(index)}
          />
        </View>
      ) : null}
    </View>
  );
}

function placeholderFor(index: number, total: number): string {
  if (index === 0) return 'Choose a starting point';
  if (index === total - 1) return 'Choose a destination';
  return 'Choose a stop along the way';
}

// ── Body ────────────────────────────────────────────────────────────────────

export interface DirectionsBodyProps {
  directions: DirectionsController;
  /** The browse query's places and its centre, reused by the stop picker. */
  places: readonly Place[];
  center: GeoCoordinate | null;
  viewport: GeoBounds | null;
  /** The user's own position, when already known. Biases the picker's search. */
  near: GeoCoordinate | null;
  testID?: string;
}

export function DirectionsBody({
  directions,
  places,
  center,
  viewport,
  near,
  testID,
}: DirectionsBodyProps) {
  const theme = useTheme();
  const total = directions.stops.length;

  if (directions.picking != null) {
    const name = slotName(directions.picking, total);
    return (
      <View className="items-center gap-space-8 px-space-24 py-space-32" testID={testID}>
        <RiMap2Line width={24} height={24} fill={theme.colors.textSecondary} />
        <Text className="text-subtitle text-foreground text-center">{`Tap the map to set the ${name.toLowerCase()}`}</Text>
        <Text className="text-bodySmall text-muted-foreground text-center">
          Drag the map to where you mean, then tap the spot. GoWay will name it if it recognises it.
        </Text>
        <View className="pt-space-8">
          <Button variant="secondary" size="small" onPress={directions.cancelPicking}>
            Cancel
          </Button>
        </View>
      </View>
    );
  }

  if (directions.editing != null) {
    const slot = directions.editing;
    return (
      <StopPicker
        slotName={slotName(slot, total)}
        draft={directions.draft}
        near={near}
        viewport={viewport}
        center={center}
        places={places}
        onPickPlace={(place) => directions.setStopFromPlace(slot, place)}
        onPickResult={(result) => directions.setStopFromResult(slot, result)}
        onUseDevice={() => directions.setStopFromDevice(slot)}
        onChooseOnMap={() => directions.chooseOnMap(slot)}
        onCancel={directions.endEdit}
        // Offered for the STARTING POINT only: "route from the map instead" is
        // a true sentence about an origin and a confusing one about a stop,
        // which already has "Choose on map" right above it.
        onUseMapCentre={
          slot === 0 && directions.setStopFromMapCentre
            ? () => directions.setStopFromMapCentre?.(0)
            : null
        }
        locationBusy={directions.locationBusy}
        locationFailure={directions.locationSlot === slot ? directions.locationFailure : null}
        canAskLocationAgain={directions.canAskLocationAgain}
        onRetryLocation={directions.retryLocation}
        testID={testID}
      />
    );
  }

  return <RouteBody directions={directions} testID={testID} />;
}

function RouteBody({ directions, testID }: { directions: DirectionsController; testID?: string }) {
  const { route, stops } = directions;
  const origin = stops[0];
  const total = stops.length;

  return (
    <View className="gap-space-12 pb-space-16" testID={testID}>
      <View className="flex-row items-center gap-space-8 px-space-16 pt-space-8">
        {MODES.map((mode) => {
          const Icon = MODE_ICONS[mode];
          const active = mode === directions.travelMode;
          return (
            <Button
              key={mode}
              variant={active ? 'primary' : 'secondary'}
              size="xs"
              leadingIcon={Icon}
              onPress={() => directions.setTravelMode(mode)}
              accessibilityLabel={`${MODE_LABELS[mode]} directions${active ? ', selected' : ''}`}
            >
              {MODE_LABELS[mode]}
            </Button>
          );
        })}
      </View>

      {/* Waiting for a permission and waiting for a router are different waits,
          and they are said differently. */}
      {directions.locationBusy ? (
        <Wait>Finding your location…</Wait>
      ) : null}
      {directions.routeBusy ? <Wait>Working out the route…</Wait> : null}

      {/* An itinerary with a hole in it is not a failure; it is a form that is
          not finished, and saying which field is empty is more use than a
          disabled button with no explanation. */}
      {!directions.ready && !directions.degenerate ? (
        <Text className="px-space-16 text-bodySmall text-muted-foreground">
          {missingStopSentence(stops)}
        </Text>
      ) : null}

      {directions.degenerate ? (
        <Text className="px-space-16 text-bodySmall text-muted-foreground">
          The start and the destination are the same place. Change one of them to get a route.
        </Text>
      ) : null}

      {/* The state the old Directions button was missing entirely. It belongs
          HERE as well as in the picker, because the most common way to meet it
          is the one-tap path: Directions asks the device for the starting
          point, the answer is no, and nothing has been opened for editing. */}
      {directions.locationFailure && !directions.locationBusy ? (
        <LocationFailureState
          reason={directions.locationFailure}
          canAskAgain={directions.canAskLocationAgain}
          onRetry={directions.retryLocation}
          onUseMapOrigin={
            directions.locationSlot === 0 && directions.setStopFromMapCentre
              ? () => directions.setStopFromMapCentre?.(0)
              : undefined
          }
        />
      ) : null}

      {route ? (
        <View className="gap-space-4 px-space-16">
          <Text className="text-sectionTitle text-foreground">
            {`${formatDuration(route.durationSeconds)} · ${formatDistance(route.distanceMeters)}`}
          </Text>
          <Text className="text-caption text-muted-foreground">
            {summaryLine(directions, total)}
          </Text>
          {/* A route measured from a point on the map is never allowed to read
              as a route from the user. Saying so is why a stop carries where it
              came from at all. */}
          {origin?.source === 'map' ? (
            <Text className="text-caption text-muted-foreground">
              Measured from a point on the map, not from your location.
            </Text>
          ) : null}
        </View>
      ) : null}

      {directions.routeFailure === 'noRoute' ? (
        <Text className="px-space-16 text-bodySmall text-muted-foreground">
          {`No ${MODE_LABELS[directions.travelMode].toLowerCase()} route between these stops. Try another travel mode, or move a stop.`}
        </Text>
      ) : null}
      {directions.routeFailure && directions.routeFailure !== 'noRoute' ? (
        <View className="gap-space-8 px-space-16">
          <Text className="text-bodySmall text-muted-foreground">
            {directions.routeFailure === 'offline'
              ? "Directions need a connection, and GoWay can't reach the network."
              : "Directions aren't available right now."}
          </Text>
          <View className="flex-row">
            <Button variant="secondary" size="small" onPress={directions.retryRoute}>
              Try again
            </Button>
          </View>
        </View>
      ) : null}

      {route && directions.steps.length > 0 ? (
        <>
          <Divider />
          <ManeuverList
            steps={directions.steps}
            stops={stops}
            selected={directions.selectedStep}
            onSelect={directions.selectStep}
            testID="directions-maneuvers"
          />
        </>
      ) : null}

      {/* Leaving is one control, not two: there is no state where "clear the
          route" and "stop planning" are usefully different, and the map is not
          moved on the way out — browsing resumes exactly where it is. */}
      <View className="flex-row px-space-16">
        <Button
          variant="secondary"
          size="small"
          leadingIcon={RiCloseLine}
          onPress={directions.close}
          accessibilityLabel={
            route
              ? 'Clear the route and go back to browsing the map'
              : 'Leave directions and go back to browsing the map'
          }
        >
          {route ? 'Clear route' : 'Cancel'}
        </Button>
      </View>
    </View>
  );
}

function Wait({ children }: { children: string }) {
  return (
    <View className="flex-row items-center gap-space-8 px-space-16">
      <Loading variant="spinner" size="small" />
      <Text className="text-bodySmall text-muted-foreground">{children}</Text>
    </View>
  );
}

/** "Choose a destination" — naming the empty field, not just refusing to route. */
function missingStopSentence(stops: readonly (DirectionsStop | null)[]): string {
  const missing = stops
    .map((stop, index) => (stop ? null : slotName(index, stops.length)))
    .filter((name): name is string => name != null);
  if (missing.length === 0) return '';
  if (missing.length === 1) return `Choose a ${missing[0].toLowerCase()} to get directions.`;
  return `Choose a ${missing.map((name) => name.toLowerCase()).join(' and a ')} to get directions.`;
}

/** "Walking, via 2 stops" — what the numbers above are actually measuring. */
function summaryLine(directions: DirectionsController, total: number): string {
  const via = Math.max(0, total - 2);
  const mode = MODE_LABELS[directions.travelMode];
  return via === 0 ? mode : `${mode} · via ${via} ${via === 1 ? 'stop' : 'stops'}`;
}

/**
 * The ways into the landmark tour (`docs/MAP_LANDMARKS.md` → Tour):
 *
 *  - {@link LandmarksPill}: a "Landmarks" control in the map's top-right
 *    stack whenever a landmark is within reach of the view (icon only on a
 *    phone); it opens the tour on the nearest.
 *  - {@link LandmarkPlaceAction}: a "Landmark tour" button in a place's sheet
 *    when that place IS a landmark — matched on its OpenStreetMap source (or
 *    its GoWay Place ID), never on a name (`landmarkForPlace`).
 */
import { View } from 'react-native';
import { localizedLabel, type Place } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { Fab } from '@oxy.so/bloom/fab';
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';

import { formatMessage, useTranslation } from '@/lib/i18n';
import { distanceMeters } from '@/lib/map/geo';
import { LANDMARK_ENTRY_LABELS } from '@/lib/map/landmarks/labels';
import type { PreparedLandmark } from '@/lib/map/landmarks/load';
import { landmarkForPlace } from '@/lib/map/landmarks/match';

import { useLandmarks } from './useLandmarks';

/** The pill shows while a landmark is within this distance of the view's centre. */
export const PILL_RADIUS_M = 6_000;

export function nearestLandmark(
  landmarks: readonly PreparedLandmark[],
  centre: { latitude: number; longitude: number } | null,
): PreparedLandmark | null {
  if (!centre) return null;
  let best: { landmark: PreparedLandmark; d: number } | null = null;
  for (const landmark of landmarks) {
    const d = distanceMeters(centre, landmark.placement.position);
    if (d <= PILL_RADIUS_M && (!best || d < best.d)) best = { landmark, d };
  }
  return best?.landmark ?? null;
}

/**
 * The pill, IN FLOW: the screen places it in its top-right stack, under the
 * settings button, so it never lands on another control. The same round
 * control as the rest of that stack; on a phone (`compact`) its word folds
 * away and only the building and its name for screen readers remain, so the
 * stack stays one narrow column — the place sheet's "Landmark tour" is the
 * other way in.
 */
export function LandmarksPill({
  landmarks,
  centre,
  onOpen,
  compact = false,
}: {
  landmarks: readonly PreparedLandmark[];
  centre: { latitude: number; longitude: number } | null;
  onOpen: (id: string) => void;
  /** A phone: icon only, the smaller round control like the rest of its stack. */
  compact?: boolean;
}) {
  const { locale } = useTranslation();
  const nearest = nearestLandmark(landmarks, centre);
  if (!nearest) return null;
  return (
    <View pointerEvents="box-none">
      <Fab
        size={compact ? 'xs' : 'sm'}
        icon={RiBuilding2Line}
        iconSize={compact ? 20 : 22}
        label={localizedLabel(LANDMARK_ENTRY_LABELS.pill, locale)}
        collapsed={compact}
        appearance="subtle"
        tone="neutral"
        onPress={() => onOpen(nearest.entry.id)}
        accessibilityLabel={formatMessage(localizedLabel(LANDMARK_ENTRY_LABELS.pillName, locale), {
          name: nearest.entry.name,
        })}
        testID="landmarks-pill"
      />
    </View>
  );
}

/** {@link LandmarksPill} with the registry loaded — what `ExploreScreen` stacks. */
export function LandmarksPillEntry({
  centre,
  onOpen,
  compact = false,
}: {
  centre: { latitude: number; longitude: number } | null;
  onOpen: (id: string) => void;
  compact?: boolean;
}) {
  return (
    <LandmarksPill landmarks={useLandmarks()} centre={centre} onOpen={onOpen} compact={compact} />
  );
}

export function LandmarkPlaceAction({
  place,
  onOpen,
}: {
  place: Place;
  onOpen: (id: string) => void;
}) {
  const { locale } = useTranslation();
  const landmark = landmarkForPlace(useLandmarks(), place);
  if (!landmark) return null;
  return (
    <Button
      size="sm"
      leadingIcon={RiBuilding2Line}
      onPress={() => onOpen(landmark.entry.id)}
      accessibilityLabel={formatMessage(
        localizedLabel(LANDMARK_ENTRY_LABELS.placeActionName, locale),
        { name: landmark.entry.name },
      )}
      tone="neutral"
      appearance="outline"
      testID="landmark-place-action"
    >
      {localizedLabel(LANDMARK_ENTRY_LABELS.placeAction, locale)}
    </Button>
  );
}

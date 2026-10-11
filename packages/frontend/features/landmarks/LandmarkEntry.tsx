/**
 * The ways into the landmark tour (`docs/MAP_LANDMARKS.md` → Tour):
 *
 *  - {@link LandmarksPill}: a "Landmarks" pill over the map whenever a
 *    landmark is within reach of the view; it opens the tour on the nearest.
 *  - {@link LandmarkPlaceAction}: a "Landmark tour" button in a place's sheet
 *    when that place IS a landmark — matched on its OpenStreetMap source (or
 *    its GoWay Place ID), never on a name (`landmarkForPlace`).
 */
import { View } from 'react-native';
import type { Place } from '@goway.to/sdk';
import { Button } from '@oxy.so/bloom/button';
import { RiBuilding2Line } from '@oxy.so/bloom/icons/RiBuilding2Line';

import { distanceMeters } from '@/lib/map/geo';
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
 * layers button, so it never lands on another chip.
 */
export function LandmarksPill({
  landmarks,
  centre,
  onOpen,
}: {
  landmarks: readonly PreparedLandmark[];
  centre: { latitude: number; longitude: number } | null;
  onOpen: (id: string) => void;
}) {
  const nearest = nearestLandmark(landmarks, centre);
  if (!nearest) return null;
  return (
    <View pointerEvents="box-none">
      <Button
        size="sm"
        leadingIcon={RiBuilding2Line}
        appearance="solid"
        tone="neutral"
        onPress={() => onOpen(nearest.entry.id)}
        accessibilityLabel={`Landmarks tour, starting at ${nearest.entry.name}`}
        testID="landmarks-pill"
      >
        Landmarks
      </Button>
    </View>
  );
}

/** {@link LandmarksPill} with the registry loaded — what `ExploreScreen` stacks. */
export function LandmarksPillEntry({
  centre,
  onOpen,
}: {
  centre: { latitude: number; longitude: number } | null;
  onOpen: (id: string) => void;
}) {
  return <LandmarksPill landmarks={useLandmarks()} centre={centre} onOpen={onOpen} />;
}

export function LandmarkPlaceAction({
  place,
  onOpen,
}: {
  place: Place;
  onOpen: (id: string) => void;
}) {
  const landmark = landmarkForPlace(useLandmarks(), place);
  if (!landmark) return null;
  return (
    <Button
      size="sm"
      leadingIcon={RiBuilding2Line}
      onPress={() => onOpen(landmark.entry.id)}
      accessibilityLabel={`Landmark tour of ${landmark.entry.name}`}
      tone="neutral"
      appearance="outline"
      testID="landmark-place-action"
    >
      Landmark tour
    </Button>
  );
}

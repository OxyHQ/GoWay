/**
 * The turn-by-turn list: GoWay's route steps in Bloom's `DirectionsSteps`.
 *
 * `RouteLeg.maneuvers` has been populated by the backend since routing landed;
 * this is where they are read. Selecting a step is not decoration: it drives
 * the map, through the `geometryIndex` the contract carries on every maneuver
 * (see `maneuvers.ts`). The selection is a single choice, marked on screen and
 * named in the row's announcement by Bloom (`currentStepId`), and pressing the
 * selected step again clears it — a toggle, not a trap.
 *
 * With waypoints a route has several legs, and a leg heading is the only thing
 * that tells the user which stop the next dozen turns are about; a single leg
 * gets no heading.
 */
import { useMemo } from 'react';
import type { TravelMode } from '@goway.to/sdk';
import {
  type DirectionsLeg,
  type DirectionsManeuver,
  type DirectionsMode,
  DirectionsSteps,
} from '@oxy.so/bloom/directions';
import { Text } from '@oxy.so/bloom/typography';

import { formatDistance, formatDuration } from '@/lib/goway/format';

import type { RouteStep } from './maneuvers';
import type { DirectionsStop } from './stops';

/**
 * `ManeuverType` is an OPEN union — a router may emit a type this version has
 * never heard of — so anything unknown is a plain "carry on".
 */
const MANEUVER: Readonly<Record<string, DirectionsManeuver>> = {
  depart: 'depart',
  continue: 'straight',
  'turn-left': 'left',
  'turn-right': 'right',
  'turn-slight-left': 'slight-left',
  'turn-slight-right': 'slight-right',
  'turn-sharp-left': 'sharp-left',
  'turn-sharp-right': 'sharp-right',
  uturn: 'uturn',
  merge: 'merge',
  fork: 'straight',
  'roundabout-enter': 'roundabout',
  'roundabout-exit': 'roundabout',
  ferry: 'transfer',
  arrive: 'arrive',
};

const MODE: Readonly<Record<TravelMode, DirectionsMode>> = {
  drive: 'drive',
  walk: 'walk',
  bike: 'cycle',
};

export function maneuverOf(type: string): DirectionsManeuver {
  return MANEUVER[type] ?? 'straight';
}

export interface ManeuverListProps {
  steps: readonly RouteStep[];
  /** The itinerary, so a leg can be headed with the stop it ends at. */
  stops: readonly (DirectionsStop | null)[];
  mode: TravelMode;
  selected: number | null;
  /** Pressing the selected step again clears it — a toggle, not a trap. */
  onSelect: (index: number | null) => void;
  testID?: string;
}

export function ManeuverList({
  steps,
  stops,
  mode,
  selected,
  onSelect,
  testID,
}: ManeuverListProps) {
  const legs = useMemo<DirectionsLeg[]>(() => {
    /** Leg headings only earn their space once there is more than one leg. */
    const multiLeg = steps.some((step) => step.legIndex > 0);
    const byLeg = new Map<number, DirectionsLeg['steps'][number][]>();
    for (const step of steps) {
      const { maneuver } = step;
      const detail = [
        maneuver.streetName,
        maneuver.durationSeconds > 0 ? formatDuration(maneuver.durationSeconds) : null,
      ]
        .filter(Boolean)
        .join(' · ');
      const entry = {
        id: String(step.index),
        instruction: maneuver.instruction,
        maneuver: maneuverOf(maneuver.type),
        distance: maneuver.distanceMeters > 0 ? formatDistance(maneuver.distanceMeters) : undefined,
        detail: detail || undefined,
        // Said out loud rather than implied: without a geometry index the map
        // can only mark the point, not the stretch.
        accessibilityLabel: [
          `Step ${step.index + 1} of ${steps.length}`,
          maneuver.instruction,
          detail || null,
          selected === step.index ? 'selected, shown on the map' : null,
          selected === step.index && !step.exact ? 'approximate position on the route' : null,
        ]
          .filter(Boolean)
          .join(', '),
      };
      byLeg.set(step.legIndex, [...(byLeg.get(step.legIndex) ?? []), entry]);
    }
    return [...byLeg.entries()].map(([legIndex, legSteps]) => ({
      id: String(legIndex),
      title: multiLeg ? legHeading(legIndex, stops) : undefined,
      mode: MODE[mode],
      steps: legSteps,
    }));
  }, [steps, stops, mode, selected]);

  if (steps.length === 0) return null;

  return (
    <>
      <Text className="px-space-16 pt-space-8 pb-space-4 text-caption text-muted-foreground">
        {`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
      </Text>
      <DirectionsSteps
        legs={legs}
        currentStepId={selected === null ? undefined : String(selected)}
        onPressStep={(id) => onSelect(selected === Number(id) ? null : Number(id))}
        accessibilityLabel="Directions, step by step"
        testID={testID}
      />
    </>
  );
}

/** "To <the stop this leg ends at>", or a plain leg number when it has no name. */
function legHeading(legIndex: number, stops: readonly (DirectionsStop | null)[]): string {
  const destination = stops[legIndex + 1];
  return destination ? `To ${destination.label}` : `Leg ${legIndex + 1}`;
}

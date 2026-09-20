/**
 * The turn-by-turn list.
 *
 * `RouteLeg.maneuvers` has been populated by the backend since routing landed
 * and was rendered nowhere, so a user could see that a walk was 14 minutes and
 * not one word about which way to go.
 *
 * Selecting a step is not decoration: it drives the map, through the
 * `geometryIndex` the contract carries on every maneuver (see `maneuvers.ts`).
 * The selection is therefore a real, single-choice list — one row selected at a
 * time, `role="option"` so the web announces it as one, and the selected row
 * says "selected" in its accessible name rather than relying on the tinted
 * background Bloom gives it. Colour is never the only signal; neither is the
 * glyph, which only ever repeats what the instruction text already says.
 *
 * With waypoints a route has several legs, and a leg heading is the only thing
 * that tells the user which stop the next dozen turns are about.
 */
import { View } from 'react-native';
import { Item } from '@oxy.so/bloom/item';
import { Text } from '@oxy.so/bloom/typography';
import { useTheme } from '@oxy.so/bloom/theme';
import type { BloomIconComponent } from '@oxy.so/bloom/icons';
import { RiArrowLeftLine } from '@oxy.so/bloom/icons/RiArrowLeftLine';
import { RiArrowRightLine } from '@oxy.so/bloom/icons/RiArrowRightLine';
import { RiArrowUpLine } from '@oxy.so/bloom/icons/RiArrowUpLine';
import { RiCornerUpLeftLine } from '@oxy.so/bloom/icons/RiCornerUpLeftLine';
import { RiFlagLine } from '@oxy.so/bloom/icons/RiFlagLine';
import { RiFocus3Line } from '@oxy.so/bloom/icons/RiFocus3Line';
import { RiGuideLine } from '@oxy.so/bloom/icons/RiGuideLine';
import { RiRefreshLine } from '@oxy.so/bloom/icons/RiRefreshLine';

import { formatDistance, formatDuration } from '@/lib/goway/format';

import type { RouteStep } from './maneuvers';
import type { DirectionsStop } from './stops';

/**
 * The glyph for a maneuver type.
 *
 * Redundant emphasis only: every step renders its `instruction` text, and the
 * accessible name is built from the words, never from the glyph. `ManeuverType`
 * is an OPEN union — a router may emit a type this version has never heard
 * of — so the default is a plain "carry on" arrow rather than a blank.
 */
function maneuverIcon(type: string): BloomIconComponent {
  if (type === 'depart') return RiFocus3Line;
  if (type === 'arrive') return RiFlagLine;
  if (type === 'uturn') return RiCornerUpLeftLine;
  if (type.startsWith('roundabout')) return RiRefreshLine;
  if (type === 'ferry') return RiGuideLine;
  if (type.endsWith('-left')) return RiArrowLeftLine;
  if (type.endsWith('-right')) return RiArrowRightLine;
  return RiArrowUpLine;
}

export interface ManeuverListProps {
  steps: readonly RouteStep[];
  /** The itinerary, so a leg can be headed with the stop it ends at. */
  stops: readonly (DirectionsStop | null)[];
  selected: number | null;
  /** Pressing the selected step again clears it — a toggle, not a trap. */
  onSelect: (index: number | null) => void;
  testID?: string;
}

export function ManeuverList({ steps, stops, selected, onSelect, testID }: ManeuverListProps) {
  const theme = useTheme();

  if (steps.length === 0) return null;

  /** Leg headings only earn their space once there is more than one leg. */
  const multiLeg = steps.some((step) => step.legIndex > 0);

  return (
    <View testID={testID}>
      <Text className="px-space-16 pt-space-8 pb-space-4 text-caption text-muted-foreground">
        {`${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`}
      </Text>

      <View
        accessibilityRole="list"
        // One option selected at a time, and the selection moves the map.
        // `Item` spells the matching ARIA for `role="option"`.
        accessibilityLabel="Directions, step by step"
      >
        {steps.map((step) => {
          const Icon = maneuverIcon(step.maneuver.type);
          const isSelected = selected === step.index;
          const detail = [
            step.maneuver.streetName,
            step.maneuver.distanceMeters > 0 ? formatDistance(step.maneuver.distanceMeters) : null,
            step.maneuver.durationSeconds > 0 ? formatDuration(step.maneuver.durationSeconds) : null,
          ]
            .filter(Boolean)
            .join(' · ');

          return (
            <View key={`${step.legIndex}-${step.index}`}>
              {step.firstOfLeg && multiLeg ? (
                <Text className="px-space-16 pt-space-12 pb-space-4 text-caption text-muted-foreground">
                  {legHeading(step.legIndex, stops)}
                </Text>
              ) : null}

              <Item
                role="option"
                selected={isSelected}
                density="compact"
                onPress={() => onSelect(isSelected ? null : step.index)}
                leading={
                  <View className="h-8 w-8 items-center justify-center rounded-radius-max bg-muted">
                    <Icon width={16} height={16} fill={theme.colors.textSecondary} />
                  </View>
                }
                title={step.maneuver.instruction}
                subtitle={detail || undefined}
                accessibilityLabel={[
                  `Step ${step.index + 1} of ${steps.length}`,
                  step.maneuver.instruction,
                  detail || null,
                  isSelected ? 'selected, shown on the map' : null,
                  // Said out loud rather than implied: without a geometry index
                  // the map can only mark the point, not the stretch.
                  isSelected && !step.exact ? 'approximate position on the route' : null,
                ]
                  .filter(Boolean)
                  .join(', ')}
                testID={`maneuver-${step.index}`}
              />
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** "To <the stop this leg ends at>", or a plain leg number when it has no name. */
function legHeading(legIndex: number, stops: readonly (DirectionsStop | null)[]): string {
  const destination = stops[legIndex + 1];
  return destination ? `To ${destination.label}` : `Leg ${legIndex + 1}`;
}

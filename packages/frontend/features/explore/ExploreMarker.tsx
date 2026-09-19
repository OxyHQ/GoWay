/**
 * The marker GoWay draws, which is Bloom's marker plus one fact.
 *
 * `DefaultMapMarker` already picks between Bloom's `MapPriceMarker` and
 * `MapClusterMarker` and carries their default / active / visited states, so
 * this does not re-draw any of it. What it adds is the state issue #7 asks for
 * and Bloom's map-marker family has no opinion about: an **Oxy-enriched**
 * marker — a place asserting a live ecosystem capability — which gets that
 * capability's own glyph in a Bloom `Badge` on the pill's corner.
 *
 * Two deliberate properties:
 *
 *  - **The glyph is not the information.** The marker's `accessibilityLabel`
 *    (built in `lib/goway/markers.ts`) already names the capability in words,
 *    and Bloom hides a badge's icon from assistive technology, so the badge is
 *    redundant emphasis for sighted users rather than a channel of its own.
 *    Colour is therefore never the only indicator, and neither is shape.
 *  - **A stale claim gets no badge.** `presentCapability` demotes a claim that
 *    is too old to be presented as current, and a marker is the least
 *    qualifiable surface in the product — there is nowhere on a 28px pill to
 *    say "reported once, three years ago".
 */
import { memo } from 'react';
import type { PlaceCapability } from '@goway.to/sdk';
import { Badge } from '@oxy.so/bloom/badge';

import { DefaultMapMarker, type MapMarker } from '@/components/map';
import { presentCapability } from '@/lib/goway/capabilities';

export interface ExploreMarkerProps {
  marker: MapMarker;
  /** The strongest live capability this place asserts, if any. */
  capability?: PlaceCapability;
  onPress: () => void;
}

function ExploreMarkerComponent({ marker, capability, onPress }: ExploreMarkerProps) {
  const base = <DefaultMapMarker marker={marker} onPress={onPress} />;

  if (!capability || marker.count != null) return base;

  const presented = presentCapability(capability);
  if (presented.stale) return base;

  return (
    <Badge
      icon={presented.icon}
      size="label-small"
      variant="solid"
      color={presented.tone === 'verified' ? 'success' : 'primary'}
      placement="top-right"
      testID={`marker-capability-${marker.id}`}
    >
      {base}
    </Badge>
  );
}

export const ExploreMarker = memo(ExploreMarkerComponent);

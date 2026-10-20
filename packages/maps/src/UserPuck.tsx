/**
 * Where the reader is, as Bloom's `LocationPuck`: the dot, the accuracy halo
 * at the device's own ± and the heading cone.
 *
 * Bloom draws one square box and the marker centres it on the fix. The halo is
 * in PIXELS, so it is derived from the camera and redrawn on zoom
 * (`userPuck.ts`), through the camera store so nothing around it re-renders.
 */
import { memo } from 'react';
import { LocationPuck } from '@oxy.so/bloom/location-puck';

import { useMapCamera } from './cameraStore';
import { type PuckPaint, puckPaint, samePaint, type UserFix } from './puckPaint';

const NO_PAINT: PuckPaint = { accuracyRadius: undefined, heading: undefined, headingUnknown: true };

function UserPuckComponent({ fix }: { fix: UserFix }) {
  const paint = useMapCamera(
    (viewport) => (viewport ? puckPaint(fix, viewport) : NO_PAINT),
    samePaint,
  );
  return (
    <LocationPuck
      state="located"
      mode="following"
      heading={paint.heading}
      headingUnknown={paint.headingUnknown}
      accuracyRadius={paint.accuracyRadius}
      testID="map-user-location"
    />
  );
}

export const UserPuck = memo(UserPuckComponent);

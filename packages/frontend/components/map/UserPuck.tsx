/**
 * Where the reader is, as Bloom's `LocationPuck`: the dot, the accuracy halo
 * at the device's own ± and the heading cone — one component for web and
 * native.
 *
 * Bloom draws one square box and the canvas centres it on the fix (a MapLibre
 * marker on web, a `<Marker>` on native). The halo is in PIXELS, so it is
 * derived from the camera and redrawn on zoom (`lib/map/userPuck.ts`), through
 * the camera store so the canvas around it does not re-render for it.
 */
import { memo } from 'react';
import { LocationPuck } from '@oxy.so/bloom/location-puck';

import { puckPaint, samePaint, type PuckPaint, type UserFix } from '@/lib/map/userPuck';

import { type MapCameraStore, useCameraValue } from './cameraFeed';

const NO_PAINT: PuckPaint = { accuracyRadius: undefined, heading: undefined, headingUnknown: true };

function UserPuckComponent({ fix, camera }: { fix: UserFix; camera: MapCameraStore }) {
  const paint = useCameraValue(
    camera,
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
      testID="user-puck"
    />
  );
}

export const UserPuck = memo(UserPuckComponent);

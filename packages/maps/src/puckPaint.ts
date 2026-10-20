/**
 * What the location puck draws, from a position fix and the camera.
 *
 * Pure, so the three claims it makes are tests (`test/puckPaint.test.ts`):
 * the accuracy halo is the device's own ± in PIXELS at the current zoom (and
 * absent when the device reported none — a halo of an invented size is a claim
 * about precision nobody measured); the cone points the way the device is
 * MOVING, relative to the map's own rotation; and with no heading there is no
 * cone at all.
 */
import { metresPerPixel } from './scale';

/** A position the device reported. Transient: held in memory only, never stored. */
export interface UserFix {
  latitude: number;
  longitude: number;
  /** ± metres, or `null` when the platform reported none. */
  accuracy: number | null;
  /** Degrees clockwise from north the device is travelling, or `null` when it is not. */
  heading: number | null;
}

export interface PuckPaint {
  /** The halo's radius in px, or `undefined` for none. */
  accuracyRadius: number | undefined;
  /** The cone/chevron direction on screen, 0..360, or `undefined` when unknown. */
  heading: number | undefined;
  headingUnknown: boolean;
}

/** A halo narrower than the dot says nothing. */
const MIN_HALO_PX = 12;

/** The platform's course, or `null`: browsers say `NaN`, native says `-1`, a parked device says nothing. */
export function usableHeading(raw: number | null | undefined): number | null {
  if (raw == null || !Number.isFinite(raw) || raw < 0) return null;
  return raw % 360;
}

export function puckPaint(
  fix: Pick<UserFix, 'latitude' | 'accuracy' | 'heading'>,
  camera: { zoom: number; bearing: number },
): PuckPaint {
  const perPixel = metresPerPixel(fix.latitude, camera.zoom);
  const radius =
    fix.accuracy != null && Number.isFinite(fix.accuracy) && fix.accuracy > 0 && perPixel > 0
      ? Math.round(fix.accuracy / perPixel)
      : undefined;
  const heading = usableHeading(fix.heading);
  return {
    accuracyRadius: radius !== undefined && radius >= MIN_HALO_PX ? radius : undefined,
    // The map may be turned: the cone is drawn on SCREEN, not on the compass.
    heading: heading === null ? undefined : (((heading - camera.bearing) % 360) + 360) % 360,
    headingUnknown: heading === null,
  };
}

export function samePaint(a: PuckPaint, b: PuckPaint): boolean {
  return (
    a.accuracyRadius === b.accuracyRadius &&
    a.heading === b.heading &&
    a.headingUnknown === b.headingUnknown
  );
}

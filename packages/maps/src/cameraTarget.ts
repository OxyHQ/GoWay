/**
 * The VALUE a `<Camera>` target stands for, as a string a binding can key on.
 *
 * A box or a point arrives as a fresh object on every render of a screen that
 * derives it; keying on the object would re-frame the camera on every render,
 * under a reader who has panned away. Keying on its numbers re-frames it only
 * when the target really changed. `null` is "no target".
 */
import type { GeoBoundingBox, GeoCoordinate } from './types';

export function cameraTargetKey(target: {
  bounds?: GeoBoundingBox | null;
  center?: GeoCoordinate | null;
  zoom?: number;
}): string | null {
  const { bounds, center, zoom } = target;
  if (bounds) return `b:${bounds.west},${bounds.south},${bounds.east},${bounds.north}`;
  if (center) return `c:${center.latitude},${center.longitude},${zoom ?? ''}`;
  return null;
}

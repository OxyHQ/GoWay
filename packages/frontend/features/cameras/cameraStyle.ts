/**
 * How cameras are drawn on the map and read in the detail screen — pure, so it
 * is tested without a renderer.
 */
import type { Camera } from '@goway.to/sdk';

import type { GeoBoundingBox, MapCreditLink, MapMarker } from '@/components/map/types';

/** A camera is a street-scale thing; below this zoom it is noise and is not fetched. */
export const CAMERAS_MIN_ZOOM = 12;

/** Marker `kind` for a camera's pin. */
export const CAMERA_MARKER_KIND = 'camera';
const MARKER_PREFIX = 'camera:';

export function shouldFetchCameras(zoom: number | null | undefined): boolean {
  return typeof zoom === 'number' && Number.isFinite(zoom) && zoom >= CAMERAS_MIN_ZOOM;
}

/** The centre of a box, for ranking what is nearest it. */
export function centreOf(bounds: GeoBoundingBox): { latitude: number; longitude: number } {
  const longitude =
    bounds.west <= bounds.east
      ? (bounds.west + bounds.east) / 2
      : normaliseLongitude((bounds.west + bounds.east + 360) / 2);
  return { latitude: (bounds.south + bounds.north) / 2, longitude };
}

function normaliseLongitude(value: number): number {
  return value > 180 ? value - 360 : value;
}

/**
 * The `max` cameras nearest `centre`, nearest first: the quality profile's
 * budget (`QualityProfile.cameras.maxMarkers`) is spent where the person is
 * looking, never on the cameras that happen to sort first by id.
 */
export function nearestCameras(
  cameras: readonly Camera[],
  centre: { latitude: number; longitude: number },
  max: number,
): Camera[] {
  const cosine = Math.cos((centre.latitude * Math.PI) / 180);
  const distance = (camera: Camera) => {
    const dLat = camera.position.latitude - centre.latitude;
    let dLon = Math.abs(camera.position.longitude - centre.longitude);
    if (dLon > 180) dLon = 360 - dLon;
    return dLat * dLat + (dLon * cosine) ** 2;
  };
  return [...cameras].sort((a, b) => distance(a) - distance(b)).slice(0, Math.max(0, max));
}

/** A pin per camera. `label` words the accessible name; pins are never clustered with places. */
export function cameraMarkers(
  cameras: readonly Camera[],
  label: (camera: Camera) => string,
): MapMarker[] {
  return cameras.map((camera) => ({
    id: `${MARKER_PREFIX}${camera.id}`,
    coordinate: camera.position,
    kind: CAMERA_MARKER_KIND,
    accessibilityLabel: label(camera),
  }));
}

/** The camera id behind a marker this module made, or `null` for any other marker. */
export function cameraIdOfMarker(marker: Pick<MapMarker, 'id' | 'kind'>): string | null {
  if (marker.kind !== CAMERA_MARKER_KIND || !marker.id.startsWith(MARKER_PREFIX)) return null;
  const id = marker.id.slice(MARKER_PREFIX.length);
  return id === '' ? null : id;
}

/**
 * The credits owed for the cameras drawn: each provider's own credit with its
 * licence, once (a provider with a hundred pins is one line).
 */
export function cameraCredits(cameras: readonly Camera[]): MapCreditLink[] {
  const seen = new Set<string>();
  const credits: MapCreditLink[] = [];
  for (const { attribution, licence } of cameras) {
    if (seen.has(attribution.label)) continue;
    seen.add(attribution.label);
    credits.push({ label: `${attribution.label} (${licence.label})`, href: attribution.href });
  }
  return credits;
}

/** Seconds since the camera's newest frame, or `null` when none has been seen. */
export function frameAgeSeconds(camera: Pick<Camera, 'lastFrameAt'>, now: number): number | null {
  if (!camera.lastFrameAt) return null;
  const at = Date.parse(camera.lastFrameAt);
  return Number.isFinite(at) ? Math.max(0, Math.round((now - at) / 1000)) : null;
}

/**
 * The still's URL for this moment. Cameras refresh every `refreshSeconds`; the
 * address changes on that beat so the image view fetches the next picture
 * (GoWay's relay answers a repeat within its hold from one copy) and not
 * before.
 */
export function snapshotSource(baseUrl: string, refreshSeconds: number, now: number): string {
  const beat = Math.max(5, refreshSeconds) * 1000;
  return `${baseUrl}?t=${Math.floor(now / beat)}`;
}

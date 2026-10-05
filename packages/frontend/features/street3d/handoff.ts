/**
 * The 2D ⇄ 3D handoff: what the map tells the viewer on the way in, and what
 * the viewer tells the map on the way out.
 *
 * In: the map already has the scene's summary (poster, bounds) from coverage,
 * so the viewer paints the poster on its first frame instead of a spinner while
 * the manifest loads — that poster is the visual bridge the transition scales
 * from.
 *
 * Out: closing the viewer returns to the map framed on the scene's bounds. The
 * map screen stays mounted under the viewer in the stack, so the viewer leaves
 * the bounds here and `ExploreScreen` consumes them when it regains focus and
 * calls `MapApi.fitBounds`. A cold-opened viewer (a shared link, no map behind
 * it) instead navigates to the map with the equivalent `?lat&lng&zoom`.
 *
 * Module state, deliberately: it is one value per direction, consumed once,
 * and never persisted — nothing here is location history.
 */
import type { GeoBoundingBox, StreetSceneSummary } from '@goway.to/sdk';

const summaries = new Map<string, StreetSceneSummary>();
const MAX_SUMMARIES = 50;
let pendingReturn: GeoBoundingBox | null = null;

export function rememberSceneSummary(summary: StreetSceneSummary): void {
  summaries.delete(summary.id);
  summaries.set(summary.id, summary);
  // Bounded: a long session panning a dense city must not grow this forever.
  while (summaries.size > MAX_SUMMARIES) {
    const oldest = summaries.keys().next().value;
    if (oldest === undefined) break;
    summaries.delete(oldest);
  }
}

export function sceneSummary(id: string): StreetSceneSummary | undefined {
  return summaries.get(id);
}

export function setReturnBounds(bounds: GeoBoundingBox): void {
  pendingReturn = bounds;
}

/** The bounds the map should frame on return, once; `null` afterwards. */
export function takeReturnBounds(): GeoBoundingBox | null {
  const bounds = pendingReturn;
  pendingReturn = null;
  return bounds;
}

/**
 * A `?lat&lng&zoom` camera that frames `bounds` in a `width × height` window —
 * the fallback for a viewer with no map underneath it.
 *
 * Web-Mercator maths with 512 px tiles (MapLibre's), padded by `paddingPx` on
 * each side and clamped to street zoom so a tiny scene does not open at z22.
 */
export function viewportForBounds(
  bounds: GeoBoundingBox,
  width: number,
  height: number,
  { paddingPx = 48, maxZoom = 18 }: { paddingPx?: number; maxZoom?: number } = {},
): { latitude: number; longitude: number; zoom: number } {
  const latitude = (bounds.south + bounds.north) / 2;
  const longitude = (bounds.west + bounds.east) / 2;
  const usableWidth = Math.max(64, width - paddingPx * 2);
  const usableHeight = Math.max(64, height - paddingPx * 2);

  const mercatorY = (lat: number) => {
    const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
    const sin = Math.sin((clamped * Math.PI) / 180);
    return 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI);
  };
  const spanX = Math.max(1e-9, (bounds.east - bounds.west) / 360);
  const spanY = Math.max(1e-9, Math.abs(mercatorY(bounds.south) - mercatorY(bounds.north)));
  const zoomX = Math.log2(usableWidth / (512 * spanX));
  const zoomY = Math.log2(usableHeight / (512 * spanY));
  const zoom = Math.max(0, Math.min(maxZoom, Math.min(zoomX, zoomY)));
  return { latitude, longitude, zoom: Math.round(zoom * 100) / 100 };
}

/**
 * Translation helpers shared by the two renderer forks.
 *
 * This is the ONLY place GoWay's `{ latitude, longitude }` becomes MapLibre's
 * `[longitude, latitude]` — once, tested by both forks using it, rather than at
 * every call site where a swapped pair renders a plausible map of the wrong
 * place and nothing errors.
 *
 * It is also the gate. `isDrawableCoordinate` / `drawableMarkers` /
 * `isDrawableBounds` / `resolvePadding` / `asFinite` keep a `NaN` from reaching
 * an engine, which is a THROW rather than a bad frame — see the block comment
 * above {@link isDrawableCoordinate}. `drawableOverlays` covers the one path
 * that fails the OTHER way: raw GeoJSON does not throw, it renders nowhere and
 * says nothing.
 */
import type {
  GeoBounds,
  GeoCoordinate,
  MapInteractionOptions,
  MapMarker,
  MapOverlay,
  MapOverlayKind,
  MapOverlayPaint,
  MapViewport,
} from './types';

/** MapLibre position order, on both engines. */
export type LngLat = [longitude: number, latitude: number];

/** MapLibre `[west, south, east, north]`, on both engines. */
export type LngLatBoundsArray = [west: number, south: number, east: number, north: number];

export function toLngLat(coordinate: GeoCoordinate): LngLat {
  return [coordinate.longitude, coordinate.latitude];
}

export function fromLngLat(position: readonly [number, number]): GeoCoordinate {
  return { longitude: position[0], latitude: position[1] };
}

export function toBoundsArray(bounds: GeoBounds): LngLatBoundsArray {
  return [bounds.west, bounds.south, bounds.east, bounds.north];
}

/** Every interaction is on unless a caller turns it off. */
export function resolveInteraction(options?: MapInteractionOptions): Required<MapInteractionOptions> {
  return {
    pan: options?.pan ?? true,
    zoom: options?.zoom ?? true,
    rotate: options?.rotate ?? true,
    pitch: options?.pitch ?? true,
  };
}

/**
 * Fill in a neutral overlay paint.
 *
 * `accent` is the theme's primary, passed in by the fork so this module stays
 * free of a theme import (and so an overlay can override it per call).
 */
export function resolveOverlayPaint(
  kind: MapOverlayKind,
  paint: MapOverlayPaint | undefined,
  accent: string,
): Required<Omit<MapOverlayPaint, 'outlineColor'>> & { outlineColor: string } {
  const color = paint?.color ?? accent;
  // `asFinite` on the numbers for the same reason as everywhere else in this
  // file: these go into a style layer's paint, and a non-finite one is rejected
  // by MapLibre's style validator — which fails the whole `addLayer`, so the
  // overlay does not appear at all. A default width is a visible line.
  return {
    color,
    width: asFinite(paint?.width) ?? 4,
    opacity: asFinite(paint?.opacity) ?? (kind === 'fill' ? 0.15 : 1),
    outlineColor: paint?.outlineColor ?? color,
    radius: asFinite(paint?.radius) ?? 6,
  };
}

/**
 * Normalise a `moveTo` target: a bare coordinate leaves the camera's zoom alone.
 *
 * `Number.isFinite`, not `typeof === 'number'` — `typeof NaN` IS `'number'`, so
 * the old test accepted `{ latitude, longitude, zoom: NaN }` as a viewport and
 * passed that `NaN` on to the engine. See {@link asFinite} for what that costs.
 * A viewport whose zoom is not a number is treated as the bare coordinate it
 * usefully is.
 */
export function isViewport(target: GeoCoordinate | MapViewport): target is MapViewport {
  return Number.isFinite((target as MapViewport).zoom);
}

/**
 * A camera scalar the engine can use, or `undefined`.
 *
 * Zoom, bearing, pitch, duration and maxZoom are the seam's unchecked numbers,
 * and a `NaN` in any of them is not a bad frame — it is the SAME crash a bad
 * coordinate is, one step later. `transform.setZoom(NaN)` survives MapLibre's
 * own `clamp` (every comparison against `NaN` is false), so `_scale` and
 * `worldSize` become `NaN`; the next unprojection — `map.getBounds()`, which
 * this canvas calls on every `move` event, and which `jumpTo` fires
 * SYNCHRONOUSLY — builds a `LngLat` out of two `NaN`s and throws
 * `Invalid LngLat object: (NaN, NaN)` from inside the caller's own React
 * handler. The camera simply not moving is the better failure.
 */
export function asFinite(value: number | null | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Fit padding, expanded to the four-sided form both engines want — or `null`
 * when it is not a number the engine can use.
 *
 * See {@link isDrawableCoordinate} for why a non-finite number is refused here
 * rather than passed on: MapLibre's `cameraForBoxAndBearing` divides the free
 * viewport by the padding, and `NaN` propagates all the way to the LngLat it
 * constructs for the new centre, which throws. A NEGATIVE padding does not
 * throw, but it is never what a caller meant (it frames content OUTSIDE the
 * viewport), and a negative pair is one of the ways the free space lands on
 * exactly zero, which does throw. So negatives clamp to zero and non-finite
 * values refuse the fit outright.
 */
export function resolvePadding(
  padding: number | { top: number; right: number; bottom: number; left: number } | undefined,
  fallback: number,
): { top: number; right: number; bottom: number; left: number } | null {
  const raw =
    padding == null
      ? { top: fallback, right: fallback, bottom: fallback, left: fallback }
      : typeof padding === 'number'
        ? { top: padding, right: padding, bottom: padding, left: padding }
        : padding;

  if (
    !Number.isFinite(raw.top) ||
    !Number.isFinite(raw.right) ||
    !Number.isFinite(raw.bottom) ||
    !Number.isFinite(raw.left)
  ) {
    reportMapDefect('padding:non-finite', `Refusing a fit: padding is not finite (${describeNumbers(raw)}).`);
    return null;
  }

  return {
    top: Math.max(0, raw.top),
    right: Math.max(0, raw.right),
    bottom: Math.max(0, raw.bottom),
    left: Math.max(0, raw.left),
  };
}

// ---------------------------------------------------------------------------
// The garbage gate
// ---------------------------------------------------------------------------

/**
 * Both MapLibre engines build a `LngLat` out of whatever they are handed, and
 * `LngLat` THROWS on a non-number — `Invalid LngLat object: (NaN, NaN)`. Thrown
 * from a React effect (setting a marker's position, framing a route) that
 * reaches the nearest error boundary, so one bad pin takes the whole screen
 * down and the user sees "Something went wrong" instead of a map.
 *
 * `components/map/` is the single seam every coordinate crosses on its way to
 * an engine, so it is where that stops being possible. A marker whose
 * coordinate is not drawable is DROPPED (a map missing one pin is a degraded
 * map; a map that throws is no map) and a camera move whose target is not
 * drawable is a no-op.
 *
 * ## Why this is not `isValidCoordinate`
 *
 * `lib/map/geo.ts`'s `isValidCoordinate` is the PRODUCT's rule — a real point
 * on the earth, longitude within ±180. This is the ENGINE's rule, which is
 * looser on longitude on purpose: MapLibre reports unwrapped longitudes across
 * the antimeridian (a click at 181°E comes back as 181, not −179), and feeding
 * one of those back in is legal and does the right thing. Rejecting it here
 * would break panning past the date line in the name of safety. Latitude is
 * bounded, because `LngLat` throws outside ±90 too.
 */
export function isDrawableCoordinate(value: unknown): value is GeoCoordinate {
  if (!value || typeof value !== 'object') return false;
  const { latitude, longitude } = value as GeoCoordinate;
  return (
    Number.isFinite(longitude) && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
  );
}

/** The same rule as {@link isDrawableCoordinate}, applied to a box's corners. */
export function isDrawableBounds(bounds: GeoBounds | null | undefined): bounds is GeoBounds {
  if (!bounds) return false;
  return (
    isDrawableCoordinate({ latitude: bounds.south, longitude: bounds.west }) &&
    isDrawableCoordinate({ latitude: bounds.north, longitude: bounds.east })
  );
}

/**
 * The markers an engine may be given, with the undrawable ones removed.
 *
 * Returns the INPUT ARRAY when nothing is wrong, so the common path adds one
 * pass and no allocation, and the forks' effect dependencies do not change
 * identity every render.
 */
export function drawableMarkers(markers: readonly MapMarker[] | undefined): readonly MapMarker[] {
  if (!markers || markers.length === 0) return EMPTY_MARKERS;
  let firstBad = -1;
  for (let index = 0; index < markers.length; index += 1) {
    if (!isDrawableCoordinate(markers[index].coordinate)) {
      firstBad = index;
      break;
    }
  }
  if (firstBad < 0) return markers;

  const kept = markers.slice(0, firstBad);
  for (let index = firstBad; index < markers.length; index += 1) {
    const marker = markers[index];
    if (isDrawableCoordinate(marker.coordinate)) {
      kept.push(marker);
      continue;
    }
    reportMapDefect(
      `marker:${marker.id}`,
      `Dropped marker "${marker.id}": coordinate is not drawable (${describeNumbers(marker.coordinate)}).`,
    );
  }
  return kept;
}

const EMPTY_MARKERS: readonly MapMarker[] = [];

/**
 * The overlays an engine may be given, with the undrawable ones removed.
 *
 * Overlays were the one path from feature code into an engine that this seam
 * did not check, and they are not a small one: the route line, the highlighted
 * step and any service area all travel as raw GeoJSON handed straight to
 * `addSource`/`setData`.
 *
 * ## What a bad overlay actually does, measured
 *
 * Unlike a marker or a camera move, a bad coordinate here does NOT throw. A
 * GeoJSON source is tiled in the worker by geojson-vt, whose `projectX`/
 * `projectY` are plain arithmetic: `NaN` in, `NaN` out, no `LngLat` anywhere on
 * the path (`GeoJSONSource.setData` only serialises and posts). A `LineString`
 * with a `NaN` vertex, an empty `coordinates: []`, a one-point `LineString` —
 * all produce a feature whose bounding box is `[NaN, NaN, NaN, NaN]`, which
 * belongs to no tile and is therefore drawn NOWHERE, silently, with no error
 * event and nothing in the console.
 *
 * That is why this is worth checking rather than leaving to the engine: the
 * failure mode is a route the user asked for that simply is not on the map, and
 * nothing anywhere says why.
 *
 * ## Why it drops rather than repairs
 *
 * Filtering the bad vertices out of a line would leave a line that still draws
 * — straight through whatever is between the two surviving points. A route that
 * cuts a corner it does not cut is a lie the user has no way to detect. A
 * missing line is visibly missing.
 */
export function drawableOverlays(
  overlays: readonly MapOverlay[] | undefined,
): readonly MapOverlay[] {
  if (!overlays || overlays.length === 0) return EMPTY_OVERLAYS;
  let firstBad = -1;
  for (let index = 0; index < overlays.length; index += 1) {
    if (!isDrawableGeoJSON(overlays[index].data)) {
      firstBad = index;
      break;
    }
  }
  if (firstBad < 0) return overlays;

  const kept = overlays.slice(0, firstBad);
  for (let index = firstBad; index < overlays.length; index += 1) {
    const overlay = overlays[index];
    if (isDrawableGeoJSON(overlay.data)) {
      kept.push(overlay);
      continue;
    }
    reportMapDefect(
      `overlay:${overlay.id}`,
      `Dropped overlay "${overlay.id}": its geometry is not drawable, so it would have rendered nowhere.`,
    );
  }
  return kept;
}

const EMPTY_OVERLAYS: readonly MapOverlay[] = [];

/**
 * Every position in a GeoJSON document is a point the engine can project, and
 * every geometry has enough of them to BE that geometry.
 *
 * The arity check is not pedantry about RFC 7946: a one-point `LineString` and
 * an empty ring are exactly what a mis-sliced route produces, they draw
 * nothing, and they are indistinguishable from "the route did not arrive"
 * unless something says so.
 */
export function isDrawableGeoJSON(data: GeoJSON.GeoJSON | null | undefined): boolean {
  if (!data || typeof data !== 'object') return false;
  switch (data.type) {
    case 'FeatureCollection':
      return Array.isArray(data.features) && data.features.every((f) => isDrawableGeoJSON(f));
    case 'Feature':
      // A null geometry is legal GeoJSON and draws nothing, which for an
      // overlay is the same as not being there.
      return data.geometry != null && isDrawableGeoJSON(data.geometry);
    case 'GeometryCollection':
      return (
        Array.isArray(data.geometries) &&
        data.geometries.length > 0 &&
        data.geometries.every((g) => isDrawableGeoJSON(g))
      );
    case 'Point':
      return isDrawablePosition(data.coordinates);
    case 'MultiPoint':
      return ring(data.coordinates, 1);
    case 'LineString':
      return ring(data.coordinates, 2);
    case 'MultiLineString':
      return Array.isArray(data.coordinates) && data.coordinates.every((l) => ring(l, 2));
    case 'Polygon':
      return Array.isArray(data.coordinates) && data.coordinates.every((r) => ring(r, 4));
    case 'MultiPolygon':
      return (
        Array.isArray(data.coordinates) &&
        data.coordinates.every((p) => Array.isArray(p) && p.every((r) => ring(r, 4)))
      );
    default:
      return false;
  }
}

function ring(positions: unknown, minimum: number): boolean {
  return (
    Array.isArray(positions) && positions.length >= minimum && positions.every(isDrawablePosition)
  );
}

/** A GeoJSON position is `[longitude, latitude]`, altitude optional. */
function isDrawablePosition(position: unknown): boolean {
  if (!Array.isArray(position) || position.length < 2) return false;
  return isDrawableCoordinate({ longitude: position[0], latitude: position[1] });
}

/**
 * Say it ONCE per defect.
 *
 * Markers are re-applied on every camera frame a parent reacts to, so a
 * per-occurrence warning would be thousands of identical lines during a single
 * drag — which is how a real signal becomes noise somebody mutes. The key is
 * the marker id (or the kind of camera defect), so a second, different bad pin
 * is still reported.
 */
const reported = new Set<string>();

export function reportMapDefect(key: string, message: string): void {
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(`[goway/map] ${message}`);
}

/**
 * `key NaN` — never `JSON.stringify`, which prints `NaN` and `Infinity` as
 * `null` and so erases the one detail the reader needs.
 */
export function describeNumbers(value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  return Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => `${key} ${String(entry)}`)
    .join(', ');
}

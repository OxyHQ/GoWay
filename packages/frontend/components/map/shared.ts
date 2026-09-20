/**
 * Translation helpers shared by the two renderer forks.
 *
 * This is the ONLY place GoWay's `{ latitude, longitude }` becomes MapLibre's
 * `[longitude, latitude]` — once, tested by both forks using it, rather than at
 * every call site where a swapped pair renders a plausible map of the wrong
 * place and nothing errors.
 *
 * It is also the gate: `isDrawableCoordinate` / `drawableMarkers` /
 * `isDrawableBounds` / `resolvePadding` are what keep a `NaN` from reaching an
 * engine, which is a THROW rather than a bad frame. See the block comment above
 * {@link isDrawableCoordinate}.
 */
import type {
  GeoBounds,
  GeoCoordinate,
  MapInteractionOptions,
  MapMarker,
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
  return {
    color,
    width: paint?.width ?? 4,
    opacity: paint?.opacity ?? (kind === 'fill' ? 0.15 : 1),
    outlineColor: paint?.outlineColor ?? color,
    radius: paint?.radius ?? 6,
  };
}

/** Normalise a `moveTo` target: a bare coordinate leaves the camera's zoom alone. */
export function isViewport(target: GeoCoordinate | MapViewport): target is MapViewport {
  return typeof (target as MapViewport).zoom === 'number';
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

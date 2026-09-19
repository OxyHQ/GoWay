/**
 * Translation helpers shared by the two renderer forks.
 *
 * This is the ONLY place GoWay's `{ latitude, longitude }` becomes MapLibre's
 * `[longitude, latitude]` — once, tested by both forks using it, rather than at
 * every call site where a swapped pair renders a plausible map of the wrong
 * place and nothing errors.
 */
import type {
  GeoBounds,
  GeoCoordinate,
  MapInteractionOptions,
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
 * Fit padding, expanded to the four-sided form both engines want.
 *
 * A single number means "the same all round", which is what a caller framing a
 * set of pins almost always means.
 */
export function resolvePadding(
  padding: number | { top: number; right: number; bottom: number; left: number } | undefined,
  fallback: number,
): { top: number; right: number; bottom: number; left: number } {
  if (padding == null) {
    return { top: fallback, right: fallback, bottom: fallback, left: fallback };
  }
  if (typeof padding === 'number') {
    return { top: padding, right: padding, bottom: padding, left: padding };
  }
  return padding;
}

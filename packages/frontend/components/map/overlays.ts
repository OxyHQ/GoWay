/**
 * GoWay's overlays — the route line, the highlighted step, a service area — as
 * `@goway.to/maps` sources and layers.
 *
 * An overlay is a handful of neutral paint values rather than a MapLibre paint
 * object: a paint spec is the provider's vocabulary, and letting one through
 * would make every route-line call site a MapLibre call site. This module is
 * where the neutral values become the style spec, once, for both platforms.
 */
import { isDrawableGeoJSON, reportMapDefect } from '@goway.to/maps/plugin';

import type { MapOverlay, MapOverlayKind, MapOverlayPaint } from './types';

/**
 * Fill in a neutral overlay paint. `accent` is the theme's primary; an overlay
 * can override it per call.
 */
export function resolveOverlayPaint(
  kind: MapOverlayKind,
  paint: MapOverlayPaint | undefined,
  accent: string,
): Required<Omit<MapOverlayPaint, 'outlineColor'>> & { outlineColor: string } {
  const color = paint?.color ?? accent;
  // These go into a style layer's paint, and a non-finite number is rejected
  // by MapLibre's validator — which fails the whole layer. A default width is
  // a visible line.
  return {
    color,
    width: finite(paint?.width) ?? 4,
    opacity: finite(paint?.opacity) ?? (kind === 'fill' ? 0.15 : 1),
    outlineColor: paint?.outlineColor ?? color,
    radius: finite(paint?.radius) ?? 6,
  };
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** An overlay's style-spec paint and layout, for a `<Layer>` of its kind. */
export function overlayStyle(
  overlay: MapOverlay,
  accent: string,
): { paint: Record<string, unknown>; layout: Record<string, unknown> } {
  const paint = resolveOverlayPaint(overlay.kind, overlay.paint, accent);
  const visibility = overlay.visible === false ? 'none' : 'visible';
  if (overlay.kind === 'line') {
    return {
      paint: {
        'line-color': paint.color,
        'line-width': paint.width,
        'line-opacity': paint.opacity,
      },
      layout: { visibility, 'line-cap': 'round', 'line-join': 'round' },
    };
  }
  if (overlay.kind === 'fill') {
    return {
      paint: {
        'fill-color': paint.color,
        'fill-opacity': paint.opacity,
        'fill-outline-color': paint.outlineColor,
      },
      layout: { visibility },
    };
  }
  return {
    paint: {
      'circle-color': paint.color,
      'circle-opacity': paint.opacity,
      'circle-radius': paint.radius,
    },
    layout: { visibility },
  };
}

/**
 * The overlays a map may be given, with the undrawable ones removed — and said
 * so, once each. Raw GeoJSON does not throw: a NaN vertex tiles to nothing and
 * the route the reader asked for is simply absent, so it is refused here where
 * the overlay still has its name. A missing line is visibly missing; a line
 * repaired by dropping vertices would cut a corner the route does not.
 */
export function drawableOverlays(
  overlays: readonly MapOverlay[] | undefined,
): readonly MapOverlay[] {
  if (!overlays || overlays.length === 0) return EMPTY_OVERLAYS;
  if (overlays.every((overlay) => isDrawableGeoJSON(overlay.data))) return overlays;
  return overlays.filter((overlay) => {
    if (isDrawableGeoJSON(overlay.data)) return true;
    reportMapDefect(
      `overlay:${overlay.id}`,
      `Dropped overlay "${overlay.id}": its geometry is not drawable, so it would have rendered nowhere.`,
    );
    return false;
  });
}

const EMPTY_OVERLAYS: readonly MapOverlay[] = [];

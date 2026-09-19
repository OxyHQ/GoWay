/**
 * The GoWay map contract — provider-neutral by construction.
 *
 * Nothing in this file mentions MapLibre, and nothing that imports it may. The
 * two renderer forks (`MapCanvas.web.tsx` → `maplibre-gl`,
 * `MapCanvas.native.tsx` → `@maplibre/maplibre-react-native`) translate these
 * shapes into their engine's vocabulary; feature code only ever sees these.
 *
 * Two conventions worth stating once, because getting them wrong is silent:
 *
 *  - GoWay speaks `{ latitude, longitude }` OBJECTS, never positional pairs.
 *    Both MapLibre engines use `[longitude, latitude]` arrays, which is the
 *    reverse of how every human writes a coordinate, and a swapped pair renders
 *    a perfectly plausible map of the wrong hemisphere. The conversion happens
 *    exactly twice — once per fork — in `toLngLat()`.
 *  - Bearing is degrees clockwise from north; pitch is degrees from straight
 *    down. Both match the engines, so they pass through untouched.
 */
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';

import type { MapAppearance } from '@/lib/map/provider';

export type { MapAppearance };

/** A point on the earth. */
export interface GeoCoordinate {
  latitude: number;
  longitude: number;
}

/** An axis-aligned geographic box, in the GeoJSON `bbox` sense. */
export interface GeoBounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

/**
 * Where the camera is.
 *
 * `bearing` and `pitch` are optional on input (omitting them means "leave it
 * alone") and always present on output.
 */
export interface MapViewport {
  latitude: number;
  longitude: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
}

/** A viewport as reported back by the renderer — every field resolved. */
export interface ResolvedMapViewport extends MapViewport {
  bearing: number;
  pitch: number;
}

/**
 * Who moved the camera.
 *
 * This has to travel WITH the event because nothing downstream can recover it:
 * a viewport the user dragged to and one the app flew to are the same four
 * numbers. Issue #7's "Search this area" button must not arm itself against a
 * camera move the app made in response to the search that is already showing.
 */
export type MapMoveSource = 'user' | 'programmatic';

export interface MapViewportChange {
  viewport: ResolvedMapViewport;
  bounds: GeoBounds;
  source: MapMoveSource;
  /** `true` on the settled frame at the end of a gesture or animation. */
  isFinal: boolean;
}

/**
 * A point GoWay draws on the map.
 *
 * `kind` is an OPEN string rather than a union so that Places categories
 * (issue #5) and route waypoints (issue #6) can add their own without editing
 * this file. The renderer does not interpret it; it is handed back to
 * `renderMarker` and used for the default marker styling.
 */
export interface MapMarker {
  id: string;
  coordinate: GeoCoordinate;
  kind?: string;
  /** Short text drawn in the default marker (a price, a name, a count). */
  label?: string;
  /** Number of collapsed points; renders as a cluster bubble when > 1. */
  count?: number;
  selected?: boolean;
  accessibilityLabel?: string;
}

/**
 * Neutral paint for a GeoJSON overlay.
 *
 * Deliberately a handful of plain values rather than a MapLibre paint object:
 * a paint spec is the provider's vocabulary, and letting one through here would
 * make every route-line call site a MapLibre call site.
 */
export interface MapOverlayPaint {
  /** CSS colour. Defaults to the theme's primary. */
  color?: string;
  /** Line width in px (line overlays). */
  width?: number;
  /** 0–1. Defaults to 1 for lines, 0.15 for fills. */
  opacity?: number;
  /** Outline colour for fill overlays. */
  outlineColor?: string;
  /** Radius in px (circle overlays). */
  radius?: number;
}

export type MapOverlayKind = 'line' | 'fill' | 'circle';

/**
 * A GeoJSON/vector overlay: route lines, service areas, isochrones, tracks.
 *
 * `data` is plain GeoJSON — the one provider-neutral geometry format both
 * engines already speak — so it crosses the seam without translation.
 */
export interface MapOverlay {
  id: string;
  kind: MapOverlayKind;
  data: GeoJSON.GeoJSON;
  paint?: MapOverlayPaint;
  /** Hide without unmounting, so the source/tiles stay warm. */
  visible?: boolean;
}

export interface MapCameraOptions {
  zoom?: number;
  bearing?: number;
  pitch?: number;
  /** Animation duration in ms. `0` jumps. */
  duration?: number;
}

export interface MapFitOptions {
  /** Padding in px kept between the fitted content and the viewport edge. */
  padding?: number | { top: number; right: number; bottom: number; left: number };
  duration?: number;
  /** Never zoom in past this, however tight the box is. */
  maxZoom?: number;
}

/**
 * Imperative handle, shared by both forks.
 *
 * Every reader is async because the native engine answers over the bridge; the
 * web fork resolves immediately. Making web sync and native async would put a
 * platform fork back into feature code, which is the thing this seam exists to
 * prevent.
 */
export interface MapApi {
  /** Move the camera. A bare coordinate keeps the current zoom/bearing/pitch. */
  moveTo(target: GeoCoordinate | MapViewport, options?: MapCameraOptions): void;
  /** Frame a declared area. */
  fitBounds(bounds: GeoBounds, options?: MapFitOptions): void;
  /** Frame a set of points. A single point is treated as a `moveTo`. */
  fitCoordinates(coordinates: readonly GeoCoordinate[], options?: MapFitOptions): void;
  /** Rotate to a bearing (degrees clockwise from north). */
  setBearing(bearing: number, options?: MapCameraOptions): void;
  /** Rotate back to north and level the pitch. */
  resetNorth(options?: MapCameraOptions): void;
  /** Current camera, or `null` before the map is ready. */
  getViewport(): Promise<ResolvedMapViewport | null>;
  /** Current visible box, or `null` before the map is ready. */
  getBounds(): Promise<GeoBounds | null>;
}

/**
 * Why the canvas is degraded.
 *
 * `style` and `tiles` are the two the product must survive: the style document
 * or the tile host is unreachable, and the map cannot draw. `unsupported` is a
 * platform without a renderer (see `MapCanvas.tsx`). The rest of the UI stays
 * usable in all three — the error state covers the canvas only.
 */
export type MapErrorReason = 'style' | 'tiles' | 'unsupported' | 'runtime';

export interface MapCanvasError {
  reason: MapErrorReason;
  message?: string;
}

/** Which map interactions are enabled. Everything defaults to on. */
export interface MapInteractionOptions {
  pan?: boolean;
  zoom?: boolean;
  /** Rotate/bearing, where the platform's gesture conventions allow it. */
  rotate?: boolean;
  pitch?: boolean;
}

export interface MapCanvasProps {
  /** Camera on first render. Uncontrolled afterwards — move it via {@link MapApi}. */
  initialViewport?: MapViewport;
  /** Cartographic appearance. Defaults to following the Bloom theme. */
  appearance?: MapAppearance;
  markers?: readonly MapMarker[];
  /**
   * Custom marker body. Receives the marker and returns Bloom UI; the renderer
   * positions it. Omit to get Bloom's `MapPriceMarker` / `MapClusterMarker`.
   */
  renderMarker?: (marker: MapMarker) => ReactNode;
  overlays?: readonly MapOverlay[];
  /**
   * Draw the blue user-location dot.
   *
   * Honoured ONLY when foreground location permission has already been
   * GRANTED — the canvas never triggers a permission prompt of its own, so
   * passing `true` speculatively cannot turn opening the map into a permission
   * request (GoWay AGENTS.md → Privacy). Use `useUserLocation()` to ask, at the
   * moment the user invokes a location-dependent action.
   */
  showUserLocation?: boolean;
  interaction?: MapInteractionOptions;
  onViewportChange?: (change: MapViewportChange) => void;
  onPress?: (event: { coordinate: GeoCoordinate }) => void;
  onMarkerPress?: (marker: MapMarker) => void;
  /** Fired once the style has loaded and the first frame is on screen. */
  onReady?: () => void;
  /** Fired when the canvas enters its degraded state. */
  onError?: (error: MapCanvasError) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Default camera: the whole inhabited world, before anything is known. */
export const DEFAULT_VIEWPORT: MapViewport = {
  latitude: 41.3874,
  longitude: 2.1686,
  zoom: 11,
  bearing: 0,
  pitch: 0,
};

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

/**
 * What kind of thing the BASEMAP is labelling.
 *
 * Two values, because two is what the product can honestly act on. A `poi` is a
 * thing at a point with a door, and it may turn out to be a GoWay Place. An
 * `area` is a named region — a city, a district, a park, a peak — and it never
 * does: GoWay Places holds businesses and venues, not the gazetteer.
 */
export type MapLabelKind = 'poi' | 'area';

/**
 * A label the basemap drew, as GoWay sees it.
 *
 * The vector tiles have always carried these and the style has always painted
 * them; this is what makes them TAPPABLE. It is deliberately thin — a name, a
 * point, and whatever the tiles said it was — because that is genuinely all the
 * basemap knows, and a shape with room for a phone number would invite a card
 * that pretends to have one.
 *
 * Nothing here is a GoWay identity. `id` is derived from a tile feature id,
 * which belongs to a planet build and changes when that build does; resolving a
 * label to a GoWay Place goes through search reconciliation
 * (`lib/goway/basemapLabels.ts`), never through this id.
 */
export interface MapLabelFeature {
  /** Stable for as long as the loaded tiles are. NOT a GoWay Place ID. */
  id: string;
  /** The name as the basemap draws it — `name:latin`, else `name`. */
  name: string;
  kind: MapLabelKind;
  coordinate: GeoCoordinate;
  /** The tiles' own `class`, verbatim (`restaurant`, `hospital`, `city`, …). */
  category?: string;
  /** The tiles' finer `subclass`, verbatim. */
  subcategory?: string;
  /** OpenMapTiles' importance ordering, where the tiles supply one. */
  rank?: number;
}

/**
 * A tap on the map.
 *
 * `label` is the basemap's own label under the finger, when the tap landed on
 * one. It is OPTIONAL rather than a second callback because the two cases are
 * one decision for the caller — the directions planner wants the coordinate
 * whether or not there was a label on it, and the explore screen wants the
 * label — and two callbacks would make that decision twice, in two places, and
 * eventually differently.
 *
 * A tap that a GoWay MARKER handled does not produce this event at all: see
 * {@link MapCanvasProps.onMarkerPress}.
 */
export interface MapPressEvent {
  coordinate: GeoCoordinate;
  label?: MapLabelFeature;
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
  /**
   * A tap on the map, carrying the basemap label under it when there was one.
   *
   * ## Hit priority
   *
   * A tap resolves to exactly ONE of three things, in this order:
   *
   *  1. a GoWay marker → {@link MapCanvasProps.onMarkerPress}, and this does
   *     not fire. (On web that is not free: a `maplibregl.Marker` lives inside
   *     the canvas container, so a click on one bubbles and MapLibre fires its
   *     own `click` for it — which is why this used to fire underneath every
   *     marker press, and why "tap the map to set a stop" could set a stop the
   *     user had aimed at a pin.)
   *  2. a basemap label inside the hit pad → this, with `label` set;
   *  3. bare map → this, with no `label`.
   */
  onPress?: (event: MapPressEvent) => void;
  onMarkerPress?: (marker: MapMarker) => void;
  /**
   * The basemap labels currently PLACED in the viewport, on each settled frame.
   *
   * Only an engine can answer this — it is the output of the collision system,
   * not of the tiles — so the canvas reports it and feature code decides what
   * to do with it. Its one consumer is the overlay-side duplicate suppression
   * in `lib/goway/basemapLabels.ts`: a GoWay chip drawn over a name the
   * basemap is already drawing is the double-draw this whole seam exists to
   * stop.
   *
   * Reported labels are the ones MapLibre actually PLACED, not the ones the
   * tiles contain (measured: 16 of 3185 over central Barcelona at z16), which
   * is the property that makes suppression safe — a label lost to a collision
   * cannot hide a chip.
   */
  onLabelsChange?: (labels: readonly MapLabelFeature[]) => void;
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

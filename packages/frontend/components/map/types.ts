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
 * What kind of named thing the BASEMAP is labelling.
 *
 * Four values, because four is what the product acts on differently:
 *
 *  - **`poi`** — a thing at a point with a door: a shop, a station, an airport.
 *    The only kind that may turn out to be a GoWay Place.
 *  - **`road`** — a street or route name. A line, so its point is wherever on
 *    the way the user pointed.
 *  - **`water`** — a river, a lake, a bay.
 *  - **`area`** — a named region: a city, a district, a park, a peak.
 *
 * `poi` is the only one GoWay ever looks up, and deliberately: GoWay Places
 * holds businesses and venues, not the gazetteer and not the street network
 * (`packages/backend/src/search/merge.ts`). The other three always show what
 * the basemap knows and nothing more.
 */
export type MapLabelKind = 'poi' | 'road' | 'water' | 'area';

/**
 * A label the basemap drew, as GoWay sees it.
 *
 * The vector tiles have always carried these and the style has always painted
 * them; this is what makes them TAPPABLE. It is deliberately thin — a name, a
 * point, and whatever the tiles said it was — because that is genuinely all the
 * basemap knows, and a shape with room for a phone number would invite a card
 * that pretends to have one.
 *
 * **Nothing here is, or can become, a GoWay identity.** `id` is derived from a
 * tile feature id, and that id joins to nothing: OpenFreeMap's tiles are built
 * by Planetiler, whose feature ids bear no relation to the OpenStreetMap
 * element ids `places_sources` stores. Measured — the Boqueria is OSM
 * `way/25336101` and tile id `62887353`; the Museu Picasso is `way/34633854`
 * and tile id `1889380012`. So resolving a label to a Place is an inference
 * made through GoWay's own search (`lib/goway/basemapLabels.ts`), never a join,
 * and nothing may treat this shape as a `Place`.
 */
export interface MapLabelFeature {
  /** Stable for as long as the loaded tiles are. NOT a GoWay Place ID. */
  id: string;
  /** The name as the basemap draws it — `name:latin`, else `name`. */
  name: string;
  kind: MapLabelKind;
  /**
   * Where this label is: its own point, the nearest point on its line, or —
   * when it has neither, as for a park's name — where the user tapped.
   */
  coordinate: GeoCoordinate;
  /**
   * `false` when {@link MapLabelFeature.coordinate} is the tap rather than the
   * feature's own position, so a caller can tell "this IS here" from "you
   * pointed at this".
   */
  anchored: boolean;
  /** The tiles' own `class`, verbatim (`restaurant`, `primary`, `city`, …). */
  category?: string;
  /** The tiles' finer `subclass`, verbatim. */
  subcategory?: string;
  /** OpenMapTiles' importance ordering, where the tiles supply one. */
  rank?: number;
}

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

/**
 * Which map interactions are enabled. Everything defaults to on.
 *
 * The four flags are INDEPENDENT, and identically so on web and on native.
 * `rotate` and `pitch` are the pair that could plausibly be read otherwise:
 * MapLibre GL JS drives bearing and tilt from a single desktop handler
 * (Ctrl-drag or right-drag), so `{ rotate: false, pitch: true }` reads like an
 * option that cannot exist there. It can — see `components/map/dragAxes.ts` —
 * and it means the same thing on both platforms: the user may tilt the camera
 * and may not turn it.
 *
 * Each flag names one thing the user may do, never a gesture on one device:
 * `pitch` covers both the two-finger vertical drag and the desktop Ctrl-drag,
 * and turning it off also clamps `maxPitch` to 0 so no other path can tilt the
 * camera either.
 */
export interface MapInteractionOptions {
  /** Drag to move the camera over the ground. */
  pan?: boolean;
  /** Scroll, pinch and double-tap zoom. */
  zoom?: boolean;
  /** Turn the camera: bearing. Independent of {@link pitch}. */
  rotate?: boolean;
  /** Tilt the camera off straight-down: pitch. Independent of {@link rotate}. */
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
  /**
   * Fired when the canvas enters its degraded state, and **with `null` when it
   * leaves it**.
   *
   * The second half is what makes the first usable. A screen that only ever
   * hears about failure latches on the first one: `ExploreScreen` hides
   * "Search this area" and the directions picker while `mapError` is set, and
   * without a recovery signal they stay hidden on a map that is drawing
   * perfectly. That is what happened on `goway.to` — a handful of stale
   * edge-cached tiles among thousands of good ones, and the canvas reported
   * the failure and never the return.
   *
   * A `tiles` failure is recoverable and is retracted once the viewport settles
   * with every tile in hand. A `style` failure is not: nothing to draw, and
   * nothing that arrives later changes it short of a retry.
   */
  onError?: (error: MapCanvasError | null) => void;
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

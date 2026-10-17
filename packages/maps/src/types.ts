/**
 * The public shapes of `@goway.to/maps`.
 *
 * Coordinates are GoWay's `{ latitude, longitude }` and boxes its
 * `{ west, south, east, north }` (`@goway.to/sdk/geo`), never positional
 * `[lng, lat]` pairs: a transposed pair is a plausible point in the wrong
 * hemisphere rather than an error, so the one place it becomes an engine's
 * order is inside this package (`shared.ts`).
 */
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { MapLightPreset } from '@goway.to/sdk/map';
import type { GeoBoundingBox, GeoCoordinate } from '@goway.to/sdk/geo';

export type { GeoBoundingBox, GeoCoordinate };

/** Where the camera is. `bearing` and `pitch` are optional on input and always present on output. */
export interface MapViewport {
  latitude: number;
  longitude: number;
  zoom: number;
  bearing?: number;
  pitch?: number;
}

/** A viewport as the engine reports it back — every field resolved. */
export interface ResolvedMapViewport extends MapViewport {
  bearing: number;
  pitch: number;
}

/**
 * Who moved the camera.
 *
 * It travels WITH the event because nothing downstream can recover it: a
 * viewport the reader dragged to and one the app framed are the same numbers,
 * and "Search this area" must never arm itself over a frame the app chose.
 */
export type MapMoveSource = 'user' | 'programmatic';

export interface MapCameraChange {
  viewport: ResolvedMapViewport;
  bounds: GeoBoundingBox;
  source: MapMoveSource;
  /** `true` on the settled frame at the end of a gesture or an animation. */
  isFinal: boolean;
}

/** One point drawn as a marker. */
export interface MapMarkerData {
  id: string;
  coordinate: GeoCoordinate;
  /** Short text in the default pill: a price, a name. Absent, a compact dot-sized pill. */
  label?: string;
  /** Read aloud for the marker; defaults to `label`. */
  accessibilityLabel?: string;
  /** An open string a `renderMarker` may branch on; the default marker ignores it. */
  kind?: string;
}

/** A cluster of markers, as `<Markers cluster>` draws and reports it. */
export interface MapMarkerCluster {
  /** Stable while the cluster's members and zoom are. */
  id: string;
  coordinate: GeoCoordinate;
  count: number;
  /** The ids of every marker it holds. */
  markerIds: readonly string[];
}

/**
 * What a marker body is drawn from: one point, or a cluster of them, with the
 * state Bloom's map markers draw (`active` = selected, `visited` = pressed
 * before on this map).
 */
export type MapMarkerItem =
  | { kind: 'point'; marker: MapMarkerData; state: 'default' | 'active' | 'visited' }
  | { kind: 'cluster'; cluster: MapMarkerCluster; state: 'default' | 'active' };

/**
 * Basemap label kinds a press can resolve to:
 * `poi` (a thing at a point with a door), `road`, `water`, `area`.
 */
export type MapLabelKind = 'poi' | 'road' | 'water' | 'area';

/**
 * A label the basemap drew, as the press saw it. Thin on purpose — a name, a
 * point, and what the tiles said it was. Its `id` joins to nothing.
 */
export interface MapLabelFeature {
  /** Stable for as long as the loaded tiles are. Not a GoWay Place ID. */
  id: string;
  /** The name as the basemap draws it — `name:latin`, else `name`. */
  name: string;
  kind: MapLabelKind;
  /** Its own point, the nearest point on its line, or where the reader tapped. */
  coordinate: GeoCoordinate;
  /** `false` when `coordinate` is the tap rather than the feature's own position. */
  anchored: boolean;
  /** The tiles' own `class`, verbatim. */
  category?: string;
  /** The tiles' finer `subclass`, verbatim. */
  subcategory?: string;
  /** OpenMapTiles' importance ordering, where the tiles supply one. */
  rank?: number;
}

export interface MapPressEvent {
  coordinate: GeoCoordinate;
  /** The basemap label under the press, when there was one. */
  label?: MapLabelFeature;
}

/** Which interactions are enabled; each is independent, and all default to on. */
export interface MapInteractionOptions {
  /** Drag to move the camera over the ground. */
  pan?: boolean;
  /** Scroll, pinch and double-tap zoom. */
  zoom?: boolean;
  /** Turn the camera (bearing). */
  rotate?: boolean;
  /** Tilt the camera (pitch). Off also clamps the maximum pitch to 0. */
  pitch?: boolean;
}

/** Why the map is degraded: the style document, tiles, no renderer, or an engine throw. */
export type MapErrorReason = 'style' | 'tiles' | 'unsupported' | 'runtime';

export interface MapError {
  reason: MapErrorReason;
  message?: string;
}

/** A link in the map's credit. */
export interface MapCreditLink {
  label: string;
  href: string;
}

/** A line the credit adds while something it names is drawn (e.g. simulated content). */
export interface MapCreditDisclosure {
  /** The full sentence, shown while the credit is open. */
  text: string;
  /** Read after `text` by a screen reader. */
  detail: string;
  /** A word or two, shown beside the folded credit's ⓘ. */
  short: string;
}

export type MapPadding = number | { top: number; right: number; bottom: number; left: number };

export interface MapCameraOptions {
  zoom?: number;
  bearing?: number;
  pitch?: number;
  /** Animation duration in ms; `0` jumps. */
  duration?: number;
  /**
   * One frame of an animation the caller drives: reported as in progress,
   * never as a settled camera. End it with one ordinary move.
   */
  transient?: boolean;
  /** Vertical field of view, degrees (10–60). Web only; native ignores it. */
  fieldOfView?: number;
}

export interface MapFitOptions {
  padding?: MapPadding;
  duration?: number;
  /** Never zoom in past this, however tight the box is. */
  maxZoom?: number;
}

/** One drawn frame (web only); `canvas` holds the pixels only during the callback. */
export interface MapFrame {
  canvas: HTMLCanvasElement;
}

/**
 * The map's imperative handle — for EVENT HANDLERS (a button that re-frames,
 * a press that recentres). Anything a screen derives from state is a
 * declarative prop instead: `<Camera bounds>`, `<Markers selectedId>`.
 */
export interface MapViewRef {
  /**
   * Move the camera. A bare coordinate keeps zoom, bearing and pitch. Answers
   * whether a move was issued — `false` when there is no engine yet or the
   * target is not drawable, so a caller waiting for its settle must not.
   */
  moveTo(target: GeoCoordinate | MapViewport, options?: MapCameraOptions): boolean;
  /** Frame an area. A box with no area moves to its centre at a street zoom. */
  fitBounds(bounds: GeoBoundingBox, options?: MapFitOptions): void;
  /** Frame a set of points. */
  fitCoordinates(coordinates: readonly GeoCoordinate[], options?: MapFitOptions): void;
  /** Rotate to a bearing, degrees clockwise from north. */
  setBearing(bearing: number, options?: MapCameraOptions): void;
  /** North up and the pitch level. */
  resetNorth(options?: MapCameraOptions): void;
  /** The camera now, or `null` before the map is ready. */
  getViewport(): Promise<ResolvedMapViewport | null>;
  /** The visible box now, or `null` before the map is ready. */
  getBounds(): Promise<GeoBoundingBox | null>;
  /**
   * Web only: `draw` with every frame the engine draws, synchronously after it
   * drew it, until the returned function is called. Absent on native.
   */
  captureFrames?(draw: (frame: MapFrame) => void): () => void;
}

export interface MapViewProps {
  /**
   * The style: a `goway://styles/<id>` name (default `goway://styles/standard`),
   * any MapLibre style URL, or a style document. A GoWay style follows the
   * Bloom theme's light — day in light mode, night in dark — unless
   * `lightPreset` names one.
   */
  mapStyle?: string;
  /** Pin a GoWay style's light: `day`, `dawn`, `dusk` or `night`. */
  lightPreset?: MapLightPreset;
  /**
   * The camera on first render. Absent, the map opens on `camera`'s target, or
   * on the whole world.
   */
  initialViewState?: MapInitialViewState;
  /** Where the camera should be, applied whenever its VALUE changes (`MapCameraTarget`). */
  camera?: MapCameraTarget;
  /** `globe` draws a sphere to ~z11 easing into mercator. Changing it rebuilds the engine. */
  projection?: 'mercator' | 'globe';
  /** The style's light (a MapLibre `LightSpecification`), e.g. aimed from the sun. */
  light?: Readonly<Record<string, unknown>> | null;
  interaction?: MapInteractionOptions;
  /** The highest pitch the camera may take; default 60. */
  maxPitch?: number;
  /** Web only, read when the engine is built: the device pixel ratio cap. */
  pixelRatio?: number;
  /** Web only, read when the engine is built: multisample antialiasing. */
  antialias?: boolean;
  /** Credits owed for data the app draws over the basemap, beside the basemap's own. */
  credits?: readonly MapCreditLink[];
  /** A line the credit carries while something it names is drawn. */
  creditDisclosure?: MapCreditDisclosure | null;
  /** A press on the map that no marker took: the coordinate, and the basemap label under it. */
  onPress?: (event: MapPressEvent) => void;
  /** The camera, live while it moves (`isFinal: false`) and once when it settles. */
  onCameraChanged?: (change: MapCameraChange) => void;
  /** The basemap labels placed in the viewport, on every settled frame. */
  onLabelsChange?: (labels: readonly MapLabelFeature[]) => void;
  /** The style has loaded and the first frame is on screen. */
  onReady?: () => void;
  /** The map entered (`MapError`) or left (`null`) its degraded state. */
  onError?: (error: MapError | null) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /**
   * What is drawn ON the map: `<Markers>`, sources and layers,
   * `<UserLocation>`, plugins. Chrome laid over the map (buttons, cards) goes
   * beside the `MapView` in the screen's own layout.
   */
  children?: ReactNode;
}

/** The camera a map opens at: a point and zoom, or a box to frame. */
export type MapInitialViewState =
  | MapViewport
  | { bounds: GeoBoundingBox; padding?: MapPadding; maxZoom?: number };

/**
 * Where the camera should be, as a VALUE: applied whenever its numbers change
 * — compared by the four numbers of the box (or the point and zoom), never by
 * identity, so a re-render with an equal target never moves the camera under
 * a reader who has panned. To frame the SAME target again after a pan (a
 * "back to the searched area" button), call `fitBounds` on the map's ref from
 * that button's handler.
 */
export interface MapCameraTarget {
  /** The box to frame. A box with no area moves to its centre at street zoom. */
  bounds?: GeoBoundingBox | null;
  /** The centre to move to; ignored while `bounds` is set. */
  center?: GeoCoordinate | null;
  /** The zoom to move to with `center`. */
  zoom?: number;
  padding?: MapPadding;
  /** Never zoom past this when framing `bounds`. */
  maxZoom?: number;
  /** Animation duration in ms; default 500, `0` jumps. */
  duration?: number;
}

export interface MarkersProps {
  data: readonly MapMarkerData[];
  /**
   * The marker drawn active. With `cluster`, it is never folded into a
   * cluster: what the reader is looking at stays on the map.
   */
  selectedId?: string | null;
  /** Group nearby markers into Bloom cluster bubbles. */
  cluster?: boolean;
  /** Cluster radius in pixels; default 50 (Mapbox's). */
  clusterRadius?: number;
  /** Zoom from which markers are never clustered; default 14 (Mapbox's). */
  clusterMaxZoom?: number;
  /** Minimum points that form a cluster; default 2. */
  clusterMinPoints?: number;
  /**
   * A custom body for a marker or cluster; call `onPress` from its own press
   * so the marker is remembered as visited and a cluster opens. Default:
   * Bloom's `MapPriceMarker` / `MapClusterMarker`.
   */
  renderMarker?: (item: MapMarkerItem, onPress: () => void) => ReactNode;
  /** A marker was pressed (it is also remembered as visited). */
  onPress?: (marker: MapMarkerData) => void;
  /**
   * A cluster was pressed. The map zooms in to where it splits by itself; this
   * only tells the screen which markers it held.
   */
  onClusterPress?: (cluster: MapMarkerCluster) => void;
}

export interface GeoJSONSourceProps {
  id: string;
  data: GeoJSON.GeoJSON;
  /** Cluster the points (MapLibre's own source clustering), for GL-drawn layers. */
  cluster?: boolean;
  clusterRadius?: number;
  clusterMaxZoom?: number;
  clusterMinPoints?: number;
  clusterProperties?: Readonly<Record<string, unknown>>;
  /** `<Layer>` children drawing this source. */
  children?: ReactNode;
}

export interface RasterDEMSourceProps {
  id: string;
  tiles: readonly string[];
  encoding?: 'mapbox' | 'terrarium';
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  children?: ReactNode;
}

export type MapLayerType = 'line' | 'fill' | 'circle' | 'symbol' | 'fill-extrusion' | 'hillshade';

export interface LayerProps {
  id: string;
  type: MapLayerType;
  /** Style-spec paint properties (`line-color`, `fill-opacity`, …). */
  paint?: Readonly<Record<string, unknown>>;
  /** Style-spec layout properties. */
  layout?: Readonly<Record<string, unknown>>;
  filter?: readonly unknown[];
  /** Draw under this layer (e.g. under the labels). Absent: on top. */
  beforeId?: string;
  minzoom?: number;
  maxzoom?: number;
}

export interface UserLocationProps {
  /**
   * Draw the reader's position. Only ever against a permission ALREADY
   * granted: opening a map never prompts. Ask with `useUserLocation()` when
   * the reader asks for something that needs it.
   */
  visible?: boolean;
}

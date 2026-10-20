/**
 * GoWay's own map contract, over `@goway.to/maps`.
 *
 * `@goway.to/maps` is the map every app gets; `MapCanvas` is GoWay's map built
 * on it — the explore screen's markers and overlays, GoWay Live, 3D models and
 * the city engine (`gowayEngine.web.ts`). The shapes the SDK already defines
 * are its own, re-exported here so feature code has one import site; this
 * file adds only what is GoWay's.
 *
 * GoWay speaks `{ latitude, longitude }` OBJECTS, never positional pairs; the
 * SDK is the one place a coordinate becomes an engine's `[lng, lat]`.
 */
import type { ReactNode } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import type { ModelPlacementInput } from '@goway.to/sdk';
import type {
  GeoBoundingBox,
  GeoCoordinate,
  MapCameraChange,
  MapCreditLink,
  MapError,
  MapInteractionOptions,
  MapLabelFeature,
  MapPressEvent,
  MapViewport,
  MapViewRef,
} from '@goway.to/maps';

import type { MapAppearance } from '@/lib/map/provider';
import type { MapLightPreset, MapStyleId } from '@/lib/map/style/catalogue';

export type { MapAppearance };
export type {
  GeoBoundingBox,
  GeoCoordinate,
  MapCameraChange,
  MapCameraOptions,
  MapCreditDisclosure,
  MapCreditLink,
  MapError,
  MapErrorReason,
  MapFitOptions,
  MapFrame,
  MapInteractionOptions,
  MapLabelFeature,
  MapLabelKind,
  MapMoveSource,
  MapPressEvent,
  MapViewport,
  ResolvedMapViewport,
} from '@goway.to/maps';

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
  /**
   * May be gathered into a cluster bubble with its neighbours (GoWay's places).
   * Absent — route stops, a tapped label's pin, search results — it is always
   * its own pin.
   */
  clustered?: boolean;
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

/** How a live glyph is drawn: a shape and a CSS colour, chosen by the feature that owns the data. */
export interface MapLiveGlyph {
  shape: 'aircraft' | 'arrow' | 'vehicle' | 'boat' | 'station' | 'train' | 'bus';
  color: string;
}

/**
 * A simplified 3D vehicle: a generic FORM, its proportions, and a livery as
 * flat colour bands — never a logo, wordmark or emblem. Feature data
 * (`features/live/fleets.ts`), drawn by the 3D pass.
 */
export interface MapLiveModel {
  form: 'emu' | 'bus' | 'double-deck' | 'coach' | 'aircraft' | 'vessel';
  /** Cars in the consist (an articulated bus is two). */
  cars: number;
  /** Metres, each car. */
  carLength: number;
  /** Metres between cars. */
  gap: number;
  width: number;
  height: number;
  /** `#RRGGBB` bands, bottom to top. */
  livery: { lower: string; stripe: string; body: string; window: string; roof: string };
}

/**
 * One real thing on the map at one instant, as the live layer wants it drawn.
 *
 * Provider-neutral and renderer-neutral: the feature (`features/live`) decides
 * where a thing is NOW (its own interpolation, within its source's bounds) and
 * how fresh it is; the canvas only draws.
 */
export interface MapLivePoint {
  id: string;
  /** A key of {@link MapLiveLayer.glyphs}. */
  glyph: string;
  coordinate: GeoCoordinate;
  /** Degrees clockwise from north; `null` draws the glyph unrotated. */
  heading: number | null;
  /** Metres above sea level, for a 3D renderer; `null` on the ground. */
  altitude: number | null;
  /** 0–1: freshness, as the feature judges it. */
  opacity: number;
  /** Short text beside the glyph — a line, a bike count. */
  label?: string;
  selected?: boolean;
  /** Colours the glyph instead of its own colour — a line's colour. */
  tint?: string;
  /** Real length in metres, for glyphs drawn to scale at street zooms (trains, buses). */
  length?: number;
  /** A key of {@link MapLiveLayer.models}, for the 3D shape. */
  model?: string;
  /** Where each car of a consist is, leading car first; absent: one body at {@link coordinate}. */
  parts?: readonly { coordinate: GeoCoordinate; heading: number }[];
  /** Not on a known track: drawn as reported, styled as approximate. */
  approximate?: boolean;
  /**
   * Not a reported position at all: estimated (from arrival predictions).
   * Drawn in its own hollow style, and never in 3D.
   */
  estimated?: boolean;
}

/**
 * Real, moving things drawn over the map (the GoWay Live layer).
 *
 * A PULL interface rather than props: positions change every frame, and a
 * React render per frame would re-render the whole screen. The canvas samples
 * {@link MapLiveLayer.sample} on its own clock while {@link MapLiveLayer.animating}
 * says something moves, and sleeps until {@link MapLiveLayer.subscribe} wakes
 * it otherwise.
 */
export interface MapLiveLayer {
  glyphs: Readonly<Record<string, MapLiveGlyph>>;
  /** The 3D vehicle models points may name; absent, the 3D pass draws generic shapes. */
  models?: Readonly<Record<string, MapLiveModel>>;
  /** Everything to draw at `now` (`Date.now()` milliseconds). */
  sample(now: number): readonly MapLivePoint[];
  /** Whether anything is moving or fading: the canvas keeps drawing frames while so. */
  animating(): boolean;
  /** Something changed (data, selection, credits). Returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /** The visible area settled — what the feature should be receiving. */
  setViewport(view: { bounds: GeoBoundingBox; zoom: number }): void;
  /** A live point was tapped, or `null` for a tap elsewhere. */
  select(id: string | null): void;
  /** The credits for what is drawn now. */
  credits(): readonly MapCreditLink[];
}

/**
 * A glTF model anchored at a coordinate — phase 1 of `docs/SDK_MAP_MODELS.md`.
 *
 * Drawn in 3D on the web fork (inside the map's one three.js scene, occluded
 * by buildings through the shared depth buffer) and as its `fallback` marker
 * everywhere it is not: the native fork, outside the zoom window, while the
 * asset loads, and when it fails or is over budget. A model is never
 * information only the GPU has.
 */
export interface MapModel {
  id: string;
  /** The contract's placement (`@goway.to/sdk` → `ModelPlacementInput`), checked by `parseModelPlacement`. */
  placement: ModelPlacementInput;
  /**
   * Phase 1: a GLB the caller hosts (HTTPS, or this page's origin), or a
   * catalogue key resolved from the app's fixture catalogue
   * (`lib/map/modelCatalogue.ts`; the served catalogue is phase 2).
   */
  asset: { kind: 'url'; url: string } | { kind: 'catalogue'; key: string };
  /** `world` (default): true metres. `screen`: at least `heightPx` tall at any zoom. */
  sizing?: { mode: 'world' } | { mode: 'screen'; heightPx: number };
  /** Outside this zoom window the fallback marker is drawn instead. */
  minZoom?: number;
  maxZoom?: number;
  /** `buildings` (default) hides it behind extrusions; `none` always draws it. */
  occlusion?: 'buildings' | 'none';
  /** CSS colour applied to the asset's materials named `paint…`. */
  tint?: string;
  accessibilityLabel: string;
  /** What the marker that stands in for it looks like. */
  fallback?: Pick<MapMarker, 'kind' | 'label'>;
}

/**
 * The canvas's imperative handle: `@goway.to/maps`'s, plus the one command
 * only GoWay's 3D engine answers.
 */
export interface MapApi extends MapViewRef {
  /**
   * Move one of the canvas's {@link MapModel}s without re-rendering the
   * `models` prop — a vehicle driving a route, every frame. The override
   * holds until the `models` prop changes. A placement that does not parse is
   * ignored, like an undrawable `moveTo`.
   */
  moveModel(id: string, placement: ModelPlacementInput): void;
}

export interface MapCanvasProps {
  /** Camera on first render. Uncontrolled afterwards — move it via {@link MapApi}. */
  initialViewport?: MapViewport;
  /**
   * Day or night, as the older spelling of {@link lightPreset}. Absent with
   * `lightPreset`, the light is this device's choice (`useMapStyle.ts`).
   */
  appearance?: MapAppearance;
  /**
   * The map style (`lib/map/style/catalogue.ts`). Absent, the person's
   * choice on this device — set from the layers picker. A screen that must
   * not follow the visitor (the embed) passes its own.
   */
  mapStyle?: MapStyleId;
  /** The light: day, dawn, dusk or night. Absent, this device's choice. */
  lightPreset?: MapLightPreset;
  markers?: readonly MapMarker[];
  /**
   * Custom marker body. Receives the marker and returns Bloom UI; the renderer
   * positions it. Omit to get Bloom's `MapPriceMarker` / `MapClusterMarker`.
   */
  renderMarker?: (marker: MapMarker) => ReactNode;
  overlays?: readonly MapOverlay[];
  /**
   * Real things moving on the map (GoWay Live), or `null`/absent for none.
   * Web only today: the native canvas ignores it (`docs/MAP_LIVE.md`).
   *
   * Hit priority: a live point sits between GoWay markers and basemap labels —
   * a tap on one calls {@link MapLiveLayer.select} and `onPress` does not
   * fire; a tap anywhere else selects nothing and proceeds as usual.
   */
  live?: MapLiveLayer | null;
  /**
   * The time-of-day scrubber (web, while the city sky draws): open, or not.
   * Closed — and absent, as on every map but the explore screen — the map is
   * lit for NOW: closing it is going back to now. A screen opens it from its
   * own control (`docs/MAP_FEATURES.md` → "The time of day"). Native ignores it.
   */
  timeOfDayOpen?: boolean;
  /** The scrubber asked to close: its close button, or Escape. */
  onTimeOfDayClose?: () => void;
  /**
   * Whether the city sky is drawn — so whether there is a time of day to
   * change. A screen shows its time-of-day control only while it is.
   */
  onSkyActiveChange?: (active: boolean) => void;
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
  /**
   * The camera: live while it moves, `isFinal` when it settles — including
   * the camera the map opened at, reported once it has loaded (`programmatic`,
   * so it never reads as the reader's move; `loadedCamera.ts`). A frame of a
   * `transient` animation is never final.
   */
  onViewportChange?: (change: MapCameraChange) => void;
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
  /** 3D models anchored at coordinates (see {@link MapModel}). */
  models?: readonly MapModel[];
  /**
   * A tap on a model (or on its fallback marker). Hit priority: marker, then
   * model, then basemap label, then bare map; a model is hit by its screen
   * bounds, because a 3 m car on a phone has to be forgiving.
   */
  onModelPress?: (model: MapModel) => void;
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
  onError?: (error: MapError | null) => void;
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

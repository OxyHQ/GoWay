/**
 * Engine plugins: what an app attaches to the web engine beyond sources,
 * layers and markers — a three.js custom layer, terrain, a camera rule.
 *
 * A plugin is an imperative object with a lifecycle, and the `<MapPlugin>`
 * component is the ONE place an app's plugin is bound to the engine: it
 * attaches when the engine is ready, hands the plugin every new `props` through
 * `update`, and detaches it when the component unmounts or the engine is
 * rebuilt. The app passes props; it never runs an effect.
 *
 * Web only. On native `<MapPlugin>` renders nothing: MapLibre Native has no
 * custom-layer API.
 *
 * `@goway.to/maps/plugin` is this module: the protocol, and the guards every
 * coordinate and command crossing into an engine goes through — pure, with no
 * React and no React Native, so an engine module (and its tests) can load it.
 */
import type { Map as MapLibreMap } from 'maplibre-gl';

export {
  asFinite,
  isDrawableBounds,
  isDrawableCoordinate,
  isDrawableGeoJSON,
  optionalScalar,
  reportMapDefect,
  runEngineCommand,
  toLngLat,
} from './shared';
export { PROGRAMMATIC, PROGRAMMATIC_TRANSIENT } from './moveMarkers';

/** A source's failure, as the engine reported it. */
export interface MapSourceError {
  sourceId: string;
  /** The HTTP status, when the failure was a response. */
  status?: number;
  message?: string;
}

export interface MapPluginHost {
  /** The element the engine draws into. */
  container: HTMLElement;
}

export interface MapPluginHandle<Props> {
  /** New props for an attached plugin. */
  update?(props: Props): void;
  /** Undo everything `attach` did. */
  detach(): void;
  /**
   * A press at a screen point, after the markers and before the basemap's
   * labels. `true` takes it: no label is resolved and `onPress` does not fire.
   */
  press?(point: { x: number; y: number }): boolean;
  /** Whether the pointer at `point` is over something this plugin draws (the cursor says so). */
  hover?(point: { x: number; y: number }): boolean;
  /**
   * Whether a source's error is the plugin's to handle — a decorative source
   * that may legitimately 404 — rather than the map's degraded state. The
   * plugin reports what it takes, if anything is worth reporting.
   */
  ownsError?(error: MapSourceError): boolean;
}

export interface MapPlugin<Props> {
  attach(map: MapLibreMap, props: Props, host: MapPluginHost): MapPluginHandle<Props>;
}

export interface MapPluginProps<Props> {
  plugin: MapPlugin<Props>;
  props: Props;
}

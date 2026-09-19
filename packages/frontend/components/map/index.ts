/**
 * The GoWay map seam.
 *
 * Feature code imports from HERE and nowhere else. `MapCanvas` resolves to the
 * `maplibre-gl` fork on web and the `@maplibre/maplibre-react-native` fork on
 * native; neither engine's name appears outside `components/map/`, so replacing
 * the renderer — or the tile source behind it (`lib/map/provider.ts`) — changes
 * no screen and no public `@goway.to/sdk` contract.
 */
export { MapCanvas } from './MapCanvas';
export { MapErrorState } from './MapErrorState';
export { MapAttribution } from './MapAttribution';
export { DefaultMapMarker } from './DefaultMapMarker';
export { DEFAULT_VIEWPORT } from './types';

export type {
  GeoBounds,
  GeoCoordinate,
  MapApi,
  MapAppearance,
  MapCameraOptions,
  MapCanvasError,
  MapCanvasProps,
  MapErrorReason,
  MapFitOptions,
  MapInteractionOptions,
  MapMarker,
  MapMoveSource,
  MapOverlay,
  MapOverlayKind,
  MapOverlayPaint,
  MapViewport,
  MapViewportChange,
  ResolvedMapViewport,
} from './types';

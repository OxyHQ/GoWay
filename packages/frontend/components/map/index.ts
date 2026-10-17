/**
 * GoWay's map seam.
 *
 * Feature code imports from HERE and nowhere else. `MapCanvas` is GoWay's map
 * composed on `@goway.to/maps` (MapLibre GL JS on the web, MapLibre Native on
 * iOS and Android); neither engine's name appears in feature code, so
 * replacing the renderer — or the tile source behind it (`lib/map/provider.ts`)
 * — changes no screen.
 */
export { MapCanvas } from './MapCanvas';
export { DEFAULT_VIEWPORT } from './types';
export { markerItem } from './markerItems';
export {
  DefaultMapMarker,
  MAP_BRAND_CLEARANCE,
  MAP_BRAND_HEIGHT,
  MAP_BRAND_WIDTH,
  MAP_CREDIT_CLEARANCE,
} from '@goway.to/maps';

export type {
  GeoBoundingBox,
  GeoCoordinate,
  MapApi,
  MapAppearance,
  MapCameraChange,
  MapCameraOptions,
  MapCanvasProps,
  MapCreditLink,
  MapError,
  MapErrorReason,
  MapFitOptions,
  MapFrame,
  MapInteractionOptions,
  MapLabelFeature,
  MapLabelKind,
  MapLiveGlyph,
  MapLiveLayer,
  MapLiveModel,
  MapLivePoint,
  MapMarker,
  MapModel,
  MapMoveSource,
  MapOverlay,
  MapOverlayKind,
  MapOverlayPaint,
  MapPressEvent,
  MapViewport,
  ResolvedMapViewport,
} from './types';

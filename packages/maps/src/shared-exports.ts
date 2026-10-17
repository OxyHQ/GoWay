/** What both entries export beyond their platform's components. */
export { useMap } from './mapRef';
export { useUserLocation } from './useUserLocation';
export type {
  LocationErrorReason,
  LocationPermissionStatus,
  UserLocationApi,
  UserLocationState,
} from './useUserLocation';
export { DefaultMapMarker } from './DefaultMapMarker';
export { MAP_CREDIT_CLEARANCE, MAP_DATA_CREDITS } from './MapAttribution';
export { MAP_BRAND_CLEARANCE, MAP_BRAND_HEIGHT, MAP_BRAND_WIDTH } from './MapBrand';
export { CREDIT_GAP, creditRise } from './creditRise';
export { sameLabelSet } from './labels';
export { MapChromeLiftContext, useMapChromeLift } from './chromeLift';
export type { MapChromeLift } from './chromeLift';
export { MapCreditHeightContext, useMapCreditHeight } from './creditHeight';
export { BrandedChromeProvider, useBrandedChrome } from './brand/BrandedChrome';
export { GowayLogo, gowayLogoHeight } from './brand/GowayLogo';
export type { GowayLogoProps, GowayLogoVariant } from './brand/GowayLogo';
export { DEFAULT_MAP_STYLE } from './styleUrl';
export type {
  GeoBoundingBox,
  GeoCoordinate,
  GeoJSONSourceProps,
  LayerProps,
  MapCameraChange,
  MapCameraOptions,
  MapCameraTarget,
  MapCreditDisclosure,
  MapCreditLink,
  MapError,
  MapErrorReason,
  MapFitOptions,
  MapFrame,
  MapInitialViewState,
  MapInteractionOptions,
  MapLabelFeature,
  MapLabelKind,
  MapLayerType,
  MapMarkerCluster,
  MapMarkerData,
  MapMarkerItem,
  MapMoveSource,
  MapPadding,
  MapPressEvent,
  MapViewport,
  MapViewProps,
  MapViewRef,
  MarkersProps,
  RasterDEMSourceProps,
  ResolvedMapViewport,
  UserLocationProps,
} from './types';

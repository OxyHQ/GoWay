/**
 * `@goway.to/maps` on the web — the same API as `index.ts`, built on
 * `maplibre-gl`. Every web fork is named explicitly: an export condition does
 * not apply to a relative import.
 */
export { MapView } from './MapView.web';
export { Markers } from './Markers.web';
export { GeoJSONSource } from './GeoJSONSource.web';
export { RasterDEMSource } from './RasterDEMSource.web';
export { Layer } from './Layer.web';
export { UserLocation } from './UserLocation.web';
export { MapPlugin } from './MapPlugin.web';
export * from './shared-exports';

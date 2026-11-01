import { DefaultMapMarker, MapView, Markers } from '@goway.to/maps/view';
import type { GeoCoordinate, MapMarkerData, MapViewRef } from '@goway.to/maps/view';
import type * as Root from '@goway.to/maps';

const map: typeof Root.MapView = MapView;
const markers: typeof Root.Markers = Markers;
const marker: typeof Root.DefaultMapMarker = DefaultMapMarker;
const coordinate: Root.GeoCoordinate = {} as GeoCoordinate;
const data: Root.MapMarkerData = {} as MapMarkerData;
const ref: Root.MapViewRef = {} as MapViewRef;
void [map, markers, marker, coordinate, data, ref];

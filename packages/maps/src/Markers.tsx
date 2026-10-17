/**
 * `<Markers>`, native — Bloom markers at their coordinates, clustered by the
 * same options Mapbox's sources take (`clusters.ts`).
 */
import { DefaultMapMarker } from './DefaultMapMarker';
import { Marker } from './Marker';
import type { MarkersProps } from './types';
import { useMarkerSlots } from './useMarkerSlots';

export function Markers(props: MarkersProps) {
  const { slots, press } = useMarkerSlots(props);
  const { renderMarker } = props;
  return (
    <>
      {slots.map((slot) => (
        <Marker key={slot.key} coordinate={slot.coordinate}>
          {renderMarker ? (
            renderMarker(slot.item, () => press(slot))
          ) : (
            <DefaultMapMarker item={slot.item} onPress={() => press(slot)} />
          )}
        </Marker>
      ))}
    </>
  );
}

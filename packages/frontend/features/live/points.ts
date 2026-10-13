/**
 * A sampled live entity → what the map draws: glyph, colour, real length,
 * 3D model and, for a train or bus, where each of its cars is. Pure.
 */
import type { MapLivePoint } from '@/components/map';

import { FLEETS, fleetLength, fleetOf } from './fleets';
import { glyphOf, labelOf, tintOf } from './kinds';
import type { LiveSample } from './liveStore';
import { consistAlong, consistStraight } from './track';

export function pointOf(sample: LiveSample, selectedId: string | null): MapLivePoint {
  const entity = sample.entity;
  const fleet = fleetOf(entity);
  const model = FLEETS[fleet];
  const point: MapLivePoint = {
    id: entity.id,
    glyph: glyphOf(entity),
    coordinate: { latitude: sample.latitude, longitude: sample.longitude },
    heading: entity.kind === 'bikeshare' ? null : sample.heading,
    altitude: entity.kind === 'aircraft' && !entity.onGround ? entity.altitudeMeters : null,
    opacity: sample.opacity,
    label: labelOf(entity),
    selected: entity.id === selectedId,
  };
  if (entity.kind === 'aircraft' || entity.kind === 'vessel') point.model = fleet;
  if (entity.kind !== 'transit') return point;

  const tint = tintOf(entity);
  if (tint) point.tint = tint;
  // A vehicle of no stated mode has no size or body to give it: flat, a marker.
  if (entity.mode === 'other') return point;
  point.length = fleetLength(fleet);
  point.approximate = sample.approximate;
  // An estimate is drawn flat only: in 3D a train placed by arithmetic would
  // look like a sighting, and a subway train would stand on the street above
  // its tunnel (`docs/MAP_LIVE.md` → Estimated positions).
  if (sample.estimated) {
    point.estimated = true;
    return point;
  }
  point.model = fleet;
  // Each car on the track where it is; off a track, a straight line along
  // the reported heading (or none, when there is none — one body).
  if (sample.onTrack) {
    point.parts = consistAlong(
      sample.onTrack.shape,
      sample.onTrack.along,
      model.cars,
      model.carLength,
      model.gap,
    ).map(({ latitude, longitude, heading }) => ({ coordinate: { latitude, longitude }, heading }));
  } else if (sample.heading !== null) {
    point.parts = consistStraight(
      sample,
      sample.heading,
      model.cars,
      model.carLength,
      model.gap,
    ).map(({ latitude, longitude, heading }) => ({ coordinate: { latitude, longitude }, heading }));
  }
  return point;
}

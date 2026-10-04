/**
 * GoWay Places as labels inside a Street 3D scene.
 *
 * Labels are drawn by the app over the splat, never baked into it: a renamed
 * shop is a data change, not a retraining. This module answers one question —
 * where, in SCENE coordinates, does each place go — and leaves projecting it
 * to the screen to the viewer, which does it every frame.
 */
import { placeDisplayName, type Place } from '@goway.to/sdk';
import type { StreetSceneWorldTransform } from '@goway/shared-types';

import { geodeticToEnu, invertSimilarity, transformPoint, type Vec3 } from './geodesy';

export interface ScenePlaceLabel {
  /** The GoWay Place ID — what a tap opens. */
  id: string;
  /** Already resolved for the reader's language (`placeDisplayName`). */
  name: string;
  /** Scene coordinates of the label's anchor point. */
  position: Vec3;
  /** Horizontal distance from the scene anchor, metres. */
  distanceMeters: number;
}

export interface PlaceLabelOptions {
  /** Most labels to hand the viewer. A wall of text is not a street. */
  max?: number;
  /**
   * Places farther than this from the scene anchor are dropped. A scene is a
   * stretch of street; a label for something three blocks away floats over
   * nothing the splat shows.
   */
  maxDistanceMeters?: number;
  /**
   * Height above the anchor's altitude to float the label at.
   *
   * Places carry no altitude, so ground level is approximated by the anchor's,
   * which is the solved ground of the scene. Eye level-ish keeps the label off
   * the pavement without putting it on the roof.
   */
  heightMeters?: number;
}

export const DEFAULT_MAX_LABELS = 40;
export const DEFAULT_MAX_LABEL_DISTANCE_METERS = 300;
export const DEFAULT_LABEL_HEIGHT_METERS = 3;

/**
 * Scene-space label anchors for `places`, nearest first, capped.
 *
 * Returns `[]` when the transform is not a similarity: no labels is honest,
 * labels placed by a matrix the contract does not allow are not.
 */
export function placeLabelsForScene(
  places: readonly Place[],
  transform: StreetSceneWorldTransform,
  options: PlaceLabelOptions = {},
): ScenePlaceLabel[] {
  const max = options.max ?? DEFAULT_MAX_LABELS;
  const maxDistance = options.maxDistanceMeters ?? DEFAULT_MAX_LABEL_DISTANCE_METERS;
  const height = options.heightMeters ?? DEFAULT_LABEL_HEIGHT_METERS;
  if (transform.frame !== 'enu') return [];
  const sceneFromEnu = invertSimilarity(transform.enuFromScene);
  if (!sceneFromEnu) return [];

  const { anchor } = transform;
  const origin = {
    latitude: anchor.latitude,
    longitude: anchor.longitude,
    altitudeMeters: anchor.altitudeMeters,
  };

  const labels: ScenePlaceLabel[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    if (seen.has(place.id)) continue;
    const { latitude, longitude } = place.location;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
    const enu = geodeticToEnu({ latitude, longitude, altitudeMeters: anchor.altitudeMeters + height }, origin);
    const distanceMeters = Math.hypot(enu[0], enu[1]);
    if (distanceMeters > maxDistance) continue;
    const name = placeDisplayName(place).trim();
    if (!name) continue;
    seen.add(place.id);
    labels.push({ id: place.id, name, position: transformPoint(sceneFromEnu, enu), distanceMeters });
  }

  labels.sort((a, b) => a.distanceMeters - b.distanceMeters || a.id.localeCompare(b.id));
  return labels.slice(0, Math.max(0, max));
}

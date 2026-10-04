/**
 * The published guided-navigation data of a scene version.
 *
 * The worker reports where every solved camera stood and which way it faced.
 * That is, in effect, the path each contributor walked — so before anything is
 * stored it is reduced to what a viewer needs and no more:
 *
 * - positions are rounded to centimetres and directions to four decimals;
 * - the set is SORTED by position before it is thinned, so neither what is kept
 *   nor the order it is stored in depends on the order the worker reported (a
 *   capture sequence, a contributor, a time);
 * - no two kept viewpoints are closer than {@link MIN_VIEWPOINT_SPACING_METERS};
 * - at most {@link MAX_PUBLISHED_VIEWPOINTS} survive.
 *
 * What remains says where the scene was seen from, which is what keeps a viewer
 * inside observed space. It carries no timestamp, no sequence and no identity.
 */

import type { StreetSceneNavigation, StreetSceneViewpoint } from '@goway/contracts';
import type { SceneReconstructResult } from './workerContract';

export const MIN_VIEWPOINT_SPACING_METERS = 1.5;
export const MAX_PUBLISHED_VIEWPOINTS = 1000;

type Vector3 = [number, number, number];

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  // `+ 0` folds a rounded `-0` into `0`, so equal positions serialize equally.
  return Math.round(value * factor) / factor + 0;
}

function unit(vector: Vector3): Vector3 | null {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (!Number.isFinite(length) || length < 1e-6) return null;
  return [round(vector[0] / length, 4), round(vector[1] / length, 4), round(vector[2] / length, 4)];
}

function compare(a: StreetSceneViewpoint, b: StreetSceneViewpoint): number {
  for (let axis = 0; axis < 3; axis += 1) {
    const delta = a.position[axis]! - b.position[axis]! || a.forward[axis]! - b.forward[axis]!;
    if (delta !== 0) return delta;
  }
  return 0;
}

function distance(a: Vector3, b: Vector3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/**
 * Round, sort and thin reported viewpoints. Pure and deterministic: the same
 * SET of viewpoints yields the same output whatever order it arrived in.
 */
export function decimateViewpoints(
  viewpoints: readonly { position: Vector3; forward: Vector3 }[],
): StreetSceneViewpoint[] {
  const rounded: StreetSceneViewpoint[] = [];
  for (const viewpoint of viewpoints) {
    const forward = unit(viewpoint.forward);
    if (!forward) continue;
    const position = viewpoint.position.map((value) => round(value, 2)) as Vector3;
    if (!position.every(Number.isFinite)) continue;
    rounded.push({ position, forward });
  }
  rounded.sort(compare);

  const kept: StreetSceneViewpoint[] = [];
  for (const candidate of rounded) {
    if (kept.every((other) => distance(other.position, candidate.position) >= MIN_VIEWPOINT_SPACING_METERS)) {
      kept.push(candidate);
    }
  }
  if (kept.length <= MAX_PUBLISHED_VIEWPOINTS) return kept;

  // Evenly across the sorted set rather than its first N, which would cut the
  // scene off along one axis.
  return Array.from(
    { length: MAX_PUBLISHED_VIEWPOINTS },
    (_, index) => kept[Math.floor((index * kept.length) / MAX_PUBLISHED_VIEWPOINTS)]!,
  );
}

/** The navigation a result publishes, or `null` when the worker reported none. */
export function publishedNavigation(result: SceneReconstructResult): StreetSceneNavigation | null {
  if (!result.viewpoints && !result.captureFieldOfView) return null;
  const navigation: StreetSceneNavigation = { viewpoints: decimateViewpoints(result.viewpoints ?? []) };
  if (result.captureFieldOfView) {
    navigation.fieldOfView = {
      horizontalDegrees: round(result.captureFieldOfView.horizontalDegrees, 1),
      verticalDegrees: round(result.captureFieldOfView.verticalDegrees, 1),
    };
  }
  return navigation;
}

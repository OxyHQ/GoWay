/**
 * Deciding where a capture actually is.
 *
 * A capture arrives with CLAIMS about its position, possibly several, possibly
 * disagreeing. This module turns them into one anchor and records which claim
 * won — and it is deliberately the only place that decision is made, because a
 * resolution rule spread across call sites is a rule that differs between the
 * upload path and the ingest path, and the two would then place the same photo
 * in two places.
 *
 * ## Why the client's coordinate is not simply believed
 *
 * It is not that contributors are adversaries: contribution requires an Oxy
 * session precisely so a bad actor is attributable. It is that a request body
 * is a CLAIM whatever its author intended — a stale last-known fix, a photo
 * edited by an app that rewrote its GPS, a library image whose EXIF belongs to
 * a different holiday. GoWay stores every claim, resolves one, and records
 * which one it resolved to, so that #13 can ask "was this position ever
 * independently measured?" and #11 can weight a georeferencing prior instead of
 * treating all positions as equally certain.
 *
 * ## The order, and the one thing it is NOT
 *
 * Origin first, by #9's stated preference (`device_capture` > `media_metadata`
 * > `user_placed`), then GoWay's own measurement over the client's claim within
 * the same origin, then the tighter accuracy.
 *
 * Accuracy is deliberately the LAST tiebreak rather than the first. A
 * `user_placed` tap can be reported with a 1 m accuracy and a real GPS fix with
 * 20 m, and ranking on the number alone would prefer the guess. Accuracy
 * discriminates between two positions of the same kind; it does not outrank
 * what kind they are.
 */

import {
  CAPTURE_LOCATION_ORIGIN_RANK,
  type CaptureAnchor,
  type CaptureLocationEvidence,
} from '@goway/shared-types';

/** GoWay's own measurement outranks a client's claim, within one origin. */
const WITNESS_RANK: Readonly<Record<CaptureLocationEvidence['witness'], number>> = {
  goway_ingest: 2,
  client: 1,
};

/**
 * Whether `candidate` should replace `incumbent` as the anchor.
 *
 * Strictly better, never merely equal: ties keep the incumbent, so resolution
 * is stable against the order evidence happens to be loaded in. An unstable
 * resolution would move a capture every time its rows came back in a different
 * order, which reads as data corruption rather than as a missing `ORDER BY`.
 */
function outranks(candidate: CaptureLocationEvidence, incumbent: CaptureLocationEvidence): boolean {
  const candidateOrigin = CAPTURE_LOCATION_ORIGIN_RANK[candidate.origin];
  const incumbentOrigin = CAPTURE_LOCATION_ORIGIN_RANK[incumbent.origin];
  if (candidateOrigin !== incumbentOrigin) return candidateOrigin > incumbentOrigin;

  const candidateWitness = WITNESS_RANK[candidate.witness];
  const incumbentWitness = WITNESS_RANK[incumbent.witness];
  if (candidateWitness !== incumbentWitness) return candidateWitness > incumbentWitness;

  // Unknown accuracy never beats a stated one. "We do not know how good this
  // is" is not evidence of being good, and treating an absent field as zero
  // metres would make the least informative claim win every tie.
  if (candidate.accuracyMeters === undefined) return false;
  if (incumbent.accuracyMeters === undefined) return true;
  return candidate.accuracyMeters < incumbent.accuracyMeters;
}

/**
 * The anchor for a set of evidence, or `null` when there is none.
 *
 * `null` is a real answer and callers must handle it: #9 is explicit that a
 * contribution is useful only if GoWay can establish a geographic anchor, and
 * the alternative to refusing is inventing one — which is the "silently guess a
 * precise location from unrelated personal history" the issue forbids by name.
 */
export function resolveCaptureAnchor(
  evidence: readonly CaptureLocationEvidence[],
): CaptureAnchor | null {
  let best: CaptureLocationEvidence | null = null;
  for (const candidate of evidence) {
    if (best === null || outranks(candidate, best)) best = candidate;
  }
  if (best === null) return null;
  return {
    coordinate: best.coordinate,
    origin: best.origin,
    witness: best.witness,
    ...(best.accuracyMeters === undefined ? {} : { accuracyMeters: best.accuracyMeters }),
  };
}

/**
 * Metres between two positions on a sphere.
 *
 * Used only to REPORT how far apart two pieces of evidence are — a diagnostic
 * for "the app said one street and the file's EXIF said another" — never to
 * decide which is right. A spherical approximation is ample for that: the
 * question is "tens of metres or hundreds", and the ellipsoidal correction is
 * far below the accuracy of anything being compared.
 */
export function evidenceDistanceMeters(
  a: CaptureLocationEvidence,
  b: CaptureLocationEvidence,
): number {
  const EARTH_RADIUS_METERS = 6_371_008.8;
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const deltaLatitude = toRadians(b.coordinate.latitude - a.coordinate.latitude);
  const deltaLongitude = toRadians(b.coordinate.longitude - a.coordinate.longitude);
  const halfChord =
    Math.sin(deltaLatitude / 2) ** 2 +
    Math.cos(toRadians(a.coordinate.latitude)) *
      Math.cos(toRadians(b.coordinate.latitude)) *
      Math.sin(deltaLongitude / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(halfChord)));
}

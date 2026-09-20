/**
 * Anchor resolution — which claim about a capture's position wins.
 *
 * The rule is small enough to look obvious and has three ways to get it wrong,
 * each of which produces a capture in the wrong place rather than an error:
 * ranking on accuracy first (a map tap reported as 1 m beats a real GPS fix),
 * treating an absent accuracy as zero (the least informative claim wins every
 * tie), and resolving unstably (the same capture moves depending on row order).
 */

import { describe, expect, it } from 'bun:test';
import type { CaptureLocationEvidence } from '@goway/shared-types';
import { evidenceDistanceMeters, resolveCaptureAnchor } from '../anchor';

const at = (
  latitude: number,
  longitude: number,
  overrides: Partial<CaptureLocationEvidence> = {},
): CaptureLocationEvidence => ({
  origin: 'media_metadata',
  witness: 'client',
  coordinate: { latitude, longitude },
  ...overrides,
});

describe('resolveCaptureAnchor', () => {
  it('has no anchor when there is no evidence, and says so', () => {
    // `null` is a real answer callers must handle: the alternative to refusing a
    // contribution with no position is inventing one.
    expect(resolveCaptureAnchor([])).toBeNull();
  });

  it('prefers a capture-time device position over media metadata', () => {
    const anchor = resolveCaptureAnchor([
      at(41.3851, 2.1734, { origin: 'media_metadata' }),
      at(41.39, 2.16, { origin: 'device_capture' }),
    ]);
    expect(anchor?.origin).toBe('device_capture');
    expect(anchor?.coordinate.latitude).toBe(41.39);
  });

  it('prefers media metadata over a contributor pointing at a map', () => {
    const anchor = resolveCaptureAnchor([
      at(41.39, 2.16, { origin: 'user_placed' }),
      at(41.3851, 2.1734, { origin: 'media_metadata' }),
    ]);
    expect(anchor?.origin).toBe('media_metadata');
  });

  it("prefers GoWay's own measurement over the client's claim about the same origin", () => {
    const anchor = resolveCaptureAnchor([
      at(41.3851, 2.1734, { witness: 'client' }),
      at(41.3902, 2.1601, { witness: 'goway_ingest' }),
    ]);
    expect(anchor?.witness).toBe('goway_ingest');
    expect(anchor?.coordinate.latitude).toBe(41.3902);
  });

  it('does NOT let a tight accuracy outrank the kind of evidence', () => {
    // The mistake this guards: a map tap reported at 1 m beating a real GPS fix
    // at 20 m. Accuracy discriminates between two positions of the same kind; it
    // does not decide what kind they are.
    const anchor = resolveCaptureAnchor([
      at(41.39, 2.16, { origin: 'user_placed', accuracyMeters: 1 }),
      at(41.3851, 2.1734, { origin: 'device_capture', accuracyMeters: 20 }),
    ]);
    expect(anchor?.origin).toBe('device_capture');
  });

  it('prefers the tighter accuracy between two claims of the same kind', () => {
    const anchor = resolveCaptureAnchor([
      at(41.39, 2.16, { accuracyMeters: 50 }),
      at(41.3851, 2.1734, { accuracyMeters: 8 }),
    ]);
    expect(anchor?.accuracyMeters).toBe(8);
  });

  it('never lets an unknown accuracy beat a stated one', () => {
    // "We do not know how good this is" is not evidence of being good. Treating
    // an absent field as zero metres would make the least informative claim win.
    const stated = at(41.3851, 2.1734, { accuracyMeters: 30 });
    const unknown = at(41.39, 2.16);
    expect(resolveCaptureAnchor([stated, unknown])?.accuracyMeters).toBe(30);
    expect(resolveCaptureAnchor([unknown, stated])?.accuracyMeters).toBe(30);
  });

  it('resolves the same way whatever order the evidence arrives in', () => {
    // An unstable resolution moves a capture every time its rows come back in a
    // different order, which reads as data corruption rather than as a missing
    // ORDER BY.
    const evidence = [
      at(41.39, 2.16, { origin: 'user_placed' }),
      at(41.3851, 2.1734, { origin: 'device_capture', accuracyMeters: 12 }),
      at(41.3902, 2.1601, { origin: 'media_metadata', witness: 'goway_ingest' }),
    ];
    const forwards = resolveCaptureAnchor(evidence);
    const backwards = resolveCaptureAnchor([...evidence].reverse());
    expect(forwards).toEqual(backwards);
    expect(forwards?.origin).toBe('device_capture');
  });

  it('carries the winning claim’s provenance, not just its coordinate', () => {
    // The point of the anchor: #13 and #11 need to know whether this position
    // was ever independently measured, and a bare pair of ordinates cannot say.
    const anchor = resolveCaptureAnchor([at(41.3851, 2.1734, { origin: 'user_placed' })]);
    expect(anchor).toEqual({
      coordinate: { latitude: 41.3851, longitude: 2.1734 },
      origin: 'user_placed',
      witness: 'client',
    });
  });
});

describe('evidenceDistanceMeters', () => {
  it('measures a real, independently checkable distance', () => {
    // Barcelona to Madrid is about 505 km. A transposed coordinate or a
    // degrees/radians slip would be off by orders of magnitude, not percent.
    const barcelona = at(41.3851, 2.1734);
    const madrid = at(40.4168, -3.7038);
    const kilometres = evidenceDistanceMeters(barcelona, madrid) / 1000;
    expect(kilometres).toBeGreaterThan(495);
    expect(kilometres).toBeLessThan(515);
  });

  it('is zero for two claims about the same point', () => {
    expect(evidenceDistanceMeters(at(41.3851, 2.1734), at(41.3851, 2.1734))).toBe(0);
  });
});

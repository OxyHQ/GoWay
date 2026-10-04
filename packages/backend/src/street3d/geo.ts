/**
 * The small amount of geometry and hashing the scheduler does in TypeScript.
 *
 * Neighbour search is PostGIS's job (`ST_DWithin` against GiST indexes), and
 * stays there. What is here is arithmetic on values already selected: which
 * 45° sector a heading falls in, the centre and box of a geohash cell, and the
 * digests that make an input set or a coverage cell comparable without
 * publishing what they are made of.
 */

import { createHash, createHmac } from 'node:crypto';

/** Eight 45° sectors; `0` is north-ish (337.5°–22.5°). */
export function headingSector(headingDegrees: number): number {
  const normalized = ((headingDegrees % 360) + 360) % 360;
  return Math.floor(((normalized + 22.5) % 360) / 45);
}

/**
 * The fingerprint of an input set: SHA-256 over the sorted frame digests.
 *
 * Content, not ids — a frame re-derived to identical bytes is the same input —
 * and order-free, so the same frames in a different SELECT order compare equal.
 */
export function inputFingerprint(frameDigests: readonly string[]): string {
  return createHash('sha256').update([...frameDigests].sort().join('\n'), 'utf8').digest('hex');
}

/**
 * The opaque `sequenceGroup` of a manifest frame.
 *
 * Frames from one contribution session are related (a walk down a street), and
 * telling the solve so is worth having. The group must not BE the session id
 * or anything a reader could join back to a contributor, so it is an HMAC keyed
 * by the job id: stable within one manifest, unlinkable across manifests.
 */
export function sequenceGroup(jobId: string, sessionId: string): string {
  return `g-${createHmac('sha256', jobId).update(sessionId, 'utf8').digest('hex').slice(0, 16)}`;
}

/** The public id of a coverage cell: a digest, so the cell key is not published. */
export function coverageAreaId(cell: string): string {
  return `area-${createHash('sha256').update(`goway-street3d-coverage:${cell}`, 'utf8').digest('hex').slice(0, 20)}`;
}

const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';

/** The bounds and centre of a geohash cell. Throws on a character outside the alphabet. */
export function decodeGeohash(cell: string): {
  center: { latitude: number; longitude: number };
  bounds: { west: number; south: number; east: number; north: number };
} {
  let south = -90;
  let north = 90;
  let west = -180;
  let east = 180;
  let longitudeBit = true;
  for (const character of cell) {
    const value = BASE32.indexOf(character);
    if (value < 0) throw new Error('Not a geohash.');
    for (let bit = 4; bit >= 0; bit -= 1) {
      const on = ((value >> bit) & 1) === 1;
      if (longitudeBit) {
        const middle = (west + east) / 2;
        if (on) west = middle;
        else east = middle;
      } else {
        const middle = (south + north) / 2;
        if (on) south = middle;
        else north = middle;
      }
      longitudeBit = !longitudeBit;
    }
  }
  return {
    center: { latitude: (south + north) / 2, longitude: (west + east) / 2 },
    bounds: { west, south, east, north },
  };
}

/** `1-4`, `5-19`, `20+`. Counts are only ever published as a band. */
export function contributionBand(count: number): '1-4' | '5-19' | '20+' {
  if (count >= 20) return '20+';
  if (count >= 5) return '5-19';
  return '1-4';
}

/**
 * Where a live thing is drawn NOW, and how fresh it looks — pure functions.
 *
 * ## The honesty rules, in code
 *
 *  - **A fix is the truth.** A thing that REPORTS its speed and course may be
 *    moved past its fix by dead reckoning for at most
 *    {@link extrapolationBoundSeconds}, never longer; past that it is HELD.
 *    A thing that reports no speed is never predicted: it is walked between
 *    its real fixes (`liveStore.ts`), and the course between them only turns
 *    its glyph.
 *  - **Stale is shown as stale.** Older than its source's `staleAfterSeconds`,
 *    a thing is drawn faded at its last REAL fix — not at a prediction — and
 *    does not move. Older than `dropAfterSeconds` it is not drawn at all.
 *  - **Nothing is invented.** A thing with no speed, no course and no usable
 *    previous fix does not move; a bike station never moves.
 *
 * Ages are measured on the SERVER's clock (`serverNow`), from the offset each
 * message's `at` gives, so a client whose clock is a minute out still shows
 * the right age.
 */

import type { LiveKind } from '@goway.to/sdk/live';

export interface Fix {
  latitude: number;
  longitude: number;
  /** Server-clock milliseconds the source observed it. */
  at: number;
}

/** Metres per second, east and north. */
export interface Velocity {
  east: number;
  north: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const DEG = Math.PI / 180;

/**
 * How long past its fix a thing of this kind may be moved. Kept SHORT: about
 * one poll interval plus latency, so motion bridges the gap between two real
 * fixes and never runs on beyond it.
 */
export function extrapolationBoundSeconds(kind: LiveKind, staleAfterSeconds: number): number {
  const cap: Record<LiveKind, number> = { aircraft: 20, transit: 25, vessel: 60, bikeshare: 0 };
  return Math.max(0, Math.min(cap[kind], staleAfterSeconds));
}

/** The fastest plausible ground speed per kind, for refusing a derived velocity. */
const MAX_SPEED_MPS: Record<LiveKind, number> = {
  aircraft: 340,
  transit: 90,
  vessel: 30,
  bikeshare: 0,
};

/** A reported speed and course as a velocity; `null` without both. */
export function velocityOf(speed: number | null, heading: number | null): Velocity | null {
  if (speed === null || heading === null || !Number.isFinite(speed) || !Number.isFinite(heading)) {
    return null;
  }
  return { east: speed * Math.sin(heading * DEG), north: speed * Math.cos(heading * DEG) };
}

/** Metres between two points, east and north (equirectangular: fine at these distances). */
export function offsetMeters(from: Fix, to: { latitude: number; longitude: number }): Velocity {
  const north = (to.latitude - from.latitude) * DEG * EARTH_RADIUS_M;
  let dLon = to.longitude - from.longitude;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  const east = dLon * DEG * EARTH_RADIUS_M * Math.cos(((from.latitude + to.latitude) / 2) * DEG);
  return { east, north };
}

/**
 * The velocity between two consecutive fixes, or `null` when they cannot
 * honestly give one: too close in time (a re-sent fix), too far apart (the
 * thing may have stopped in between), or implausibly fast (a feed glitch).
 */
export function derivedVelocity(kind: LiveKind, previous: Fix, current: Fix): Velocity | null {
  const seconds = (current.at - previous.at) / 1000;
  if (seconds < 2 || seconds > 180) return null;
  const offset = offsetMeters(previous, current);
  const speed = Math.hypot(offset.east, offset.north) / seconds;
  if (speed > MAX_SPEED_MPS[kind]) return null;
  // Under a walking pace is "standing at a stop", not motion worth drawing.
  if (speed < 0.5) return null;
  return { east: offset.east / seconds, north: offset.north / seconds };
}

/** A point moved by metres east and north. */
export function moveBy(
  point: Fix,
  east: number,
  north: number,
): { latitude: number; longitude: number } {
  const latitude = point.latitude + north / (EARTH_RADIUS_M * DEG);
  let longitude =
    point.longitude +
    east / (EARTH_RADIUS_M * DEG * Math.max(0.01, Math.cos(point.latitude * DEG)));
  if (longitude > 180) longitude -= 360;
  if (longitude < -180) longitude += 360;
  return { latitude: Math.max(-85, Math.min(85, latitude)), longitude };
}

/** Course in degrees from a velocity, `null` when not moving. */
export function headingOf(velocity: Velocity | null): number | null {
  if (!velocity || Math.hypot(velocity.east, velocity.north) < 0.1) return null;
  const degrees = Math.atan2(velocity.east, velocity.north) / DEG;
  return (degrees + 360) % 360;
}

export type Freshness = 'fresh' | 'stale' | 'expired';

export function freshnessOf(ageSeconds: number, staleAfter: number, dropAfter: number): Freshness {
  if (ageSeconds > dropAfter) return 'expired';
  if (ageSeconds > staleAfter) return 'stale';
  return 'fresh';
}

/** The opacity a freshness is drawn at. Stale things stay visible, plainly faded. */
export function opacityOf(freshness: Freshness): number {
  return freshness === 'fresh' ? 1 : freshness === 'stale' ? 0.38 : 0;
}

/**
 * Where to draw a thing at `serverNow`: its fix, moved by `velocity` for at
 * most `boundSeconds` while fresh; the fix itself once stale.
 */
export function positionAt(
  fix: Fix,
  velocity: Velocity | null,
  serverNow: number,
  boundSeconds: number,
  freshness: Freshness,
): { latitude: number; longitude: number } {
  if (!velocity || freshness !== 'fresh' || boundSeconds <= 0) {
    return { latitude: fix.latitude, longitude: fix.longitude };
  }
  const seconds = Math.max(0, Math.min((serverNow - fix.at) / 1000, boundSeconds));
  return moveBy(fix, velocity.east * seconds, velocity.north * seconds);
}

/**
 * Move between two drawn positions over `durationMs`: eased out for a short
 * correction, at a constant pace for a walk between fixes (a vehicle does not
 * brake into every report).
 */
export function blend(
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
  elapsedMs: number,
  durationMs: number,
  easing: 'out' | 'linear' = 'out',
): { latitude: number; longitude: number } {
  if (elapsedMs >= durationMs) return to;
  const t = Math.max(0, elapsedMs / durationMs);
  const k = easing === 'linear' ? t : 1 - (1 - t) ** 3;
  let dLon = to.longitude - from.longitude;
  if (dLon > 180) dLon -= 360;
  if (dLon < -180) dLon += 360;
  return {
    latitude: from.latitude + (to.latitude - from.latitude) * k,
    longitude: from.longitude + dLon * k,
  };
}

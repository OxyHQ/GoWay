/**
 * When and with what the buildings are re-lit from the sun — the runtime half
 * of `style/buildings3d.ts` → `sunLitBuildingsLight`.
 *
 * ## Why this happens at runtime at all
 *
 * The style document is a static JSON file (`scripts/build-map-style.ts` →
 * `public/map/goway-{light,dark}.json`) that both adapters load BY URL, and
 * MapLibre Native cannot be handed a style object at all. A light that depends
 * on the hour and on where the camera is cannot be baked into a file, so the
 * file keeps the static `BUILDINGS_LIGHT` as its fallback and each adapter lays
 * the sun light over it once the style is up: `map.setLight()` on web, the
 * `light` prop of `<Map>` on native. This module is everything about that
 * which is not engine wiring — the clock, the inputs, the dedupe — so it is the
 * same code on both platforms and it is testable without either engine.
 *
 * ## The inputs, and the privacy rule they keep
 *
 * The point the sun is computed for is the centre of the VIEWPORT: the place
 * the user is looking at, which is also the only place whose buildings are on
 * screen to be lit. It is never the user's position. Nothing here asks for
 * location permission, reads a location API or writes anything anywhere — the
 * centre lives in a ref inside the adapter's hook for as long as the map is
 * mounted and is gone when it unmounts. (A viewport centre is the same datum
 * the map already holds to draw itself; computing an angle from it creates no
 * new record of anything.)
 *
 * ## When it is recomputed — and why that is enough throttling
 *
 * Two triggers, and never a frame:
 *
 *  1. **The map settles** after a move (web `moveend`, native
 *     `onRegionDidChange`). A gesture produces one settle, not one per frame.
 *  2. **A slow clock**, {@link SUN_LIGHT_REFRESH_MS}, for a map left open while
 *     the sun moves. The sun's hour angle turns 0.25° a minute, so five
 *     minutes is 1.25° of it — a few degrees of azimuth, more only while the
 *     sun passes near the zenith, where the azimuth swings fastest — and
 *     MapLibre transitions the light over its default 300 ms either way.
 *
 * Neither trigger reaches the engine unless the light actually CHANGED:
 * `sunLitBuildingsLight` rounds to whole degrees and {@link nextBuildingsLight}
 * returns the previous object when the new one is equal, which the hook uses
 * as React's bail-out. Panning around one city therefore re-lights nothing —
 * a degree of longitude (~80 km at Barcelona's latitude) is four minutes of
 * hour angle, about a degree of azimuth — and the engine sees a call only when
 * the sun or the city really moved. Computing a sun position costs about a
 * microsecond; the call into the engine is the only thing worth rationing.
 */
import type { LightSpecification } from '@maplibre/maplibre-gl-style-spec';

import { isDrawableCoordinate } from '@/components/map/shared';
import type { GeoCoordinate } from '@/components/map/types';

import type { MapAppearance } from './provider';
import { BUILDINGS_LIGHT, sunLitBuildingsLight } from './style/buildings3d';
import { sunPosition } from './sun';

/**
 * How often an open, unmoving map re-reads the clock: five minutes. See the
 * module header for why that is slow enough to be free and fast enough to be
 * invisible.
 */
export const SUN_LIGHT_REFRESH_MS = 5 * 60_000;

/**
 * The buildings' light for `appearance`, at `now`, over `centre`.
 *
 * Falls back to the style document's own static light rather than throwing
 * when the inputs are not usable — a centre the engine could not draw, an
 * invalid `Date`. Those cannot happen from the adapters (the centre is the
 * engine's own, and `new Date()` is valid), but the rule of this whole seam is
 * that nothing non-finite crosses it, and a light with `NaN` in its position
 * is rejected by MapLibre's validator: the call would fail and leave whatever
 * light was there before, which is the same outcome said less clearly.
 */
export function buildingsLightAt(
  appearance: MapAppearance,
  centre: GeoCoordinate | null | undefined,
  now: Date,
): LightSpecification {
  if (!isDrawableCoordinate(centre) || !Number.isFinite(now.getTime())) {
    return BUILDINGS_LIGHT[appearance];
  }
  const sun = sunPosition(now, centre.latitude, centre.longitude);
  if (!Number.isFinite(sun.azimuthDeg) || !Number.isFinite(sun.altitudeDeg)) {
    return BUILDINGS_LIGHT[appearance];
  }
  return sunLitBuildingsLight(appearance, sun);
}

/**
 * What to hand the engine next, given what it has now.
 *
 * Two jobs:
 *
 *  1. **Dedupe.** An equal light returns `previous` ITSELF, so a hook can pass
 *     the result to `setState` and let React bail out — no render, no effect,
 *     no engine call.
 *  2. **Keep the azimuth continuous.** MapLibre transitions `position`
 *     component by component, so a light going from 359° to 1° would sweep
 *     358° the long way round — the shading visibly spinning once round every
 *     building — rather than step 2°. That is not an edge case: the sun
 *     crosses north every noon in the southern hemisphere and every midnight
 *     in the northern one, and the light follows it there (see the night note
 *     in `buildings3d.ts`). So the new azimuth is written as whichever
 *     equivalent angle (± 360·k) is nearest the current one. The value may
 *     therefore leave `[0, 360)` — by 360° a day on a map left open — which
 *     the style spec allows (`position` is three unbounded numbers, and the
 *     renderer only takes its sine and cosine).
 */
export function nextBuildingsLight(
  previous: LightSpecification | null,
  next: LightSpecification,
): LightSpecification {
  if (!previous) return next;
  const continuous = withAzimuthNear(next, previous);
  return sameLight(previous, continuous) ? previous : continuous;
}

/** Field-by-field equality over the four properties GoWay ever sets. */
export function sameLight(a: LightSpecification, b: LightSpecification): boolean {
  if (a.anchor !== b.anchor || a.color !== b.color || a.intensity !== b.intensity) return false;
  const pa = a.position;
  const pb = b.position;
  if (pa === pb) return true;
  if (!Array.isArray(pa) || !Array.isArray(pb) || pa.length !== pb.length) return false;
  return pa.every((value, index) => value === pb[index]);
}

/**
 * `next`, with its azimuth unwrapped to the representative nearest
 * `reference`'s. Only between two `map`-anchored lights with literal positions:
 * the azimuths of a `viewport` light and a `map` light are measured from
 * different zeros, and there is no "nearest" between them worth preserving.
 */
function withAzimuthNear(
  next: LightSpecification,
  reference: LightSpecification,
): LightSpecification {
  if (next.anchor !== 'map' || reference.anchor !== 'map') return next;
  const target = literalPosition(next.position);
  const current = literalPosition(reference.position);
  if (!target || !current) return next;
  const turns = Math.round((current[1] - target[1]) / 360);
  if (turns === 0) return next;
  return { ...next, position: [target[0], target[1] + turns * 360, target[2]] };
}

function literalPosition(
  position: LightSpecification['position'],
): [number, number, number] | null {
  if (!Array.isArray(position) || position.length !== 3) return null;
  const [r, azimuth, polar] = position;
  return typeof r === 'number' && typeof azimuth === 'number' && typeof polar === 'number'
    ? [r, azimuth, polar]
    : null;
}

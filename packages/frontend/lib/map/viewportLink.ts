/**
 * The other half of `@goway.to/sdk`'s `links.map(viewport)`.
 *
 * The SDK has always been able to BUILD `https://goway.to/?lat=…&lng=…&zoom=…`
 * — it is the documented way an integrator points somebody at a place on the
 * map — but the app never read those parameters back, so every link the SDK
 * produced opened on the default camera and the frame the sender chose was
 * silently discarded. That is a one-sided contract: a link format promised by
 * a published package and honoured by nothing. This module is the read side.
 *
 * ## Why a whole module for three numbers
 *
 * Because the numbers arrive from a URL, which is to say from anywhere: a
 * truncated paste, a link mangled by a chat client, a crawler probing
 * `?lat=NaN`, a spreadsheet that wrote `2,1750` with a comma. MapLibre's camera
 * does not defend itself against any of that — a non-finite centre reaches
 * `LngLat` and **throws**, taking the canvas down with it, which is exactly the
 * class of defect `isDrawableCoordinate` exists to stop one layer lower. So the
 * rule here is total: {@link parseViewportFromParams} answers with a viewport
 * or with `null`, never with a partially-trusted object and never by throwing.
 * `null` means "open where you always open", which is a perfectly good outcome
 * for a broken link and is not worth an error state.
 *
 * ## What is accepted
 *
 * `lat`, `lng` and `zoom` together, or nothing. A link with a centre and no
 * zoom is a link that says where but not how close, and picking a zoom for it
 * would be inventing the half the sender did not send; the SDK always writes
 * all three. `bearing` and `pitch` are optional on both sides and are dropped
 * individually if they do not parse, because a rotation is a refinement of a
 * frame rather than part of it.
 *
 * Ranges are the projection's, not the schema's: Web Mercator cannot express a
 * latitude past ±85.0511, so a pole is refused rather than clamped — clamping
 * would answer a nonsense link with a confident, wrong map of Antarctica.
 * Longitude wraps instead of refusing, because ±180 is a seam and not a limit,
 * and `lng=181` is a real way to say `-179`. Zoom clamps into the source's
 * advertised range, since a zoom past `maxZoom` is a legible intention ("as
 * close as you can") rather than an error.
 */
import type { MapViewport } from '@/components/map/types';

import { getMapSource } from './provider';

/**
 * The widest latitude Web Mercator can project.
 *
 * `atan(sinh(π))` in degrees. Past it the projection runs to infinity, and an
 * engine handed 90 produces either a throw or a camera nobody asked for.
 */
const MERCATOR_LATITUDE_LIMIT = 85.051129;

/** Query parameters as a router hands them over: string, repeated, or absent. */
export type ViewportParamSource = Readonly<Record<string, string | string[] | undefined>>;

/**
 * One parameter as a finite number, or `undefined`.
 *
 * A repeated parameter (`?zoom=14&zoom=17`) is a malformed link rather than a
 * choice, so the first value wins and the rest are ignored — the alternative,
 * refusing the whole viewport, throws away a frame that is probably right.
 *
 * `Number('')` is `0` and `Number(' ')` is `0`, which would turn `?lat=` into
 * the equator; the empty check is what stops that.
 */
function numberParam(source: ViewportParamSource, key: string): number | undefined {
  const raw = source[key];
  const text = Array.isArray(raw) ? raw[0] : raw;
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * Fold a longitude into [-180, 180]. `-179` and `181` are the same meridian.
 *
 * The early return is not an optimisation. `((2.1 + 180) % 360 + 360) % 360 -
 * 180` is `2.1000000000000227` in binary floating point, so wrapping a
 * longitude that was ALREADY in range perturbs it — and since this parser sits
 * at the far end of a link the SDK built from a camera, that perturbation is a
 * link that does not round-trip. An in-range value is returned untouched.
 */
function wrapLongitude(value: number): number {
  if (value >= -180 && value <= 180) return value;
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  // `-180` and `180` are the same line; normalise so a round-trip is stable.
  return wrapped === -180 ? 180 : wrapped;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Read `?lat=&lng=&zoom=` (and optionally `&bearing=&pitch=`) into a viewport.
 *
 * @returns the viewport the link asked for, or `null` when the link did not
 * ask for one or asked for one that cannot be drawn. Never throws.
 */
export function parseViewportFromParams(source: ViewportParamSource): MapViewport | null {
  const latitude = numberParam(source, 'lat');
  const longitude = numberParam(source, 'lng');
  const zoom = numberParam(source, 'zoom');

  if (latitude === undefined || longitude === undefined || zoom === undefined) return null;
  if (latitude < -MERCATOR_LATITUDE_LIMIT || latitude > MERCATOR_LATITUDE_LIMIT) return null;

  const { minZoom, maxZoom } = getMapSource();
  const viewport: MapViewport = {
    latitude,
    longitude: wrapLongitude(longitude),
    zoom: clamp(zoom, minZoom, maxZoom),
  };

  const bearing = numberParam(source, 'bearing');
  if (bearing !== undefined) viewport.bearing = ((bearing % 360) + 360) % 360;

  const pitch = numberParam(source, 'pitch');
  // 60° is MapLibre's own ceiling on both engines; past it the horizon enters
  // the frame and the renderer clamps anyway.
  if (pitch !== undefined) viewport.pitch = clamp(pitch, 0, 60);

  return viewport;
}

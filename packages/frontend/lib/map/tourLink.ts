/**
 * A Camera Studio tour as a link: `https://goway.to/studio?tour=1.<payload>`.
 *
 * The same contract as the viewport link (`viewportLink.ts`), extended from
 * three numbers to a whole camera path, and held to the same rules:
 *
 *  - **Total.** {@link parseTourFromParams} answers a tour or `null` — never a
 *    partly trusted object, never a throw. A link arrives from anywhere: a
 *    truncated paste, a chat client that ate the end, a crawler, a hand edit.
 *    `null` means "open the Studio empty", which is a fine outcome for a broken
 *    link.
 *  - **The projection's ranges.** Latitudes past Web Mercator's ±85.0511 are
 *    refused, not clamped; zoom clamps into the source's range; pitch into the
 *    renderer's 0–60.
 *  - **Versioned.** The payload starts with its format version (`1.`). A
 *    version this build does not know is refused, so a future format can never
 *    be misread as this one.
 *  - **Validated by schema.** Decoding the bytes only produces CANDIDATE
 *    numbers; whether they are a tour is decided by one zod schema
 *    ({@link tourLinkSchema}), so a bound lives in exactly one place.
 *
 * The link also carries `lat`/`lng`/`zoom` of the first keyframe. A build
 * without the Studio (the flag is off) redirects `/studio` to the map with
 * those, so a shared tour degrades to "here is where it starts" rather than to
 * the default camera.
 *
 * ## Why a binary payload
 *
 * Readable query parameters would be ~80 characters a keyframe and a 64-frame
 * tour would overflow what chat clients keep of a URL. The payload is varints
 * (base64url): coordinates as 1e-5° deltas from the previous keyframe — about
 * a metre, Google's polyline precision — zoom in hundredths, pitch and bearing
 * in tenths, hold in tenths of a second. A drawn 20-keyframe tour is ~250
 * characters.
 *
 * ## Why the schema is here and not in `packages/contracts`
 *
 * This is a URL the GoWay app writes and reads, not an API request or
 * response: no server sees it and `@goway.to/sdk` does not build it. AGENTS.md
 * puts every API shape in `contracts`; if the SDK ever learns to build tour
 * links, this schema moves there with it.
 */
import { z } from 'zod';

import { WEB_ORIGIN } from '@/lib/config';

import {
  MAX_TOUR_HOLD_MS,
  MAX_TOUR_KEYFRAMES,
  MAX_TOUR_SPEED,
  MIN_TOUR_KEYFRAMES,
  MIN_TOUR_SPEED,
  TOUR_AIMS,
  type Tour,
  type TourKeyframe,
} from './camera/tour';
import { getMapSource } from './provider';
import { MERCATOR_LATITUDE_LIMIT, type ViewportParamSource } from './viewportLink';

/** The format this build writes, and the only one it reads. */
export const TOUR_LINK_VERSION = 1;

/** Longest `tour=` value accepted, before any decoding is attempted. */
const MAX_PARAM_LENGTH = 4096;

const COORDINATE_SCALE = 1e5;

const coordinateSchema = z.object({
  latitude: z.number().min(-MERCATOR_LATITUDE_LIMIT).max(MERCATOR_LATITUDE_LIMIT),
  longitude: z.number().min(-180).max(180),
});

const keyframeSchema = z
  .object({
    center: coordinateSchema,
    zoom: z.number().min(0).max(24),
    pitch: z.number().min(0).max(60),
    bearing: z.number().min(0).lt(360),
    aim: z.enum(TOUR_AIMS),
    lookAt: coordinateSchema.optional(),
    holdMs: z.number().int().min(0).max(MAX_TOUR_HOLD_MS),
  })
  .refine((k) => k.aim !== 'lookAt' || k.lookAt !== undefined, 'lookAt needs a point');

/** What a decoded payload must be to count as a tour. */
export const tourLinkSchema = z.object({
  version: z.literal(TOUR_LINK_VERSION),
  speed: z.number().min(MIN_TOUR_SPEED).max(MAX_TOUR_SPEED),
  keyframes: z.array(keyframeSchema).min(MIN_TOUR_KEYFRAMES).max(MAX_TOUR_KEYFRAMES),
});

// --- bytes ----------------------------------------------------------------

class Writer {
  private readonly bytes: number[] = [];
  uint(value: number): void {
    let v = Math.max(0, Math.round(value));
    while (v >= 0x80) {
      this.bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    this.bytes.push(v);
  }
  int(value: number): void {
    const v = Math.round(value);
    this.uint(v >= 0 ? v * 2 : -v * 2 - 1);
  }
  toBase64Url(): string {
    let binary = '';
    for (const b of this.bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
}

/** Thrown inside {@link decodePayload} only; never escapes this module. */
class Truncated extends Error {}

class Reader {
  private offset = 0;
  constructor(private readonly bytes: Uint8Array) {}
  uint(): number {
    let value = 0;
    let scale = 1;
    // Five bytes is 35 bits — more than any field here needs; a longer run is
    // garbage, not a big number.
    for (let i = 0; i < 5; i++) {
      if (this.offset >= this.bytes.length) throw new Truncated();
      const byte = this.bytes[this.offset++];
      value += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return value;
      scale *= 0x80;
    }
    throw new Truncated();
  }
  int(): number {
    const v = this.uint();
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
  get done(): boolean {
    return this.offset === this.bytes.length;
  }
}

function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// --- encode ---------------------------------------------------------------

/** The `tour=` value for a tour. Keyframe ids are not part of it. */
export function encodeTour(tour: Tour): string {
  const w = new Writer();
  w.uint(tour.speed * 100);
  w.uint(tour.keyframes.length);
  let lat = 0;
  let lng = 0;
  for (const k of tour.keyframes) {
    const qLat = Math.round(k.center.latitude * COORDINATE_SCALE);
    const qLng = Math.round(k.center.longitude * COORDINATE_SCALE);
    w.int(qLat - lat);
    w.int(qLng - lng);
    lat = qLat;
    lng = qLng;
    w.uint(k.zoom * 100);
    w.uint(k.pitch * 10);
    w.uint(TOUR_AIMS.indexOf(k.aim));
    if (k.aim === 'fixed') w.uint(((Math.round(k.bearing * 10) % 3600) + 3600) % 3600);
    if (k.aim === 'lookAt' && k.lookAt) {
      w.int(Math.round(k.lookAt.latitude * COORDINATE_SCALE) - qLat);
      w.int(Math.round(k.lookAt.longitude * COORDINATE_SCALE) - qLng);
    }
    w.uint(k.holdMs / 100);
  }
  return `${TOUR_LINK_VERSION}.${w.toBase64Url()}`;
}

/**
 * A shareable URL for a tour, on the configured web origin. Carries the first
 * keyframe's camera too (see the header).
 */
export function tourLink(tour: Tour, origin: string = WEB_ORIGIN): string {
  const first = tour.keyframes[0];
  const params = new URLSearchParams({ tour: encodeTour(tour) });
  if (first) {
    params.set('lat', first.center.latitude.toFixed(5));
    params.set('lng', first.center.longitude.toFixed(5));
    params.set('zoom', first.zoom.toFixed(2));
  }
  return `${origin.replace(/\/+$/, '')}/studio?${params.toString()}`;
}

// --- decode ---------------------------------------------------------------

/** Bytes → candidate numbers. Shape only; ranges are the schema's job. */
function decodePayload(bytes: Uint8Array): unknown {
  const r = new Reader(bytes);
  const speed = r.uint() / 100;
  const count = r.uint();
  // Refuse before allocating: a count is a claim, and the schema would refuse
  // it anyway after we had read garbage for it.
  if (count > MAX_TOUR_KEYFRAMES) return null;
  const keyframes: unknown[] = [];
  let lat = 0;
  let lng = 0;
  for (let i = 0; i < count; i++) {
    lat += r.int();
    lng += r.int();
    const zoom = r.uint() / 100;
    const pitch = r.uint() / 10;
    const aim = TOUR_AIMS[r.uint()];
    let bearing = 0;
    let lookAt: { latitude: number; longitude: number } | undefined;
    if (aim === 'fixed') bearing = r.uint() / 10;
    if (aim === 'lookAt') {
      const dLat = r.int();
      const dLng = r.int();
      lookAt = {
        latitude: (lat + dLat) / COORDINATE_SCALE,
        longitude: (lng + dLng) / COORDINATE_SCALE,
      };
    }
    const holdMs = r.uint() * 100;
    keyframes.push({
      center: { latitude: lat / COORDINATE_SCALE, longitude: lng / COORDINATE_SCALE },
      zoom,
      pitch,
      bearing,
      aim,
      ...(lookAt ? { lookAt } : {}),
      holdMs,
    });
  }
  // Trailing bytes mean this is not the payload we wrote.
  if (!r.done) return null;
  return { version: TOUR_LINK_VERSION, speed, keyframes };
}

/**
 * A `tour=` value as a tour, or `null`. Never throws.
 */
export function decodeTour(value: string): Tour | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PARAM_LENGTH)
    return null;
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  if (value.slice(0, dot) !== String(TOUR_LINK_VERSION)) return null;
  const bytes = fromBase64Url(value.slice(dot + 1));
  if (!bytes || bytes.length === 0) return null;

  let candidate: unknown;
  try {
    candidate = decodePayload(bytes);
  } catch {
    // `Truncated`, or anything else the bytes provoke: not a tour.
    return null;
  }
  const parsed = tourLinkSchema.safeParse(candidate);
  if (!parsed.success) return null;

  const { minZoom, maxZoom } = getMapSource();
  const keyframes: TourKeyframe[] = parsed.data.keyframes.map((k, index) => ({
    id: `k${index + 1}`,
    center: k.center,
    zoom: Math.min(maxZoom, Math.max(minZoom, k.zoom)),
    pitch: k.pitch,
    bearing: k.bearing,
    aim: k.aim,
    ...(k.lookAt ? { lookAt: k.lookAt } : {}),
    holdMs: k.holdMs,
  }));
  return { speed: parsed.data.speed, keyframes };
}

/**
 * Read `?tour=` from a route's parameters. A repeated parameter takes the
 * first value, as the viewport link does.
 */
export function parseTourFromParams(source: ViewportParamSource): Tour | null {
  const raw = source.tour;
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' ? decodeTour(value) : null;
}

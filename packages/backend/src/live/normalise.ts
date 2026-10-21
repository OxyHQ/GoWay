/**
 * The small, strict helpers every adapter normalises with, and the HTTP read
 * they all share.
 *
 * Strict in one direction only: a value that is ABSENT or out of range becomes
 * `null` (an aircraft that does not report its vertical rate still has a
 * position), but a value the entity cannot exist without — a coordinate, an
 * observation time, an id — refuses the whole record.
 */

import { type LiveEntity, liveEntitySchema } from '@goway/contracts';
import { type LiveFetch, LiveUpstreamError } from './types';

/** A finite number, or `null`. Strings are NOT parsed: a feed that sends `"12"` for a number is junk there. */
export function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A finite number within `[min, max]`, or `null`. */
export function within(value: unknown, min: number, max: number): number | null {
  const number = finite(value);
  return number !== null && number >= min && number <= max ? number : null;
}

/** Trimmed text of at most `max` characters, or `null` (empty, too long, not a string). */
export function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= max ? trimmed : null;
}

/** A heading in `[0, 360)`, folded from any finite angle; `null` otherwise. */
export function heading(value: unknown): number | null {
  const angle = finite(value);
  if (angle === null) return null;
  // Hundredths of a degree: more than any feed measures, and it keeps the
  // modulo's float noise (98.79 → 98.79000000000002) off the wire.
  const folded = Math.round((((angle % 360) + 360) % 360) * 100) / 100;
  return folded >= 360 ? 0 : folded;
}

/**
 * A plausible position: in range, and not the `(0, 0)` "Null Island" a feed
 * writes when it has no fix. Optionally inside a box (with a margin, in
 * degrees), because a Barcelona bike station in the Gulf of Guinea is a feed
 * bug, not a station.
 */
export function position(
  latitude: unknown,
  longitude: unknown,
  inside?: { west: number; south: number; east: number; north: number } | null,
  marginDegrees = 1,
): { latitude: number; longitude: number } | null {
  const lat = within(latitude, -90, 90);
  const lon = within(longitude, -180, 180);
  if (lat === null || lon === null) return null;
  if (Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6) return null;
  if (inside) {
    if (lat < inside.south - marginDegrees || lat > inside.north + marginDegrees) return null;
    if (inside.west <= inside.east) {
      if (lon < inside.west - marginDegrees || lon > inside.east + marginDegrees) return null;
    }
  }
  return { latitude: lat, longitude: lon };
}

/** An instant as ISO 8601, from epoch milliseconds; `null` for anything implausible. */
export function instant(epochMs: number | null, nowMs: number): string | null {
  if (epochMs === null || !Number.isFinite(epochMs)) return null;
  // Before 2000 or more than five minutes in the future: a clock or unit bug.
  if (epochMs < 946_684_800_000 || epochMs > nowMs + 5 * 60_000) return null;
  return new Date(epochMs).toISOString();
}

export const KNOTS_TO_METERS_PER_SECOND = 0.514444;
export const FEET_TO_METERS = 0.3048;
export const FEET_PER_MINUTE_TO_METERS_PER_SECOND = 0.00508;

/** The contract's own check, as the last step of every normaliser. */
export function accept(candidate: unknown): LiveEntity | null {
  const parsed = liveEntitySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

/** The largest upstream body read. Digitraffic's full AIS snapshot is ~6 MB. */
export const MAX_UPSTREAM_BYTES = 40 * 1024 * 1024;

/** The most redirects followed for one request. */
export const MAX_REDIRECTS = 5;

/**
 * Headers that may follow a redirect to ANOTHER origin. Everything else — an
 * API key (`x-api-key`, `Authorization`, `Ocp-Apim-Subscription-Key`,
 * `KeyID`…), a client name — stays with the origin it was meant for.
 */
const CROSS_ORIGIN_HEADERS = new Set(['user-agent', 'accept', 'accept-encoding', 'range']);

/**
 * A `Retry-After` value in seconds: its delay-seconds form, or its HTTP-date
 * form measured against `nowMs`; `null` for neither (or one in the past).
 */
export function retryAfterSeconds(value: string | null, nowMs: number = Date.now()): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    return seconds > 0 ? seconds : null;
  }
  const at = Date.parse(trimmed);
  if (!Number.isFinite(at)) return null;
  const seconds = Math.ceil((at - nowMs) / 1000);
  return seconds > 0 ? seconds : null;
}

/**
 * A response's body, counted as it arrives — DECOMPRESSED bytes, which is
 * what `fetch` streams (a 3 MB gzip bomb is 3 GB of them; `content-length`
 * is the compressed size and says nothing). Refused at `maxBytes`: an
 * oversized, endless or bombed body costs at most the cap, never itself.
 */
export async function readBody(
  response: Awaited<ReturnType<LiveFetch>>,
  maxBytes: number,
): Promise<Uint8Array> {
  const tooLarge = (bytes: number) =>
    new LiveUpstreamError(`upstream body too large (over ${maxBytes} bytes; ${bytes} read)`);
  if (!response.body) {
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw tooLarge(body.byteLength);
    return body;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooLarge(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/**
 * GET a URL and answer its response once it is not a redirect, or throw
 * {@link LiveUpstreamError} for an error status. Redirects are followed by
 * hand: to the same origin with every header, to another with none but the
 * ones in {@link CROSS_ORIGIN_HEADERS} — a key never leaves for a host it was
 * not issued for — and only from https to https.
 */
export async function getResponse(
  fetch: LiveFetch,
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  { accept206 = false }: { accept206?: boolean } = {},
): Promise<Awaited<ReturnType<LiveFetch>>> {
  let current = url;
  let sent = headers;
  for (let hop = 0; ; hop++) {
    const response = await fetch(current, { signal, headers: sent, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
      const location = response.headers.get('location');
      if (!location || hop >= MAX_REDIRECTS)
        throw new LiveUpstreamError(
          `upstream redirected ${response.status} without a usable location`,
        );
      const next = new URL(location, current);
      const from = new URL(current);
      if (from.protocol === 'https:' && next.protocol !== 'https:')
        throw new LiveUpstreamError('upstream redirected from https to http');
      if (next.origin !== from.origin) {
        sent = Object.fromEntries(
          Object.entries(sent).filter(([name]) => CROSS_ORIGIN_HEADERS.has(name.toLowerCase())),
        );
      }
      current = next.toString();
      continue;
    }
    const ok = response.status >= 200 && response.status < 300;
    if (!ok && !(accept206 && response.status === 206)) {
      throw new LiveUpstreamError(
        `upstream answered ${response.status}`,
        retryAfterSeconds(response.headers.get('retry-after')),
        response.status,
      );
    }
    return response;
  }
}

/**
 * GET a URL and return its body, bounded at `maxBytes` decompressed
 * ({@link readBody}), or throw {@link LiveUpstreamError}.
 *
 * A 429 or 503 carries its `Retry-After` (seconds or an HTTP date) into the
 * error, so the poller backs off for as long as the upstream asked rather
 * than by its own guess.
 */
export async function getBytes(
  fetch: LiveFetch,
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
  maxBytes: number = MAX_UPSTREAM_BYTES,
): Promise<Uint8Array> {
  const response = await getResponse(fetch, url, signal, headers);
  return readBody(response, maxBytes);
}

/** GET and parse JSON, or throw {@link LiveUpstreamError}. */
export async function getJson(
  fetch: LiveFetch,
  url: string,
  signal: AbortSignal,
  headers: Record<string, string>,
): Promise<unknown> {
  const bytes = await getBytes(fetch, url, signal, { accept: 'application/json', ...headers });
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new LiveUpstreamError('upstream answered something that is not JSON');
  }
}

/** A plain object, or `null`. */
export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

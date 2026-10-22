/**
 * Reading a provider's catalogue: one bounded GET, refused when it is not data.
 * Every source goes through here, so a slow, huge or failing upstream is the
 * same `CameraUpstreamError` whatever the provider.
 */

import { CameraUpstreamError, type CameraFetchContext } from './types';

/** The largest catalogue GoWay reads (Hong Kong's is ~0.4 MB; this is generous, not open-ended). */
export const MAX_CATALOGUE_BYTES = 40 * 1024 * 1024;

export async function getText(
  url: string,
  context: CameraFetchContext,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await context.fetch(url, {
    signal: context.signal,
    headers: { accept: '*/*', ...headers },
  });
  if (response.status !== 200) {
    throw new CameraUpstreamError(
      `${new URL(url).host} answered ${response.status}`,
      response.status,
    );
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_CATALOGUE_BYTES) throw new CameraUpstreamError('the catalogue is too large');
  const text = await response.text();
  if (text.length > MAX_CATALOGUE_BYTES)
    throw new CameraUpstreamError('the catalogue is too large');
  return text;
}

export async function getJson(
  url: string,
  context: CameraFetchContext,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const text = await getText(url, context, { accept: 'application/json', ...headers });
  try {
    return JSON.parse(text);
  } catch {
    throw new CameraUpstreamError(`${new URL(url).host} did not answer JSON`);
  }
}

/** `value` as a plain object, or `null`. */
export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `value` as a finite number (a numeric string counts: XML and CSV feeds are all text), or `null`. */
export function numberOf(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** `value` as a Date from an ISO 8601 string, or `null`. */
export function dateOf(value: unknown): Date | null {
  if (typeof value !== 'string') return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

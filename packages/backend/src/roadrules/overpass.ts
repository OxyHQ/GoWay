/**
 * The Overpass API, as far as road-rule syncs read it.
 *
 * A replaceable adapter like every provider: the syncs call {@link Overpass}
 * and never a URL. The public instance asks for an identifying `User-Agent`
 * and answers `429`/`504` under load, so a request is identified, bounded in
 * time and retried a couple of times with a growing pause — and then fails
 * loudly, because a sync that quietly read half an answer must not withdraw
 * the other half's rules.
 */

import { logger } from '../utils/logger';

export const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const USER_AGENT = 'GoWay-road-rules/1.0 (https://goway.to; contact: hello@goway.to)';
const REQUEST_TIMEOUT_MS = 150_000;
const RETRIES = 2;
const RETRY_PAUSE_MS = 20_000;

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role: string;
  geometry?: { lat: number; lon: number }[];
}

export interface OverpassElement {
  type: 'relation' | 'way' | 'node';
  id: number;
  tags?: Record<string, string>;
  members?: OverpassMember[];
}

export interface OverpassResult {
  elements: OverpassElement[];
  /** The OpenStreetMap data's own timestamp, ISO 8601. */
  dataTimestamp: string | null;
}

export interface Overpass {
  query(ql: string): Promise<OverpassResult>;
}

type Fetch = typeof fetch;

export function createOverpass(
  options: { fetch?: Fetch; url?: string; pauseMs?: number } = {},
): Overpass {
  const doFetch = options.fetch ?? fetch;
  const url = options.url ?? OVERPASS_URL;
  const pause = options.pauseMs ?? RETRY_PAUSE_MS;
  return {
    async query(ql) {
      let lastError: unknown;
      for (let attempt = 0; attempt <= RETRIES; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, pause * attempt));
        try {
          const response = await doFetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
              'user-agent': USER_AGENT,
            },
            body: `data=${encodeURIComponent(ql)}`,
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          });
          if (response.status === 429 || response.status >= 500) {
            lastError = new Error(`Overpass answered ${response.status}`);
            logger.warn({ status: response.status, attempt }, 'Overpass busy; retrying');
            continue;
          }
          if (!response.ok) throw new Error(`Overpass answered ${response.status}`);
          const body = (await response.json()) as {
            elements?: OverpassElement[];
            osm3s?: { timestamp_osm_base?: string };
            remark?: string;
          };
          // A query that ran out of time or memory answers 200 with a remark and
          // a partial list: never mistake that for the whole answer.
          if (body.remark && /(runtime error|timed out|out of memory)/i.test(body.remark)) {
            throw new Error(`Overpass could not finish the query: ${body.remark}`);
          }
          return {
            elements: body.elements ?? [],
            dataTimestamp: body.osm3s?.timestamp_osm_base ?? null,
          };
        } catch (error) {
          lastError = error;
          if (error instanceof Error && error.message.startsWith('Overpass could not finish'))
            throw error;
          logger.warn({ err: error, attempt }, 'Overpass request failed');
        }
      }
      throw lastError instanceof Error ? lastError : new Error('Overpass request failed');
    },
  };
}

/**
 * GoWay Live configuration, parsed ONCE at module load.
 *
 * ## Off unless switched on, and never a boot dependency of the map
 *
 * Kept out of `config/index.ts` for the reason routing and Street 3D are: the
 * core parse refuses to start the process, and a third party's real-time feed
 * must not have that power over the map. With nothing set:
 *
 *   - `LIVE_ENABLED` is false: no poller starts, the `/live` Socket.IO
 *     namespace is never attached, and `GET /api/v1/live/sources` answers
 *     `service_unavailable`;
 *   - `/ready` reads nothing here — a feed that is down changes nothing about
 *     whether Places, search and routing can serve.
 *
 * `LIVE_ENABLED=1` alone still serves nothing: each source is opted into BY ID
 * in `LIVE_SOURCES` (the catalogue is `live/catalogue.ts`, with each feed's
 * licence). That is deliberate — enabling a source is a decision about a third
 * party's terms, and it should be made one feed at a time, in configuration a
 * reviewer can read, never by a default.
 *
 * ## Endpoints are configuration
 *
 * Every source has its public endpoint as a default (a feed's address is part
 * of what a licence review approved), and `LIVE_SOURCE_<ID>_URL` points it
 * somewhere else — a mirror, a paid tier, a self-hosted aggregator — without a
 * code change. A source that needs a key (`requiresKey` in the catalogue)
 * reads `LIVE_SOURCE_<ID>_KEY` and stays OFF, with one warning, without it.
 * `<ID>` is the source id upper-cased with `-` as `_` (`adsb-lol` →
 * `LIVE_SOURCE_ADSB_LOL_URL`).
 *
 * A value that is PRESENT and malformed (an unknown source id, a URL that is
 * not one) still fails the parse at boot, naming every variable — a typo in
 * `LIVE_SOURCES` must not silently serve nothing.
 */

import { z } from 'zod';
import { LIVE_SOURCE_IDS } from '../live/catalogue';
import type { EnvironmentSource } from './index';

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const booleanFlag = z.preprocess((value) => {
  const normalized = emptyAsUndefined(value);
  if (normalized === undefined) return undefined;
  const text = String(normalized).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(text)) return true;
  if (['0', 'false', 'no', 'off'].includes(text)) return false;
  return normalized;
}, z.boolean().default(false));

const integer = (fallback: number, minimum: number, maximum: number) =>
  z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(minimum).max(maximum).default(fallback),
  );

/** An http(s) URL without credentials, query or fragment — a key goes in its own variable. */
const endpointUrl = z
  .string()
  .trim()
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        (url.protocol === 'https:' || url.protocol === 'http:') &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  }, 'must be an http(s) URL without credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

/** `adsb-lol` → `ADSB_LOL`. */
export function liveSourceEnvName(sourceId: string): string {
  return sourceId.toUpperCase().replace(/-/g, '_');
}

export interface LiveSourceSettings {
  /** Overrides the catalogue's endpoint. */
  url?: string;
  /** For a source that needs one. Never logged. */
  key?: string;
}

export interface LiveConfig {
  enabled: boolean;
  /** Source ids, as listed, de-duplicated. Checked against the catalogue by the caller. */
  sources: readonly string[];
  settings: Readonly<Record<string, LiveSourceSettings>>;
  /** Identifies GoWay to feeds that ask callers to (`User-Agent`, Digitraffic's `Digitraffic-User`). */
  userAgent: string;
  /** Live sockets this process accepts at once; the next is refused. */
  maxConnections: number;
  /** Subscription token bucket, per socket. */
  subscribeBurst: number;
  subscribePerMinute: number;
  /** Upstream requests a regional source (aircraft) may make per poll cycle. */
  maxRegionsPerPoll: number;
}

const baseSchema = z.object({
  enabled: booleanFlag,
  sources: z.preprocess(
    (value) => {
      const text = emptyAsUndefined(value);
      if (text === undefined) return [];
      return [
        ...new Set(
          String(text)
            .split(/[\s,]+/)
            .map((entry) => entry.trim().toLowerCase())
            .filter(Boolean),
        ),
      ];
    },
    z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{1,47}$/, 'must be a live source id')),
  ),
  userAgent: z.preprocess(
    emptyAsUndefined,
    z.string().trim().min(3).max(120).default('GoWay-Live/1.0 (+https://goway.to)'),
  ),
  maxConnections: integer(2000, 1, 100_000),
  subscribeBurst: integer(10, 1, 100),
  subscribePerMinute: integer(60, 1, 6000),
  maxRegionsPerPoll: integer(4, 1, 50),
});

/**
 * Parse `source` into a {@link LiveConfig}.
 *
 * @param knownSourceIds the catalogue's ids; a listed id outside it fails the parse.
 */
export function parseLiveConfig(
  source: EnvironmentSource = process.env,
  knownSourceIds: readonly string[] = [],
): LiveConfig {
  const result = baseSchema.safeParse({
    enabled: source.LIVE_ENABLED,
    sources: source.LIVE_SOURCES,
    userAgent: source.LIVE_USER_AGENT,
    maxConnections: source.LIVE_MAX_CONNECTIONS,
    subscribeBurst: source.LIVE_SUBSCRIBE_BURST,
    subscribePerMinute: source.LIVE_SUBSCRIBE_PER_MINUTE,
    maxRegionsPerPoll: source.LIVE_MAX_REGIONS_PER_POLL,
  });
  const problems: string[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      problems.push(`  - ${issue.path.join('.') || '(root)'}: ${issue.message}`);
    }
  }

  const settings: Record<string, LiveSourceSettings> = {};
  const listed = result.success ? result.data.sources : [];
  for (const id of listed) {
    if (knownSourceIds.length > 0 && !knownSourceIds.includes(id)) {
      problems.push(
        `  - LIVE_SOURCES: unknown source "${id}" (known: ${knownSourceIds.join(', ')})`,
      );
      continue;
    }
    const name = liveSourceEnvName(id);
    const entry: LiveSourceSettings = {};
    const rawUrl = emptyAsUndefined(source[`LIVE_SOURCE_${name}_URL`]);
    if (rawUrl !== undefined) {
      const url = endpointUrl.safeParse(rawUrl);
      if (url.success) entry.url = url.data;
      else
        problems.push(`  - LIVE_SOURCE_${name}_URL: ${url.error.issues[0]?.message ?? 'invalid'}`);
    }
    const rawKey = emptyAsUndefined(source[`LIVE_SOURCE_${name}_KEY`]);
    if (typeof rawKey === 'string') entry.key = rawKey.trim();
    settings[id] = entry;
  }

  if (problems.length > 0 || !result.success) {
    throw new Error(`Invalid live configuration:\n${problems.join('\n')}`);
  }
  return { ...result.data, settings };
}

/** The one parse for this process, against the catalogue's ids. */
export const liveConfig: LiveConfig = parseLiveConfig(process.env, LIVE_SOURCE_IDS);

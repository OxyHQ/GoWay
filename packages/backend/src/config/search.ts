/**
 * Search, geocoding and reverse-geocoding configuration, parsed ONCE at module
 * load.
 *
 * A separate module from `config/index.ts` rather than more fields on it: the
 * search layer is the only thing that reads these. The SHAPE follows
 * `config/index.ts` exactly — one zod parse, `parseSearchConfig` taking an
 * injectable `source` so a test can hand it a fake environment instead of
 * mutating `process.env` (a mutation leaks into every other test in the same
 * worker, order-dependently).
 *
 * What a deployment configures is WHICH geocoder instances it talks to (and
 * what the Photon instance was built with). How GoWay calls them — timeouts,
 * retries, limits, the cache — is {@link SEARCH_POLICY}, in code.
 *
 * ## Provider URLs are configuration, and the defaults are NOT an SLA
 *
 * `photon.komoot.io` is community infrastructure run as a public good: an
 * acceptable default for development and for initial low-volume operation
 * WITHIN its fair-use policy, and not a production dependency GoWay may lean
 * on. Anything past fair use points `SEARCH_PHOTON_BASE_URL` at a self-hosted
 * instance, which is the whole reason the adapters take a base URL at all.
 *
 * ## Nominatim is on when configured, never by default
 *
 * Its usage policy forbids autocomplete against the public instance, and the
 * code enforces that structurally (`NominatimProvider.allowsInteractiveSearch`
 * is `false`, so it can never serve `/search`). Not shipping a default URL is
 * the second half: an operator enables it by naming the instance it points at
 * (`SEARCH_NOMINATIM_BASE_URL`), for explicit forward/reverse/structured
 * lookups, after deciding which one that is.
 */

import { z } from 'zod';
import type { EnvironmentSource } from './index';

export type { EnvironmentSource };

/** The external geocoders this backend knows how to speak to. */
export const SEARCH_PROVIDER_IDS = ['photon', 'nominatim'] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

/** How GoWay calls its geocoders. Constants: a change is a reviewed commit, not a task definition. */
export interface SearchPolicy {
  /**
   * How long ONE upstream request may take before it is aborted. Small on
   * purpose: this sits inside a user's search keystroke, and a short result
   * list with the provider marked degraded is a better answer than a spinner.
   */
  timeoutMs: number;
  /**
   * Total attempts per upstream request, retries included. `1` — no retry: a
   * retry inside an interactive search doubles the worst-case latency, and the
   * degraded-provider path already produces a usable answer.
   */
  attempts: number;
  /** A caller's `limit` when it gives none. */
  defaultLimit: number;
  /** A caller's `limit` is clamped to this. */
  maxLimit: number;
  /**
   * The bounded cache for upstream answers. Only requests carrying NO
   * coordinate are cached — never a `near` bias or a reverse lookup, whose key
   * would be the user's own location.
   */
  cacheTtlSeconds: number;
  cacheMaxEntries: number;
  /** The radius the Places side scans around a `near` bias or a reverse lookup, in metres. */
  placesRadiusMeters: number;
}

export const SEARCH_POLICY: SearchPolicy = {
  timeoutMs: 4_000,
  attempts: 1,
  defaultLimit: 10,
  maxLimit: 25,
  cacheTtlSeconds: 60,
  cacheMaxEntries: 500,
  placesRadiusMeters: 5_000,
};

/**
 * Identifies GoWay to Nominatim. Its usage policy REQUIRES a self-identifying
 * `User-Agent`; an anonymous one is blocked, and rightly.
 */
const NOMINATIM_USER_AGENT = 'GoWay/0.1 (+https://goway.to)';

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

/**
 * An http(s) base URL for an upstream API.
 *
 * Unlike `httpOrigin` in `config/index.ts` this ALLOWS a path, because a
 * self-hosted Photon or Nominatim commonly sits behind a reverse proxy at
 * `https://maps.example.com/photon`. A query, a fragment or embedded
 * credentials are still refused: each would be silently dropped or duplicated
 * when the adapter appends its own query string, and credentials in a URL end
 * up in every log line that records the request.
 */
const httpBaseUrl = z
  .string()
  .trim()
  .refine((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return false;
    }
    return (
      (url.protocol === 'http:' || url.protocol === 'https:') &&
      url.search.length === 0 &&
      url.hash.length === 0 &&
      url.username.length === 0 &&
      url.password.length === 0
    );
  }, 'must be an http(s) base URL without credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

/**
 * The languages the configured Photon instance can localize into.
 *
 * Photon answers `400` for a `lang` it was not built with — the public instance
 * carries de/en/fr/it — so an unknown locale must be DROPPED rather than
 * forwarded. A self-hosted instance built with more languages widens this.
 * An empty value is "unset", not "the empty list".
 */
const DEFAULT_PHOTON_LANGUAGES = ['de', 'en', 'fr', 'it'] as const;

const photonLanguages = z.preprocess(
  (value) => {
    if (value === undefined || value === null) return [...DEFAULT_PHOTON_LANGUAGES];
    const members = String(value)
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    return members.length === 0 ? [...DEFAULT_PHOTON_LANGUAGES] : [...new Set(members)];
  },
  z.array(z.string().regex(/^[a-z]{2}$/, 'must be a two-letter language code')).min(1),
);

const schema = z.object({
  photonBaseUrl: z.preprocess(emptyAsUndefined, httpBaseUrl.default('https://photon.komoot.io')),
  photonLanguages,
  nominatimBaseUrl: z.preprocess(emptyAsUndefined, httpBaseUrl.optional()),
  /** An optional operator contact address, which Nominatim's policy also asks for. */
  nominatimEmail: z.preprocess(emptyAsUndefined, z.string().trim().email().max(320).optional()),
});

/** How the search layer reaches one Photon instance. */
export interface PhotonConfig {
  baseUrl: string;
  languages: readonly string[];
}

/** How the search layer reaches one Nominatim instance. */
export interface NominatimConfig {
  baseUrl: string;
  userAgent: string;
  email?: string;
}

export interface SearchConfig extends Readonly<SearchPolicy> {
  readonly photon: Readonly<PhotonConfig>;
  /** `null` unless `SEARCH_NOMINATIM_BASE_URL` names an instance. */
  readonly nominatim: Readonly<NominatimConfig> | null;
}

/**
 * Parse `source` into a {@link SearchConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first.
 */
export function parseSearchConfig(source: EnvironmentSource = process.env): SearchConfig {
  const result = schema.safeParse({
    photonBaseUrl: source.SEARCH_PHOTON_BASE_URL,
    photonLanguages: source.SEARCH_PHOTON_LANGUAGES,
    nominatimBaseUrl: source.SEARCH_NOMINATIM_BASE_URL,
    nominatimEmail: source.SEARCH_NOMINATIM_EMAIL,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid search configuration:\n${problems}\n\n` +
        'Every SEARCH_* variable is optional; unset, search uses the community Photon ' +
        'instance, which is suitable for development within its fair-use policy only.',
    );
  }

  const parsed = result.data;
  return {
    ...SEARCH_POLICY,
    photon: { baseUrl: parsed.photonBaseUrl, languages: parsed.photonLanguages },
    nominatim: parsed.nominatimBaseUrl
      ? {
          baseUrl: parsed.nominatimBaseUrl,
          userAgent: NOMINATIM_USER_AGENT,
          ...(parsed.nominatimEmail ? { email: parsed.nominatimEmail } : {}),
        }
      : null,
  };
}

/**
 * The one parse for this process.
 *
 * Module-level on purpose: importing anything that reads search configuration
 * is what proves the configuration is valid, so there is no window in which a
 * half-configured process is already serving.
 */
export const searchConfig: SearchConfig = parseSearchConfig();

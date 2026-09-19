/**
 * Search, geocoding and reverse-geocoding configuration, parsed ONCE at module
 * load.
 *
 * A separate module from `config/index.ts` rather than more fields on it: the
 * search layer is the only thing that reads these, and keeping the parse next
 * to the subsystem means a deployment that never enables an external geocoder
 * does not carry its variables. The SHAPE follows `config/index.ts` exactly —
 * one zod parse, `parseSearchConfig` taking an injectable `source` so a test can
 * hand it a fake environment instead of mutating `process.env` (a mutation leaks
 * into every other test in the same worker, order-dependently).
 *
 * ## Provider URLs are configuration, and the defaults are NOT an SLA
 *
 * `photon.komoot.io` and `nominatim.openstreetmap.org` are community
 * infrastructure run as a public good. They are acceptable defaults for
 * development and for initial low-volume operation WITHIN their fair-use
 * policies, and they are not a production dependency GoWay may lean on: there
 * is no contract, no capacity commitment and no support channel behind either.
 * Anything past fair use points `SEARCH_PHOTON_BASE_URL` /
 * `SEARCH_NOMINATIM_BASE_URL` at a self-hosted instance, which is the whole
 * reason the adapters take a base URL at all.
 *
 * ## Nominatim is not in the default provider list
 *
 * Its usage policy forbids autocomplete against the public instance, and the
 * code enforces that structurally (`NominatimProvider.allowsInteractiveSearch`
 * is `false`, so it can never serve `/search`). Leaving it out of the default
 * `SEARCH_PROVIDERS` is the second half: an operator enables it deliberately,
 * for explicit forward/reverse/structured lookups, after deciding which
 * instance it points at.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import type { EnvironmentSource } from './index';

export type { EnvironmentSource };

// Idempotent, and deliberately not dependent on `config/index.ts` having been
// imported first: a tool that imports only the search configuration should see
// the same `.env` a server does. In ECS every variable arrives from the task
// definition and there is no file to find, so a missing one is not an error.
loadDotenv();

/** The external geocoders this backend knows how to speak to. */
export const SEARCH_PROVIDER_IDS = ['photon', 'nominatim'] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDER_IDS)[number];

// ---------------------------------------------------------------------------
// Combinators. A shell exports an EMPTY string for a variable set to nothing,
// which zod sees as a present value that fails `.min(1)` — so every optional
// field folds `''` back to `undefined` first, and a `.default()` can apply.
// ---------------------------------------------------------------------------

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

const integerFromEnv = (fallback: number, { minimum, maximum }: { minimum: number; maximum: number }) =>
  z.preprocess(emptyAsUndefined, z.coerce.number().int().min(minimum).max(maximum).default(fallback));

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

/** A comma- or whitespace-separated list, lower-cased and de-duplicated. */
const tokenList = <T extends string>(schema: z.ZodType<T[]>, fallback: readonly T[]) =>
  z.preprocess((value) => {
    if (value === undefined || value === null) return [...fallback];
    const members = String(value)
      .split(/[\s,]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean);
    // An empty or whitespace-only value is "unset", not "the empty list": a
    // deployment that exports SEARCH_PROVIDERS= should get the defaults rather
    // than a search API that silently answers nothing.
    return members.length === 0 ? [...fallback] : [...new Set(members)];
  }, schema);

const DEFAULT_PROVIDERS = ['photon'] as const;

/**
 * The enabled providers, IN PRIORITY ORDER.
 *
 * Order is load-bearing twice over: it decides which adapter's candidate
 * represents a group of duplicates, and which failure is reported when every
 * provider fails.
 */
const providerList = tokenList<SearchProviderId>(z.array(z.enum(SEARCH_PROVIDER_IDS)).min(1), DEFAULT_PROVIDERS);

/**
 * The languages the configured Photon instance can localize into.
 *
 * Photon answers `400` for a `lang` it was not built with — the public instance
 * carries de/en/fr/it — so an unknown locale must be DROPPED rather than
 * forwarded. A self-hosted instance built with more languages widens this.
 */
const DEFAULT_PHOTON_LANGUAGES = ['de', 'en', 'fr', 'it'] as const;

const photonLanguages = tokenList<string>(
  z.array(z.string().regex(/^[a-z]{2}$/, 'must be a two-letter language code')).min(1),
  DEFAULT_PHOTON_LANGUAGES,
);

/**
 * The largest radius the GoWay Places side of a search will scan, in metres.
 *
 * Mirrors `MAX_RADIUS_METERS` in `routes/placeSchemas.ts`; restated rather than
 * imported so the configuration layer does not depend on the HTTP layer.
 */
const MAX_PLACES_RADIUS_METERS = 50_000;

const schema = z
  .object({
    providers: providerList,
    /**
     * How long ONE upstream request may take before it is aborted.
     *
     * Small on purpose. This sits inside a user's search keystroke, and a
     * geocoder that has not answered in four seconds is not about to produce a
     * useful autocomplete list — a short result list with the provider marked
     * degraded is a better answer than a spinner.
     */
    timeoutMs: integerFromEnv(4_000, { minimum: 250, maximum: 30_000 }),
    /**
     * Total attempts per upstream request, retries included. `1` — no retry —
     * is the default deliberately: a retry inside an interactive search doubles
     * the worst-case latency the user waits through, and the degraded-provider
     * path already produces a usable answer. Bounded at 3 so no configuration
     * can express an infinite retry.
     */
    attempts: integerFromEnv(1, { minimum: 1, maximum: 3 }),
    defaultLimit: integerFromEnv(10, { minimum: 1, maximum: 50 }),
    maxLimit: integerFromEnv(25, { minimum: 1, maximum: 50 }),
    /** `0` disables the cache. */
    cacheTtlSeconds: integerFromEnv(60, { minimum: 0, maximum: 3_600 }),
    /** `0` disables the cache. */
    cacheMaxEntries: integerFromEnv(500, { minimum: 0, maximum: 100_000 }),
    /** The radius the Places side scans around a `near` bias or a reverse lookup. */
    placesRadiusMeters: integerFromEnv(5_000, { minimum: 1, maximum: MAX_PLACES_RADIUS_METERS }),
    photonBaseUrl: z.preprocess(emptyAsUndefined, httpBaseUrl.default('https://photon.komoot.io')),
    photonLanguages,
    nominatimBaseUrl: z.preprocess(
      emptyAsUndefined,
      httpBaseUrl.default('https://nominatim.openstreetmap.org'),
    ),
    /**
     * Identifies GoWay to Nominatim. Its usage policy REQUIRES a
     * self-identifying `User-Agent`; an anonymous one is blocked, and rightly.
     */
    nominatimUserAgent: z.preprocess(
      emptyAsUndefined,
      z.string().trim().min(1).max(256).default('GoWay/0.1 (+https://goway.to)'),
    ),
    /** An optional operator contact address, which Nominatim's policy also asks for. */
    nominatimEmail: z.preprocess(emptyAsUndefined, z.string().trim().email().max(320).optional()),
  })
  .refine((parsed) => parsed.defaultLimit <= parsed.maxLimit, {
    message: 'must not exceed SEARCH_MAX_LIMIT',
    path: ['defaultLimit'],
  });

type ParsedSearchEnvironment = z.infer<typeof schema>;

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

export interface SearchConfig {
  readonly providers: readonly SearchProviderId[];
  readonly timeoutMs: number;
  readonly attempts: number;
  readonly defaultLimit: number;
  readonly maxLimit: number;
  readonly cacheTtlSeconds: number;
  readonly cacheMaxEntries: number;
  readonly placesRadiusMeters: number;
  readonly photon: Readonly<PhotonConfig>;
  readonly nominatim: Readonly<NominatimConfig>;
}

function shape(parsed: ParsedSearchEnvironment): SearchConfig {
  return {
    providers: parsed.providers,
    timeoutMs: parsed.timeoutMs,
    attempts: parsed.attempts,
    defaultLimit: parsed.defaultLimit,
    maxLimit: parsed.maxLimit,
    cacheTtlSeconds: parsed.cacheTtlSeconds,
    cacheMaxEntries: parsed.cacheMaxEntries,
    placesRadiusMeters: parsed.placesRadiusMeters,
    photon: { baseUrl: parsed.photonBaseUrl, languages: parsed.photonLanguages },
    nominatim: {
      baseUrl: parsed.nominatimBaseUrl,
      userAgent: parsed.nominatimUserAgent,
      ...(parsed.nominatimEmail ? { email: parsed.nominatimEmail } : {}),
    },
  };
}

/**
 * Parse `source` into a {@link SearchConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first.
 */
export function parseSearchConfig(source: EnvironmentSource = process.env): SearchConfig {
  const result = schema.safeParse({
    providers: source.SEARCH_PROVIDERS,
    timeoutMs: source.SEARCH_TIMEOUT_MS,
    attempts: source.SEARCH_UPSTREAM_ATTEMPTS,
    defaultLimit: source.SEARCH_DEFAULT_LIMIT,
    maxLimit: source.SEARCH_MAX_LIMIT,
    cacheTtlSeconds: source.SEARCH_CACHE_TTL_SECONDS,
    cacheMaxEntries: source.SEARCH_CACHE_MAX_ENTRIES,
    placesRadiusMeters: source.SEARCH_PLACES_RADIUS_METERS,
    photonBaseUrl: source.SEARCH_PHOTON_BASE_URL,
    photonLanguages: source.SEARCH_PHOTON_LANGUAGES,
    nominatimBaseUrl: source.SEARCH_NOMINATIM_BASE_URL,
    nominatimUserAgent: source.SEARCH_NOMINATIM_USER_AGENT,
    nominatimEmail: source.SEARCH_NOMINATIM_EMAIL,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid search configuration:\n${problems}\n\n` +
        'Every SEARCH_* variable is optional; the defaults point at community Photon/Nominatim ' +
        'instances that are suitable for development within their fair-use policies only.',
    );
  }

  return shape(result.data);
}

/**
 * The one parse for this process.
 *
 * Module-level on purpose: importing anything that reads search configuration
 * is what proves the configuration is valid, so there is no window in which a
 * half-configured process is already serving.
 */
export const searchConfig: SearchConfig = parseSearchConfig();

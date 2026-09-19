/**
 * Routing configuration, parsed ONCE at module load.
 *
 * Kept OUT of `src/config/index.ts` deliberately. The core parse there refuses
 * to start the process when a value is wrong, and routing must not have that
 * power: a GoWay deployment with no routing engine reachable still serves the
 * map, Places and search, so "no engine configured" is a per-request answer
 * (`service_unavailable` on `POST /routes`) rather than a boot failure. Every
 * variable here is therefore optional, and the module exports enough for a
 * caller to tell "configured" from "not configured" without guessing.
 *
 * `parseRoutingConfig` takes its source as an argument (defaulting to
 * `process.env`) so a test can hand it a fake environment without mutating the
 * real one — a mutation leaks into every other test in the same worker, and the
 * leak is order-dependent, which is the worst shape a flake can take.
 *
 * ## There is no default endpoint, on purpose
 *
 * `AGENTS.md`: API origins and hosts are configuration-driven; never hardcode a
 * development endpoint into product code. Issue #6 says the same thing more
 * sharply — do not call a public community Valhalla demo service from consumer
 * applications. A public demo instance MAY be used while developing, by setting
 * `ROUTING_VALHALLA_URL` in a local `.env`; it is NOT an SLA-backed production
 * dependency, it is rate-limited under a fair-use policy, and nothing in this
 * repository points at one by default.
 */

import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';
import { TRAVEL_MODES } from '@goway/shared-types';
import type { EnvironmentSource } from './index';

// Type-only import above, so this module does NOT pull the core configuration
// parse in as a side effect. It still wants a `.env` file when one exists, and
// dotenv never overrides a variable the environment already set, so calling it
// a second time is free.
loadDotenv();

/** Engines this backend knows how to drive. One today; the seam is the point. */
export const ROUTING_PROVIDERS = ['valhalla'] as const;
export type RoutingProviderName = (typeof ROUTING_PROVIDERS)[number];

/**
 * How long one upstream routing call may take, in milliseconds.
 *
 * Under `@goway.to/sdk`'s own 15 s budget, so a slow engine surfaces as GoWay
 * answering `provider_unavailable` — which a client can act on — rather than as
 * the SDK's timeout, which tells the caller nothing about who was slow.
 */
const DEFAULT_TIMEOUT_MS = 10_000;

/** Alternatives asked for when a caller sets `alternatives: true`. */
const DEFAULT_MAX_ALTERNATIVES = 2;

/**
 * Identifies GoWay to the routing engine.
 *
 * Community-run map services ask callers to identify themselves so abuse can be
 * traced to a project rather than to an IP range. Sending nothing is how a
 * shared endpoint ends up blocking everyone behind a NAT.
 */
const DEFAULT_USER_AGENT = 'GoWay/1.0 (+https://goway.to)';

const emptyAsUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim().length === 0 ? undefined : value;

/**
 * The FULL route endpoint, not an origin.
 *
 * A stock Valhalla server answers `POST /route` at its root, while hosted ones
 * put the engine under a prefix of their own (`/route/v1`, `/valhalla/route`).
 * Taking the complete URL means neither case needs a special path rule here,
 * and an operator can see exactly what will be called.
 *
 * `new URL` rather than zod's own URL check: the accepted spelling of that
 * check moved between zod 3 and 4, and this one cannot move under us.
 */
const routeEndpointUrl = z
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
      url.hash.length === 0 &&
      // Credentials in a URL end up in a connection error's message, which is
      // one `logger.error({ err })` away from an aggregator's index.
      url.username.length === 0 &&
      url.password.length === 0 &&
      // The API key has its own variable so it is never part of a logged URL.
      url.search.length === 0
    );
  }, 'must be an http(s) route endpoint without credentials, query or fragment')
  .transform((value) => value.replace(/\/+$/, ''));

const integerFromEnv = (fallback: number, { minimum, maximum }: { minimum: number; maximum: number }) =>
  z.preprocess(emptyAsUndefined, z.coerce.number().int().min(minimum).max(maximum).default(fallback));

/**
 * The travel modes this deployment offers.
 *
 * A deployment whose tiles were built without bicycle costing should say so
 * here, so a caller gets `unsupported_mode` — a stable answer they can hide a
 * button for — instead of an engine error they cannot interpret.
 */
const modeList = z.preprocess((value) => {
  if (value === undefined || value === null || value === '') return undefined;
  if (Array.isArray(value)) return value;
  const members = String(value)
    .split(/[\s,]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return members.length === 0 ? undefined : [...new Set(members)];
}, z.array(z.enum(TRAVEL_MODES)).min(1).default([...TRAVEL_MODES]));

const schema = z.object({
  provider: z.preprocess(emptyAsUndefined, z.enum(ROUTING_PROVIDERS).default('valhalla')),
  valhallaUrl: z.preprocess(emptyAsUndefined, routeEndpointUrl.optional()),
  valhallaApiKey: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
  timeoutMs: integerFromEnv(DEFAULT_TIMEOUT_MS, { minimum: 250, maximum: 60_000 }),
  modes: modeList,
  maxAlternatives: integerFromEnv(DEFAULT_MAX_ALTERNATIVES, { minimum: 0, maximum: 5 }),
  userAgent: z.preprocess(emptyAsUndefined, z.string().min(1).max(200).default(DEFAULT_USER_AGENT)),
});

/** The parsed routing configuration. */
export type RoutingConfig = Readonly<z.infer<typeof schema>> & {
  /** Whether an engine endpoint is configured at all. */
  readonly enabled: boolean;
};

/**
 * Parse `source` into a {@link RoutingConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first — a
 *   deployment with three bad values should take one round trip to fix.
 */
export function parseRoutingConfig(source: EnvironmentSource = process.env): RoutingConfig {
  const result = schema.safeParse({
    provider: source.ROUTING_PROVIDER,
    valhallaUrl: source.ROUTING_VALHALLA_URL,
    valhallaApiKey: source.ROUTING_VALHALLA_API_KEY,
    timeoutMs: source.ROUTING_TIMEOUT_MS,
    modes: source.ROUTING_MODES,
    maxAlternatives: source.ROUTING_MAX_ALTERNATIVES,
    userAgent: source.ROUTING_USER_AGENT,
  });

  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(
      `Invalid routing configuration:\n${problems}\n\n` +
        'See the ROUTING_* block in packages/backend/.env.example. Leaving ' +
        'ROUTING_VALHALLA_URL unset is valid: POST /routes then answers ' +
        'service_unavailable and the rest of the API is unaffected.',
    );
  }

  const parsed = result.data;
  return { ...parsed, enabled: parsed.valhallaUrl !== undefined };
}

/** The one routing parse for this process. */
export const routingConfig: RoutingConfig = parseRoutingConfig();

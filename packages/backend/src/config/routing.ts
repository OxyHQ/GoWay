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
 * What a deployment configures is WHERE its engine is (and a key, for a hosted
 * one). How GoWay calls it — timeout, alternatives, modes, how it identifies
 * itself — is {@link ROUTING_POLICY}, in code.
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

import { z } from 'zod';
import { TRAVEL_MODES, type TravelMode } from '@goway/contracts';
import type { EnvironmentSource } from './index';

export interface RoutingPolicy {
  /**
   * How long one upstream routing call may take, in milliseconds.
   *
   * Under `@goway.to/sdk`'s own 15 s budget, so a slow engine surfaces as GoWay
   * answering `provider_unavailable` — which a client can act on — rather than
   * as the SDK's timeout, which tells the caller nothing about who was slow.
   * One attempt, no retries: a directions request is interactive.
   */
  timeoutMs: number;
  /** Alternatives asked for when a caller sets `alternatives: true`. */
  maxAlternatives: number;
  /** The travel modes GoWay's engine is built for: every mode in the contract. */
  modes: readonly TravelMode[];
  /**
   * Identifies GoWay to the routing engine. Community-run map services ask
   * callers to identify themselves so abuse can be traced to a project rather
   * than to an IP range.
   */
  userAgent: string;
}

export const ROUTING_POLICY: RoutingPolicy = {
  timeoutMs: 10_000,
  maxAlternatives: 2,
  modes: TRAVEL_MODES,
  userAgent: 'GoWay/1.0 (+https://goway.to)',
};

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

const schema = z.object({
  valhallaUrl: z.preprocess(emptyAsUndefined, routeEndpointUrl.optional()),
  valhallaApiKey: z.preprocess(emptyAsUndefined, z.string().min(1).optional()),
});

/** The parsed routing configuration. */
export type RoutingConfig = Readonly<z.infer<typeof schema>> &
  Readonly<RoutingPolicy> & {
    /** Whether an engine endpoint is configured at all. */
    readonly enabled: boolean;
  };

/**
 * Parse `source` into a {@link RoutingConfig}.
 *
 * @throws {Error} Naming every variable that failed, not just the first.
 */
export function parseRoutingConfig(source: EnvironmentSource = process.env): RoutingConfig {
  const result = schema.safeParse({
    valhallaUrl: source.ROUTING_VALHALLA_URL,
    valhallaApiKey: source.ROUTING_VALHALLA_API_KEY,
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
  return { ...ROUTING_POLICY, ...parsed, enabled: parsed.valhallaUrl !== undefined };
}

/** The one routing parse for this process. */
export const routingConfig: RoutingConfig = parseRoutingConfig();
